from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select

from rabbit_hole.domain.project import WorkbenchError
from rabbit_hole.persistence.projects import (
    WorkbenchStore,
    workbench_events,
    workbench_projects,
)


@pytest.fixture(autouse=True)
async def clean_workbench(db_engine):
    async with db_engine.begin() as connection:
        await connection.execute(delete(workbench_events))
        await connection.execute(delete(workbench_projects))


@pytest.fixture
def store(db_engine):
    return WorkbenchStore(db_engine)


async def test_create_get_list_are_durable_full_views(store, db_engine):
    command_id = str(uuid4())
    created = await store.create("Travel", "Packing", "US", command_id)
    reopened = WorkbenchStore(db_engine)

    fetched = await reopened.get(created["id"])
    listed = await reopened.list_projects()

    assert fetched == created
    assert listed == [created]
    assert fetched["events"][0]["action"] == "create"


async def test_create_idempotency_rejects_reused_id_with_different_body(store):
    command_id = str(uuid4())
    first = await store.create("Travel", "Packing", "US", command_id)
    duplicate = await store.create("Travel", "Packing", "US", command_id)
    assert duplicate == first
    with pytest.raises(WorkbenchError) as raised:
        await store.create("Kitchen", "Storage", "US", command_id)
    assert raised.value.code == "idempotency_conflict"
    assert raised.value.status == 409


async def test_command_idempotency_and_version_conflict(store, db_engine):
    project = await store.create("Travel", "Packing", "US", str(uuid4()))
    command_id = str(uuid4())
    payload = {"text": "packing cubes", "type": "category"}
    first = await store.command(project["id"], 0, command_id, "add_keyword", payload)
    duplicate = await store.command(
        project["id"], 0, command_id, "add_keyword", payload
    )
    assert duplicate == first
    assert len(duplicate["keywords"]) == 1
    async with db_engine.connect() as connection:
        count = await connection.scalar(
            select(func.count()).select_from(workbench_events)
        )
    assert count == 2

    with pytest.raises(WorkbenchError) as mismatch:
        await store.command(
            project["id"],
            1,
            command_id,
            "add_keyword",
            {"text": "bags", "type": "category"},
        )
    assert mismatch.value.code == "idempotency_conflict"
    with pytest.raises(WorkbenchError) as stale:
        await store.command(
            project["id"],
            0,
            str(uuid4()),
            "add_keyword",
            {"text": "bags", "type": "category"},
        )
    assert stale.value.code == "version_conflict"
    assert stale.value.status == 409


async def test_triage_command_retry_does_not_duplicate_history(store):
    project = await store.create("Travel", "Packing", "US", str(uuid4()))
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_product",
        {"name": "Travel pouch", "url": "https://shop.example/p/pouch"},
    )
    product_id = project["products"][0]["id"]
    command_id = str(uuid4())
    payload = {
        "product_id": product_id,
        "disposition": "rejected",
        "reason": "广告与商品无关",
    }
    first = await store.command(
        project["id"], project["version"], command_id, "triage_product", payload
    )
    duplicate = await store.command(
        project["id"], project["version"], command_id, "triage_product", payload
    )
    assert duplicate == first
    assert len(duplicate["products"][0]["triage"]["history"]) == 1


async def test_concurrent_versions_allow_exactly_one_writer(store):
    project = await store.create("Travel", "Packing", "US", str(uuid4()))

    async def add(text):
        try:
            return await store.command(
                project["id"],
                0,
                str(uuid4()),
                "add_keyword",
                {"text": text, "type": "category"},
            )
        except WorkbenchError as exc:
            return exc

    results = await asyncio.gather(add("packing cubes"), add("travel bags"))
    assert (
        sum(
            isinstance(result, WorkbenchError) and result.status == 409
            for result in results
        )
        == 1
    )
    assert sum(isinstance(result, dict) for result in results) == 1


async def test_failed_command_rolls_back_project_and_event(store, db_engine):
    project = await store.create("Travel", "Packing", "US", str(uuid4()))
    with pytest.raises(WorkbenchError):
        await store.command(
            project["id"],
            0,
            str(uuid4()),
            "add_product",
            {"name": "bad", "url": "file:///etc/passwd"},
        )
    fetched = await store.get(project["id"])
    assert fetched["version"] == 0
    assert fetched["products"] == []
    async with db_engine.connect() as connection:
        count = await connection.scalar(
            select(func.count()).select_from(workbench_events)
        )
    assert count == 1


async def test_missing_project_is_404_and_reads_do_not_write(store, db_engine):
    with pytest.raises(WorkbenchError) as raised:
        await store.get(str(uuid4()))
    assert raised.value.status == 404
    project = await store.create("Travel", "Packing", "US", str(uuid4()))
    async with db_engine.connect() as connection:
        before = await connection.scalar(
            select(func.count()).select_from(workbench_events)
        )
    await store.get(project["id"])
    await store.list_projects()
    async with db_engine.connect() as connection:
        after = await connection.scalar(
            select(func.count()).select_from(workbench_events)
        )
    assert after == before


async def test_old_runtime_tables_remain_available_after_workbench_migration(db_engine):
    async with db_engine.connect() as connection:
        tables = set(
            (
                await connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type='table'" if db_engine.dialect.name == "sqlite" else "SELECT tablename FROM pg_tables WHERE schemaname='public'"
                )
            ).scalars()
        )
    assert {
        "runtime_jobs",
        "daily_usage",
        "workbench_projects",
        "workbench_events",
        "workbench_actions",
    } <= tables


async def test_evidence_action_cursor_index_matches_keyset_order(db_engine):
    async with db_engine.connect() as connection:
        definition = (
            await connection.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name='ix_workbench_actions_project_created_id'" if db_engine.dialect.name == "sqlite" else """
                SELECT indexdef
                FROM pg_indexes
                WHERE schemaname = 'public'
                  AND indexname = 'ix_workbench_actions_project_created_id'
                """
            )
        ).scalar_one_or_none()

    assert definition is not None
    assert "(project_id, created_at DESC, id DESC)" in definition


async def test_delete_project_is_versioned_confirmed_and_removes_only_target(store):
    project = await store.create("Remove me", "Packing", "US", str(uuid4()))
    other = await store.create("Keep me", "Kitchen", "US", str(uuid4()))
    with pytest.raises(WorkbenchError):
        await store.delete_project(project["id"], project["version"], "wrong title")
    with pytest.raises(WorkbenchError) as conflict:
        await store.delete_project(project["id"], project["version"] + 1, project["title"])
    assert conflict.value.status == 409
    result = await store.delete_project(project["id"], project["version"], project["title"])
    assert result["deleted"] is True
    assert await store.delete_project(project["id"], project["version"], project["title"]) == result
    with pytest.raises(WorkbenchError) as missing:
        await store.get(project["id"])
    assert missing.value.status == 404
    assert [p["id"] for p in await store.list_projects()] == [other["id"]]


@pytest.mark.parametrize("kind", ["action", "sync"])
async def test_delete_project_refuses_active_work(store, kind):
    from datetime import UTC, datetime

    from sqlalchemy import insert

    from rabbit_hole.application.actions import enqueue_action
    from rabbit_hole.application.sync import runs
    project = await store.create("Busy", "Packing", "US", str(uuid4()))
    if kind == "action":
        await enqueue_action(store, project["id"], {"kind": "keywords", "version": project["version"]})
        project = await store.get(project["id"])
    else:
        async with store.engine.begin() as conn:
            await conn.execute(insert(runs).values(id=str(uuid4()), project_id=project["id"], version=project["version"], target="test", digest="test", snapshot={}, checkpoint={}, message="", status="ready", updated_at=datetime.now(UTC)))
    with pytest.raises(WorkbenchError) as busy:
        await store.delete_project(project["id"], project["version"], project["title"])
    assert busy.value.code == "project_busy"
    assert (await store.get(project["id"]))["title"] == "Busy"
    from sqlalchemy import update
    from uuid import UUID
    from rabbit_hole.application.actions import actions
    table = actions if kind == "action" else runs
    value = UUID(project["id"]) if kind == "action" else project["id"]
    async with store.engine.begin() as conn:
        await conn.execute(update(table).where(table.c.project_id == value).values(status="blocked"))
    await store.delete_project(project["id"], project["version"], project["title"])



async def test_delete_cleans_finished_actions_logs_and_sync_history(store):
    from datetime import UTC, datetime
    from uuid import UUID

    from sqlalchemy import insert, select, func, update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.sync import runs
    from rabbit_hole.integrations.provider_jobs import provider_logs
    from rabbit_hole.persistence.projects import workbench_events
    project = await store.create("History", "Packing", "US", str(uuid4()))
    action = await enqueue_action(store, project["id"], {"kind": "keywords", "version": project["version"]})
    async with store.engine.begin() as conn:
        await conn.execute(update(actions).where(actions.c.id == UUID(action["id"])).values(status="complete"))
        await conn.execute(insert(provider_logs).values(project_id=UUID(project["id"]), action_id=UUID(action["id"]), attempt=1, stage="complete",message="done", level="info"))
        await conn.execute(insert(runs).values(id=str(uuid4()), project_id=project["id"], version=project["version"], target="test", digest="test", snapshot={}, checkpoint={}, message="", status="complete", updated_at=datetime.now(UTC)))
    project = await store.get(project["id"])
    await store.delete_project(project["id"], project["version"], project["title"])
    async with store.engine.connect() as conn:
        for table in (actions, provider_logs, runs, workbench_events):
            value = UUID(project["id"]) if table in (actions, provider_logs) else project["id"]
            assert await conn.scalar(select(func.count()).select_from(table).where(table.c.project_id == value)) == 0


async def test_enqueue_cannot_create_orphan_after_project_deletion(store, monkeypatch):
    from uuid import UUID

    from rabbit_hole.application.actions import actions, enqueue_action
    project = await store.create("Race", "Packing", "US", str(uuid4()))
    reached, resume = asyncio.Event(), asyncio.Event()
    original = store.get
    async def paused_get(project_id):
        result = await original(project_id)
        reached.set()
        await resume.wait()
        return result
    monkeypatch.setattr(store, "get", paused_get)
    task = asyncio.create_task(enqueue_action(store, project["id"], {"kind": "keywords", "version": project["version"]}))
    await asyncio.wait_for(reached.wait(), 3)
    await store.delete_project(project["id"], project["version"], project["title"])
    resume.set()
    with pytest.raises(WorkbenchError) as missing:
        await task
    assert missing.value.status == 404
    async with store.engine.connect() as conn:
        assert await conn.scalar(select(func.count()).select_from(actions).where(actions.c.project_id == UUID(project["id"]))) == 0
