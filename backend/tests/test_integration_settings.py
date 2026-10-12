"""Integration settings use only prepared synthetic databases, never credentials/env."""

import json
import sqlite3

import pytest


def prepared(tmp_path):
    from backend.migrations.full_merge_v1 import prepare_schema

    path = tmp_path / "candidate.db"
    sqlite3.connect(path).close()
    prepare_schema(path, backup_verified=True, target_revision=2)
    return path


def test_explicit_revision_two_preserves_baseline_and_requires_backup(tmp_path):
    from backend.migrations.full_merge_v1 import prepare_schema

    path = tmp_path / "candidate.db"
    sqlite3.connect(path).close()
    assert prepare_schema(path, backup_verified=True)["revision"] == 1
    with pytest.raises(ValueError, match="backup"):
        prepare_schema(path, backup_verified=False, target_revision=2)
    assert (
        prepare_schema(path, backup_verified=True, target_revision=2)["revision"] == 2
    )
    assert (
        prepare_schema(path, backup_verified=True, target_revision=2)["revision"] == 2
    )


def test_mask_blank_isolation_and_database_authoritative(tmp_path):
    from services.integration_settings_service import IntegrationSettingsService

    path = prepared(tmp_path)
    api, worker = IntegrationSettingsService(path), IntegrationSettingsService(path)
    result = api.update("firecrawl", "main", {"api_key": "synthetic-main"})
    assert result["version"] == 1 and result["configured"] is True
    assert "synthetic-main" not in json.dumps(result)
    api.update("firecrawl", "research", {"api_key": "synthetic-research"})
    assert worker.resolve("firecrawl", "main")["api_key"] == "synthetic-main"
    assert worker.resolve("firecrawl", "research")["api_key"] == "synthetic-research"
    api.update("firecrawl", "research", {"api_key": ""})
    assert worker.resolve("firecrawl", "research")["api_key"] == "synthetic-research"
    api.update("firecrawl", "research", {"api_key": "synthetic-next"})
    assert worker.resolve("firecrawl", "research")["api_key"] == "synthetic-next"
    assert worker.public("firecrawl", "research")["version"] == 3


@pytest.mark.parametrize(
    "provider,purpose,changes",
    [
        ("openai", "research", {"api_key": "synthetic"}),
        ("apify", "../main", {"api_key": "synthetic"}),
        ("apify", "research", {"unrecognized": "synthetic"}),
        ("apify", "research", {"api_key": "space value"}),
        ("apify", "research", {"api_key": {"nested": "synthetic"}}),
    ],
)
def test_invalid_input_never_echoes_value(tmp_path, provider, purpose, changes):
    from services.integration_settings_service import IntegrationSettingsService

    service = IntegrationSettingsService(prepared(tmp_path))
    with pytest.raises(ValueError) as exc:
        service.update(provider, purpose, changes)
    assert "synthetic" not in str(exc.value)


def test_missing_database_schema_and_environment_fail_closed(tmp_path, monkeypatch):
    from services.integration_settings_service import IntegrationSettingsService

    monkeypatch.setenv("RABBIT_HOLE_APIFY_API_KEY", "synthetic-env")
    absent = tmp_path / "absent.db"
    service = IntegrationSettingsService(absent)
    with pytest.raises(ValueError, match="unprepared"):
        service.public("apify", "research")
    assert not absent.exists()
    path = tmp_path / "empty.db"
    sqlite3.connect(path).close()
    with pytest.raises(ValueError, match="unprepared"):
        IntegrationSettingsService(path).resolve("apify", "research")
    service = IntegrationSettingsService(prepared(tmp_path))
    assert service.resolve("apify", "research") == {}
    assert service.public("apify", "research")["configured"] is False


def test_explicit_legacy_fixture_import_never_overwrites(tmp_path):
    from services.integration_settings_service import (
        IntegrationSettingsService,
        import_legacy_provider_fixture,
    )

    path = prepared(tmp_path)
    service = IntegrationSettingsService(path)
    service.update("firecrawl", "main", {"api_key": "synthetic-main"})
    service.update("apify", "research", {"api_key": "synthetic-existing"})
    fixture = tmp_path / "keys.json"
    fixture.write_text(
        json.dumps({"apify": "synthetic-old", "firecrawl": "synthetic-old-crawl"})
    )
    before = fixture.read_bytes()
    import_legacy_provider_fixture(service, fixture, purpose="research")
    assert service.resolve("apify", "research")["api_key"] == "synthetic-existing"
    assert service.resolve("firecrawl", "main")["api_key"] == "synthetic-main"
    assert service.resolve("firecrawl", "research")["api_key"] == "synthetic-old-crawl"
    assert fixture.read_bytes() == before


def test_settings_routes_share_research_security_and_never_echo(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.integration_settings import create_integration_settings_router
    from routes.research import _session_token
    from services.integration_settings_service import IntegrationSettingsService

    app = FastAPI()
    app.state.integration_settings = IntegrationSettingsService(prepared(tmp_path))
    app.include_router(create_integration_settings_router())
    client = TestClient(app, base_url="http://127.0.0.1:9503")
    endpoint = "/api/settings/integrations/apify/research"
    assert client.get(endpoint).status_code == 401
    headers = {"X-Research-Token": _session_token, "Origin": "http://127.0.0.1:9502"}
    assert (
        client.patch(
            endpoint,
            headers={**headers, "Origin": "https://external.invalid"},
            json={"api_key": "synthetic-api"},
        ).status_code
        == 403
    )
    response = client.patch(
        endpoint, headers=headers, json={"api_key": "synthetic-api"}
    )
    assert response.status_code == 200 and response.json()["configured"]
    assert "synthetic-api" not in response.text
    assert client.get(endpoint, headers=headers).headers["cache-control"] == "no-store"
    bad = client.patch(endpoint, headers=headers, json={"api_key": "synthetic bad"})
    assert bad.status_code == 422 and "synthetic bad" not in bad.text


def test_unavailable_runtime_api_is_503(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.integration_settings import create_integration_settings_router
    from routes.research import _session_token

    app = FastAPI()
    app.include_router(create_integration_settings_router())
    response = TestClient(app, base_url="http://127.0.0.1:9503").get(
        "/api/settings/integrations/apify/research",
        headers={"X-Research-Token": _session_token},
    )
    assert response.status_code == 503


def test_production_dependencies_never_read_legacy_files_or_create_transport(
    tmp_path, monkeypatch
):
    from services.integration_settings_service import IntegrationSettingsService
    from services.research_integrations import assemble_non_ai_integrations
    from services.research_runtime import _research_imports

    _research_imports()
    import httpx
    from rabbit_hole.integrations.ad_translation import TranslationSettings
    from rabbit_hole.integrations.provider_settings import ProviderSecrets

    path = prepared(tmp_path)
    store = IntegrationSettingsService(path)
    monkeypatch.setattr(
        ProviderSecrets, "_read", lambda self: pytest.fail("legacy file access")
    )
    monkeypatch.setattr(
        TranslationSettings,
        "resolve",
        lambda self: pytest.fail("legacy translation access"),
    )
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **kw: pytest.fail("constructor transport")
    )
    bundle = assemble_non_ai_integrations(store, allow_external=False)
    assert bundle.providers.status() == {
        "apify": False,
        "serpapi": False,
        "firecrawl": False,
    }
    bundle.providers.update({"apify": "synthetic-one"})
    assert bundle.providers.get("apify") == "synthetic-one"
    store.update("apify", "research", {"api_key": "synthetic-two"})
    assert bundle.providers.get("apify") == "synthetic-two"
    store.update(
        "aliyun",
        "research",
        {"access_key_id": "synthetic-id", "access_key_secret": "synthetic-secret"},
    )
    credentials = bundle.translation_credentials()
    assert credentials.access_key_secret == "synthetic-secret"
    assert "synthetic-secret" not in repr(credentials)


@pytest.mark.asyncio
async def test_translation_unified_cache_and_closed_external_gate(
    tmp_path, monkeypatch
):
    from services.integration_settings_service import IntegrationSettingsService
    from services.research_integrations import assemble_non_ai_integrations
    from services.research_runtime import _research_imports

    _research_imports()
    from rabbit_hole.integrations.ad_translation import TranslationError

    path = prepared(tmp_path)
    store = IntegrationSettingsService(path)
    bundle = assemble_non_ai_integrations(store, allow_external=False)
    with pytest.raises(TranslationError, match="尚未授权"):
        await bundle.translator.translate("Original source")

    async def translated(text):
        return {"translated": "译文", "detected_language": "en"}

    monkeypatch.setattr(bundle.translator, "_request", translated)
    first = await bundle.translator.translate("Original source")
    assert first["cached"] is False
    restarted = assemble_non_ai_integrations(store, allow_external=False)
    assert (await restarted.translator.translate("Original source"))["cached"] is True
    with sqlite3.connect(path) as db:
        assert (
            db.execute("SELECT count(*) FROM research_translation_cache").fetchone()[0]
            == 1
        )
    assert {p.name for p in tmp_path.iterdir()} <= {
        "candidate.db",
        "candidate.db-wal",
        "candidate.db-shm",
    }


@pytest.mark.asyncio
async def test_feishu_injected_settings_rotation_and_no_probe(tmp_path, monkeypatch):
    from services.integration_settings_service import IntegrationSettingsService
    from services.research_integrations import assemble_non_ai_integrations
    from services.research_runtime import _research_imports

    _research_imports()
    import httpx

    path = prepared(tmp_path)
    store = IntegrationSettingsService(path)
    store.update(
        "feishu",
        "research",
        {
            "app_id": "synthetic-id",
            "app_secret": "synthetic-secret",
            "base_app_token": "synthetic-base",
        },
    )
    calls = []

    def transport(request):
        calls.append(request)
        if request.url.path.endswith("/internal"):
            data = json.loads(request.content)
            assert (
                data["app_secret"] == store.resolve("feishu", "research")["app_secret"]
            )
            return httpx.Response(
                200, json={"tenant_access_token": "synthetic-tenant", "expire": 7200}
            )
        assert store.resolve("feishu", "research")["base_app_token"] in request.url.path
        return httpx.Response(
            200, json={"code": 0, "data": {"items": [], "has_more": False}}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        bundle = assemble_non_ai_integrations(
            store, allow_external=True, feishu_http_client=client
        )
        assert calls == []
        await bundle.feishu.list_tables()
        store.update(
            "feishu",
            "research",
            {"app_secret": "synthetic-next", "base_app_token": "synthetic-next-base"},
        )
        await bundle.feishu.list_tables()
        assert len(calls) == 4
        closed = assemble_non_ai_integrations(
            store, allow_external=False, feishu_http_client=client
        )
        with pytest.raises(PermissionError, match="not_authorized"):
            await closed.feishu.list_tables()
        assert len(calls) == 4


def test_revision_two_partial_tables_atomic_refusal(tmp_path):
    from backend.migrations.full_merge_v1 import prepare_schema

    path = prepared(tmp_path)
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE research_translation_cache")
    with pytest.raises(ValueError, match="partial prepared schema"):
        prepare_schema(path, backup_verified=True, target_revision=2)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT revision FROM full_merge_schema").fetchone()[0] == 2
        assert not db.execute(
            "SELECT name FROM sqlite_master WHERE name='research_translation_cache'"
        ).fetchall()


@pytest.mark.asyncio
async def test_runtime_owned_dependencies_require_revision_two_and_keep_activation_closed(
    tmp_path,
):
    from services.research_runtime import open_research_runtime, resolve_runtime_paths

    from backend.migrations.full_merge_v1 import prepare_schema

    path = tmp_path / "candidate.db"
    sqlite3.connect(path).close()
    prepare_schema(path, backup_verified=True)
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    paths = resolve_runtime_paths(path, root)
    for directory in (
        paths.evidence_root,
        paths.keys_root,
        paths.browser_root,
        paths.lock_root,
    ):
        directory.mkdir(mode=0o700)
    for name, content in [
        ("evidence-signing.key", b"x" * 32),
        (
            "evidence-namespace.json",
            json.dumps(
                {
                    "version": 1,
                    "evidence_bucket": "fixture-bucket",
                    "collector_version": "fixture-collector",
                }
            ).encode(),
        ),
    ]:
        target = paths.keys_root / name
        target.write_bytes(content)
        target.chmod(0o600)
    async with open_research_runtime(
        paths, allow_commands=True, allow_external=False
    ) as legacy:
        assert legacy.workbench_services == {}
        assert legacy.settings_store is None
    prepare_schema(path, backup_verified=True, target_revision=2)
    async with open_research_runtime(
        paths, allow_commands=True, allow_external=False
    ) as runtime:
        assert runtime.settings_store.database == path
        assert "provider_settings" in runtime.workbench_services
        assert "ai_settings" not in runtime.workbench_services
        assert "generate_direction" not in runtime.workbench_services
        assert runtime.non_ai_integrations.feishu._client is None
        runtime.settings_store.update(
            "feishu",
            "research",
            {
                "app_id": "synthetic-id",
                "app_secret": "synthetic-secret",
                "base_app_token": "synthetic-base",
            },
        )
        from uuid import uuid4

        with pytest.raises(Exception, match="尚未授权"):
            await runtime.workbench_services["sync"].preview(str(uuid4()), 1)
        from services.research_worker import build_local_worker_services

        with pytest.raises(RuntimeError, match="not_ready"):
            build_local_worker_services(runtime)


@pytest.mark.asyncio
async def test_lifecycle_settings_store_shared_with_runtime(tmp_path):
    from fastapi import FastAPI
    from routes.research_workbench import research_lifespan

    from backend.migrations.full_merge_v1 import prepare_schema

    path = tmp_path / "candidate.db"
    sqlite3.connect(path).close()
    prepare_schema(path, backup_verified=True, target_revision=2)
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    for name in ("evidence", "keys", "browser", "locks"):
        (root / name).mkdir(mode=0o700)
    key = root / "keys/evidence-signing.key"
    key.write_bytes(b"x" * 32)
    key.chmod(0o600)
    namespace = root / "keys/evidence-namespace.json"
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
    app = FastAPI()
    async with research_lifespan(
        app, config={"enabled": True, "mode": "local"}, database=path, data_root=root
    ):
        assert app.state.research_runtime is not None
        assert (
            app.state.integration_settings is app.state.research_runtime.settings_store
        )
    assert app.state.integration_settings is None


def test_corrupt_integration_schema_returns_unconfigured_not_parameter_error(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.integration_settings import create_integration_settings_router
    from routes.research import _session_token
    from services.integration_settings_service import IntegrationSettingsService

    path = prepared(tmp_path)
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE research_translation_cache")
    app = FastAPI()
    app.state.integration_settings = IntegrationSettingsService(path)
    app.include_router(create_integration_settings_router())
    response = TestClient(app, base_url="http://127.0.0.1:9503").get(
        "/api/settings/integrations/apify/research",
        headers={"X-Research-Token": _session_token},
    )
    assert response.status_code == 503


def test_multi_writer_version_and_main_provider_binding_preserved(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    from db import Base
    from services.integration_settings_service import IntegrationSettingsService
    from sqlalchemy import create_engine

    path = prepared(tmp_path)
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            Base.metadata.tables["ai_provider_configs"]
            .insert()
            .values(
                id=71,
                name="fixture",
                protocol="gemini",
                api_key="synthetic-ai-key",
                text_model="fixture-model",
            )
        )
        conn.execute(
            Base.metadata.tables["ai_capability_bindings"]
            .insert()
            .values(capability="text", provider_config_id=71)
        )
    engine.dispose()
    service = IntegrationSettingsService(path)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(
            pool.map(
                lambda i: IntegrationSettingsService(path).update(
                    "apify", "research", {"api_key": f"synthetic-{i}"}
                ),
                range(8),
            )
        )
    assert sorted(r["version"] for r in results) == list(range(1, 9))
    assert service.public("apify", "research")["version"] == 8
    with sqlite3.connect(path) as db:
        assert (
            db.execute(
                "SELECT api_key FROM ai_provider_configs WHERE id=71"
            ).fetchone()[0]
            == "synthetic-ai-key"
        )
        assert (
            db.execute(
                'SELECT provider_config_id FROM ai_capability_bindings WHERE capability="text"'
            ).fetchone()[0]
            == 71
        )


def test_blank_null_and_masked_value_semantics(tmp_path):
    from services.integration_settings_service import (
        IntegrationSettingsService,
        ResearchProviderSettings,
    )

    store = IntegrationSettingsService(prepared(tmp_path))
    adapter = ResearchProviderSettings(store)
    adapter.update({"apify": "synthetic-original"})
    adapter.update({"apify": ""})
    assert adapter.get("apify") == "synthetic-original"
    with pytest.raises(ValueError):
        adapter.update({"serpapi": "synthetic-no-partial", "apify": "••••••••"})
    assert adapter.get("serpapi") == ""
    adapter.update({"apify": None})
    assert adapter.status()["apify"] is False


@pytest.mark.asyncio
async def test_production_runner_collector_injection_never_reads_legacy_or_environment(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace

    from services.integration_settings_service import IntegrationSettingsService
    from services.research_integrations import assemble_non_ai_integrations
    from services.research_runtime import _research_imports

    _research_imports()
    import rabbit_hole.integrations.provider_budget as provider
    from rabbit_hole.integrations.collectors.provider_api import ProviderError

    store = IntegrationSettingsService(prepared(tmp_path))
    bundle = assemble_non_ai_integrations(store, allow_external=False)
    monkeypatch.setattr(
        provider, "ProviderSecrets", lambda: pytest.fail("old vault constructor")
    )
    monkeypatch.setattr(provider.os, "environ", {})
    runner = bundle.make_runner(SimpleNamespace(), SimpleNamespace(), None)
    assert runner.provider_key("apify") == ""
    store.update(
        "apify", "research", {"api_key": "synthetic-current", "daily_limit": 7}
    )
    assert runner.provider_key("apify") == "synthetic-current"
    assert runner.provider_budget_limits("apify") == 7
    with pytest.raises(ProviderError, match="未配置"):
        runner.provider_budget_limits("serpapi")
    with pytest.raises(PermissionError, match="not_authorized"):
        await runner.execute({"kind": "scan", "payload": {"execution_mode": "api"}}, {})
    # Actual provider boundary receives injected key; no caller-level gate bypass.
    runner.allow_external = True
    calls = []

    async def meta(fake_runner, action, project, client, key):
        calls.append(key)
        return {"provider": "apify"}

    import httpx

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: pytest.fail("actual transport"))
    )
    monkeypatch.setattr(provider.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(provider, "meta", meta)
    assert (await provider.execute_provider(runner, {"kind": "scan"}, {}))[
        "provider"
    ] == "apify"
    assert calls == ["synthetic-current"]


@pytest.mark.parametrize("value", [True, 0, -1, "8", None, 1000001])
def test_production_budget_requires_explicit_valid_integer(tmp_path, value):
    from services.integration_settings_service import IntegrationSettingsService

    store = IntegrationSettingsService(prepared(tmp_path))
    with pytest.raises(ValueError, match="daily limit"):
        store.update("apify", "research", {"daily_limit": value})
    assert store.resolve("apify", "research") == {}


def test_partial_revision_one_upgrade_rolls_back_and_retains_existing_values(tmp_path):
    from backend.migrations.full_merge_v1 import prepare_schema

    path = tmp_path / "candidate.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE original(value TEXT)")
        db.execute("INSERT INTO original VALUES ('preserved')")
    prepare_schema(path, backup_verified=True)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE research_translation_cache(key TEXT)")
    with pytest.raises(ValueError, match="partial integration schema"):
        prepare_schema(path, backup_verified=True, target_revision=2)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT revision FROM full_merge_schema").fetchone()[0] == 1
        assert db.execute("SELECT value FROM original").fetchone()[0] == "preserved"
        assert not db.execute(
            "SELECT name FROM sqlite_master WHERE name='integration_settings'"
        ).fetchall()


@pytest.mark.asyncio
async def test_feishu_warm_named_table_view_rotation_uses_current_base_ids(tmp_path):
    import httpx
    from services.integration_settings_service import IntegrationSettingsService
    from services.research_integrations import assemble_non_ai_integrations

    store = IntegrationSettingsService(prepared(tmp_path))
    store.update(
        "feishu",
        "research",
        {
            "app_id": "synthetic-id",
            "app_secret": "synthetic-secret",
            "base_app_token": "base-old",
        },
    )
    calls = []

    def transport(request):
        calls.append(request)
        if request.url.path.endswith("/internal"):
            return httpx.Response(
                200, json={"tenant_access_token": "synthetic-token", "expire": 7200}
            )
        suffix = "New" if "/bases/base-new/" in request.url.path else "Old"
        if request.url.path.endswith("/tables"):
            data = {
                "items": [{"name": "Products", "id": "tbl" + suffix}],
                "has_more": False,
            }
        elif request.url.path.endswith("/views"):
            data = {
                "items": [{"name": "Active", "id": "view" + suffix}],
                "has_more": False,
            }
        else:
            data = {"records": [], "has_more": False}
        return httpx.Response(200, json={"code": 0, "data": data})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
        client = assemble_non_ai_integrations(
            store, allow_external=True, feishu_http_client=http
        ).feishu
        assert await client.resolve_table_id("Products") == "tblOld"
        assert await client.resolve_view_id("Products", "Active") == "viewOld"
        store.update("feishu", "research", {"base_app_token": "base-new"})
        assert await client.list_records("Products", view_name="Active") == []
        request = calls[-1]
        assert (
            request.url.path
            == "/open-apis/base/v3/bases/base-new/tables/tblNew/records"
        )
        assert request.url.params["view_id"] == "viewNew"


@pytest.mark.asyncio
async def test_feishu_rotation_during_lookup_is_next_operation_snapshot(tmp_path):
    import httpx
    from services.integration_settings_service import IntegrationSettingsService
    from services.research_integrations import assemble_non_ai_integrations

    store = IntegrationSettingsService(prepared(tmp_path))
    store.update(
        "feishu",
        "research",
        {
            "app_id": "synthetic-id",
            "app_secret": "synthetic-secret",
            "base_app_token": "base-old",
        },
    )
    paths = []

    def transport(request):
        paths.append(request.url.path)
        if request.url.path.endswith("/internal"):
            return httpx.Response(
                200, json={"tenant_access_token": "synthetic-token", "expire": 7200}
            )
        suffix = "New" if "/bases/base-new/" in request.url.path else "Old"
        if request.url.path.endswith("/tables"):
            if suffix == "Old":
                store.update("feishu", "research", {"base_app_token": "base-new"})
            data = {
                "items": [{"name": "Products", "id": "tbl" + suffix}],
                "has_more": False,
            }
        elif request.url.path.endswith("/views"):
            data = {
                "items": [{"name": "Active", "id": "view" + suffix}],
                "has_more": False,
            }
        else:
            data = {"records": [], "has_more": False}
        return httpx.Response(200, json={"code": 0, "data": data})

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
        client = assemble_non_ai_integrations(
            store, allow_external=True, feishu_http_client=http
        ).feishu
        await client.list_records("Products", view_name="Active")
        assert paths[-1] == "/open-apis/base/v3/bases/base-old/tables/tblOld/records"
        await client.list_records("Products", view_name="Active")
        assert paths[-1] == "/open-apis/base/v3/bases/base-new/tables/tblNew/records"
