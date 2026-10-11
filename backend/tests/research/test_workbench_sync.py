import json
from copy import deepcopy
from uuid import uuid4

import pytest

from rabbit_hole.persistence.projects import WorkbenchStore


class Remote:
    base_token = "isolated-test"

    def __init__(self):
        self.base_token = str(uuid4())
        self.tables = []
        self.fields = {}
        self.records = {}
        self.creates = 0
        self.fail_after_create = False

    async def list_tables(self):
        return deepcopy(self.tables)

    async def list_fields(self, table):
        return deepcopy(self.fields[table])

    async def list_records(self, table):
        return deepcopy(self.records[table])

    async def sync_create_table(self, name):
        key = "tbl" + str(len(self.tables))
        self.tables.append({"id": key, "name": name})
        self.fields[key] = []
        self.records[key] = []
        return key

    async def sync_create_field(self, table, definition):
        self.fields[table].append(deepcopy(definition))
        return "fld" + str(len(self.fields[table]))

    async def sync_create_record(self, table, cells):
        self.creates += 1
        key = "rec" + str(self.creates)
        self.records[table].append({"id": key, "fields": deepcopy(cells)})
        if self.fail_after_create:
            self.fail_after_create = False
            raise RuntimeError("secret_should_not_leak")
        return key


def test_feishu_business_rate_limit_is_transient_not_definitive():
    from rabbit_hole.application.sync import definitive_rejection, transient_failure
    from rabbit_hole.integrations.feishu import FeishuAPIError

    error = FeishuAPIError(200, {"code": 1254291, "msg": "concurrent write"})

    assert transient_failure(error) is True
    assert definitive_rejection(error) is False


def test_snapshot_defensively_removes_sensitive_url_parameters():
    from rabbit_hole.application.sync import snapshot

    project = {
        "id": "project-1",
        "version": 1,
        "title": "URL snapshot",
        "direction": "travel",
        "keywords": [],
        "todos": [],
        "rules_version": 1,
        "products": [
            {
                "id": "product-1",
                "name": "Product",
                "url": (
                    "https://shop.example/?p=123&token=SYNTHETIC_BEARER"
                    "&X-Amz-Signature=SYNTHETIC_SIGNATURE"
                ),
                "steps": [],
                "decision": None,
                "scores": [],
                "revision": 1,
            }
        ],
    }

    encoded = str(snapshot(project))

    assert "SYNTHETIC_BEARER" not in encoded
    assert "SYNTHETIC_SIGNATURE" not in encoded
    assert "https://shop.example/?p=123" in encoded


def test_snapshot_includes_triage_and_all_guided_funnel_counts():
    from rabbit_hole.application.sync import snapshot

    project = {
        "id": "project-funnel",
        "version": 3,
        "title": "Guided funnel",
        "direction": "travel",
        "keywords": [],
        "todos": [{"step": "identification"}],
        "rules_version": 1,
        "products": [
            {
                "id": "product-retained",
                "name": "Retained product",
                "url": "https://shop.example/p/a?token=SYNTHETIC_SYNC_SECRET",
                "triage": {
                    "state": "retained",
                    "reason": "商品相关，继续深挖",
                    "decided_at": "2026-09-20T08:00:00Z",
                    "operator": "local_user",
                    "history": [],
                },
                "identification": {"passed": False},
                "steps": [],
                "decision": None,
                "scores": [],
                "revision": 1,
                "test_runs": [],
                "test_results": [],
            }
        ],
    }

    rows = snapshot(project)
    project_summary = json.loads(rows[0]["cells"]["AUTO｜摘要"])
    product_summary = json.loads(rows[1]["cells"]["AUTO｜摘要"])

    assert project_summary["selection_funnel"] == {
        "discovered": 1,
        "pending": 0,
        "retained": 1,
        "observing": 0,
        "rejected": 0,
        "active_workload": 1,
        "coarse_passed": 0,
        "test_candidates": 0,
        "confirmed_tests": 0,
    }
    assert product_summary["triage"]["state"] == "retained"
    assert product_summary["triage"]["reason"] == "商品相关，继续深挖"
    assert "SYNTHETIC_SYNC_SECRET" not in str(rows)


async def test_preview_enqueue_and_restart_preserve_snapshot(db_engine):
    from rabbit_hole.application.sync import WorkbenchSync

    store, remote = WorkbenchStore(db_engine), Remote()
    project = await store.create("同步验收", "收纳", "US", str(uuid4()))
    sync = WorkbenchSync(store, remote)
    preview = await sync.preview(project["id"], project["version"])
    assert preview["records"] == 1 and remote.tables == []
    run = await sync.enqueue(project["id"], project["version"], preview["digest"])
    assert (await sync.enqueue(project["id"], project["version"], preview["digest"]))[
        "id"
    ] == run["id"]
    assert await sync.run_once()
    status = await WorkbenchSync(store, remote).status(project["id"])
    assert status[0]["status"] == "complete"
    assert remote.creates == 1
    assert all(table["name"].startswith("工作台V2｜") for table in remote.tables)
    assert all(
        key.startswith("AUTO｜")
        for records in remote.records.values()
        for row in records
        for key in row["fields"]
    )


async def test_ambiguous_create_is_reconciled_without_duplicate(db_engine):
    from rabbit_hole.application.sync import WorkbenchSync

    store, remote = WorkbenchStore(db_engine), Remote()
    project = await store.create("超时验收", "收纳", "US", str(uuid4()))
    sync = WorkbenchSync(store, remote)
    preview = await sync.preview(project["id"], 0)
    await sync.enqueue(project["id"], 0, preview["digest"])
    remote.fail_after_create = True
    await sync.run_once()
    assert "secret_should_not_leak" not in str(await sync.status(project["id"]))
    await sync.enqueue(project["id"], 0, preview["digest"])
    await sync.run_once()
    assert (await sync.status(project["id"]))[0]["status"] == "complete"
    assert remote.creates == 1


async def test_sync_rejects_changed_project_or_remote_schema(db_engine):
    from rabbit_hole.application.sync import WorkbenchSync
    from rabbit_hole.domain.project import WorkbenchError

    store, remote = WorkbenchStore(db_engine), Remote()
    project = await store.create("版本验收", "收纳", "US", str(uuid4()))
    sync = WorkbenchSync(store, remote)
    preview = await sync.preview(project["id"], 0)
    await store.command(
        project["id"],
        0,
        str(uuid4()),
        "add_keyword",
        {"text": "bag", "type": "category"},
    )
    with pytest.raises(WorkbenchError):
        await sync.enqueue(project["id"], 0, preview["digest"])
    key = await remote.sync_create_table("工作台V2｜项目快照")
    remote.fields[key] = [{"name": "AUTO｜快照键", "type": "number"}]
    with pytest.raises(WorkbenchError):
        await sync.preview(project["id"], 1)


async def test_ambiguous_invisible_create_blocks_other_project_too(db_engine):
    from rabbit_hole.application.sync import WorkbenchSync

    class Invisible(Remote):
        calls = 0

        async def sync_create_table(self, name):
            self.calls += 1
            raise TimeoutError("ambiguous")

    store, remote = WorkbenchStore(db_engine), Invisible()
    remote.base_token = str(uuid4())
    sync = WorkbenchSync(store, remote)
    for _ in range(2):
        project = await store.create("不确定写入", "收纳", "US", str(uuid4()))
        preview = await sync.preview(project["id"], 0)
        await sync.enqueue(project["id"], 0, preview["digest"])
        await sync.run_once()
        assert (await sync.status(project["id"]))[0]["status"] == "blocked"
    assert remote.calls == 1


async def test_sync_transient_reads_have_bounded_durable_retry(db_engine):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from rabbit_hole.application.sync import WorkbenchSync, runs
    from rabbit_hole.integrations.feishu import FeishuAPIError

    class Unavailable(Remote):
        fail = False

        async def list_tables(self):
            if self.fail:
                raise FeishuAPIError(503, {"code": 123, "secret": "synthetic-secret"})
            return await super().list_tables()

    store, remote = WorkbenchStore(db_engine), Unavailable()
    p = await store.create("retry", "test", "US", str(uuid4()))
    sync = WorkbenchSync(store, remote)
    preview = await sync.preview(p["id"], 0)
    run = await sync.enqueue(p["id"], 0, preview["digest"])
    remote.fail = True
    for attempt in range(1, 5):
        assert await sync.run_once()
        status = (await sync.status(p["id"]))[0]
        assert status["attempt_count"] == attempt
        assert "synthetic-secret" not in str(status)
        if attempt < 4:
            assert status["status"] == "retry_wait"
            assert status["next_attempt_at"] is not None
            assert await sync.run_once() is False
            async with db_engine.begin() as c:
                await c.execute(
                    update(runs)
                    .where(runs.c.id == run["id"])
                    .values(next_attempt_at=datetime.now(UTC) - timedelta(seconds=1))
                )
        else:
            assert status["status"] == "blocked"
            assert status["next_attempt_at"] is None
    remote.fail = False
    await sync.enqueue(p["id"], 0, preview["digest"])
    assert await sync.run_once()
    recovered = (await sync.status(p["id"]))[0]
    assert recovered["status"] == "complete", recovered


async def test_sync_business_rate_limit_uses_durable_retry(db_engine):
    from rabbit_hole.application.sync import WorkbenchSync
    from rabbit_hole.integrations.feishu import FeishuAPIError

    class RateLimited(Remote):
        fail = False

        async def list_tables(self):
            if self.fail:
                raise FeishuAPIError(200, {"code": 1254291, "msg": "concurrent write"})
            return await super().list_tables()

    store, remote = WorkbenchStore(db_engine), RateLimited()
    p = await store.create("rate-limit", "test", "US", str(uuid4()))
    sync = WorkbenchSync(store, remote)
    preview = await sync.preview(p["id"], 0)
    run = await sync.enqueue(p["id"], 0, preview["digest"])
    remote.fail = True
    assert run["status"] == "ready"
    assert await sync.run_once()
    status = (await sync.status(p["id"]))[0]
    assert status["status"] == "retry_wait"
    assert status["error_code"] == "temporary_remote_failure"
    assert status["next_attempt_at"] is not None


async def test_definitive_sync_create_rejection_can_be_retried(db_engine):
    from sqlalchemy import select

    from rabbit_hole.application.sync import WorkbenchSync, runs
    from rabbit_hole.integrations.feishu import FeishuAPIError

    class Rejected(Remote):
        fail = True

        async def sync_create_table(self, name):
            if self.fail:
                raise FeishuAPIError(403, {"code": 123})
            return await super().sync_create_table(name)

    store, remote = WorkbenchStore(db_engine), Rejected()
    p = await store.create("rejected", "test", "US", str(uuid4()))
    sync = WorkbenchSync(store, remote)
    preview = await sync.preview(p["id"], 0)
    run = await sync.enqueue(p["id"], 0, preview["digest"])
    await sync.run_once()
    assert (await sync.status(p["id"]))[0]["status"] == "blocked"
    async with db_engine.connect() as c:
        checkpoint = await c.scalar(
            select(runs.c.checkpoint).where(runs.c.id == run["id"])
        )
    assert checkpoint == {}
    remote.fail = False
    await sync.enqueue(p["id"], 0, preview["digest"])
    await sync.run_once()
    assert (await sync.status(p["id"]))[0]["status"] == "complete"


async def test_sync_retry_uses_owned_immutable_snapshot_after_project_changes(
    db_engine,
):
    from sqlalchemy import select, update

    from rabbit_hole.application.sync import WorkbenchSync, runs
    from rabbit_hole.domain.project import WorkbenchError

    store, remote = WorkbenchStore(db_engine), Remote()
    p = await store.create("old version retry", "test", "US", str(uuid4()))
    other = await store.create("other project", "test", "US", str(uuid4()))
    sync = WorkbenchSync(store, remote)
    preview = await sync.preview(p["id"], 0)
    run = await sync.enqueue(p["id"], 0, preview["digest"])
    async with db_engine.begin() as c:
        await c.execute(
            update(runs)
            .where(runs.c.id == run["id"])
            .values(status="blocked", checkpoint={"audit-marker": "keep"})
        )
    await store.command(
        p["id"],
        0,
        str(uuid4()),
        "add_keyword",
        {"text": "travel pouch", "type": "pain"},
    )
    with pytest.raises(WorkbenchError) as raised:
        await sync.retry(other["id"], run["id"])
    assert raised.value.status == 404
    assert (await sync.retry(p["id"], run["id"]))["status"] == "ready"
    async with db_engine.connect() as c:
        row = (
            (await c.execute(select(runs).where(runs.c.id == run["id"])))
            .mappings()
            .one()
        )
    assert row["version"] == 0
    assert row["checkpoint"]["audit-marker"] == "keep"
    await sync.run_once()
    assert (await sync.status(p["id"]))[0]["status"] == "complete"


async def test_sync_retry_api_guards_and_project_ownership(db_engine):
    import httpx
    from sqlalchemy import update

    from rabbit_hole.application.sync import WorkbenchSync, runs
    from rabbit_hole.runtime.server import create_app

    store = WorkbenchStore(db_engine)
    sync = WorkbenchSync(store, Remote())
    project = await store.create("retry API", "test", "US", str(uuid4()))
    other = await store.create("other API", "test", "US", str(uuid4()))
    preview = await sync.preview(project["id"], 0)
    run = await sync.enqueue(project["id"], 0, preview["digest"])
    async with db_engine.begin() as connection:
        await connection.execute(
            update(runs).where(runs.c.id == run["id"]).values(status="blocked")
        )
    app = create_app(checks={})
    app.state.workbench_store = store
    app.state.workbench_sync = sync
    path = f"/workbench/api/projects/{project['id']}/sync/{run['id']}/retry"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        assert (await client.post(path, json={})).status_code == 403
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        headers = {"X-Workbench-Token": token}
        assert (
            await client.post(
                path, headers={**headers, "Origin": "https://evil.example"}, json={}
            )
        ).status_code == 403
        assert (
            await client.post(path, headers=headers, content="x" * 1_000_001)
        ).status_code == 413
        assert (
            await client.post(
                f"/workbench/api/projects/{other['id']}/sync/{run['id']}/retry",
                headers=headers,
                json={},
            )
        ).status_code == 404
        assert (await sync.status(project["id"]))[0]["status"] == "blocked"
        response = await client.post(path, headers=headers, json={})
        assert response.status_code == 200
        assert response.json()["status"] == "ready"
        assert "snapshot" not in response.json()
        assert "checkpoint" not in response.json()
