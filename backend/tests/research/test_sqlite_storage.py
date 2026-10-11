"""Real SQLite concurrency, UTC, durability and process ownership."""
import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text

from rabbit_hole.config import Settings
from rabbit_hole.persistence.database import create_database_engine
from rabbit_hole.persistence.projects import WorkbenchStore


@pytest.fixture
async def sqlite_engine(tmp_path):
    from rabbit_hole.persistence.sql import initialize_sqlite
    engine = create_database_engine(type("Settings", (), {"database_url": f"sqlite+aiosqlite:///{tmp_path}/test.db"})())
    await initialize_sqlite(engine)
    try:
        yield engine
    finally:
        await engine.dispose()


async def test_sqlite_concurrent_project_commands_keep_versions_and_utc(sqlite_engine):
    from rabbit_hole.domain.project import WorkbenchError
    store = WorkbenchStore(sqlite_engine)
    project = await store.create("isolated", "test", "US", str(uuid4()))
    async def change(word):
        try:
            return await store.command(project["id"], project["version"], str(uuid4()), "add_keyword", {"text": word, "type": "function"})
        except WorkbenchError as exc:
            return exc.code
    results = await asyncio.gather(change("pet"), change("travel"))
    assert sum(isinstance(r, dict) for r in results) == 1
    updated = await store.get(project["id"])
    assert len(updated["keywords"]) == 1
    assert updated["version"] == project["version"] + 1
    from rabbit_hole.persistence.projects import workbench_projects
    async with sqlite_engine.connect() as c:
        stamp = await c.scalar(select(workbench_projects.c.created_at))
        assert stamp.tzinfo is not None
        assert await c.scalar(text("PRAGMA journal_mode")) == "wal"


async def test_sqlite_worker_exclusive_shutdown_and_restart(sqlite_engine):
    from rabbit_hole.runtime.workbench_worker import WorkerAlreadyRunning, is_worker_live, serve_workbench
    class Loop:
        def __init__(self):
            self.started = asyncio.Event()
        async def loop(self):
            self.started.set()
            await asyncio.Event().wait()
    runner, sync, stop = Loop(), Loop(), asyncio.Event()
    first = asyncio.create_task(serve_workbench(sqlite_engine, runner, sync, stop=stop, heartbeat_seconds=.02))
    try:
        await asyncio.wait_for(runner.started.wait(), 3)
        assert await is_worker_live(sqlite_engine)
        with pytest.raises(WorkerAlreadyRunning):
            await serve_workbench(sqlite_engine, Loop(), Loop())
    finally:
        stop.set()
        await first
    assert not await is_worker_live(sqlite_engine)
    stop2 = asyncio.Event()
    stop2.set()
    await serve_workbench(sqlite_engine, Loop(), Loop(), stop=stop2)


async def test_sqlite_logs_roundtrip_uuid_cursor(sqlite_engine):
    from rabbit_hole.application.actions import actions
    from rabbit_hole.integrations.provider_jobs import append_log, read_logs
    from rabbit_hole.persistence.sql import write_transaction
    now = datetime.now(UTC)
    pid, aid = str(uuid4()), str(uuid4())
    async with write_transaction(sqlite_engine) as c:
        await c.execute(actions.insert().values(id=UUID(aid), project_id=UUID(pid), kind="scan", status="running", input_version=0,
            payload={"keyword_text":"pet", "execution_mode":"api"}, dedupe_key="isolated", created_at=now,updated_at=now,attempt=1))
    await append_log(sqlite_engine, pid, aid, 1, "read", "safe log")
    rows = await read_logs(sqlite_engine,pid,0)
    assert len(rows) == 1 and rows[0]["keyword_text"] == "pet"
    assert rows[0]["action_id"] == aid
    assert rows[0]["created_at"].endswith("+00:00")
    assert not await read_logs(sqlite_engine,pid,rows[0]["id"])


async def test_sqlite_lock_separate_process_crash_releases(sqlite_engine):
    import os
    import subprocess
    import sys
    from rabbit_hole.persistence.sql import session_lock
    db = str(sqlite_engine.url)
    script = """import asyncio,sys,os
from rabbit_hole.persistence.sql import create_engine,session_lock
async def main():
 e=create_engine(sys.argv[1])
 async with session_lock(e,123) as acquired:
  print('owned' if acquired else 'busy',flush=True)
  if acquired: await asyncio.Event().wait()
asyncio.run(main())
"""
    process = subprocess.Popen([sys.executable,"-c",script,db],stdout=subprocess.PIPE,text=True)
    try:
        assert await asyncio.to_thread(process.stdout.readline) == "owned\n"
        async with session_lock(sqlite_engine,123) as acquired:
            assert acquired is False
    finally:
        process.kill()
        await asyncio.to_thread(process.wait)
    async with session_lock(sqlite_engine,123) as acquired:
        assert acquired is True

async def test_sqlite_concurrent_queue_claims_are_unique(sqlite_engine):
    from datetime import timedelta
    from rabbit_hole.domain.legacy import JobKind, JobPayload
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    repo=JobRepository(sqlite_engine)
    first=await repo.enqueue(JobPayload(kind=JobKind.KEYWORD_SCAN,record_id="one",input_version="v1"))
    second=await repo.enqueue(JobPayload(kind=JobKind.KEYWORD_SCAN,record_id="two",input_version="v1"))
    claimed=await asyncio.gather(repo.lease_next("one",lease_for=timedelta(minutes=5)),
                                 repo.lease_next("two",lease_for=timedelta(minutes=5)))
    assert {job.id for job in claimed} == {first.id,second.id}

async def test_sqlite_startup_rejects_unverified_migration(tmp_path):
    from rabbit_hole.persistence.sql import create_engine,initialize_sqlite
    (tmp_path/".migration-required").write_text("verified migration required")
    engine=create_engine("sqlite+aiosqlite:///"+str(tmp_path/"partial.db"))
    try:
        with pytest.raises(ValueError,match="migration"):
            await initialize_sqlite(engine)
    finally:
        await engine.dispose()

async def test_sqlite_database_files_are_private(sqlite_engine):
    from pathlib import Path
    async with sqlite_engine.connect() as c:
        await c.execute(text("SELECT 1"))
        for path in Path(sqlite_engine.url.database).parent.glob("test.db*"):
            assert path.stat().st_mode & 0o777 == 0o600

async def test_sqlite_cache_miss_rejects_caller_transaction(sqlite_engine):
    from rabbit_hole.extraction import PostgresExtractionCache, ExtractionCacheKey
    from rabbit_hole.persistence.sql import write_transaction
    called = False
    async def factory():
        nonlocal called
        called = True
        raise AssertionError("network factory must not run under a write lock")
    async with write_transaction(sqlite_engine) as c:
        with pytest.raises(ValueError, match="transaction"):
            await PostgresExtractionCache(c).get_or_create(
                ExtractionCacheKey("hash", "model", "prompt"), factory)
    assert called is False
