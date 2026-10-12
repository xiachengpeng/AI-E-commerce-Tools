"""Durable logical budgets and network observations; owns no network retries."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from models.research_ai_usage import network_attempts, reservations
from sqlalchemy import select, update

from services.research_runtime import _research_imports

_research_imports()
from rabbit_hole.application.actions import actions, ai_usage
from rabbit_hole.domain.rules import effective_rules
from rabbit_hole.integrations.provider_jobs import provider_logs
from rabbit_hole.persistence.sql import transaction_lock, write_transaction


class ResearchUsageError(ValueError):
    def __init__(self, message, *, code="submission_uncertain"):
        self.code = code
        super().__init__(message)


def _engine(runtime):
    return getattr(runtime, "engine", None) or runtime.store.engine


def _fenced(row, attempt):
    return (
        row["attempt"] == attempt
        and row["status"] == "running"
        and row["lease_until"] is not None
        and row["lease_until"] > datetime.now(UTC)
    )


async def reserve_ai(runtime, action_id: str, attempt: int, operation: str) -> str:
    if (
        type(attempt) is not int
        or attempt < 1
        or operation not in {"keywords", "expand", "verify", "extract", "direction"}
    ):
        raise ValueError("invalid logical research reservation")
    now = datetime.now(UTC)
    async with write_transaction(_engine(runtime)) as c:
        action = (
            (await c.execute(select(actions).where(actions.c.id == UUID(action_id))))
            .mappings()
            .one()
        )
        await transaction_lock(c, str(action["project_id"]))
        if not _fenced(action, attempt):
            raise ResearchUsageError(
                "研究任务围栏已变化，未提交请求", code="input_changed"
            )
        old = (
            (
                await c.execute(
                    select(reservations).where(
                        reservations.c.action_id == UUID(action_id),
                        reservations.c.attempt == attempt,
                        reservations.c.operation == operation,
                    )
                )
            )
            .mappings()
            .first()
        )
        if old:
            return old["id"]
        previous = (
            (
                await c.execute(
                    select(reservations.c.status).where(
                        reservations.c.action_id == UUID(action_id),
                        reservations.c.operation == operation,
                    )
                )
            )
            .scalars()
            .all()
        )
        if any(
            status in {"submitted", "retrying", "received", "uncertain", "cancelled"}
            for status in previous
        ):
            raise ResearchUsageError("上次AI提交结果未知，请人工核对；未重复提交")
        project = await runtime.store.get(str(action["project_id"]))
        rows = (
            (
                await c.execute(
                    select(actions).where(
                        actions.c.project_id == action["project_id"],
                        actions.c.kind.in_(["keywords", "expand", "verify"]),
                    )
                )
            )
            .mappings()
            .all()
        )
        if (
            ai_usage(rows, now, reservations=False)
            >= effective_rules(project)["ai_daily_limit"]
        ):
            raise ResearchUsageError(
                "今天的AI请求预算已用完，可继续人工研究", code="budget"
            )
        payload = dict(action["payload"])
        ledger = dict(payload.get("ai_usage", {}))
        day = now.date().isoformat()
        ledger[day] = ledger.get(day, 0) + 1
        payload["ai_usage"] = ledger
        await c.execute(
            update(actions).where(actions.c.id == action["id"]).values(payload=payload)
        )
        rid = str(uuid4())
        await c.execute(
            reservations.insert().values(
                id=rid,
                project_id=action["project_id"],
                action_id=action["id"],
                attempt=attempt,
                operation=operation,
                day=day,
                status="reserved",
                created_at=now.replace(tzinfo=None),
            )
        )
        return rid


async def record_ai_attempt(runtime, reservation_id: str, event: dict) -> None:
    status = event.get("status")
    number = event.get("network_attempt")
    if (
        status
        not in {
            "submitted",
            "retrying",
            "received",
            "succeeded",
            "failed",
            "uncertain",
            "cancelled",
        }
        or type(number) is not int
        or not 1 <= number <= 100
    ):
        raise ValueError("invalid research AI event")

    def metric(name):
        value = event.get(name, 0)
        return min(max(value, 0), 86400000) if type(value) is int else 0

    category = event.get("category", "")
    # Enumerated codes only; arbitrary event strings/payloads are never persisted.
    from services.retry_service import ErrorCategory

    category = category if category in {item.value for item in ErrorCategory} else ""
    violation = False
    async with write_transaction(_engine(runtime)) as c:
        row = (
            (
                await c.execute(
                    select(reservations).where(reservations.c.id == reservation_id)
                )
            )
            .mappings()
            .one()
        )
        action = (
            (await c.execute(select(actions).where(actions.c.id == row["action_id"])))
            .mappings()
            .one()
        )
        network = (
            (
                await c.execute(
                    select(network_attempts).where(
                        network_attempts.c.reservation_id == reservation_id,
                        network_attempts.c.network_attempt == number,
                    )
                )
            )
            .mappings()
            .first()
        )
        valid = _fenced(action, row["attempt"])
        if valid and row["status"] == "cancelled" and status == "cancelled":
            return
        if not valid or row["status"] in {
            "uncertain",
            "cancelled",
            "succeeded",
            "failed",
        }:
            if network is None and status == "submitted":
                raise ResearchUsageError("研究任务围栏或提交状态已变化，未重放请求")
            status = (
                "uncertain"
                if row["status"] not in {"succeeded", "failed"}
                else row["status"]
            )
            violation = True
        if status == "submitted" and network is not None:
            raise ResearchUsageError("本次网络提交已记录，未重放请求")
        values = {
            "status": status,
            "category": category,
            "delay_ms": metric("delay_ms"),
            "duration_ms": metric("duration_ms"),
            "updated_at": datetime.now(UTC).replace(tzinfo=None),
        }
        if network:
            await c.execute(
                update(network_attempts)
                .where(
                    network_attempts.c.reservation_id == reservation_id,
                    network_attempts.c.network_attempt == number,
                )
                .values(**values)
            )
        else:
            await c.execute(
                network_attempts.insert().values(
                    reservation_id=reservation_id, network_attempt=number, **values
                )
            )
        await c.execute(
            update(reservations)
            .where(reservations.c.id == reservation_id)
            .values(
                status="reserved"
                if status == "failed" and event.get("terminal") is not True
                else status
            )
        )
        # Existing durable log table, fixed controlled message; no prompt/URL/exception.
        await c.execute(
            provider_logs.insert().values(
                project_id=row["project_id"],
                action_id=row["action_id"],
                attempt=row["attempt"],
                stage="ai_" + status,
                message=f"AI {row['operation']}：网络尝试 {number}，状态 {status}；等待 {values['delay_ms']}ms，耗时 {values['duration_ms']}ms",
                level="warning"
                if status in {"failed", "uncertain", "cancelled"}
                else "info",
            )
        )
    if violation:
        raise ResearchUsageError(
            "研究任务围栏或提交状态已变化，迟到结果已拒绝", code="input_changed"
        )
