"""Independent collection and user-requested sync process."""
from __future__ import annotations

import asyncio
import signal
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncEngine

from rabbit_hole.application.runner import WorkbenchRunner
from rabbit_hole.application.sync import WorkbenchSync
from rabbit_hole.config import get_settings
from rabbit_hole.integrations.feishu import FeishuClient
from rabbit_hole.monitoring import runtime_health
from rabbit_hole.persistence.database import create_database_engine
from rabbit_hole.persistence.evidence_store import EvidenceStore
from rabbit_hole.persistence.projects import WorkbenchStore
from rabbit_hole.persistence.storage_factory import create_storage_client

COMPONENT = "workbench_worker"
LOCK_KEY = 727481063


class WorkerAlreadyRunning(RuntimeError):
    """Another process owns this workbench runtime."""


class LoopService(Protocol):
    async def loop(self) -> None: ...


async def is_worker_live(engine: AsyncEngine, *, max_age: float = 60) -> bool:
    async with engine.connect() as c:
        stamp = await c.scalar(select(runtime_health.c.updated_at).where(runtime_health.c.component == COMPONENT))
    return stamp is not None and 0 <= (datetime.now(UTC) - stamp).total_seconds() <= max_age


async def serve_workbench(
    engine: AsyncEngine, runner: LoopService | None = None, sync: LoopService | None = None,
    *, service_factory: Callable[[], tuple[LoopService, LoopService]] | None = None, stop: asyncio.Event | None = None, heartbeat_seconds: float = 15,
) -> None:
    """Hold a session lock and cancel both loops on shutdown or lock failure."""
    if engine.dialect.name == "postgresql":
        await _serve_postgres(engine, runner, sync, service_factory=service_factory, stop=stop, heartbeat_seconds=heartbeat_seconds)
        return
    from rabbit_hole.persistence.sql import (
        dialect_insert,
        session_lock,
        write_transaction,
    )
    stopped = stop if stop is not None else asyncio.Event()
    async with session_lock(engine, LOCK_KEY) as owned:
        if not owned:
            raise WorkerAlreadyRunning("workbench_worker_already_running")
        if service_factory is not None:
            runner, sync = service_factory()
        if runner is None or sync is None:
            raise ValueError("worker services are required")
        async def heartbeat() -> None:
            async with write_transaction(engine) as c:
                stmt = dialect_insert(c, runtime_health).values(component=COMPONENT, updated_at=datetime.now(UTC))
                await c.execute(stmt.on_conflict_do_update(index_elements=[runtime_health.c.component], set_={"updated_at":stmt.excluded.updated_at}))
        async def heartbeat_loop() -> None:
            while True:
                await asyncio.sleep(heartbeat_seconds)
                await heartbeat()
        try:
            await heartbeat()
            async with asyncio.TaskGroup() as group:
                tasks = [group.create_task(runner.loop(), name="workbench-actions"),
                         group.create_task(sync.loop(), name="workbench-sync"),
                         group.create_task(heartbeat_loop(), name="workbench-heartbeat")]
                try:
                    await stopped.wait()
                finally:
                    for task in tasks:
                        task.cancel()
        finally:
            async with write_transaction(engine) as c:
                await c.execute(delete(runtime_health).where(runtime_health.c.component == COMPONENT))


async def _serve_postgres(
    engine: AsyncEngine, runner: LoopService | None, sync: LoopService | None,
    *, service_factory: Callable[[], tuple[LoopService, LoopService]] | None,
    stop: asyncio.Event | None, heartbeat_seconds: float,
) -> None:
    stopped = stop if stop is not None else asyncio.Event()
    async with engine.connect() as lock:
        claimed = await lock.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": LOCK_KEY})
        await lock.commit()
        if not claimed:
            raise WorkerAlreadyRunning("workbench_worker_already_running")

        async def heartbeat() -> None:
            # A lost lock-owning connection must stop the collectors.
            await lock.execute(text("SELECT 1"))
            await lock.commit()
            async with engine.begin() as c:
                stmt = insert(runtime_health).values(component=COMPONENT, updated_at=datetime.now(UTC))
                await c.execute(stmt.on_conflict_do_update(index_elements=[runtime_health.c.component], set_={"updated_at": stmt.excluded.updated_at}))

        async def heartbeat_loop() -> None:
            while True:
                await asyncio.sleep(heartbeat_seconds)
                await heartbeat()

        try:
            if service_factory is not None:
                runner, sync = service_factory()
            if runner is None or sync is None:
                raise ValueError("worker services are required")
            await heartbeat()
            async with asyncio.TaskGroup() as group:
                tasks = [
                    group.create_task(runner.loop(), name="workbench-actions"),
                    group.create_task(sync.loop(), name="workbench-sync"),
                    group.create_task(heartbeat_loop(), name="workbench-heartbeat"),
                ]
                try:
                    await stopped.wait()
                finally:
                    for task in tasks:
                        task.cancel()
        finally:
            # Cleanup before releasing ownership, never after a standby starts.
            if not lock.invalidated:
                # Verify ownership before deleting: a failed heartbeat may have
                # lost its DB session while a standby already claimed the lock.
                owns = await lock.scalar(text(
                    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' "
                    "AND pid=pg_backend_pid() AND classid=0 AND objid=:key "
                    "AND objsubid=1 AND granted)"
                ), {"key": LOCK_KEY})
                await lock.commit()
                if owns:
                    try:
                        async with engine.begin() as c:
                            await c.execute(delete(runtime_health).where(runtime_health.c.component == COMPONENT))
                    finally:
                        await lock.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": LOCK_KEY})
                        await lock.commit()


async def run_workbench_worker() -> None:
    settings = get_settings()
    engine = create_database_engine(settings)
    from rabbit_hole.persistence.sql import initialize_sqlite
    await initialize_sqlite(engine)
    s3 = create_storage_client(settings)
    feishu = FeishuClient(settings.feishu_app_id, settings.feishu_app_secret, settings.feishu_base_app_token)
    store = WorkbenchStore(engine)
    runner = WorkbenchRunner(store, settings,
        lambda: EvidenceStore(s3, bucket=settings.s3_bucket, collector_version="workbench-v2"))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await serve_workbench(engine, runner, WorkbenchSync(store, feishu), stop=stop)
    finally:
        await feishu.aclose()
        s3.close()
        await engine.dispose()


async def healthcheck() -> bool:
    engine = create_database_engine(get_settings())
    try:
        async with asyncio.timeout(5):
            return await is_worker_live(engine)
    finally:
        await engine.dispose()


def main() -> int:
    try:
        if sys.argv[1:] == ["health"]:
            return 0 if asyncio.run(healthcheck()) else 1
        asyncio.run(run_workbench_worker())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:  # noqa: BLE001 -- never print provider credentials/payloads
        print("workbench_worker_failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
