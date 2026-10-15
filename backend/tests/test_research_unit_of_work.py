"""Atomic local imports exercise original Store against prepared synthetic shared DB."""

import asyncio
import json
import sqlite3
from uuid import uuid4

import pytest
import pytest_asyncio
from services.research_repository import RepositoryError, ResearchRepository, digest

from backend.tests.test_full_merge_schema import candidate  # noqa: F401


@pytest_asyncio.fixture
async def local(candidate, tmp_path, monkeypatch):  # noqa: F811
    import httpx
    from services.research_facade import ResearchFacade
    from services.research_runtime import open_research_runtime, resolve_runtime_paths

    from backend.migrations.full_merge_v1 import prepare_schema

    def forbidden(*args, **kwargs):
        pytest.fail("local research invoked HTTP transport")

    monkeypatch.setattr(httpx.AsyncClient, "__init__", forbidden)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", forbidden)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", forbidden)
    prepare_schema(candidate, backup_verified=True)
    root = tmp_path / "research"
    root.mkdir(mode=0o700)
    paths = resolve_runtime_paths(candidate, root)
    for directory in (
        paths.evidence_root,
        paths.keys_root,
        paths.browser_root,
        paths.lock_root,
    ):
        directory.mkdir(mode=0o700)
    key = paths.keys_root / "evidence-signing.key"
    key.write_bytes(bytes(range(32)))
    key.chmod(0o600)
    namespace = paths.keys_root / "evidence-namespace.json"
    namespace.write_text(
        json.dumps(
            {
                "version": 1,
                "evidence_bucket": "fixture-bucket",
                "collector_version": "fixture-collector",
            }
        )
    )
    namespace.chmod(0o600)
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        state = await runtime.store.create(
            "Fixture project", "Fixture direction", "US", str(uuid4())
        )
        facade = ResearchFacade(runtime)
        project = await facade.command(
            state["id"],
            state["version"],
            str(uuid4()),
            "add_product",
            {"name": "Pouch", "url": "https://example.com/p"},
        )
        yield facade, project, paths


def request_for(project, *, confirm=True):
    request = {
        "project_id": project["id"],
        "product_id": project["products"][0]["source_ref"]["product_id"],
        "import_id": str(uuid4()),
        "name": "Pouch archive",
        "expected_source_version": project["source_version"],
        "expected_identity_revision": 1,
        "expected_market": "US",
        "existing": {},
        "selected_fields": ["material"],
    }
    if confirm:
        request["confirmation"] = {
            "command_id": str(uuid4()),
            "expected_version": project["source_version"],
            "identity_revision": 1,
            "market": "US",
            "key": "material",
            "value": "Cotton",
            "source_url": "https://example.com/p",
            "own_product": True,
        }
    return request


@pytest.mark.asyncio
async def test_four_concurrent_confirm_imports_commit_once_and_replay(local):
    from services.research_unit_of_work import confirm_and_import

    facade, project, paths = local
    request = request_for(project)
    results = await asyncio.gather(
        *(
            confirm_and_import(facade.runtime, request, request["import_id"])
            for _ in range(4)
        )
    )
    assert results == [results[0]] * 4
    assert (
        results[0]["snapshot"]["source_ref"]["source_version"]
        == project["source_version"] + 1
    )
    assert results[0]["snapshot"]["facts"][0]["value"] == "Cotton"
    with sqlite3.connect(paths.database) as db:
        assert (
            db.execute(
                "SELECT count(*) FROM workbench_events WHERE action='confirm_marketing_fact'"
            ).fetchone()[0]
            == 1
        )
        assert (
            db.execute(
                "SELECT count(*) FROM research_links WHERE id != 'synthetic-link'"
            ).fetchone()[0]
            == 1
        )
    assert (
        ResearchRepository(paths.database).lookup(request["import_id"], digest(request))
        == results[0]
    )
    with pytest.raises(RepositoryError) as error:
        await confirm_and_import(
            facade.runtime, {**request, "name": "different"}, request["import_id"]
        )
    assert error.value.status == 409


@pytest.mark.asyncio
async def test_archive_failure_rolls_back_fact_event_and_link(local, monkeypatch):
    from services.research_unit_of_work import confirm_and_import

    facade, project, paths = local
    original = ResearchRepository.save_async

    async def broken(self, connection, *args):
        await original(self, connection, *args)
        raise RuntimeError("synthetic archive failure")

    monkeypatch.setattr(ResearchRepository, "save_async", broken)
    request = request_for(project)
    with pytest.raises(RuntimeError, match="synthetic"):
        await confirm_and_import(facade.runtime, request, request["import_id"])
    assert await facade.get_project(project["id"]) == project
    assert ResearchRepository(paths.database).lookup(request["import_id"]) is None
    with sqlite3.connect(paths.database) as db:
        assert (
            db.execute(
                "SELECT count(*) FROM research_links WHERE id != 'synthetic-link'"
            ).fetchone()[0]
            == 0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"expected_source_version": 0},
        {"expected_identity_revision": 2},
        {"expected_market": "GB"},
        {"confirmation": {"expected_version": 0}},
        {"confirmation": {"identity_revision": 2}},
        {"confirmation": {"market": "GB"}},
        {"confirmation": {"own_product": False}},
    ],
)
async def test_invalid_fences_cannot_confirm_or_import(local, change):
    from services.research_unit_of_work import confirm_and_import

    facade, project, paths = local
    request = request_for(project)
    if "confirmation" in change:
        request["confirmation"].update(change["confirmation"])
    else:
        request.update(change)
    with pytest.raises(Exception) as error:
        await confirm_and_import(facade.runtime, request, request["import_id"])
    assert getattr(error.value, "status", None) in {409, 422}
    assert await facade.get_project(project["id"]) == project
    assert ResearchRepository(paths.database).lookup(request["import_id"]) is None


@pytest.mark.asyncio
async def test_unknown_unconfirmed_fact_cannot_import(local):
    from services.research_unit_of_work import confirm_and_import

    facade, project, paths = local
    request = request_for(project, confirm=False)
    with pytest.raises(RepositoryError) as error:
        await confirm_and_import(facade.runtime, request, request["import_id"])
    assert error.value.status == 409
    assert ResearchRepository(paths.database).lookup(request["import_id"]) is None


@pytest.mark.asyncio
async def test_http_combined_import_rollback_and_legacy_digest(local, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research
    from services.research_client import ResearchError

    facade, project, paths = local
    monkeypatch.setattr(
        research, "load_research_config", lambda: {"enabled": True, "mode": "local"}
    )
    monkeypatch.setattr(
        research, "repository", lambda: ResearchRepository(paths.database)
    )
    app = FastAPI()
    app.state.research_runtime = facade.runtime
    app.include_router(research.router)
    request = request_for(project)
    url = (
        "/api/research/v1/projects/"
        + project["id"]
        + "/products/"
        + request["product_id"]
        + "/imports"
    )
    body = {k: v for k, v in request.items() if k not in {"project_id", "product_id"}}
    original = ResearchRepository.save_async

    async def broken(self, connection, *args):
        await original(self, connection, *args)
        raise ResearchError("unavailable", "synthetic failure", 503)

    with TestClient(app, client=('127.0.0.1', 50000), base_url="http://127.0.0.1:9503") as browser:
        headers = {
            "X-Research-Token": browser.get("/api/research/v1/session").json()[
                "csrf_token"
            ]
        }
        monkeypatch.setattr(ResearchRepository, "save_async", broken)
        response = browser.post(url, json=body, headers=headers)
        assert response.status_code == 503
        assert ResearchRepository(paths.database).lookup(request["import_id"]) is None
        assert (await facade.get_project(project["id"])) == project
        monkeypatch.setattr(ResearchRepository, "save_async", original)
        response = browser.post(url, json=body, headers=headers)
        assert response.status_code == 200
        assert (
            response.json()["snapshot"]["source_ref"]["source_version"]
            == project["source_version"] + 1
        )
        assert browser.post(url, json=body, headers=headers).json() == response.json()
        legacy = request_for(project, confirm=False)
        # Original remote receipts can be restored even with stale research versions.
        old = ResearchRepository(paths.database).save(
            legacy["import_id"],
            digest(legacy),
            "Old",
            {"source_ref": {}, "market": "US", "facts": []},
        )
        old_body = {
            k: v for k, v in legacy.items() if k not in {"project_id", "product_id"}
        }
        assert browser.post(url, json=old_body, headers=headers).json() == old


@pytest.mark.asyncio
async def test_no_confirmation_import_and_legacy_rows_hash_preserved(local):
    from services.research_unit_of_work import confirm_and_import

    facade, project, paths = local
    from backend.tests.test_full_merge_schema import snapshot

    before = snapshot(paths.database)
    original_tables = [
        name
        for name in before
        if name not in {"full_merge_schema", "full_merge_ledger"}
        and not name.startswith("workbench_")
    ]
    from backend.migrations.full_merge_v1 import research_metadata

    original_tables = [
        name for name in original_tables if name not in research_metadata().tables
    ]
    assert len(original_tables) == 18
    first = request_for(project)
    await confirm_and_import(facade.runtime, first, first["import_id"])
    current = await facade.get_project(project["id"])
    request = request_for(current, confirm=False)
    saved = await confirm_and_import(facade.runtime, request, request["import_id"])
    assert (
        saved["snapshot"]["source_ref"]["source_version"] == current["source_version"]
    )
    after = snapshot(paths.database)
    # Two additive archive tables gain rows; all original rows (including receipts) remain byte equivalent.
    for table in original_tables:
        if table in {"research_links", "research_import_events"}:
            old_ids = {row[0] for row in before[table]}
            restored = [row for row in after[table] if row[0] in old_ids]
            assert digest(restored) == digest(before[table])
        else:
            assert digest(after[table]) == digest(before[table])


@pytest.mark.asyncio
async def test_command_digest_conflict_rolls_back_import(local):
    from services.research_unit_of_work import confirm_and_import

    facade, project, paths = local
    request = request_for(project)
    first = await confirm_and_import(facade.runtime, request, request["import_id"])
    current = await facade.get_project(project["id"])
    second = request_for(current)
    second["confirmation"]["command_id"] = request["confirmation"]["command_id"]
    second["confirmation"]["value"] = "Silk"
    with pytest.raises(Exception) as error:
        await confirm_and_import(facade.runtime, second, second["import_id"])
    assert error.value.status == 409
    assert ResearchRepository(paths.database).lookup(second["import_id"]) is None
    assert ResearchRepository(paths.database).lookup(request["import_id"]) == first


@pytest.mark.asyncio
async def test_ready_local_route_uses_only_shared_async_connection(local, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research

    facade, project, _paths = local
    monkeypatch.setattr(
        research, "load_research_config", lambda: {"enabled": True, "mode": "local"}
    )

    def forbidden():
        raise AssertionError(
            "ready local workflow opened independent repository connection"
        )

    monkeypatch.setattr(research, "repository", forbidden)
    app = FastAPI()
    app.state.research_runtime = facade.runtime
    app.include_router(research.router)
    data = request_for(project)
    with TestClient(app, client=('127.0.0.1', 50000), base_url="http://127.0.0.1:9503") as browser:
        headers = {
            "X-Research-Token": browser.get("/api/research/v1/session").json()[
                "csrf_token"
            ]
        }
        url = (
            "/api/research/v1/projects/"
            + project["id"]
            + "/products/"
            + data["product_id"]
            + "/imports"
        )
        body = {k: v for k, v in data.items() if k not in {"project_id", "product_id"}}
        assert browser.post(url, json=body, headers=headers).status_code == 200
        assert browser.post(url, json=body, headers=headers).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,enabled,missing_runtime",
    [("remote", False, True), ("local", False, False), ("local", True, True)],
)
async def test_old_remote_receipt_recovers_offline(
    local, monkeypatch, mode, enabled, missing_runtime
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research

    facade, project, paths = local
    data = request_for(project, confirm=False)
    repo = ResearchRepository(paths.database)
    old = repo.save(
        data["import_id"],
        digest(data),
        "Old snapshot",
        {"source_ref": {}, "market": "US", "facts": []},
    )
    monkeypatch.setattr(research, "repository", lambda: repo)
    monkeypatch.setattr(
        research, "load_research_config", lambda: {"enabled": enabled, "mode": mode}
    )
    app = FastAPI()
    if not missing_runtime:
        app.state.research_runtime = facade.runtime
    app.include_router(research.router)
    with TestClient(app, client=('127.0.0.1', 50000), base_url="http://127.0.0.1:9503") as browser:
        headers = {
            "X-Research-Token": browser.get("/api/research/v1/session").json()[
                "csrf_token"
            ]
        }
        url = (
            "/api/research/v1/projects/"
            + project["id"]
            + "/products/"
            + data["product_id"]
            + "/imports"
        )
        body = {k: v for k, v in data.items() if k not in {"project_id", "product_id"}}
        assert browser.post(url, json=body, headers=headers).json() == old
        body["name"] = "changed"
        assert browser.post(url, json=body, headers=headers).status_code == 409


@pytest.mark.asyncio
async def test_remote_combined_workflow_refused_before_client(local, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research

    _, project, paths = local
    monkeypatch.setattr(
        research, "repository", lambda: ResearchRepository(paths.database)
    )
    monkeypatch.setattr(
        research, "load_research_config", lambda: {"enabled": True, "mode": "remote"}
    )

    def forbidden(*args, **kwargs):
        raise AssertionError("unsupported combined command reached remote owner")

    monkeypatch.setattr(research, "client", forbidden)
    app = FastAPI()
    app.include_router(research.router)
    data = request_for(project)
    with TestClient(app, client=('127.0.0.1', 50000), base_url="http://127.0.0.1:9503") as browser:
        headers = {
            "X-Research-Token": browser.get("/api/research/v1/session").json()[
                "csrf_token"
            ]
        }
        url = (
            "/api/research/v1/projects/"
            + project["id"]
            + "/products/"
            + data["product_id"]
            + "/imports"
        )
        body = {k: v for k, v in data.items() if k not in {"project_id", "product_id"}}
        assert browser.post(url, json=body, headers=headers).status_code == 503


@pytest.mark.asyncio
async def test_borrowed_connections_require_active_transaction(local):
    facade, project, paths = local
    async with facade.runtime.engine.connect() as connection:
        with pytest.raises(ValueError, match="active transaction"):
            await facade.runtime.store.get(project["id"], _connection=connection)
        with pytest.raises(ValueError, match="active transaction"):
            await facade.runtime.store.command(
                project["id"],
                project["source_version"],
                str(uuid4()),
                "add_keyword",
                {"text": "x"},
                _connection=connection,
            )
        with pytest.raises(ValueError, match="active transaction"):
            await ResearchRepository(paths.database).lookup_async(connection, uuid4())


@pytest.mark.asyncio
async def test_readonly_local_runtime_cannot_write_archives(local, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research
    from services.research_runtime import open_research_runtime
    from services.research_unit_of_work import confirm_and_import

    facade, project, paths = local
    first = request_for(project)
    await confirm_and_import(facade.runtime, first, first["import_id"])
    current = await facade.get_project(project["id"])
    data = request_for(current, confirm=False)
    monkeypatch.setattr(
        research, "repository", lambda: ResearchRepository(paths.database)
    )
    monkeypatch.setattr(
        research, "load_research_config", lambda: {"enabled": True, "mode": "local"}
    )
    async with open_research_runtime(paths) as runtime:
        app = FastAPI()
        app.state.research_runtime = runtime
        app.include_router(research.router)
        with TestClient(app, client=('127.0.0.1', 50000), base_url="http://127.0.0.1:9503") as browser:
            headers = {
                "X-Research-Token": browser.get("/api/research/v1/session").json()[
                    "csrf_token"
                ]
            }
            url = (
                "/api/research/v1/projects/"
                + project["id"]
                + "/products/"
                + data["product_id"]
                + "/imports"
            )
            body = {
                k: v for k, v in data.items() if k not in {"project_id", "product_id"}
            }
            assert browser.post(url, json=body, headers=headers).status_code == 503
    assert ResearchRepository(paths.database).lookup(data["import_id"]) is None
