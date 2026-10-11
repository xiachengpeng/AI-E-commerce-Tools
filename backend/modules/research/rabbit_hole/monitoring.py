"""Durable, low-cardinality operational metrics shared by API and workers."""

from __future__ import annotations

import hashlib
import logging
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from prometheus_client import CollectorRegistry, generate_latest
from prometheus_client.core import (
    CounterMetricFamily,
    GaugeMetricFamily,
    HistogramMetricFamily,
)
from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Float,
    Identity,
    Integer,
    Table,
    Text,
    func,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from rabbit_hole.domain.legacy import Clock, SystemClock
from rabbit_hole.persistence.database import feishu_outbox, metadata, runtime_jobs
from rabbit_hole.persistence.sql import (
    UTCDateTime,
    dialect_insert,
    session_lock,
    write_transaction,
)

SOURCES = ("meta", "landing", "trends", "ai", "job", "candidate")
COLLECTORS = ("meta", "landing", "trends")
JOB_BUCKETS = (30, 60, 300, 900, 3600, 43200)

runtime_events = Table(
    "runtime_events",
    metadata,
    Column("seq", BigInteger().with_variant(Integer, 'sqlite'), Identity(), primary_key=True),
    Column("event_key", Text, nullable=False, unique=True),
    Column("source", Text, nullable=False),
    Column("success", Boolean, nullable=False),
    Column("duration_seconds", Float, nullable=False),
    Column("recoveries", Integer, nullable=False),
    Column("captcha", Boolean, nullable=False),
    Column("schema_failure", Boolean, nullable=False),
    Column("count", Integer, nullable=False),
    Column("created_at", UTCDateTime(), nullable=False, index=True),
)
runtime_alerts = Table(
    "runtime_alerts",
    metadata,
    Column("alert_key", Text, primary_key=True),
    Column("code", Text, nullable=False),
    Column("message", Text, nullable=False),
    Column("first_seen", UTCDateTime(), nullable=False),
    Column("last_seen", UTCDateTime(), nullable=False),
    Column("occurrence_count", Integer, nullable=False),
    Column("sent_count", Integer, nullable=False),
    # The stable alert key identifies the Feishu 搜索批次 row.  This separate
    # fingerprint lets one row accumulate distinct incidents without treating
    # every monitor tick as a new occurrence.
    Column("event_fingerprint", Text, nullable=False),
)
runtime_health = Table(
    "runtime_health",
    metadata,
    Column("component", Text, primary_key=True),
    Column("updated_at", UTCDateTime(), nullable=False),
)


@dataclass(frozen=True)
class Alert:
    key: str
    code: str
    message: str
    fingerprint: str | None = None

    @property
    def event_fingerprint(self) -> str:
        return self.fingerprint or self.key


@dataclass
class OperationalSnapshot:
    queue: dict[str, int] = field(default_factory=dict)
    totals: dict[tuple[str, bool], int] = field(default_factory=dict)
    recoveries: int = 0
    captchas: int = 0
    schema_failures: int = 0
    duration_sum: float = 0
    duration_count: int = 0
    duration_buckets: list[tuple[str, int]] = field(default_factory=list)
    daily_candidates: int = 0
    outbox_depth: int = 0
    outbox_age: float = 0
    alerts: list[Alert] = field(default_factory=list)


class Telemetry:
    def __init__(
        self, database: AsyncEngine | AsyncConnection, clock: Clock | None = None
    ):
        self.database = database
        self.clock = clock or SystemClock()

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[AsyncConnection]:
        if isinstance(self.database, AsyncConnection):
            if self.database.in_transaction():
                yield self.database
            else:
                async with self.database.begin():
                    yield self.database
        else:
            async with write_transaction(self.database) as connection:
                yield connection

    async def record(
        self,
        event_key: str,
        *,
        source: str,
        success: bool,
        duration_seconds: float = 0,
        recoveries: int = 0,
        captcha: bool = False,
        schema_failure: bool = False,
        count: int = 1,
    ) -> None:
        if source not in SOURCES:
            raise ValueError("unknown telemetry source")
        if (
            not math.isfinite(duration_seconds)
            or duration_seconds < 0
            or recoveries < 0
            or count < 0
            or not event_key
        ):
            raise ValueError("invalid telemetry value")
        # No user strings become metric labels or are stored as event identifiers.
        digest = hashlib.sha256(event_key.encode()).hexdigest()
        async with self.transaction() as connection:
            inserted = await connection.execute(
                dialect_insert(connection, runtime_events)
                .values(
                    event_key=digest,
                    source=source,
                    success=success,
                    duration_seconds=duration_seconds,
                    recoveries=recoveries,
                    captcha=captcha,
                    schema_failure=schema_failure,
                    count=count,
                    created_at=self.clock.now(),
                )
                .on_conflict_do_nothing(index_elements=[runtime_events.c.event_key])
                .returning(runtime_events.c.seq)
            )
            if (
                inserted.scalar_one_or_none() is not None
                and source == "candidate"
                and success
            ):
                from rabbit_hole.persistence.database import daily_usage

                day = self.clock.now().astimezone(UTC).date()
                await connection.execute(
                    dialect_insert(connection, daily_usage)
                    .values(market="US", day=day, discovered_candidates=count)
                    .on_conflict_do_update(
                        index_elements=[daily_usage.c.market, daily_usage.c.day],
                        set_={
                            "discovered_candidates": daily_usage.c.discovered_candidates
                            + count
                        },
                    )
                )

    async def heartbeat(self) -> None:
        async with self.transaction() as connection:
            await connection.execute(
                dialect_insert(connection, runtime_health)
                .values(
                    component="worker",
                    updated_at=self.clock.now(),
                )
                .on_conflict_do_update(
                    index_elements=[runtime_health.c.component],
                    set_={"updated_at": self.clock.now()},
                )
            )

    async def snapshot(self) -> OperationalSnapshot:
        now = self.clock.now().astimezone(UTC)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        snapshot = OperationalSnapshot()
        async with self.transaction() as connection:
            rows = await connection.execute(
                select(runtime_jobs.c.status, func.count())
                .where(
                    runtime_jobs.c.status.in_(("ready", "delayed", "running")),
                )
                .group_by(runtime_jobs.c.status)
            )
            snapshot.queue = {str(status): int(count) for status, count in rows}
            waiting = (
                await connection.execute(
                    select(
                        runtime_jobs.c.id,
                        runtime_jobs.c.created_at,
                    )
                    .where(runtime_jobs.c.status.in_(("ready", "delayed")))
                    .order_by(runtime_jobs.c.created_at, runtime_jobs.c.id)
                    .limit(1)
                )
            ).first()
            if waiting and (now - waiting.created_at).total_seconds() >= 7200:
                snapshot.alerts.append(
                    Alert(
                        f"queue:{waiting.id}",
                        "queue_wait",
                        "任务等待已达 2 小时，请检查 Worker 和任务队列。",
                        f"queue:{waiting.id}:{waiting.created_at.isoformat()}",
                    )
                )
            outbox = (
                await connection.execute(
                    select(
                        feishu_outbox.c.id,
                        feishu_outbox.c.created_at,
                    )
                    .where(feishu_outbox.c.status.in_(("ready", "delayed", "running")))
                    .order_by(feishu_outbox.c.created_at, feishu_outbox.c.id)
                    .limit(1)
                )
            ).first()
            snapshot.outbox_depth = int(
                (
                    await connection.execute(
                        select(func.count())
                        .select_from(feishu_outbox)
                        .where(
                            feishu_outbox.c.status.in_(("ready", "delayed", "running"))
                        )
                    )
                ).scalar_one()
            )
            if outbox:
                snapshot.outbox_age = max(0, (now - outbox.created_at).total_seconds())
                if snapshot.outbox_age > 900:
                    snapshot.alerts.append(
                        Alert(
                            f"outbox:{outbox.id}",
                            "outbox_wait",
                            "飞书回写等待超过 15 分钟，请检查授权和回写队列。",
                            f"outbox:{outbox.id}:{outbox.created_at.isoformat()}",
                        )
                    )
            rows = await connection.execute(
                select(
                    runtime_events.c.source,
                    runtime_events.c.success,
                    func.sum(runtime_events.c.count),
                ).group_by(runtime_events.c.source, runtime_events.c.success)
            )
            snapshot.totals = {
                (str(source), bool(success)): int(count)
                for source, success, count in rows
                if source in SOURCES
            }
            totals = (
                await connection.execute(
                    select(
                        func.coalesce(
                            func.sum(runtime_events.c.recoveries).filter(
                                runtime_events.c.source == "meta"
                            ),
                            0,
                        ),
                        func.count().filter(
                            runtime_events.c.source == "meta",
                            runtime_events.c.captcha,
                        ),
                        func.count().filter(
                            runtime_events.c.source == "ai",
                            runtime_events.c.schema_failure,
                        ),
                    )
                )
            ).one()
            snapshot.recoveries, snapshot.captchas, snapshot.schema_failures = map(
                int, totals
            )
            duration = (
                await connection.execute(
                    select(
                        func.coalesce(func.sum(runtime_events.c.duration_seconds), 0),
                        func.count(),
                        *(
                            func.count().filter(
                                runtime_events.c.duration_seconds <= upper
                            )
                            for upper in JOB_BUCKETS
                        ),
                    ).where(runtime_events.c.source == "job")
                )
            ).one()
            snapshot.duration_sum, snapshot.duration_count = (
                float(duration[0]),
                int(duration[1]),
            )
            snapshot.duration_buckets = [
                (str(upper), int(count))
                for upper, count in zip(JOB_BUCKETS, duration[2:])
            ]
            snapshot.duration_buckets.append(("+Inf", snapshot.duration_count))
            snapshot.daily_candidates = int(
                (
                    await connection.execute(
                        select(
                            func.coalesce(func.sum(runtime_events.c.count), 0),
                        ).where(
                            runtime_events.c.source == "candidate",
                            runtime_events.c.created_at >= start,
                            runtime_events.c.created_at <= now,
                        )
                    )
                ).scalar_one()
            )
            meta_day = (
                await connection.execute(
                    select(
                        func.count(),
                        func.count().filter(runtime_events.c.success),
                        func.coalesce(func.max(runtime_events.c.seq), 0),
                    ).where(
                        runtime_events.c.source == "meta",
                        runtime_events.c.created_at >= start,
                        runtime_events.c.created_at <= now,
                        runtime_events.c.count > 0,
                    )
                )
            ).one()
            if meta_day[0] and meta_day[1] / meta_day[0] < 0.7:
                snapshot.alerts.append(
                    Alert(
                        f"meta-rate:{start.date()}",
                        "meta_success_rate",
                        "当日 Meta 采集成功率低于 70%，请检查访问限制和采集器。",
                        f"meta-rate:{start.date()}:{meta_day[2]}",
                    )
                )
            for source in COLLECTORS:
                last_success = (
                    select(func.coalesce(func.max(runtime_events.c.seq), 0))
                    .where(
                        runtime_events.c.source == source,
                        runtime_events.c.success,
                        runtime_events.c.count > 0,
                    )
                    .scalar_subquery()
                )
                failures = (
                    await connection.execute(
                        select(
                            func.count(),
                            func.min(runtime_events.c.seq),
                        ).where(
                            runtime_events.c.source == source,
                            runtime_events.c.seq > last_success,
                            ~runtime_events.c.success,
                            runtime_events.c.count > 0,
                        )
                    )
                ).one()
                if failures[0] >= 5:
                    snapshot.alerts.append(
                        Alert(
                            f"failure:{source}",
                            "collector_failures",
                            f"{source} 采集器已连续失败至少 5 次。",
                            f"failure:{source}:{failures[1]}",
                        )
                    )
        return snapshot


class AlertSink(Protocol):
    async def emit_alert(
        self,
        key: str,
        code: str,
        message: str,
        created_at: datetime,
        last_seen: datetime,
        occurrence_count: int,
    ) -> None: ...


class Monitor:
    """Persist alert incidents and deliver each unseen occurrence exactly once.

    ``alert.key`` is the stable identity of the Feishu 搜索批次 row while
    ``alert.event_fingerprint`` identifies a distinct threshold crossing.  A
    monitor tick may update ``last_seen`` but never increments the occurrence
    count unless that fingerprint changes.
    """

    def __init__(self, telemetry: Telemetry, sink: AlertSink):
        self.telemetry, self.sink = telemetry, sink

    async def tick(self) -> None:
        await self.telemetry.heartbeat()
        snapshot = await self.telemetry.snapshot()
        async with session_lock(self.telemetry.database, 771124881, wait=True):
            await self._deliver(snapshot)

    async def _deliver(self, snapshot: OperationalSnapshot) -> None:
        async with self.telemetry.transaction() as connection:
            # One scheduler holds this lock; multiple workers never duplicate a send.
            for alert in snapshot.alerts:
                key = hashlib.sha256(alert.key.encode()).hexdigest()
                fingerprint = hashlib.sha256(
                    alert.event_fingerprint.encode()
                ).hexdigest()
                now = self.telemetry.clock.now()
                existing = (
                    (
                        await connection.execute(
                            select(runtime_alerts).where(
                                runtime_alerts.c.alert_key == key
                            )
                        )
                    )
                    .mappings()
                    .first()
                )
                if existing is None:
                    await connection.execute(
                        dialect_insert(connection, runtime_alerts).values(
                            alert_key=key,
                            code=alert.code,
                            message=alert.message,
                            first_seen=now,
                            last_seen=now,
                            occurrence_count=1,
                            sent_count=0,
                            event_fingerprint=fingerprint,
                        )
                    )
                elif existing["event_fingerprint"] == fingerprint:
                    # The incident remains active, but this is only another
                    # observation of the same event—not another occurrence.
                    await connection.execute(
                        update(runtime_alerts)
                        .where(runtime_alerts.c.alert_key == key)
                        .values(last_seen=now, code=alert.code, message=alert.message)
                    )
                else:
                    await connection.execute(
                        update(runtime_alerts)
                        .where(runtime_alerts.c.alert_key == key)
                        .values(
                            last_seen=now,
                            occurrence_count=runtime_alerts.c.occurrence_count + 1,
                            event_fingerprint=fingerprint,
                            code=alert.code,
                            message=alert.message,
                        )
                    )
            pending = await connection.execute(
                select(runtime_alerts)
                .where(
                    runtime_alerts.c.sent_count < runtime_alerts.c.occurrence_count,
                )
                .order_by(runtime_alerts.c.first_seen)
                .limit(100)
            )
            pending_rows = pending.all()
        for row in pending_rows:
            try:
                await self.sink.emit_alert(
                    row.alert_key,
                    row.code,
                    row.message,
                    row.first_seen,
                    row.last_seen,
                    row.occurrence_count,
                )
            except Exception:  # noqa: BLE001 -- retain durable pending alert on any sink failure
                # Keep the same incident pending across failed Feishu calls/restarts.
                logging.getLogger(__name__).warning(
                    "runtime_alert_delivery_pending"
                )
                continue
            async with self.telemetry.transaction() as connection:
                await connection.execute(
                    update(runtime_alerts)
                    .where(
                        runtime_alerts.c.alert_key == row.alert_key,
                    )
                    .values(sent_count=row.occurrence_count)
                )


def render_metrics(snapshot: OperationalSnapshot) -> bytes:
    class Collector:
        def collect(self) -> Any:
            queue = GaugeMetricFamily(
                "job_queue_depth", "Runtime queue jobs", labels=["status"]
            )
            for status in ("ready", "delayed", "running"):
                queue.add_metric([status], snapshot.queue.get(status, 0))
            yield queue
            for success, name in (
                (True, "collector_success"),
                (False, "collector_failure"),
            ):
                metric = CounterMetricFamily(
                    name, "Completed source calls", labels=["source"]
                )
                for source in COLLECTORS:
                    metric.add_metric(
                        [source], snapshot.totals.get((source, success), 0)
                    )
                yield metric
            for name, value in (
                ("meta_recovery", snapshot.recoveries),
                ("meta_captcha", snapshot.captchas),
                ("ai_schema_failure", snapshot.schema_failures),
            ):
                yield CounterMetricFamily(name, "Operational events", value=value)
            yield HistogramMetricFamily(
                "job_duration_seconds",
                "Completed job duration",
                buckets=snapshot.duration_buckets,
                sum_value=snapshot.duration_sum,
            )
            yield GaugeMetricFamily(
                "feishu_outbox_depth",
                "Pending Feishu events",
                value=snapshot.outbox_depth,
            )
            yield GaugeMetricFamily(
                "feishu_outbox_oldest_age_seconds",
                "Oldest pending event age",
                value=snapshot.outbox_age,
            )
            yield GaugeMetricFamily(
                "daily_candidates",
                "New candidates since 00:00 UTC",
                value=snapshot.daily_candidates,
            )

    registry = CollectorRegistry()
    registry.register(Collector())
    return generate_latest(registry)
