"""Transactional PostgreSQL persistence for workbench project aggregates."""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    Column,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    UniqueConstraint,
    delete,
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from rabbit_hole.domain.project import (
    WorkbenchError,
    apply_command,
    new_project,
    project_view,
)
from rabbit_hole.input_urls import sanitize_research_url_fields
from rabbit_hole.persistence.database import json_type, metadata
from rabbit_hole.persistence.sql import (
    UTCDateTime,
    command_transaction,
    transaction_lock,
    write_transaction,
)

workbench_projects = Table(
    "workbench_projects",
    metadata,
    Column("id", Text, primary_key=True),
    Column("title", Text, nullable=False),
    Column("direction", Text, nullable=False),
    Column("market", Text, nullable=False),
    Column("version", Integer, nullable=False),
    Column("state", json_type, nullable=False),
    Column("create_command_id", Text, nullable=False, unique=True),
    Column("create_digest", Text, nullable=False),
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
)

workbench_events = Table(
    "workbench_events",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "project_id",
        Text,
        ForeignKey("workbench_projects.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("command_id", Text, nullable=False),
    Column("digest", Text, nullable=False),
    Column("action", Text, nullable=False),
    Column("payload", json_type, nullable=False),
    Column("actor", Text, nullable=False),
    Column("created_at", UTCDateTime(), nullable=False),
    UniqueConstraint(
        "project_id", "command_id", name="uq_workbench_event_project_command"
    ),
)
Index(
    "ix_workbench_events_project_created",
    workbench_events.c.project_id,
    workbench_events.c.created_at,
)


def _digest(value: dict[str, Any]) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _as_uuid(value: str, field: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise WorkbenchError("invalid_uuid", f"{field} 必须是有效 UUID") from exc


def _db_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(UTC)
    parsed = datetime.fromisoformat(str(value))
    return parsed.astimezone(UTC)


class WorkbenchStore:
    def __init__(self, engine: AsyncEngine):
        self.engine = engine

    async def create(
        self, title: str, direction: str, market: str, command_id: str
    ) -> dict[str, Any]:
        normalized_command_id = _as_uuid(command_id, "command_id")
        request_digest = _digest(
            {"title": title, "direction": direction, "market": market}
        )
        try:
            async with write_transaction(self.engine) as connection:
                existing = (
                    (
                        await connection.execute(
                            select(workbench_projects).where(
                                workbench_projects.c.create_command_id
                                == normalized_command_id
                            )
                        )
                    )
                    .mappings()
                    .first()
                )
                if existing:
                    if existing["create_digest"] != request_digest:
                        raise WorkbenchError(
                            "idempotency_conflict",
                            "该命令编号已用于不同的创建请求",
                            409,
                        )
                    return await self._view(connection, existing)
                now = datetime.now(UTC)
                state = new_project(title, direction, market, now=now)
                await connection.execute(
                    insert(workbench_projects).values(
                        id=state["id"],
                        title=state["title"],
                        direction=state["direction"],
                        market=state["market"],
                        version=0,
                        state=state,
                        create_command_id=normalized_command_id,
                        create_digest=request_digest,
                        created_at=now,
                        updated_at=now,
                    )
                )
                await connection.execute(
                    insert(workbench_events).values(
                        id=str(uuid4()),
                        project_id=state["id"],
                        command_id=normalized_command_id,
                        digest=request_digest,
                        action="create",
                        payload={
                            "title": state["title"],
                            "direction": state["direction"],
                            "market": state["market"],
                        },
                        actor="local_user",
                        created_at=now,
                    )
                )
                row = (
                    (
                        await connection.execute(
                            select(workbench_projects).where(
                                workbench_projects.c.id == state["id"]
                            )
                        )
                    )
                    .mappings()
                    .one()
                )
                return await self._view(connection, row)
        except IntegrityError:
            # A concurrent create may win the unique create_command_id race.
            async with self.engine.connect() as connection:
                existing = (
                    (
                        await connection.execute(
                            select(workbench_projects).where(
                                workbench_projects.c.create_command_id
                                == normalized_command_id
                            )
                        )
                    )
                    .mappings()
                    .first()
                )
                if existing and existing["create_digest"] == request_digest:
                    return await self._view(connection, existing)
            raise WorkbenchError(
                "idempotency_conflict", "该命令编号已用于不同的创建请求", 409
            )


    async def lock_project(self, connection: AsyncConnection, project_id: str) -> Any:
        """Serialize project writes with deletion, including task admissions."""
        row = (await connection.execute(
            select(workbench_projects).where(workbench_projects.c.id == project_id).with_for_update()
        )).mappings().first()
        if row is None:
            raise WorkbenchError("not_found", "研究项目不存在", 404)
        return row

    async def delete_project(self, project_id: str, expected_version: int, title: str) -> dict[str, Any]:
        project_id = _as_uuid(project_id, "project_id")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 0:
            raise WorkbenchError("invalid_version", "请提供有效项目版本")
        if not isinstance(title, str) or not title.strip():
            raise WorkbenchError("confirmation_required", "请输入项目名称确认删除")
        result = {"id": project_id, "deleted": True}
        async with write_transaction(self.engine) as connection:
            await transaction_lock(connection, project_id)
            row = (await connection.execute(
                select(workbench_projects).where(workbench_projects.c.id == project_id).with_for_update()
            )).mappings().first()
            if row is None:
                return result
            if row["version"] != expected_version:
                raise WorkbenchError("version_conflict", "项目已更新，请重新打开删除窗口确认", 409)
            if title.strip() != row["title"]:
                raise WorkbenchError("confirmation_required", "项目名称不一致，请输入完整项目名称")
            from rabbit_hole.application.actions import actions
            from rabbit_hole.application.sync import runs
            from rabbit_hole.integrations.provider_jobs import provider_logs
            action_busy = await connection.scalar(select(actions.c.id).where(actions.c.project_id == UUID(project_id), actions.c.status.in_(["ready", "running"])).limit(1))
            sync_busy = await connection.scalar(select(runs.c.id).where(runs.c.project_id == project_id, runs.c.status.in_(["ready", "running", "retry_wait"])).limit(1))
            if action_busy or sync_busy:
                raise WorkbenchError("project_busy", "项目还有排队或执行中的任务，请先停止采集；飞书同步需等待结束后再删除", 409)
            await connection.execute(delete(provider_logs).where(provider_logs.c.project_id == UUID(project_id)))
            await connection.execute(delete(actions).where(actions.c.project_id == UUID(project_id)))
            await connection.execute(delete(runs).where(runs.c.project_id == project_id))
            await connection.execute(delete(workbench_projects).where(workbench_projects.c.id == project_id))
        return result

    async def list_projects(self) -> list[dict[str, Any]]:
        async with self.engine.connect() as connection:
            rows = (
                (
                    await connection.execute(
                        select(workbench_projects).order_by(
                            workbench_projects.c.created_at
                        )
                    )
                )
                .mappings()
                .all()
            )
            return [await self._view(connection, row) for row in rows]

    @staticmethod
    @asynccontextmanager
    async def _borrow(connection: AsyncConnection) -> AsyncIterator[AsyncConnection]:
        if not connection.in_transaction():
            raise ValueError("read connection requires an active transaction")
        yield connection

    def read_connection(self, connection: AsyncConnection | None) -> AbstractAsyncContextManager[AsyncConnection]:
        return self._borrow(connection) if connection is not None else self.engine.connect()

    async def get(self, project_id: str, *, _connection: AsyncConnection | None = None) -> dict[str, Any]:
        project_id = _as_uuid(project_id, "project_id")
        async with self.read_connection(_connection) as connection:
            row = (
                (
                    await connection.execute(
                        select(workbench_projects).where(
                            workbench_projects.c.id == project_id
                        )
                    )
                )
                .mappings()
                .first()
            )
            if row is None:
                raise WorkbenchError("not_found", "研究项目不存在", 404)
            return await self._view(connection, row)

    async def command(
        self,
        project_id: str,
        expected_version: int,
        command_id: str,
        action: str,
        payload: dict[str, Any],
        actor: str = "user",
        *, _connection: AsyncConnection | None = None,
    ) -> dict[str, Any]:
        project_id, command_id = (
            _as_uuid(project_id, "project_id"),
            _as_uuid(command_id, "command_id"),
        )
        if (
            isinstance(expected_version, bool)
            or not isinstance(expected_version, int)
            or expected_version < 0
        ):
            raise WorkbenchError("invalid_version", "expected_version 必须是非负整数")
        normalized_actor = "automation" if actor == "automation" else "local_user"
        safe_payload = sanitize_research_url_fields(
            payload, preserve_media=action == "collection_result" and normalized_actor == "automation"
        )
        if not isinstance(safe_payload, dict):
            raise WorkbenchError("invalid_payload", "payload must be an object")
        command_digest = _digest(
            {"action": action, "payload": safe_payload, "actor": normalized_actor}
        )
        async with command_transaction(self.engine, _connection) as connection:
            row = (
                (
                    await connection.execute(
                        select(workbench_projects)
                        .where(workbench_projects.c.id == project_id)
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if row is None:
                raise WorkbenchError("not_found", "研究项目不存在", 404)
            duplicate = (
                (
                    await connection.execute(
                        select(workbench_events).where(
                            workbench_events.c.project_id == project_id,
                            workbench_events.c.command_id == command_id,
                        )
                    )
                )
                .mappings()
                .first()
            )
            if duplicate:
                if duplicate["digest"] != command_digest:
                    raise WorkbenchError(
                        "idempotency_conflict", "该命令编号已用于不同操作", 409
                    )
                return await self._view(connection, row)
            if row["version"] != expected_version:
                raise WorkbenchError(
                    "version_conflict",
                    f"项目已更新（当前版本 {row['version']}），请刷新后重试",
                    409,
                )
            state = deepcopy(row["state"])
            apply_command(state, action, safe_payload, actor=normalized_actor)
            next_version = row["version"] + 1
            now = datetime.now(UTC)
            state["version"], state["updated_at"] = (
                next_version,
                now.isoformat().replace("+00:00", "Z"),
            )
            await connection.execute(
                update(workbench_projects)
                .where(workbench_projects.c.id == project_id)
                .values(
                    title=state["title"],
                    direction=state["direction"],
                    market=state["market"],
                    version=next_version,
                    state=state,
                    updated_at=now,
                )
            )
            await connection.execute(
                insert(workbench_events).values(
                    id=str(uuid4()),
                    project_id=project_id,
                    command_id=command_id,
                    digest=command_digest,
                    action=action,
                    payload=safe_payload,
                    actor=normalized_actor,
                    created_at=now,
                )
            )
            refreshed = dict(row)
            refreshed.update(state=state, version=next_version, updated_at=now)
            return await self._view(connection, refreshed)

    async def _view(self, connection: AsyncConnection, row: Any) -> dict[str, Any]:
        state = deepcopy(row["state"])
        state["version"] = row["version"]
        state["created_at"] = (
            _db_time(row["created_at"]).isoformat().replace("+00:00", "Z")
        )
        state["updated_at"] = (
            _db_time(row["updated_at"]).isoformat().replace("+00:00", "Z")
        )
        events = (
            (
                await connection.execute(
                    select(
                        workbench_events.c.id,
                        workbench_events.c.command_id,
                        workbench_events.c.action,
                        workbench_events.c.actor,
                        workbench_events.c.created_at,
                    )
                    .where(workbench_events.c.project_id == row["id"])
                    .order_by(
                        workbench_events.c.created_at.desc(),
                        workbench_events.c.id.desc(),
                    )
                    .limit(100)
                )
            )
            .mappings()
            .all()
        )
        state["events"] = [
            {
                "id": event["id"],
                "command_id": event["command_id"],
                "action": event["action"],
                "actor": event["actor"],
                "created_at": _db_time(event["created_at"])
                .isoformat()
                .replace("+00:00", "Z"),
            }
            for event in reversed(events)
        ]
        return project_view(state)
