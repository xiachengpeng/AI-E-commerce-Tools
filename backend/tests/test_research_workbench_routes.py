"""Native workbench contracts use temporary state and injected dependencies only."""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

PREFIX = "/api/research/workbench/v1"


@pytest.fixture(autouse=True)
def isolate_research_configuration(monkeypatch):
    monkeypatch.setattr("routes.research.load_research_config", dict)


def make_client(runtime=None):
    from routes import research, research_workbench

    app = FastAPI()
    app.state.research_runtime = runtime
    app.include_router(research.router)
    app.include_router(research_workbench.router)
    client = TestClient(app, client=('127.0.0.1', 50000), base_url="http://localhost:9503")
    client.headers["X-Research-Token"] = client.get("/api/research/v1/session").json()[
        "csrf_token"
    ]
    return client


def test_original_business_route_inventory():
    from routes.research_workbench import router

    matrix = json.loads(
        (
            Path(__file__).parents[2] / "docs/merge-assessment/full-merge-coverage.json"
        ).read_text()
    )
    expected = {
        (method, PREFIX + path.removeprefix("/workbench/api"))
        for method, path in matrix["runtime_routes"]["research"]
        if path.startswith("/workbench/api")
    }
    actual = {
        (method, route.path) for route in router.routes for method in route.methods
    }
    assert actual == expected | {("GET", PREFIX + "/history"), ("GET", PREFIX + "/projects/{project_id}/commands/{command_id}")}


@pytest.mark.parametrize(
    "origin",
    [
        "http://127.0.0.1:9502",
        "http://localhost:9502",
        "http://127.0.0.1:9503",
        "http://localhost:9503",
    ],
)
def test_shared_session_and_allowed_frontend_origins(origin):
    store = AsyncMock()
    store.list_projects.return_value = []
    client = make_client(SimpleNamespace(store=store, diagnostics=()))
    assert (
        client.get(PREFIX + "/session", headers={"Origin": origin}).json()["csrf_token"]
        == client.headers["X-Research-Token"]
    )
    response = client.get(PREFIX + "/projects", headers={"Origin": origin})
    # Empty actual store list is an injected awaitable, never a network request.
    assert response.status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "null"},
        {"Origin": "https://evil.test"},
        {"Host": "evil.test"},
        {"Host": "localhost:9999"},
        {"Sec-Fetch-Site": "cross-site"},
    ],
)
def test_rejects_untrusted_request_boundaries(headers):
    client = make_client()
    assert client.get(PREFIX + "/session", headers=headers).status_code == 403


def test_token_required_for_reads_and_writes_and_unready_is_isolated():
    client = make_client()
    token = client.headers.pop("X-Research-Token")
    assert client.get(PREFIX + "/projects").status_code == 401
    assert client.post(PREFIX + "/projects", json={}).status_code == 401
    client.headers["X-Research-Token"] = token
    assert client.get(PREFIX + "/projects").status_code == 503
    response = client.get(PREFIX + "/session")
    assert response.json()["csrf_token"] == token
    assert response.headers["cache-control"] == "no-store"
    assert client.get(PREFIX + "/").status_code == 404


def test_original_input_errors_and_conflicts():
    from services.research_runtime import _research_imports

    _research_imports()
    from rabbit_hole.persistence.projects import WorkbenchError

    store = AsyncMock()
    store.list_projects.return_value = []
    store.command.side_effect = WorkbenchError("version_conflict", "版本冲突", 409)
    client = make_client(SimpleNamespace(store=store, diagnostics=()))
    project = str(uuid4())
    assert client.get(PREFIX + "/projects/not-a-uuid").status_code == 404
    assert client.post(PREFIX + "/projects", json=[]).status_code == 422
    assert client.post(PREFIX + "/projects", content='{"value":NaN}').status_code == 422
    assert client.post(PREFIX + "/projects", content="x" * 1000001).status_code == 413
    assert (
        client.post(
            PREFIX + "/projects/" + project + "/commands",
            json={"action": "worker_internal"},
        ).status_code
        == 403
    )
    body = {
        "action": "add_keyword",
        "version": 1,
        "command_id": str(uuid4()),
        "payload": {},
    }
    assert (
        client.post(
            PREFIX + "/projects/" + project + "/commands", json=body
        ).status_code
        == 409
    )
    assert client.get(PREFIX + "/projects").headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "key",
    [
        "evidence/US/a/../../keys/secret",
        "evidence/US/a/%2e%2e/secret",
        "/evidence/US/a/x",
        "evidence/US/a/\\secret",
    ],
)
def test_evidence_traversal_rejected(key):
    from fastapi import HTTPException
    from services.research_security import validate_evidence_object_id

    with pytest.raises(HTTPException) as error:
        validate_evidence_object_id(key)
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_lifecycle_is_explicit_and_isolates_failure(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager

    from routes import research_workbench

    app = FastAPI()
    calls = []

    @asynccontextmanager
    async def unavailable(paths, **options):
        calls.append((paths, options))
        raise ValueError("sensitive-internal-detail")
        yield

    monkeypatch.setattr("services.research_runtime.open_research_runtime", unavailable)
    async with research_workbench.research_lifespan(
        app,
        config={"enabled": False},
        database=tmp_path / "db",
        data_root=tmp_path / "private",
    ):
        assert app.state.research_runtime is None
    assert calls == []
    async with research_workbench.research_lifespan(
        app,
        config={"enabled": True, "mode": "local"},
        database=tmp_path / "db",
        data_root=tmp_path / "private",
    ):
        assert app.state.research_runtime is None
        assert app.state.research_diagnostics == ("initialization_failed",)
    assert calls[0][1] == {"allow_commands": False, "allow_external": False}
    assert not (tmp_path / "db").exists()


@pytest.mark.asyncio
async def test_log_stream_limit_and_cursor_validation(monkeypatch):
    from routes.research_workbench import router
    from starlette.requests import Request

    store = AsyncMock()
    store.get.return_value = {"id": str(uuid4())}
    app = FastAPI()
    app.state.research_runtime = SimpleNamespace(store=store, diagnostics=())
    from routes.research import _session_token

    def request(headers=()):
        return Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/",
                "scheme": "http",
                "query_string": b"",
                "headers": [
                    (b"host", b"localhost:9503"),
                    (b"x-research-token", _session_token.encode()),
                    *headers,
                ],
                "app": app,
                "client": ("127.0.0.1", 50000),
            }
        )

    endpoint = next(r.endpoint for r in router.routes if r.path.endswith("/log-stream"))
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        await endpoint(request([(b"last-event-id", b"-1")]), str(uuid4()), 0)
    assert error.value.status_code == 422
    streams = [await endpoint(request(), str(uuid4()), 0) for _ in range(4)]
    with pytest.raises(HTTPException) as error:
        await endpoint(request(), str(uuid4()), 0)
    assert error.value.status_code == 429

    # Start and close each generator so its acquired slot is released.
    async def events(*args, **kwargs):
        yield ": ready\n\n"

    monkeypatch.setattr("rabbit_hole.api.log_stream.stream_logs", events)
    for stream in streams:
        assert stream.headers["cache-control"] == "no-store"
        await anext(stream.body_iterator)
        await stream.body_iterator.aclose()
    response = await endpoint(request(), str(uuid4()), 0)
    await anext(response.body_iterator)
    await response.body_iterator.aclose()


@pytest.mark.asyncio
async def test_actual_store_commands_report_and_project_ownership(
    tmp_path, monkeypatch
):
    import sqlite3

    from services.research_runtime import open_research_runtime, resolve_runtime_paths

    from backend.migrations.full_merge_v1 import prepare_schema

    database = tmp_path / "history.db"
    sqlite3.connect(database).close()
    prepare_schema(database, backup_verified=True)
    root = tmp_path / "research"
    root.mkdir(mode=0o700)
    paths = resolve_runtime_paths(database, root)
    for folder in (
        paths.evidence_root,
        paths.keys_root,
        paths.browser_root,
        paths.lock_root,
    ):
        folder.mkdir(mode=0o700)
    for name, data in [
        ("evidence-signing.key", b"x" * 32),
        (
            "evidence-namespace.json",
            json.dumps(
                {
                    "version": 1,
                    "evidence_bucket": "fixture",
                    "collector_version": "fixture",
                }
            ).encode(),
        ),
    ]:
        path = paths.keys_root / name
        path.write_bytes(data)
        path.chmod(0o600)
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        client = make_client(runtime)
        created = client.post(
            PREFIX + "/projects",
            json={
                "title": "Fixture",
                "direction": "Fixture direction",
                "market": "US",
                "command_id": str(uuid4()),
            },
        )
        assert created.status_code == 200
        state = created.json()
        url = PREFIX + "/projects/" + state["id"]
        body = {
            "version": state["version"],
            "command_id": str(uuid4()),
            "action": "add_keyword",
            "payload": {"text": "pouch", "type": "function"},
        }
        changed = client.post(url + "/commands", json=body)
        assert changed.status_code == 200
        assert client.post(url + "/commands", json=body).json() == changed.json()
        body["command_id"] = str(uuid4())
        assert client.post(url + "/commands", json=body).status_code == 409
        history_before = client.get(PREFIX + "/history?kind=activity").json()
        assert client.get(url + "/report").status_code == 200
        assert client.get(PREFIX + "/history?kind=activity").json() == history_before
        assert client.get(PREFIX + "/history?kind=report").json()["items"] == []
        assert client.get(url + "/intelligence").status_code == 200
        assert client.get(url + "/actions").status_code == 200
        assert client.get(url + "/live-logs").json()["logs"] == []
        other = PREFIX + "/projects/" + str(uuid4())
        assert client.get(other).status_code == 404
        assert client.get(other + "/actions").status_code == 404
        assert (
            client.get(
                other + "/actions/" + str(uuid4()) + "/provider-evidence"
            ).status_code
            == 404
        )
        from datetime import UTC, datetime
        from uuid import UUID

        from rabbit_hole.application.actions import actions
        from sqlalchemy import insert

        aid = uuid4()
        now = datetime.now(UTC)
        raw = b"\x89PNG\r\n\x1a\nfixture"
        evidence = runtime.evidence_store.put(
            market="US",
            record_id=str(aid),
            collected_at=now,
            raw=raw,
            source_url="https://example.com/fixture",
            content_type="image/png",
        )
        async with runtime.engine.begin() as connection:
            await connection.execute(
                insert(actions).values(
                    id=aid,
                    dedupe_key=str(aid),
                    project_id=UUID(state["id"]),
                    kind="landing",
                    status="complete",
                    input_version=1,
                    payload={
                        "provider_evidence": {"status": "fixture"},
                        "apify_run": {"id": "fixture-run"},
                    },
                    result={"evidence_id": evidence.object_id},
                    created_at=now,
                    updated_at=now,
                    attempt=1,
                )
            )
        assert (
            client.post(
                url + "/actions/" + str(aid) + "/stop", json={"attempt": 1}
            ).status_code
            == 409
        )
        from sqlalchemy import select, update

        awaitable_abort = AsyncMock(
            side_effect=AssertionError("offline stop called external abort")
        )
        monkeypatch.setattr(
            "rabbit_hole.integrations.provider_budget.abort_apify_run", awaitable_abort
        )
        async with runtime.engine.begin() as connection:
            await connection.execute(
                update(actions).where(actions.c.id == aid).values(status="running")
            )
        assert (
            client.post(
                url + "/actions/" + str(aid) + "/stop", json={"attempt": 1}
            ).status_code
            == 503
        )
        async with runtime.engine.connect() as connection:
            assert (
                await connection.scalar(
                    select(actions.c.status).where(actions.c.id == aid)
                )
                == "running"
            )
        awaitable_abort.assert_not_awaited()
        async with runtime.engine.begin() as connection:
            await connection.execute(
                update(actions).where(actions.c.id == aid).values(status="complete")
            )
        screenshot_url = url + "/actions/" + str(aid) + "/screenshot"
        shot = client.get(screenshot_url)
        assert shot.status_code == 200
        assert shot.content == raw
        assert shot.headers["cache-control"] == "no-store"
        from urllib.parse import parse_qs, urlsplit

        signed = runtime.evidence_store.signed_read_link(evidence.object_id)
        signed_token = parse_qs(urlsplit(signed).query)["token"][0]
        downloaded = client.get(
            PREFIX + "/evidence-file", params={"token": signed_token}
        )
        assert downloaded.status_code == 200
        assert downloaded.content == raw
        assert downloaded.headers["cache-control"] == "no-store"
        assert (
            client.get(
                PREFIX + "/evidence-file",
                params={"token": signed_token, "project_id": str(uuid4())},
            ).status_code
            == 404
        )
        assert (
            client.get(
                PREFIX + "/evidence-file", params={"token": signed_token + "tampered"}
            ).status_code
            == 404
        )

        assert (
            client.get(other + "/actions/" + str(aid) + "/screenshot").status_code
            == 404
        )
        assert (
            client.get(
                other + "/actions/" + str(aid) + "/provider-evidence"
            ).status_code
            == 404
        )
        assert client.get(
            url + "/actions/" + str(aid) + "/provider-evidence"
        ).json() == {"status": "fixture"}


def test_injected_sync_keeps_original_preview_enqueue_receipt_contracts():
    class Sync:
        async def status(self, project_id):
            return [{"id": "receipt", "project_id": project_id, "status": "pending"}]

        async def preview(self, project_id, version):
            return {
                "project_id": project_id,
                "version": version,
                "digest": "fixture-digest",
            }

        async def enqueue(self, project_id, version, digest):
            return {
                "project_id": project_id,
                "version": version,
                "digest": digest,
                "status": "pending",
            }

        async def retry(self, project_id, run_id):
            return {"project_id": project_id, "id": run_id, "status": "pending"}

    client = make_client(
        SimpleNamespace(
            store=AsyncMock(), diagnostics=(), workbench_services={"sync": Sync()}
        )
    )
    project = str(uuid4())
    url = PREFIX + "/projects/" + project + "/sync"
    assert client.get(url).json()["runs"][0]["project_id"] == project
    assert client.post(url + "/preview", json={"version": True}).status_code == 422
    preview = client.post(url + "/preview", json={"version": 2})
    assert preview.json()["digest"] == "fixture-digest"
    queued = client.post(url, json={"version": 2, "digest": preview.json()["digest"]})
    assert queued.json()["status"] == "pending"
    assert queued.headers["cache-control"] == "no-store"
    run = str(uuid4())
    assert client.post(url + "/" + run + "/retry", json={}).json()["id"] == run


def test_injected_media_translation_and_ownership_use_saved_ad(monkeypatch):
    class Translator:
        async def translate(self, source):
            return {"translation": "已翻译", "source": source}

    async def media(item):
        return b"fixture-image", "image/png", "png"

    project = str(uuid4())
    keyword = str(uuid4())
    ad = str(uuid4())
    source = "A practical cotton pouch for keeping everyday items organized."
    store = AsyncMock()
    store.get.return_value = {
        "id": project,
        "products": [],
        "keywords": [
            {
                "id": keyword,
                "ads": [
                    {
                        "id": ad,
                        "primary_text": source,
                        "media": [
                            {"kind": "image", "url": "https://example.com/saved.png"}
                        ],
                    }
                ],
            }
        ],
    }
    client = make_client(
        SimpleNamespace(
            store=store,
            diagnostics=(),
            workbench_services={"translator": Translator(), "media_reader": media},
        )
    )
    url = PREFIX + "/projects/" + project
    assert (
        client.post(
            url + "/ads/translate",
            json={"keyword_id": keyword, "ad_id": ad, "expected_text": "changed"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            url + "/ads/translate",
            json={
                "keyword_id": keyword,
                "ad_id": str(uuid4()),
                "expected_text": source,
            },
        ).status_code
        == 404
    )
    assert (
        client.post(
            url + "/ads/translate",
            json={"keyword_id": keyword, "ad_id": ad, "expected_text": source},
        ).json()["source"]
        == source
    )
    response = client.get(
        url + "/media-download",
        params={"keyword_id": keyword, "ad_id": ad, "source": "ad", "index": 0},
    )
    assert response.content == b"fixture-image"
    assert response.headers["cache-control"] == "no-store"
    assert (
        client.get(
            url + "/media-download",
            params={
                "keyword_id": str(uuid4()),
                "ad_id": ad,
                "source": "ad",
                "index": 0,
            },
        ).status_code
        == 422
    )


def test_sources_are_honest_without_external_configuration():
    client = make_client(SimpleNamespace(store=AsyncMock(), diagnostics=()))
    response = client.get(PREFIX + "/sources")
    assert response.status_code == 200
    sources = {s["key"]: s for s in response.json()["sources"]}
    assert sources["meta"]["available"] is False
    assert sources["ai"]["available"] is False
    assert sources["amazon"]["automation_state"] == "approval_required"
    assert client.get(PREFIX + "/provider-settings").status_code == 503
    assert (
        client.post(
            PREFIX + "/project-direction", json={"title": "Fixture", "market": "US"}
        ).status_code
        == 503
    )


def test_errors_are_not_cached():
    client = make_client()
    response = client.get(PREFIX + "/projects")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "path", ["/api/research/v1/session", "/api/research/workbench/v1/session"]
)
def test_both_session_bootstraps_reject_arbitrary_ports(path):
    client = make_client()
    assert client.get(path, headers={"Host": "localhost:9999"}).status_code == 403
    assert client.get(path, headers={"Host": "evil.test:9503"}).status_code == 403
    assert client.get(path, headers={"Origin": "null"}).status_code == 403


def test_settings_handlers_use_only_injected_vaults():
    class Vault:
        def status(self):
            return {"meta": False}

        def public(self):
            return {"configured": False, "source": "saved"}

        def update(self, data):
            if data.get("invalid"):
                raise ValueError("Invalid fixture")
            return {"configured": True, "source": "saved"}

        def reset(self):
            return {"configured": False, "source": "default"}

    vault = Vault()
    client = make_client(
        SimpleNamespace(
            store=AsyncMock(),
            diagnostics=(),
            workbench_services={"provider_settings": vault, "ai_settings": vault},
        )
    )
    assert client.get(PREFIX + "/provider-settings").json() == {
        "configured": {"meta": False}
    }
    assert client.post(PREFIX + "/provider-settings", json={}).status_code == 200
    assert client.get(PREFIX + "/ai-settings").json()["configured"] is False
    assert (
        client.post(PREFIX + "/ai-settings", json={"reset": True}).json()["source"]
        == "default"
    )
    assert (
        client.post(PREFIX + "/ai-settings", json={"invalid": True}).status_code == 422
    )


def test_framework_validation_errors_are_not_cached():
    client = make_client()
    response = client.get(PREFIX + "/evidence-file")
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_native_history_canonical_projection_cursor_and_private_payload(tmp_path):
    import sqlite3

    from sqlalchemy.ext.asyncio import create_async_engine

    from backend.migrations.full_merge_v1 import prepare_schema

    database = tmp_path / "history.db"
    sqlite3.connect(database).close()
    prepare_schema(database, backup_verified=True)
    from services.research_repository import migrate

    migrate(database)
    project, other, product = map(str, (uuid4(), uuid4(), uuid4()))
    with sqlite3.connect(database) as db:
        for pid in (project, other):
            db.execute(
                "INSERT INTO workbench_projects VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    pid,
                    "fixture",
                    "private direction",
                    "US",
                    1,
                    "{}",
                    str(uuid4()),
                    "digest",
                    "2026-01-01",
                    "2026-01-01",
                ),
            )
        for pid in (project, project, other):
            db.execute(
                "INSERT INTO workbench_events VALUES (?,?,?,?,?,?,?,?)",
                (
                    str(uuid4()),
                    pid,
                    str(uuid4()),
                    "digest",
                    "review",
                    json.dumps({"api_key": "PRIVATE", "prompt": "PRIVATE"}),
                    "human",
                    "2026-01-01",
                ),
            )
        ref = {
            "project_id": project,
            "product_id": product,
            "source_version": 1,
            "identity_revision": 1,
            "system": "rabbit_hole",
        }
        db.execute(
            "INSERT INTO research_links VALUES (?,?,?,?,?,?)",
            (
                "link",
                "private name",
                json.dumps(ref),
                "US",
                1,
                json.dumps(
                    [
                        {
                            "module": "listing",
                            "history_id": 7,
                            "timestamp": "2026-01-01T00:00:00+00:00",
                            "created_at": "PRIVATE",
                            "secret": "PRIVATE",
                        }
                    ]
                ),
            ),
        )
        db.execute(
            "INSERT INTO research_import_events VALUES (?,?,?,?,?)",
            (
                str(uuid4()),
                "digest",
                "link",
                json.dumps({"source_ref": ref, "facts": [{"value": "PRIVATE"}]}),
                "2026-01-01",
            ),
        )
    engine = create_async_engine("sqlite+aiosqlite:///" + str(database))
    store = SimpleNamespace(engine=engine, get=AsyncMock(return_value={"id": project}))
    try:
        client = make_client(SimpleNamespace(store=store, diagnostics=()))
        route = PREFIX + "/history"
        response = client.get(
            route, params={"kind": "activity", "project_id": project, "limit": 1}
        )
        assert response.status_code == 200
        page = response.json()
        assert len(page["items"]) == 1 and page["next_cursor"]
        assert "PRIVATE" not in response.text and "payload" not in response.text
        assert page["items"][0]["action"] == "review"
        assert client.get(route, params={"cursor": "!!!"}).status_code == 422
        assert (
            client.get(route, headers={"Origin": "https://outside.invalid"}).status_code
            == 403
        )
        assert client.get(route, headers={"Host": "outside.invalid"}).status_code == 403
        assert response.headers["cache-control"] == "no-store"
        assert client.get(
            route,
            params={
                "kind": "activity",
                "project_id": project,
                "cursor": page["next_cursor"],
            },
        ).json()["items"]
        assert (
            client.get(
                route,
                params={
                    "kind": "import",
                    "project_id": project,
                    "cursor": page["next_cursor"],
                },
            ).status_code
            == 422
        )
        assert (
            client.get(
                route,
                params={
                    "kind": "activity",
                    "project_id": other,
                    "cursor": page["next_cursor"],
                },
            ).status_code
            == 422
        )
        imports = client.get(
            route, params={"kind": "import", "project_id": project}
        ).json()["items"]
        assert imports[0]["product_id"] == product
        assert imports[0]["artifacts"] == [
            {
                "module": "listing",
                "history_id": 7,
                "timestamp": "2026-01-01T00:00:00+00:00",
                "created_at": None,
            }
        ]
        assert "PRIVATE" not in json.dumps(imports)
        assert (
            client.get(route, params={"kind": "report", "project_id": project}).json()[
                "items"
            ]
            == []
        )
        assert client.get(route, params={"kind": "bad"}).status_code == 422
        assert client.get(route, params={"limit": 51}).status_code == 422
        assert client.delete(route).status_code == 405
        client.headers["X-Research-Token"] = "wrong"
        assert client.get(route).status_code == 401
    finally:
        await engine.dispose()


def test_native_settings_patch_seen_by_next_worker_resolution(tmp_path):
    import sqlite3

    from routes.integration_settings import create_integration_settings_router
    from services.integration_settings_service import IntegrationSettingsService
    from services.research_integrations import assemble_non_ai_integrations

    from backend.migrations.full_merge_v1 import prepare_schema

    database = tmp_path / "history.db"
    sqlite3.connect(database).close()
    prepare_schema(database, backup_verified=True, target_revision=2)
    api_store = IntegrationSettingsService(database)
    worker = assemble_non_ai_integrations(
        IntegrationSettingsService(database), allow_external=False
    )
    api_store.update(
        "apify", "research", {"api_key": "synthetic-first", "daily_limit": 10}
    )
    assert worker.providers.get("apify") == "synthetic-first"
    client = make_client()
    client.app.state.integration_settings = api_store
    client.app.include_router(create_integration_settings_router())
    path = "/api/settings/integrations/apify/research"
    saved = client.patch(path, json={"api_key": "synthetic-next", "daily_limit": 20})
    assert saved.status_code == 200 and saved.json()["version"] == 2
    assert "synthetic-next" not in saved.text
    assert worker.providers.get("apify") == "synthetic-next"
    assert worker.provider_limit("apify") == 20
    assert client.patch(path, json={"api_key": ""}).json()["version"] == 3
    assert worker.providers.get("apify") == "synthetic-next"
    assert worker.settings_store.public("apify", "research")["version"] == 3

@pytest.mark.asyncio
async def test_native_draft_receipt_is_scoped_read_only_and_private(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from sqlalchemy import insert
    from sqlalchemy.ext.asyncio import create_async_engine
    from rabbit_hole.persistence.projects import metadata, workbench_projects, workbench_events
    from datetime import datetime, UTC
    engine = create_async_engine('sqlite+aiosqlite:///' + str(tmp_path / 'receipt.db'))
    project, other, command = str(uuid4()), str(uuid4()), str(uuid4())
    now = datetime.now(UTC)
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
        await connection.execute(insert(workbench_projects), [dict(id=pid, title='fixture', direction='fixture', market='US', version=9, state={}, create_command_id=str(uuid4()), create_digest='0'*64, created_at=now, updated_at=now) for pid in (project, other)])
        await connection.execute(insert(workbench_events), dict(id=str(uuid4()), project_id=project, command_id=command, digest='a'*64, action='add_keyword', payload={'private':'not public'}, actor='local_user', created_at=now))
    store = SimpleNamespace(engine=engine, get=AsyncMock(return_value={'id':project,'version':9}))
    try:
        client = make_client(SimpleNamespace(store=store, diagnostics=()))
        path = PREFIX + f'/projects/{project}/commands/{command}'
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        assert response.json() == {'contract_version':1,'project_id':project,'command_id':command,'state':'committed','action':'add_keyword','digest':'a'*64}
        assert client.get(PREFIX + f'/projects/{other}/commands/{command}').json()['state'] == 'not_observed'
        assert client.get(PREFIX + f'/projects/{project}/commands/not-uuid').status_code == 404
        assert client.get(path, headers={'Origin':'https://evil.test'}).status_code == 403
        assert client.get(path, headers={'X-Research-Token':'bad'}).status_code == 401
        assert client.post(path,json={}).status_code == 405
    finally:
        await engine.dispose()
