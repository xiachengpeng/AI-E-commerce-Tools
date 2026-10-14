from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Select, and_, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from sqlalchemy.sql.elements import ColumnElement

from rabbit_hole.config import AdmissionLimits
from rabbit_hole.discovery import niche_research_queries
from rabbit_hole.domain.legacy import (
    Clock,
    Job,
    JobKind,
    JobPayload,
    JobStatus,
    SystemClock,
)
from rabbit_hole.input_urls import InvalidSupplierQuoteSource, canonical_supplier_inputs
from rabbit_hole.persistence.database import (
    daily_usage,
    feishu_outbox,
    job_checkpoints,
    runtime_jobs,
)
from rabbit_hole.persistence.sql import dialect_insert, write_transaction, ownership_guard


def idempotency_key(payload: JobPayload) -> str:
    # Triggered jobs retain the remote revision for input fencing, but queue
    # identity is the protected snapshot when one is available.  Automation
    # writes legitimately advance a Base revision while a delayed job is
    # resuming; they must not create a second admission or spend its budget.
    input_identity = payload.protected_input_hash or payload.input_version
    raw = f"{payload.kind.value}|{payload.record_id}|{input_identity}|{payload.market}"
    return hashlib.sha256(raw.encode()).hexdigest()


class StaleLeaseError(RuntimeError):
    """A worker attempted to write after it lost its lease."""


class ActiveLeaseError(RuntimeError):
    """An operator attempted to requeue work owned by a live worker."""


class JobNotRequeueableError(RuntimeError):
    """An operator attempted to requeue a completed job."""


class AdmissionLimitReached(RuntimeError):
    """This market's UTC-day quota refuses new work; admitted jobs may finish."""


@dataclass(frozen=True, slots=True)
class EnqueueReceipt:
    """The durable result of an idempotent queue admission attempt."""

    job: Job
    created: bool


class JobRepository:
    def __init__(
        self,
        database: AsyncEngine | AsyncConnection,
        clock: Clock | None = None,
        *,
        admission: AdmissionLimits | None = None,
    ) -> None:
        self._database = database
        self._clock = clock or SystemClock()
        self.admission = admission or AdmissionLimits()

    async def enqueue(self, payload: JobPayload) -> Job:
        """Admit work while preserving the original Job-returning API."""
        return (await self.enqueue_with_receipt(payload)).job

    async def enqueue_with_receipt(self, payload: JobPayload) -> EnqueueReceipt:
        """Admit work and report whether this transaction created its queue row."""
        safe_data, invalid = canonical_supplier_inputs(payload.data)
        payload = payload.model_copy(
            update={
                "data": safe_data,
                "input_error": "supplier_quote_source_invalid"
                if invalid
                else payload.input_error,
            }
        )
        now = self._clock.now()
        research_scans = 0
        if payload.kind is JobKind.NICHE_RESEARCH:
            try:
                research_scans = len(
                    niche_research_queries(
                        json.loads(str(payload.data.get("AUTO｜研究证据卡", "")))
                    )
                )
            except (TypeError, ValueError):
                research_scans = (
                    10  # malformed input cannot under-reserve the bounded work
                )
        ai_calls = (
            60
            if payload.kind is JobKind.KEYWORD_SEED
            else 12
            if payload.kind is JobKind.NICHE_DISCOVERY
            else 0
            if payload.kind is JobKind.NICHE_RESEARCH
            else 1
        )
        cost = (
            self.admission.estimated_call_cost_usd * ai_calls
            + self.admission.estimated_research_scan_cost_usd * research_scans
        )
        payload = payload.model_copy(
            update={
                "estimated_ai_calls": ai_calls,
                "estimated_cost_usd": float(cost),
            }
        )
        key = idempotency_key(payload)
        statement = (
            dialect_insert(self._database, runtime_jobs)
            .values(
                id=uuid4(),
                idempotency_key=key,
                kind=payload.kind.value,
                status=(
                    JobStatus.NEEDS_HUMAN.value
                    if payload.input_error
                    else JobStatus.READY.value
                ),
                payload=payload.model_dump(mode="json"),
                failure_code=payload.input_error,
                failure_detail=(
                    InvalidSupplierQuoteSource.detail if payload.input_error else None
                ),
                attempt=0,
                available_at=now,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_nothing(index_elements=[runtime_jobs.c.idempotency_key])
            .returning(runtime_jobs)
        )
        async with self._transaction() as connection:
            day = now.astimezone(UTC).date()
            await connection.execute(
                dialect_insert(self._database, daily_usage)
                .values(market=payload.market, day=day)
                .on_conflict_do_nothing()
            )
            usage = (
                (
                    await connection.execute(
                        select(daily_usage)
                        .where(
                            daily_usage.c.market == payload.market,
                            daily_usage.c.day == day,
                        )
                        .with_for_update()
                    )
                )
                .mappings()
                .one()
            )
            existing = (
                (
                    await connection.execute(
                        select(runtime_jobs).where(
                            runtime_jobs.c.idempotency_key == key
                        )
                    )
                )
                .mappings()
                .first()
            )
            if existing is not None:
                await ownership_guard(connection, kind='jobs', identifier=existing['id'])
                return EnqueueReceipt(job=_job_from_row(existing), created=False)
            if not payload.input_error:
                scans = int(
                    payload.kind
                    in {
                        JobKind.KEYWORD_SCAN,
                        JobKind.LINK_VALIDATION,
                        JobKind.META_SCAN,
                    }
                )
                scans += research_scans
                keywords = int(payload.kind is JobKind.KEYWORD_SCAN)
                candidates = int(payload.kind is JobKind.LINK_VALIDATION)
                deltas = {
                    "scans": scans,
                    "keywords": keywords,
                    "candidates": candidates,
                    "estimated_ai_calls": ai_calls,
                    "estimated_cost_usd": cost,
                }
                maxima = {
                    "scans": self.admission.daily_scans,
                    "keywords": self.admission.daily_keywords,
                    "candidates": self.admission.daily_candidates,
                    "estimated_ai_calls": self.admission.daily_ai_calls,
                    "estimated_cost_usd": self.admission.daily_cost_usd,
                }
                if any(
                    usage[name] + value > maxima[name] for name, value in deltas.items()
                ) or (
                    scans
                    and usage["discovered_candidates"]
                    >= self.admission.daily_candidates
                ):
                    raise AdmissionLimitReached(
                        "daily manual admission limit reached; retry after next UTC day"
                    )
            inserted = (await connection.execute(statement)).mappings().one_or_none()
            if inserted is None:
                # A separate writer can have inserted between our lookup and
                # the conflict-guarded write. Do not charge that replay.
                row = await connection.execute(
                    select(runtime_jobs).where(runtime_jobs.c.idempotency_key == key)
                )
                return EnqueueReceipt(
                    job=_job_from_row(row.one()._mapping), created=False
                )
            if not payload.input_error:
                await connection.execute(
                    update(daily_usage)
                    .where(
                        daily_usage.c.market == payload.market, daily_usage.c.day == day
                    )
                    .values(
                        **{name: usage[name] + value for name, value in deltas.items()}
                    )
                )
        return EnqueueReceipt(job=_job_from_row(inserted), created=True)

    async def get(self, job_id: UUID) -> Job:
        async with self._connection() as connection:
            row = await connection.execute(
                select(runtime_jobs).where(runtime_jobs.c.id == job_id)
            )
        return _job_from_row(row.one()._mapping)

    async def lease_next(self, worker: str, *, lease_for: timedelta) -> Job | None:
        now = self._clock.now()
        eligible = or_(
            and_(
                runtime_jobs.c.status == JobStatus.READY.value,
                runtime_jobs.c.available_at <= now,
            ),
            and_(
                runtime_jobs.c.status == JobStatus.DELAYED.value,
                runtime_jobs.c.available_at <= now,
            ),
            and_(
                runtime_jobs.c.status == JobStatus.RUNNING.value,
                runtime_jobs.c.lease_until <= now,
            ),
        )
        async with self._transaction() as connection:
            candidate: Select[tuple[Any]] = (
                select(runtime_jobs.c.id)
                .where(eligible)
                .order_by(runtime_jobs.c.available_at, runtime_jobs.c.created_at)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            selected = await connection.execute(candidate)
            job_id = selected.scalar_one_or_none()
            if job_id is None:
                return None
            await connection.execute(
                update(runtime_jobs)
                .where(runtime_jobs.c.id == job_id)
                .values(
                    status=JobStatus.RUNNING.value,
                    lease_until=now + lease_for,
                    leased_by=worker,
                    lease_token=uuid4(),
                    updated_at=now,
                )
            )
            row = await connection.execute(
                select(runtime_jobs).where(runtime_jobs.c.id == job_id)
            )
        return _job_from_row(row.one()._mapping)

    async def checkpoint(
        self,
        job_id: UUID,
        stage: str,
        data: dict[str, Any],
        *,
        worker: str,
        lease_token: UUID | None,
    ) -> None:
        now = self._clock.now()
        statement = (
            dialect_insert(self._database, job_checkpoints)
            .values(job_id=job_id, stage=stage, data=data, created_at=now)
            .on_conflict_do_update(
                index_elements=[job_checkpoints.c.job_id, job_checkpoints.c.stage],
                set_={"data": data, "created_at": now},
            )
        )
        async with self._transaction() as connection:
            await self._require_current_lease(
                connection, job_id, worker, lease_token, now
            )
            await connection.execute(statement)

    async def get_checkpoint(self, job_id: UUID, stage: str) -> dict[str, Any] | None:
        async with self._connection() as connection:
            row = await connection.execute(
                select(job_checkpoints.c.data).where(
                    and_(
                        job_checkpoints.c.job_id == job_id,
                        job_checkpoints.c.stage == stage,
                    )
                )
            )
        value = row.scalar_one_or_none()
        return value if isinstance(value, dict) else None

    async def retry(
        self,
        job_id: UUID,
        *,
        failure: str,
        attempt: int,
        worker: str,
        lease_token: UUID | None,
        detail: str | None = None,
        kind: JobKind | None = None,
    ) -> Job:
        now = self._clock.now()
        async with self._transaction() as connection:
            job = await self._require_current_lease(
                connection, job_id, worker, lease_token, now
            )
            status, available_at = _retry_state(kind or job.payload.kind, attempt, now)
            values: dict[str, Any] = {
                "status": status.value,
                "attempt": attempt,
                "available_at": available_at,
                "failure_code": failure,
                "failure_detail": detail or failure,
                "updated_at": now,
            }
            if status is not JobStatus.RUNNING:
                values["lease_until"] = None
                values["leased_by"] = None
                values["lease_token"] = None
            result = await connection.execute(
                update(runtime_jobs)
                .where(_current_lease(job_id, worker, lease_token, now))
                .values(values)
                .returning(runtime_jobs)
            )
        return _job_from_result(result, job_id)

    async def renew(
        self,
        job_id: UUID,
        *,
        worker: str,
        lease_token: UUID | None,
        lease_for: timedelta,
    ) -> Job:
        if lease_for <= timedelta(0):
            raise ValueError("lease_for must be positive")
        now = self._clock.now()
        async with self._transaction() as connection:
            result = await connection.execute(
                update(runtime_jobs)
                .where(_current_lease(job_id, worker, lease_token, now))
                .values(lease_until=now + lease_for, updated_at=now)
                .returning(runtime_jobs)
            )
        return _job_from_result(result, job_id)

    async def needs_human(
        self,
        job_id: UUID,
        *,
        failure: str,
        detail: str,
        worker: str,
        lease_token: UUID | None,
    ) -> Job:
        now = self._clock.now()
        async with self._transaction() as connection:
            result = await connection.execute(
                update(runtime_jobs)
                .where(_current_lease(job_id, worker, lease_token, now))
                .values(
                    status=JobStatus.NEEDS_HUMAN.value,
                    failure_code=failure,
                    failure_detail=detail,
                    lease_until=None,
                    leased_by=None,
                    lease_token=None,
                    updated_at=now,
                )
                .returning(runtime_jobs)
            )
        return _job_from_result(result, job_id)

    async def requeue(self, job_id: UUID) -> Job:
        """Explicitly retry failed work without stealing a live lease."""

        now = self._clock.now()
        async with self._transaction() as connection:
            await ownership_guard(connection, kind='jobs', identifier=job_id)
            selected = await connection.execute(
                select(runtime_jobs)
                .where(runtime_jobs.c.id == job_id)
                .with_for_update()
            )
            row = selected.one()
            job = _job_from_row(row._mapping)
            if (
                job.status is JobStatus.RUNNING
                and job.lease_until is not None
                and job.lease_until > now
            ):
                raise ActiveLeaseError(f"job {job_id} has an active lease")
            if job.status is JobStatus.SUCCEEDED:
                raise JobNotRequeueableError(f"job {job_id} already succeeded")
            if job.payload.input_error is not None:
                raise JobNotRequeueableError(
                    "invalid supplier source requires corrected input and a new version"
                )
            result = await connection.execute(
                update(runtime_jobs)
                .where(runtime_jobs.c.id == job_id)
                .values(
                    status=JobStatus.READY.value,
                    attempt=0,
                    available_at=now,
                    lease_until=None,
                    leased_by=None,
                    lease_token=None,
                    failure_code=None,
                    failure_detail=None,
                    updated_at=now,
                )
                .returning(runtime_jobs)
            )
        return _job_from_result(result, job_id)

    async def complete(
        self, job_id: UUID, *, worker: str, lease_token: UUID | None
    ) -> Job:
        now = self._clock.now()
        async with self._transaction() as connection:
            result = await connection.execute(
                update(runtime_jobs)
                .where(_current_lease(job_id, worker, lease_token, now))
                .values(
                    status=JobStatus.SUCCEEDED.value,
                    lease_until=None,
                    leased_by=None,
                    lease_token=None,
                    updated_at=now,
                )
                .returning(runtime_jobs)
            )
        return _job_from_result(result, job_id)

    @asynccontextmanager
    async def _connection(self) -> AsyncIterator[AsyncConnection]:
        if isinstance(self._database, AsyncConnection):
            yield self._database
        else:
            async with self._database.connect() as connection:
                yield connection

    @asynccontextmanager
    async def _transaction(self) -> AsyncIterator[AsyncConnection]:
        if isinstance(self._database, AsyncConnection):
            await ownership_guard(self._database)
            yield self._database
            await ownership_guard(self._database)
        else:
            async with write_transaction(self._database) as connection:
                yield connection

    async def _require_current_lease(
        self,
        connection: AsyncConnection,
        job_id: UUID,
        worker: str,
        lease_token: UUID | None,
        now: datetime,
    ) -> Job:
        result = await connection.execute(
            select(runtime_jobs)
            .where(_current_lease(job_id, worker, lease_token, now))
            .with_for_update()
        )
        row = result.one_or_none()
        if row is None:
            raise StaleLeaseError(f"job {job_id} is not leased by {worker}")
        return _job_from_row(row._mapping)


class OutboxRepository:
    def __init__(self, engine: AsyncEngine, clock: Clock | None = None) -> None:
        self._engine = engine
        self._clock = clock or SystemClock()

    async def enqueue(
        self, record_id: str, record_version: str, payload: dict[str, Any]
    ) -> UUID:
        now = self._clock.now()
        event_id = uuid4()
        async with write_transaction(self._engine) as connection:
            await ownership_guard(connection, kind='outbox', payload=payload)
            await connection.execute(
                insert(feishu_outbox).values(
                    id=event_id,
                    record_id=record_id,
                    record_version=record_version,
                    payload=payload,
                    status=JobStatus.READY.value,
                    attempt=0,
                    available_at=now,
                    created_at=now,
                    updated_at=now,
                )
            )
        return event_id


def _retry_state(
    kind: JobKind, attempt: int, now: datetime
) -> tuple[JobStatus, datetime]:
    if kind is JobKind.META_SCAN:
        if attempt >= 6:
            return JobStatus.NEEDS_HUMAN, now
        if attempt >= 3:
            return JobStatus.DELAYED, now + timedelta(minutes=15)
        return JobStatus.RUNNING, now
    if attempt >= 4:
        return JobStatus.NEEDS_HUMAN, now
    delay = (1, 5, 15)[attempt - 1]
    return JobStatus.DELAYED, now + timedelta(minutes=delay)


def _current_lease(
    job_id: UUID, worker: str, lease_token: UUID | None, now: datetime
) -> ColumnElement[bool]:
    return and_(
        runtime_jobs.c.id == job_id,
        runtime_jobs.c.status == JobStatus.RUNNING.value,
        runtime_jobs.c.leased_by == worker,
        runtime_jobs.c.lease_token == lease_token,
        runtime_jobs.c.lease_until > now,
    )


def _job_from_result(result: Any, job_id: UUID) -> Job:
    row = result.one_or_none()
    if row is None:
        raise StaleLeaseError(f"job {job_id} lease was lost before write")
    return _job_from_row(row._mapping)


def _job_from_row(row: Mapping[Any, Any]) -> Job:
    payload = JobPayload.model_validate(row["payload"])
    return Job(
        id=row["id"],
        idempotency_key=row["idempotency_key"],
        payload=payload,
        status=JobStatus(row["status"]),
        attempt=row["attempt"],
        available_at=row["available_at"],
        lease_until=row["lease_until"],
        leased_by=row["leased_by"],
        lease_token=row["lease_token"],
        failure_code=row["failure_code"],
        failure_detail=row["failure_detail"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
