"""The workbench runs outside the API with a durable, exclusive worker lease."""
import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from rabbit_hole.monitoring import runtime_health


async def test_worker_owns_one_lock_and_removes_heartbeat_on_shutdown(db_engine):
    from rabbit_hole.runtime.workbench_worker import (
        WorkerAlreadyRunning,
        is_worker_live,
        serve_workbench,
    )

    class Loop:
        def __init__(self):
            self.started = asyncio.Event()
            self.closed = asyncio.Event()

        async def loop(self):
            self.started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.closed.set()

    runner, sync, stop = Loop(), Loop(), asyncio.Event()
    task = asyncio.create_task(serve_workbench(db_engine, runner, sync, stop=stop, heartbeat_seconds=0.02))
    try:
        await asyncio.wait_for(runner.started.wait(), 2)
        await asyncio.wait_for(sync.started.wait(), 2)
        assert await is_worker_live(db_engine)
        with pytest.raises(WorkerAlreadyRunning):
            await serve_workbench(db_engine, Loop(), Loop(), stop=asyncio.Event())
        assert not task.done()
    finally:
        stop.set()
        await asyncio.wait_for(task, 3)
    assert runner.closed.is_set() and sync.closed.is_set()
    assert not await is_worker_live(db_engine)
    # Lock must be released so the restart can claim it immediately.
    restarted = asyncio.Event()
    restarted.set()
    await serve_workbench(db_engine, Loop(), Loop(), stop=restarted)


async def test_worker_health_rejects_stale_and_future_heartbeat(db_engine):
    from rabbit_hole.runtime.workbench_worker import is_worker_live

    async with db_engine.begin() as c:
        await c.execute(runtime_health.insert().values(component="workbench_worker", updated_at=datetime.now(UTC)))
    try:
        assert await is_worker_live(db_engine)
        for stamp in [datetime.now(UTC) - timedelta(minutes=2), datetime.now(UTC) + timedelta(minutes=2)]:
            async with db_engine.begin() as c:
                await c.execute(update(runtime_health).where(runtime_health.c.component == "workbench_worker").values(updated_at=stamp))
            assert not await is_worker_live(db_engine)
    finally:
        async with db_engine.begin() as c:
            await c.execute(runtime_health.delete().where(runtime_health.c.component == "workbench_worker"))


async def test_worker_failure_cancels_other_loop_and_clears_heartbeat(db_engine):
    from rabbit_hole.runtime.workbench_worker import is_worker_live, serve_workbench

    closed = asyncio.Event()
    class Failure:
        async def loop(self):
            raise RuntimeError("isolated failure")

    class Waiting:
        async def loop(self):
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()

    with pytest.raises(ExceptionGroup):
        await serve_workbench(db_engine, Failure(), Waiting())
    assert closed.is_set()
    assert not await is_worker_live(db_engine)


async def test_api_lifespan_does_not_start_business_tasks(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from rabbit_hole.runtime import server

    settings = SimpleNamespace(feishu_app_id="test", feishu_app_secret="test",
        feishu_base_app_token="test", s3_endpoint="http://storage.test",
        s3_access_key="test", s3_secret_key="test", s3_bucket="test",
        openai_api_key="", openai_model="")
    engine = Mock()
    engine.dispose = AsyncMock()
    feishu = Mock()
    feishu.base_token = 'isolated-test'
    feishu.aclose = AsyncMock()
    monkeypatch.setattr(server, "get_settings", lambda: settings)
    monkeypatch.setattr(server, "create_database_engine", lambda _: engine)
    monkeypatch.setattr(server, "FeishuClient", lambda *args: feishu)
    monkeypatch.setattr(server, "create_storage_client", lambda settings: Mock())
    app = server.create_app()
    async with app.router.lifespan_context(app):
        assert app.state.workbench_store is not None
        assert app.state.workbench_sync is not None
        assert not any(task.get_name() in {"business-actions", "business-sync", "workbench-actions", "workbench-sync"} for task in asyncio.all_tasks())
    engine.dispose.assert_awaited_once()
    feishu.aclose.assert_awaited_once()

async def test_lost_lock_connection_stops_loops_without_deleting_standby_heartbeat(db_engine):
    if db_engine.dialect.name != "postgresql":
        pytest.skip("PostgreSQL connection-loss case; SQLite process-crash ownership covered separately")
    from sqlalchemy import text

    from rabbit_hole.runtime.workbench_worker import (
        LOCK_KEY,
        is_worker_live,
        serve_workbench,
    )

    class Waiting:
        def __init__(self):
            self.started = asyncio.Event()
            self.closed = asyncio.Event()
        async def loop(self):
            self.started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.closed.set()

    first_runner, first_sync = Waiting(), Waiting()
    first = asyncio.create_task(serve_workbench(db_engine, first_runner, first_sync, heartbeat_seconds=0.05))
    await asyncio.wait_for(first_runner.started.wait(), 2)
    async with db_engine.begin() as c:
        pid = await c.scalar(text("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=:key AND objsubid=1 AND granted"), {"key": LOCK_KEY})
        assert pid is not None
        assert await c.scalar(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid})

    stop = asyncio.Event()
    second_runner, second_sync = Waiting(), Waiting()
    second = asyncio.create_task(serve_workbench(db_engine, second_runner, second_sync, stop=stop, heartbeat_seconds=0.02))
    try:
        await asyncio.wait_for(second_runner.started.wait(), 2)
        with pytest.raises(ExceptionGroup):
            await asyncio.wait_for(first, 2)
        assert first_runner.closed.is_set() and first_sync.closed.is_set()
        assert await is_worker_live(db_engine)
    finally:
        stop.set()
        await asyncio.wait_for(second, 3)
        if not first.done():
            first.cancel()
    assert not await is_worker_live(db_engine)
