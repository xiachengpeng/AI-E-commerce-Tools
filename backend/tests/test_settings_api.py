import asyncio
import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from db import Base, get_db
from main import app


VALID_TEXT_RESPONSE = {
    "candidates": [
        {"content": {"parts": [{"text": "OK"}]}}
    ]
}
TINY_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe"
    "AAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)
TINY_JPEG_BASE64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL"
    "DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/"
    "2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QA"
    "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF"
    "BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK"
    "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1"
    "dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG"
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEB"
    "AQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC"
    "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRom"
    "JygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE"
    "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU"
    "1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3"
    "E//Z"
)
VALID_IMAGE_RESPONSE = {
    "candidates": [
        {
            "content": {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": "image/png",
                            "data": TINY_PNG_BASE64,
                        }
                    }
                ]
            }
        }
    ]
}


def _provider_data(**overrides):
    data = {
        "name": "Relay",
        "protocol": "openai_compatible",
        "base_url": "https://relay.example.com",
        "api_key": "sk-secret-1234",
        "text_model": "text",
        "supports_text": True,
        "supports_image": False,
        "timeout_seconds": 30,
        "max_retries": 1,
        "enabled": True,
    }
    data.update(overrides)
    return data


def _make_client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine)

    def override_get_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app), testing_session


def test_provider_read_never_returns_secret():
    client, _ = _make_client()
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        )
    finally:
        app.dependency_overrides.clear()

    assert created.status_code == 201
    item = created.json()
    assert "sk-secret-1234" not in str(item)
    assert "incarnation_id" not in item
    assert item["has_api_key"] is True
    assert item["api_key_masked"] == "sk-****1234"


@pytest.mark.parametrize("length", range(1, 9))
def test_provider_read_fully_masks_short_api_keys(length):
    client, _ = _make_client()
    api_key = "x" * length
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(api_key=api_key),
        )
    finally:
        app.dependency_overrides.clear()

    assert created.status_code == 201
    masked = created.json()["api_key_masked"]
    assert masked == "********"
    assert set(masked) == {"*"}


def test_bound_provider_delete_returns_conflict():
    client, _ = _make_client()
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        )
        provider_id = created.json()["id"]
        bound = client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": provider_id},
        )
        response = client.delete(
            f"/api/settings/ai/providers/{provider_id}"
        )
    finally:
        app.dependency_overrides.clear()

    assert bound.status_code == 200
    assert response.status_code == 409


def test_recent_logs_returns_list(monkeypatch):
    from services.app_log_service import AppLogService

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr("main.app_logs", logs, raising=False)
    client, _ = _make_client()
    try:
        response = client.get("/api/settings/logs/recent")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_list_and_update_never_return_vertex_credentials_and_preserve_empty_secret():
    client, testing_session = _make_client()
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(
                vertex_project_id="secret-project",
                vertex_location="secret-location",
                vertex_key_path="/secret/credentials.json",
            ),
        )
        provider_id = created.json()["id"]

        listed = client.get("/api/settings/ai/providers")
        updated = client.put(
            f"/api/settings/ai/providers/{provider_id}",
            json=_provider_data(name="Relay renamed", api_key=""),
        )

        from db import AIProviderConfig

        db = testing_session()
        try:
            stored_key = db.get(AIProviderConfig, provider_id).api_key
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert listed.status_code == 200
    assert updated.status_code == 200
    response_text = f"{listed.json()} {updated.json()}"
    assert "sk-secret-1234" not in response_text
    assert "secret-project" not in response_text
    assert "secret-location" not in response_text
    assert "/secret/credentials.json" not in response_text
    assert "vertex_project_id" not in response_text
    assert "vertex_location" not in response_text
    assert "vertex_key_path" not in response_text
    assert updated.json()["name"] == "Relay renamed"
    assert updated.json()["has_api_key"] is True
    assert updated.json()["api_key_masked"] == "sk-****1234"
    assert stored_key == "sk-secret-1234"


def test_provider_api_update_clears_stale_connection_metadata():
    client, testing_session = _make_client()
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        ).json()["id"]

        from db import AIProviderConfig

        db = testing_session()
        try:
            row = db.get(AIProviderConfig, provider_id)
            row.last_test_status = "success"
            row.last_test_message = "连接成功"
            row.last_tested_at = datetime.datetime.now(datetime.timezone.utc)
            db.commit()
        finally:
            db.close()

        response = client.put(
            f"/api/settings/ai/providers/{provider_id}",
            json=_provider_data(
                base_url="https://changed-relay.example.com",
            ),
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["last_test_status"] is None
    assert response.json()["last_test_message"] is None
    assert response.json()["last_tested_at"] is None


def test_display_name_update_does_not_churn_runtime_or_analysis_cache(
    monkeypatch,
):
    import main
    from db import AIProviderConfig

    invalidate_clients = MagicMock()
    monkeypatch.setattr(main, "invalidate_provider_clients", invalidate_clients)
    monkeypatch.setattr(main, "analysis_cache", {})
    client, testing_session = _make_client()
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        ).json()["id"]
        db = testing_session()
        try:
            row = db.get(AIProviderConfig, provider_id)
            row.last_test_status = "success"
            row.last_test_message = "连接成功"
            row.last_tested_at = datetime.datetime.now(datetime.timezone.utc)
            row.last_test_capability = "text"
            db.commit()
        finally:
            db.close()
        main.analysis_cache["existing-analysis"] = ("time", "result")

        response = client.put(
            f"/api/settings/ai/providers/{provider_id}",
            json=_provider_data(name="Display name only"),
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["config_version"] == 1
    assert response.json()["last_test_status"] == "success"
    assert response.json()["last_test_capability"] == "text"
    invalidate_clients.assert_not_called()
    assert main.analysis_cache == {
        "existing-analysis": ("time", "result")
    }


def test_effective_update_bumps_version_retires_clients_and_clears_cache(
    monkeypatch,
):
    import main
    from db import AIProviderConfig

    invalidate_clients = MagicMock()
    monkeypatch.setattr(main, "invalidate_provider_clients", invalidate_clients)
    monkeypatch.setattr(
        main,
        "analysis_cache",
        {"existing-analysis": ("time", "result")},
    )
    client, testing_session = _make_client()
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        ).json()["id"]
        db = testing_session()
        try:
            row = db.get(AIProviderConfig, provider_id)
            row.last_test_status = "success"
            row.last_test_message = "连接成功"
            row.last_tested_at = datetime.datetime.now(datetime.timezone.utc)
            row.last_test_capability = "text"
            db.commit()
        finally:
            db.close()
        main.analysis_cache["existing-analysis"] = ("time", "result")

        response = client.put(
            f"/api/settings/ai/providers/{provider_id}",
            json=_provider_data(
                base_url="https://changed-relay.example.com",
            ),
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["config_version"] == 2
    assert response.json()["last_test_status"] is None
    assert response.json()["last_test_message"] is None
    assert response.json()["last_tested_at"] is None
    assert response.json()["last_test_capability"] is None
    invalidate_clients.assert_called_once_with(provider_id)
    assert main.analysis_cache == {}


def test_delete_recreate_same_provider_identity_cannot_reuse_analysis_cache(
    monkeypatch,
):
    import main

    monkeypatch.setattr(main, "analysis_cache", {})
    client, _ = _make_client()
    try:
        first = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(name="First incarnation"),
        ).json()
        identity = (first["id"], first["config_version"])
        main.analysis_cache["old-result"] = ("time", "first result")

        deleted = client.delete(
            f"/api/settings/ai/providers/{first['id']}"
        )
        replacement = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(name="Replacement incarnation"),
        ).json()
    finally:
        app.dependency_overrides.clear()

    assert deleted.status_code == 200
    assert (replacement["id"], replacement["config_version"]) == identity
    assert "old-result" not in main.analysis_cache


def test_binding_change_invalidates_analysis_cache(monkeypatch):
    import main

    monkeypatch.setattr(main, "analysis_cache", {})
    client, _ = _make_client()
    try:
        first_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(name="First"),
        ).json()["id"]
        second_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(name="Second"),
        ).json()["id"]
        client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": first_id},
        )
        main.analysis_cache["bound-first"] = ("time", "first result")

        switched = client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": second_id},
        )
    finally:
        app.dependency_overrides.clear()

    assert switched.status_code == 200
    assert main.analysis_cache == {}


def test_missing_provider_mutations_return_not_found():
    client, _ = _make_client()
    try:
        responses = [
            client.put(
                "/api/settings/ai/providers/999",
                json=_provider_data(),
            ),
            client.delete("/api/settings/ai/providers/999"),
            client.post("/api/settings/ai/providers/999/enable"),
            client.post("/api/settings/ai/providers/999/disable"),
        ]
    finally:
        app.dependency_overrides.clear()

    assert [response.status_code for response in responses] == [
        404,
        404,
        404,
        404,
    ]


def test_enable_disable_and_binding_list_contracts():
    client, _ = _make_client()
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        )
        provider_id = created.json()["id"]
        disabled = client.post(
            f"/api/settings/ai/providers/{provider_id}/disable"
        )
        enabled = client.post(
            f"/api/settings/ai/providers/{provider_id}/enable"
        )
        bound = client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": provider_id},
        )
        bindings = client.get("/api/settings/ai/bindings")
        disable_bound = client.post(
            f"/api/settings/ai/providers/{provider_id}/disable"
        )
    finally:
        app.dependency_overrides.clear()

    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    assert bound.status_code == 200
    assert bindings.status_code == 200
    assert bindings.json()["items"] == [bound.json()]
    assert disable_bound.status_code == 409


def test_incompatible_or_missing_binding_is_rejected():
    client, _ = _make_client()
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(supports_image=False),
        )
        provider_id = created.json()["id"]
        incompatible = client.put(
            "/api/settings/ai/bindings/image",
            json={"provider_config_id": provider_id},
        )
        missing = client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": 999},
        )
        invalid_capability = client.put(
            "/api/settings/ai/bindings/audio",
            json={"provider_config_id": provider_id},
        )
    finally:
        app.dependency_overrides.clear()

    assert incompatible.status_code == 409
    assert missing.status_code == 404
    assert invalid_capability.status_code == 422


@pytest.mark.parametrize(
    "invalid_update",
    [
        {"supports_text": False},
        {"text_model": ""},
        {"supports_image": False},
        {"image_model": ""},
    ],
)
def test_bound_provider_update_rejects_invalid_capability(invalid_update):
    client, testing_session = _make_client()
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(
                supports_image=True,
                image_model="image",
            ),
        )
        provider_id = created.json()["id"]
        client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": provider_id},
        )
        client.put(
            "/api/settings/ai/bindings/image",
            json={"provider_config_id": provider_id},
        )
        update_payload = _provider_data(
            supports_image=True,
            image_model="image",
        )
        update_payload.update(invalid_update)
        response = client.put(
            f"/api/settings/ai/providers/{provider_id}",
            json=update_payload,
        )

        from db import AIProviderConfig

        db = testing_session()
        try:
            stored = db.get(AIProviderConfig, provider_id)
            persisted = {
                "supports_text": bool(stored.supports_text),
                "text_model": stored.text_model,
                "supports_image": bool(stored.supports_image),
                "image_model": stored.image_model,
                "config_version": stored.config_version,
            }
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 409
    assert persisted == {
        "supports_text": True,
        "text_model": "text",
        "supports_image": True,
        "image_model": "image",
        "config_version": 1,
    }


def test_duplicate_provider_name_returns_conflict():
    client, _ = _make_client()
    try:
        first = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(name="Duplicate"),
        )
        second = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(name="Duplicate"),
        )
        other = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(name="Other"),
        )
        renamed = client.put(
            f"/api/settings/ai/providers/{other.json()['id']}",
            json=_provider_data(name="Duplicate"),
        )
    finally:
        app.dependency_overrides.clear()

    assert first.status_code == 201
    assert second.status_code == 409
    assert renamed.status_code == 409


def test_connection_test_requires_at_least_one_provider_source():
    client, _ = _make_client()
    try:
        neither = client.post(
            "/api/settings/ai/providers/test",
            json={"capability": "text"},
        )
    finally:
        app.dependency_overrides.clear()

    assert neither.status_code == 422


def test_connection_validation_error_never_echoes_draft_secrets():
    secrets = (
        "draft-api-key-secret",
        "draft-vertex-project-secret",
        "draft-vertex-location-secret",
        "/private/draft-vertex-key-secret.json",
    )
    client, _ = _make_client()
    try:
        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "provider_id": 1,
                "draft": _provider_data(
                    api_key=secrets[0],
                    vertex_project_id=secrets[1],
                    vertex_location=secrets[2],
                    vertex_key_path=secrets[3],
                ),
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 422
    for secret in secrets:
        assert secret not in response.text
    assert not any(
        key == "input"
        for error in response.json()["detail"]
        for key in error
    )


def test_saved_connection_test_updates_metadata_without_changing_binding(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_TEXT_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter, raising=False)
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        )
        provider_id = created.json()["id"]
        client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": provider_id},
        )

        response = client.post(
            "/api/settings/ai/providers/test",
            json={"provider_id": provider_id, "capability": "text"},
        )

        from db import AICapabilityBinding, AIProviderConfig

        db = testing_session()
        try:
            provider = db.get(AIProviderConfig, provider_id)
            binding = db.get(AICapabilityBinding, "text")
            saved_metadata = (
                provider.last_test_status,
                provider.last_test_message,
                provider.last_tested_at,
            )
            bound_provider_id = binding.provider_config_id
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["capability"] == "text"
    assert response.json()["duration_ms"] >= 0
    assert response.json()["message"] == "连接成功"
    assert saved_metadata[0:2] == ("success", "连接成功")
    assert saved_metadata[2] is not None
    assert bound_provider_id == provider_id
    snapshot, payload = adapter.generate.await_args.args
    assert snapshot.id == provider_id
    assert snapshot.api_key == "sk-secret-1234"
    assert payload["contents"][0]["parts"][0]["text"] == "Reply with OK"


def test_saved_connection_test_serializes_the_tested_capability(monkeypatch):
    client, _ = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_TEXT_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(
                supports_image=True,
                image_model="image",
            ),
        ).json()["id"]

        tested = client.post(
            f"/api/settings/ai/providers/{provider_id}/test",
            json={"capability": "text"},
        )
        listed = client.get("/api/settings/ai/providers")
    finally:
        app.dependency_overrides.clear()

    assert tested.status_code == 200
    assert tested.json()["capability"] == "text"
    assert listed.json()["items"][0]["last_test_capability"] == "text"


def test_saved_preflight_failure_replaces_prior_success_metadata(
    monkeypatch,
    tmp_path,
):
    credential_path = tmp_path / "vertex-service-account.json"
    credential_path.write_text("{}", encoding="utf-8")
    adapter = type("Adapter", (), {"generate": AsyncMock()})()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    client, testing_session = _make_client()
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(
                protocol="vertex",
                base_url=None,
                api_key=None,
                vertex_project_id="project",
                vertex_location="us-central1",
                vertex_key_path=str(credential_path),
            ),
        ).json()["id"]

        from db import AIProviderConfig

        db = testing_session()
        try:
            row = db.get(AIProviderConfig, provider_id)
            row.last_test_status = "success"
            row.last_test_message = "连接成功"
            row.last_tested_at = datetime.datetime.now(datetime.timezone.utc)
            db.commit()
        finally:
            db.close()
        credential_path.unlink()

        response = client.post(
            f"/api/settings/ai/providers/{provider_id}/test",
            json={"capability": "text"},
        )

        db = testing_session()
        try:
            row = db.get(AIProviderConfig, provider_id)
            persisted = (
                row.last_test_status,
                row.last_test_message,
                row.last_tested_at,
                getattr(row, "last_test_capability", None),
            )
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "error"
    assert response.json()["message"] == "Vertex 凭据文件路径无效或不可读"
    assert persisted[0:2] == (
        "error",
        "Vertex 凭据文件路径无效或不可读",
    )
    assert persisted[2] is not None
    assert persisted[3] == "text"
    adapter.generate.assert_not_awaited()


@pytest.mark.asyncio
async def test_saved_connection_result_is_discarded_after_concurrent_edit(
    monkeypatch,
    tmp_path,
):
    import main
    from models.settings import ProviderConnectionTest
    from services.ai_config_service import create_provider, update_provider

    engine = create_engine(
        f"sqlite:///{tmp_path / 'connection-test-race.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    setup_db = sessions()
    row = create_provider(setup_db, _provider_data())
    provider_id = row.id
    row.last_test_status = "success"
    row.last_test_message = "连接成功"
    row.last_tested_at = datetime.datetime.now(datetime.timezone.utc)
    setup_db.commit()
    setup_db.close()

    test_db = sessions()
    edit_db = sessions()
    request_started = asyncio.Event()
    release_response = asyncio.Event()

    class BlockingAdapter:
        async def generate(self, snapshot, payload):
            request_started.set()
            await release_response.wait()
            return VALID_TEXT_RESPONSE

    monkeypatch.setattr(main, "get_adapter", lambda protocol: BlockingAdapter())
    pending = asyncio.create_task(
        main._run_ai_provider_connection_test(
            ProviderConnectionTest(
                provider_id=provider_id,
                capability="text",
            ),
            test_db,
        )
    )
    await asyncio.wait_for(request_started.wait(), 0.5)

    updated = update_provider(
        edit_db,
        provider_id,
        {"base_url": "https://changed-relay.example.com"},
    )
    assert updated.config_version == 2
    assert updated.last_test_status is None
    release_response.set()
    result = await asyncio.wait_for(pending, 0.5)

    verify_db = sessions()
    try:
        persisted = verify_db.get(main.AIProviderConfig, provider_id)
        metadata = (
            persisted.last_test_status,
            persisted.last_test_message,
            persisted.last_tested_at,
            getattr(persisted, "last_test_capability", None),
        )
    finally:
        test_db.close()
        edit_db.close()
        verify_db.close()

    assert result["status"] == "error"
    assert result["message"] == "配置已变更，请重新测试"
    assert metadata == (None, None, None, None)


@pytest.mark.asyncio
async def test_saved_connection_result_is_discarded_after_delete_recreate(
    monkeypatch,
    tmp_path,
):
    import main
    from models.settings import ProviderConnectionTest
    from services.ai_config_service import create_provider, delete_provider

    engine = create_engine(
        f"sqlite:///{tmp_path / 'connection-delete-recreate.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    setup_db = sessions()
    original = create_provider(
        setup_db,
        _provider_data(name="Original incarnation"),
    )
    provider_id = original.id
    original_incarnation = original.incarnation_id
    setup_db.close()

    test_db = sessions()
    mutation_db = sessions()
    request_started = asyncio.Event()
    release_response = asyncio.Event()

    class BlockingAdapter:
        async def generate(self, snapshot, payload):
            request_started.set()
            await release_response.wait()
            return VALID_TEXT_RESPONSE

    monkeypatch.setattr(main, "get_adapter", lambda protocol: BlockingAdapter())
    pending = asyncio.create_task(
        main._run_ai_provider_connection_test(
            ProviderConnectionTest(
                provider_id=provider_id,
                capability="text",
            ),
            test_db,
        )
    )
    await asyncio.wait_for(request_started.wait(), 0.5)

    delete_provider(mutation_db, provider_id)
    replacement = create_provider(
        mutation_db,
        _provider_data(name="Replacement incarnation"),
    )
    assert replacement.id == provider_id
    assert replacement.config_version == 1
    assert replacement.incarnation_id != original_incarnation

    release_response.set()
    result = await asyncio.wait_for(pending, 0.5)

    verify_db = sessions()
    try:
        persisted = verify_db.get(main.AIProviderConfig, provider_id)
        metadata = (
            persisted.last_test_status,
            persisted.last_test_message,
            persisted.last_tested_at,
            persisted.last_test_capability,
        )
    finally:
        test_db.close()
        mutation_db.close()
        verify_db.close()

    assert result["status"] == "error"
    assert result["message"] == "配置已变更，请重新测试"
    assert metadata == (None, None, None, None)


@pytest.mark.asyncio
async def test_inflight_analysis_does_not_cache_after_delete_recreate(
    monkeypatch,
    tmp_path,
):
    import main
    from db import AICapabilityBinding
    from models.request import CompareRequest
    from services.ai_config_service import (
        create_provider,
        delete_provider,
        set_binding,
    )

    engine = create_engine(
        f"sqlite:///{tmp_path / 'analysis-delete-recreate.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    setup_db = sessions()
    original = create_provider(
        setup_db,
        _provider_data(name="Original analysis provider"),
    )
    set_binding(setup_db, "text", original.id)
    provider_id = original.id
    original_incarnation = original.incarnation_id
    setup_db.close()

    request_started = asyncio.Event()
    release_response = asyncio.Event()

    async def blocking_fetch(url, max_age):
        request_started.set()
        await release_response.wait()
        return "product markdown"

    async def product_summary(url, **kwargs):
        return {
            "product_name": "Old analysis",
            "price": "$1",
            "core_selling_points": [],
            "target_audience": [],
            "use_scenarios": [],
            "strengths": "strength",
            "weaknesses": "weakness",
            "reviews_count": "0",
            "source_url": url,
        }

    async def score(_product):
        return {
            "product": "Old analysis",
            "opportunity_score": 1,
            "difficulty_score": 1,
            "final_decision": "Pending",
            "decision_details": {
                "confidence": "medium",
                "reason": "",
            },
            "sub_scores": {},
        }

    async def deep_analysis(url, **kwargs):
        return {"source_url": url, "marker": "old-incarnation"}

    monkeypatch.setattr(main, "SessionLocal", sessions)
    monkeypatch.setattr(main, "analysis_cache", {})
    monkeypatch.setattr(main, "fetch_markdown", blocking_fetch)
    monkeypatch.setattr(main, "process_single_url", product_summary)
    monkeypatch.setattr(main, "calculate_score", score)
    monkeypatch.setattr(main, "process_single_url_deep", deep_analysis)

    pending = asyncio.create_task(
        main.compare(
            CompareRequest(urls=["https://example.com/product"])
        )
    )
    await asyncio.wait_for(request_started.wait(), 0.5)

    mutation_db = sessions()
    binding = mutation_db.get(AICapabilityBinding, "text")
    mutation_db.delete(binding)
    mutation_db.commit()
    delete_provider(mutation_db, provider_id)
    replacement = create_provider(
        mutation_db,
        _provider_data(name="Replacement analysis provider"),
    )
    set_binding(mutation_db, "text", replacement.id)
    assert replacement.id == provider_id
    assert replacement.config_version == 1
    assert replacement.incarnation_id != original_incarnation

    release_response.set()
    result = await asyncio.wait_for(pending, 0.5)
    mutation_db.close()

    assert result.status == "success"
    assert main.analysis_cache == {}


def test_draft_connection_test_does_not_persist_or_change_bindings(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_IMAGE_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter, raising=False)
    try:
        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "draft": _provider_data(
                    name="Unsaved",
                    image_model="image",
                    supports_image=True,
                ),
                "capability": "image",
            },
        )

        from db import AICapabilityBinding, AIProviderConfig

        db = testing_session()
        try:
            provider_count = db.query(AIProviderConfig).count()
            binding_count = db.query(AICapabilityBinding).count()
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["capability"] == "image"
    assert provider_count == 0
    assert binding_count == 0
    snapshot, payload = adapter.generate.await_args.args
    assert snapshot.name == "Unsaved"
    assert snapshot.capability == "image"
    assert "1×1" in payload["contents"][0]["parts"][0]["text"]
    assert payload["generationConfig"] == {
        "responseModalities": ["IMAGE"],
        "imageConfig": {"aspectRatio": "1:1"},
    }


def test_edited_provider_connection_test_overlays_form_without_persisting(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_TEXT_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(
                name="Saved Relay",
                api_key="saved-secret",
                text_model="saved-model",
            ),
        )
        provider_id = created.json()["id"]
        client.put(
            "/api/settings/ai/bindings/text",
            json={"provider_config_id": provider_id},
        )

        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "provider_id": provider_id,
                "draft": _provider_data(
                    name="Edited Relay",
                    api_key="",
                    text_model="edited-model",
                    timeout_seconds=17,
                ),
                "capability": "text",
            },
        )

        from db import AICapabilityBinding, AIProviderConfig

        db = testing_session()
        try:
            stored = db.get(AIProviderConfig, provider_id)
            binding = db.get(AICapabilityBinding, "text")
            persisted = {
                "name": stored.name,
                "api_key": stored.api_key,
                "text_model": stored.text_model,
                "last_test_status": stored.last_test_status,
                "binding": binding.provider_config_id,
            }
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    snapshot = adapter.generate.await_args.args[0]
    assert snapshot.name == "Edited Relay"
    assert snapshot.api_key == "saved-secret"
    assert snapshot.model == "edited-model"
    assert snapshot.timeout_seconds == 17
    assert persisted == {
        "name": "Saved Relay",
        "api_key": "saved-secret",
        "text_model": "saved-model",
        "last_test_status": None,
        "binding": provider_id,
    }


def test_edited_provider_nonblank_secret_overrides_only_for_test(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_TEXT_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(api_key="saved-secret"),
        )
        provider_id = created.json()["id"]
        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "provider_id": provider_id,
                "draft": _provider_data(api_key="draft-secret"),
                "capability": "text",
            },
        )
        from db import AIProviderConfig

        db = testing_session()
        try:
            persisted_key = db.get(AIProviderConfig, provider_id).api_key
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert adapter.generate.await_args.args[0].api_key == "draft-secret"
    assert persisted_key == "saved-secret"


def test_saved_provider_connection_test_compatibility_alias(monkeypatch):
    client, _ = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_TEXT_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        ).json()["id"]

        response = client.post(
            f"/api/settings/ai/providers/{provider_id}/test",
            json={"capability": "text"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert adapter.generate.await_args.args[0].id == provider_id


def test_saved_image_connection_rejects_text_only_response_and_saves_error(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_TEXT_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(
                supports_image=True,
                image_model="image",
            ),
        ).json()["id"]
        response = client.post(
            "/api/settings/ai/providers/test",
            json={"provider_id": provider_id, "capability": "image"},
        )

        from db import AIProviderConfig

        db = testing_session()
        try:
            stored = db.get(AIProviderConfig, provider_id)
            persisted = (
                stored.last_test_status,
                stored.last_test_message,
                stored.last_tested_at,
            )
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "error"
    assert response.json()["message"] == "不支持图片生成"
    assert persisted[0:2] == ("error", "不支持图片生成")
    assert persisted[2] is not None


@pytest.mark.parametrize(
    ("capability", "provider_response", "expected"),
    [
        ("text", {"candidates": []}, "不支持文本生成"),
        ("text", VALID_IMAGE_RESPONSE, "不支持文本生成"),
        ("image", {"candidates": []}, "不支持图片生成"),
        ("image", VALID_TEXT_RESPONSE, "不支持图片生成"),
    ],
)
def test_draft_connection_requires_normalized_capability_output(
    monkeypatch,
    capability,
    provider_response,
    expected,
):
    client, _ = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=provider_response)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "draft": _provider_data(
                    supports_image=True,
                    image_model="image",
                ),
                "capability": capability,
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {
        "status": "error",
        "capability": capability,
        "duration_ms": response.json()["duration_ms"],
        "message": expected,
    }


@pytest.mark.parametrize(
    ("mime_type", "image_data"),
    [
        ("image/png", "not-base64"),
        ("image/png", "cGxhaW4gdGV4dA=="),
        ("image/jpeg", TINY_PNG_BASE64),
    ],
)
def test_image_connection_rejects_invalid_or_mislabeled_image_bytes(
    monkeypatch,
    mime_type,
    image_data,
):
    provider_response = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": image_data,
                            }
                        }
                    ]
                }
            }
        ]
    }
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=provider_response)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    client, _ = _make_client()
    try:
        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "draft": _provider_data(
                    supports_image=True,
                    image_model="image",
                ),
                "capability": "image",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "error"
    assert response.json()["message"] == "不支持图片生成"


@pytest.mark.parametrize(
    ("mime_type", "image_data"),
    [
        ("image/png", TINY_PNG_BASE64),
        ("image/jpeg", TINY_JPEG_BASE64),
        ("image/jpg", TINY_JPEG_BASE64),
    ],
)
def test_image_connection_accepts_verified_image_bytes(
    mime_type,
    image_data,
):
    import main

    response = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": mime_type,
                                "data": image_data,
                            }
                        }
                    ]
                }
            }
        ]
    }

    assert main._connection_response_supports("image", response) is True


@pytest.mark.parametrize(
    ("mime_type", "image_data", "removed_bytes"),
    [
        ("image/png", TINY_PNG_BASE64, 1),
        ("image/jpeg", TINY_JPEG_BASE64, 2),
    ],
)
def test_image_connection_rejects_truncated_real_images(
    mime_type,
    image_data,
    removed_bytes,
):
    import base64

    import main

    raw = base64.b64decode(image_data)
    truncated = base64.b64encode(
        raw[:-removed_bytes]
    ).decode("ascii")

    assert main._verified_image_matches_mime(
        truncated,
        mime_type,
    ) is False


def test_image_connection_requires_strict_unwrapped_base64():
    import main

    assert main._verified_image_matches_mime(
        f"\n{TINY_PNG_BASE64}\n",
        "image/png",
    ) is False


def test_image_connection_enforces_decoded_byte_limit(monkeypatch):
    import base64

    import main

    raw = base64.b64decode(TINY_PNG_BASE64)
    monkeypatch.setattr(
        main,
        "MAX_CONNECTION_IMAGE_BYTES",
        len(raw) - 1,
        raising=False,
    )

    assert main._verified_image_matches_mime(
        TINY_PNG_BASE64,
        "image/png",
    ) is False


@pytest.mark.parametrize(
    ("limit_name", "limit"),
    [
        ("MAX_CONNECTION_IMAGE_DIMENSION", 1),
        ("MAX_CONNECTION_IMAGE_PIXELS", 1),
    ],
)
def test_image_connection_rejects_dimension_and_pixel_bombs(
    monkeypatch,
    limit_name,
    limit,
):
    import base64
    from io import BytesIO

    import main
    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (2, 2), color="red").save(
        buffer,
        format="PNG",
    )
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    monkeypatch.setattr(
        main,
        limit_name,
        limit,
        raising=False,
    )

    assert main._verified_image_matches_mime(
        encoded,
        "image/png",
    ) is False


def test_edited_overlay_accepts_valid_image_without_saving_test_metadata(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_IMAGE_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(
                supports_image=True,
                image_model="saved-image",
            ),
        ).json()["id"]
        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "provider_id": provider_id,
                "draft": _provider_data(
                    supports_image=True,
                    image_model="edited-image",
                ),
                "capability": "image",
            },
        )

        from db import AIProviderConfig

        db = testing_session()
        try:
            stored = db.get(AIProviderConfig, provider_id)
            metadata = (
                stored.last_test_status,
                stored.last_test_message,
                stored.last_tested_at,
            )
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert adapter.generate.await_args.args[0].model == "edited-image"
    assert metadata == (None, None, None)


def test_connection_tests_emit_safe_start_and_result_events(monkeypatch):
    from services.app_log_service import AppLogService

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr("main.app_logs", logs)
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value=VALID_TEXT_RESPONSE)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    client, _ = _make_client()
    try:
        response = client.post(
            "/api/settings/ai/providers/test",
            json={
                "draft": _provider_data(
                    api_key="draft-secret",
                    name="Safe name",
                ),
                "capability": "text",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    entries = logs.recent()
    assert [entry["message"] for entry in entries] == [
        "AI 连接测试开始",
        "AI 连接测试完成",
    ]
    assert all(entry["source"] == "system" for entry in entries)
    assert "draft-secret" not in str(entries)


class _ProviderFailure(Exception):
    def __init__(
        self,
        status_code,
        detail,
        *,
        provider_code=None,
        request_id=None,
    ):
        super().__init__(detail)
        self.status_code = status_code
        self.response = SimpleNamespace(
            status_code=status_code,
            headers={"x-request-id": request_id} if request_id else {},
            json=lambda: {
                "error": {"code": provider_code}
            } if provider_code else {},
        )


def test_connection_test_maps_failures_and_updates_saved_metadata(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {
            "generate": AsyncMock(
                side_effect=_ProviderFailure(
                    401,
                    "api_key=sk-secret-1234 rejected",
                )
            )
        },
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter, raising=False)
    try:
        created = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        )
        provider_id = created.json()["id"]
        response = client.post(
            "/api/settings/ai/providers/test",
            json={"provider_id": provider_id, "capability": "text"},
        )

        from db import AIProviderConfig

        db = testing_session()
        try:
            provider = db.get(AIProviderConfig, provider_id)
            saved_metadata = (
                provider.last_test_status,
                provider.last_test_message,
                provider.last_tested_at,
            )
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "error"
    assert response.json()["message"].startswith("AI 提供商认证失败")
    assert "sk-secret-1234" not in response.text
    assert saved_metadata[0] == "error"
    assert saved_metadata[1] == response.json()["message"]
    assert saved_metadata[2] is not None


def test_connection_test_maps_rate_limit_timeout_and_image_endpoint(
    monkeypatch,
):
    client, _ = _make_client()
    try:
        responses = []
        for failure, capability, expected in (
            (
                _ProviderFailure(429, "upstream detail"),
                "text",
                "AI 提供商请求频率受限",
            ),
            (
                asyncio.TimeoutError("upstream detail"),
                "text",
                "AI 提供商请求超时",
            ),
            (
                _ProviderFailure(404, "upstream detail"),
                "image",
                "AI 模型不存在或不可用",
            ),
        ):
            adapter = type(
                "Adapter",
                (),
                {"generate": AsyncMock(side_effect=failure)},
            )()
            monkeypatch.setattr(
                "main.get_adapter",
                lambda protocol, current=adapter: current,
                raising=False,
            )
            draft = _provider_data(
                image_model="image",
                supports_image=True,
            )
            responses.append(
                (
                    client.post(
                        "/api/settings/ai/providers/test",
                        json={
                            "draft": draft,
                            "capability": capability,
                        },
                    ),
                    expected,
                )
            )
    finally:
        app.dependency_overrides.clear()

    for response, expected in responses:
        assert response.status_code == 200
        assert response.json()["status"] == "error"
        assert response.json()["message"].startswith(expected)
        assert "upstream=upstream detail" in response.json()["message"]


def test_detailed_connection_error_includes_safe_provider_diagnostic(
    monkeypatch,
):
    client, _ = _make_client()
    failure = _ProviderFailure(
        429,
        "provider asked clients to retry",
        provider_code="RESOURCE_EXHAUSTED",
        request_id="request-429",
    )
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(side_effect=failure)},
    )()
    monkeypatch.setattr("main.get_adapter", lambda protocol: adapter)
    try:
        response = client.post(
            "/api/settings/ai/providers/test",
            json={"draft": _provider_data(), "capability": "text"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    message = response.json()["message"]
    assert "AI 提供商请求频率受限" in message
    assert "HTTP 429" in message
    assert "code=RESOURCE_EXHAUSTED" in message
    assert "type=_ProviderFailure" in message
    assert "request_id=request-429" in message
    assert "upstream=provider asked clients to retry" in message


def test_connection_failure_log_exposes_sanitized_timeout_diagnostic(
    monkeypatch,
):
    import main
    from db import AIProviderConfig
    from services.app_log_service import AppLogService

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    adapter = type(
        "Adapter",
        (),
        {
            "generate": AsyncMock(
                side_effect=asyncio.TimeoutError(
                    "provider timeout; api_key=connection-secret"
                )
            )
        },
    )()
    monkeypatch.setattr(main, "get_adapter", lambda protocol: adapter)
    client, testing_session = _make_client()
    try:
        provider_id = client.post(
            "/api/settings/ai/providers",
            json=_provider_data(),
        ).json()["id"]
        response = client.post(
            f"/api/settings/ai/providers/{provider_id}/test",
            json={"capability": "text"},
        )
        recent = client.get("/api/settings/logs/recent")

        db = testing_session()
        try:
            provider = db.get(AIProviderConfig, provider_id)
            persisted = {
                "status": provider.last_test_status,
                "message": provider.last_test_message,
                "tested_at": provider.last_tested_at,
                "capability": provider.last_test_capability,
            }
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert set(response.json()) == {
        "status",
        "capability",
        "duration_ms",
        "message",
    }
    assert response.json()["status"] == "error"
    assert response.json()["capability"] == "text"
    assert persisted["status"] == "error"
    assert persisted["message"] == response.json()["message"]
    assert persisted["tested_at"] is not None
    assert persisted["capability"] == "text"

    assert recent.status_code == 200
    completion = recent.json()["items"][-1]
    assert isinstance(completion["message"], dict)
    assert completion["message"]["summary"] == "AI 连接测试完成"
    diagnostic = completion["message"]["diagnostic"]
    assert diagnostic["category"] == "timeout"
    assert diagnostic["exception_type"] == "TimeoutError"
    assert "provider timeout" in diagnostic["upstream_message"]
    assert "connection-secret" not in str(response.json())
    assert "connection-secret" not in str(persisted)
    assert "connection-secret" not in str(recent.json())


def test_connection_test_missing_provider_is_not_found():
    client, _ = _make_client()
    try:
        response = client.post(
            "/api/settings/ai/providers/test",
            json={"provider_id": 999, "capability": "text"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 404


def test_saved_connection_metadata_rolls_back_when_commit_fails():
    import main

    db = SimpleNamespace(
        commit=MagicMock(side_effect=RuntimeError("commit failed")),
        rollback=MagicMock(),
    )
    row = SimpleNamespace(
        last_test_status=None,
        last_test_message=None,
        last_tested_at=None,
    )

    with pytest.raises(RuntimeError, match="commit failed"):
        main._save_connection_test_result(
            db,
            row,
            "success",
            "连接成功",
        )

    assert db.commit.call_count == 1
    assert db.rollback.call_count == 1


def test_frontend_log_is_structured_redacted_and_never_uses_raw_logger(
    monkeypatch,
):
    from services.app_log_service import AppLogService

    logs = AppLogService(session_id="boot-a")
    raw_info = AsyncMock()
    monkeypatch.setattr("main.app_logs", logs)
    monkeypatch.setattr("main.logger.info", raw_info)
    client, _ = _make_client()
    try:
        response = client.post(
            "/log",
            json={
                "level": "warning",
                "message": "api_key=sk-secret-1234",
                "capability": "text",
                "provider": "Relay",
                "model": "text",
                "duration_ms": "12",
                "retry": "1",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert raw_info.call_count == 0
    assert logs.recent() == [
        {
            "session_id": "boot-a",
            "id": 1,
            "timestamp": logs.recent()[0]["timestamp"],
            "level": "warning",
            "source": "frontend",
            "message": "api_key=[REDACTED]",
            "capability": "text",
            "provider": "Relay",
            "model": "text",
            "duration_ms": 12,
            "retry": 1,
        }
    ]


@pytest.mark.asyncio
async def test_sse_stream_sends_new_events_and_cleans_up_subscriber(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        async def is_disconnected(self):
            return False

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    logs.emit(level="info", source="test", message="old")

    response = await main.api_stream_logs(
        ConnectedRequest(),
        after_id=f"{logs.session_id}:{logs.recent()[-1]['id']}",
    )
    assert response.media_type == "text/event-stream"
    assert len(logs._subscribers) == 0

    next_event = asyncio.create_task(anext(response.body_iterator))
    await asyncio.sleep(0)
    assert len(logs._subscribers) == 1
    logs.emit(level="success", source="test", message="new")
    event = await next_event
    await response.body_iterator.aclose()

    assert event.startswith(
        f'id: {logs.session_id}:{logs.recent()[-1]["id"]}\n'
    )
    assert '"message": "new"' in event
    assert '"message": "old"' not in event
    assert len(logs._subscribers) == 0


@pytest.mark.asyncio
async def test_sse_stream_redacts_vertex_and_image_aliases_but_keeps_metadata(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ReconnectRequest:
        headers = {}

        async def is_disconnected(self):
            return False

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    logs.emit(
        level="info",
        source="test",
        message={
            "vertex_project_id": "sse-project-secret",
            "b64_json": "sse-image-secret",
            "status": "ready",
            "count": 1,
            "mime_type": "image/png",
        },
    )

    response = await main.api_stream_logs(ReconnectRequest())
    frame = await anext(response.body_iterator)
    await response.body_iterator.aclose()

    assert "sse-project-secret" not in frame
    assert "sse-image-secret" not in frame
    assert '"status": "ready"' in frame
    assert '"count": 1' in frame
    assert '"mime_type": "image/png"' in frame


@pytest.mark.parametrize(
    ("message", "secrets", "safe_fragments"),
    [
        (
            {
                "headers": {
                    "x-goog-api-key": "SSE-GOOGLE-HEADER-SECRET",
                    "authorization": "Bearer SSE-AUTH-SECRET",
                },
                "credentials": {
                    "refresh_token": "SSE-REFRESH-SECRET",
                    "access_token": "SSE-ACCESS-SECRET",
                    "idToken": "SSE-ID-SECRET",
                    "clientSecret": "SSE-CLIENT-SECRET",
                },
                "service_account": {
                    "private_key": "SSE-PRIVATE-KEY",
                },
                "client": {"password": "SSE-PASSWORD"},
                "image_b64": "SSE-IMAGE-B64",
                "status": "ready",
                "count": 1,
                "mime_type": "image/png",
                "model": "safe-model",
                "provider": "safe-provider",
                "capability": "image",
                "duration": 9,
                "retry": 1,
                "config_version": 3,
            },
            (
                "SSE-GOOGLE-HEADER-SECRET",
                "SSE-AUTH-SECRET",
                "SSE-REFRESH-SECRET",
                "SSE-ACCESS-SECRET",
                "SSE-ID-SECRET",
                "SSE-CLIENT-SECRET",
                "SSE-PRIVATE-KEY",
                "SSE-PASSWORD",
                "SSE-IMAGE-B64",
            ),
            (
                '"status": "ready"',
                '"count": 1',
                '"mime_type": "image/png"',
                '"model": "safe-model"',
                '"provider": "safe-provider"',
                '"capability": "image"',
                '"duration": 9',
                '"retry": 1',
                '"config_version": 3',
            ),
        ),
        (
            r'{\"x-goog-api-key\":\"SSE-ESCAPED-SECRET\", '
            r'\"status\":\"ready\"}',
            ("SSE-ESCAPED-SECRET",),
            ("status", "ready"),
        ),
        (
            '{"refresh_token":"SSE-TRUNCATED-SECRET',
            ("SSE-TRUNCATED-SECRET",),
            (),
        ),
        (
            "{'accessToken'='SSE-ACCESS-TOKEN', count=2}",
            ("SSE-ACCESS-TOKEN",),
            ("count=2",),
        ),
        (
            "{client_credentials=[{'client_secret':'SSE-CLIENT-SECRET'}] "
            "status=ready}",
            ("SSE-CLIENT-SECRET",),
            ("status=ready",),
        ),
        (
            "auth=Bearer SSE-AUTH-HEADER; config_version=4",
            ("SSE-AUTH-HEADER",),
            ("config_version=4",),
        ),
        (
            "upload=data:image/png;charset=utf-8;name=preview.png;base64,"
            "QUJD\r\n  U1NFLUlNQUdF status=ready",
            ("QUJD", "U1NFLUlNQUdF"),
            ("status=ready",),
        ),
        (
            r'{\"b64_json\":\"U1NFLU1VTFRJTElORQ==\r\n  U0VDUkVU',
            ("U1NFLU1VTFRJTElORQ==", "U0VDUkVU"),
            (),
        ),
        (
            "certificate=-----BEGIN CERTIFICATE-----\n"
            "SSE-CERTIFICATE-BLOCK-SECRET",
            ("SSE-CERTIFICATE-BLOCK-SECRET",),
            (),
        ),
    ],
)
@pytest.mark.asyncio
async def test_sse_stream_redacts_fail_closed_bypass_corpus(
    monkeypatch,
    message,
    secrets,
    safe_fragments,
):
    import main
    from services.app_log_service import AppLogService

    class ReconnectRequest:
        headers = {}

        async def is_disconnected(self):
            return False

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    logs.emit(level="info", source="test", message=message)

    response = await main.api_stream_logs(ReconnectRequest())
    frame = await anext(response.body_iterator)
    await response.body_iterator.aclose()

    for secret in secrets:
        assert secret not in frame
    for fragment in safe_fragments:
        assert fragment in frame


@pytest.mark.asyncio
async def test_sse_stream_replays_after_last_event_id_with_frame_ids(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ReconnectRequest:
        headers = {"last-event-id": "boot-a:1"}

        async def is_disconnected(self):
            return False

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    logs.emit(level="info", source="test", message="one")
    second = logs.emit(level="info", source="test", message="two")
    third = logs.emit(level="info", source="test", message="three")

    response = await main.api_stream_logs(ReconnectRequest())
    second_frame = await anext(response.body_iterator)
    third_frame = await anext(response.body_iterator)
    await response.body_iterator.aclose()

    assert second_frame.startswith(f'id: boot-a:{second["id"]}\n')
    assert '"message": "two"' in second_frame
    assert third_frame.startswith(f'id: boot-a:{third["id"]}\n')
    assert '"message": "three"' in third_frame


@pytest.mark.parametrize(
    "cursor",
    [
        "old-boot:2",
        "boot-a:999",
        "not-a-valid-event-id",
    ],
)
@pytest.mark.asyncio
async def test_sse_invalid_or_stale_epoch_cursor_replays_current_buffer(
    monkeypatch,
    cursor,
):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        headers = {}

        async def is_disconnected(self):
            return False

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    first = logs.emit(level="info", source="test", message="current one")
    second = logs.emit(level="info", source="test", message="current two")

    response = await main.api_stream_logs(
        ConnectedRequest(),
        after_id=cursor,
    )
    first_frame = await anext(response.body_iterator)
    second_frame = await anext(response.body_iterator)
    await response.body_iterator.aclose()

    assert first_frame.startswith(f'id: boot-a:{first["id"]}\n')
    assert second_frame.startswith(f'id: boot-a:{second["id"]}\n')


@pytest.mark.asyncio
async def test_sse_after_id_replays_available_buffer_when_cursor_is_too_old(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        headers = {}

        async def is_disconnected(self):
            return False

    logs = AppLogService(capacity=3, session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    for index in range(5):
        logs.emit(level="info", source="test", message=f"event {index + 1}")

    response = await main.api_stream_logs(
        ConnectedRequest(),
        after_id="boot-a:1",
    )
    frames = [
        await anext(response.body_iterator),
        await anext(response.body_iterator),
        await anext(response.body_iterator),
    ]
    await response.body_iterator.aclose()

    assert [frame.splitlines()[0] for frame in frames] == [
        "id: boot-a:3",
        "id: boot-a:4",
        "id: boot-a:5",
    ]


@pytest.mark.asyncio
async def test_sse_reconnect_replays_events_emitted_while_disconnected(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        def __init__(self, last_event_id=None):
            self.headers = (
                {"last-event-id": str(last_event_id)}
                if last_event_id is not None
                else {}
            )

        async def is_disconnected(self):
            return False

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    first = logs.emit(level="info", source="test", message="first")

    initial = await main.api_stream_logs(
        ConnectedRequest(),
        after_id="boot-a:0",
    )
    first_frame = await anext(initial.body_iterator)
    await initial.body_iterator.aclose()
    assert first_frame.startswith(f'id: boot-a:{first["id"]}\n')

    missed_second = logs.emit(level="info", source="test", message="missed two")
    missed_third = logs.emit(level="info", source="test", message="missed three")

    reconnect = await main.api_stream_logs(
        ConnectedRequest(f"boot-a:{first['id']}")
    )
    second_frame = await anext(reconnect.body_iterator)
    third_frame = await anext(reconnect.body_iterator)
    await reconnect.body_iterator.aclose()

    assert second_frame.startswith(f'id: boot-a:{missed_second["id"]}\n')
    assert third_frame.startswith(f'id: boot-a:{missed_third["id"]}\n')


@pytest.mark.asyncio
async def test_sse_deduplicates_event_present_in_replay_and_queue(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        headers = {}

        async def is_disconnected(self):
            return False

    logs = AppLogService(session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    original_recent_after = logs.recent_after
    overlap = None

    def recent_with_subscribe_overlap(session_id, sequence_id):
        nonlocal overlap
        overlap = logs.emit(
            level="success",
            source="test",
            message="replay and queue overlap",
        )
        return original_recent_after(session_id, sequence_id)

    monkeypatch.setattr(
        logs,
        "recent_after",
        recent_with_subscribe_overlap,
    )
    response = await main.api_stream_logs(
        ConnectedRequest(),
        after_id="boot-a:0",
    )
    overlap_frame = await anext(response.body_iterator)
    assert overlap_frame.startswith(f'id: boot-a:{overlap["id"]}\n')

    next_frame_task = asyncio.create_task(anext(response.body_iterator))
    await asyncio.sleep(0)
    newer = logs.emit(level="success", source="test", message="newer")
    next_frame = await asyncio.wait_for(next_frame_task, 0.1)
    await response.body_iterator.aclose()

    assert next_frame.startswith(f'id: boot-a:{newer["id"]}\n')
    assert '"message": "replay and queue overlap"' not in next_frame


@pytest.mark.asyncio
async def test_sse_overflow_replays_newest_buffer_without_stalling(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        headers = {}

        async def is_disconnected(self):
            return False

    logs = AppLogService(capacity=200, session_id="boot-a")
    monkeypatch.setattr(main, "app_logs", logs)
    response = await main.api_stream_logs(
        ConnectedRequest(),
        after_id="boot-a:0",
    )

    first_frame_task = asyncio.create_task(anext(response.body_iterator))
    await asyncio.sleep(0)
    for index in range(500):
        logs.emit(
            level="info",
            source="test",
            message=f"slow subscriber {index + 1}",
        )

    first_frame = await asyncio.wait_for(first_frame_task, 0.2)
    remaining_frames = [
        await asyncio.wait_for(anext(response.body_iterator), 0.2)
        for _ in range(199)
    ]
    await response.body_iterator.aclose()

    assert [frame.splitlines()[0] for frame in [
        first_frame,
        *remaining_frames,
    ]] == [
        f"id: boot-a:{sequence_id}"
        for sequence_id in range(301, 501)
    ]


@pytest.mark.asyncio
async def test_sse_stream_closed_before_iteration_has_no_subscriber_leak(
    monkeypatch,
):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        async def is_disconnected(self):
            return False

    logs = AppLogService()
    monkeypatch.setattr(main, "app_logs", logs)

    response = await main.api_stream_logs(ConnectedRequest())
    assert len(logs._subscribers) == 0

    await response.body_iterator.aclose()

    assert len(logs._subscribers) == 0


@pytest.mark.asyncio
async def test_sse_stream_emits_keepalive_and_cleans_up(monkeypatch):
    import main
    from services.app_log_service import AppLogService

    class ConnectedRequest:
        async def is_disconnected(self):
            return False

    async def timeout_immediately(awaitable, timeout):
        awaitable.close()
        raise asyncio.TimeoutError

    logs = AppLogService()
    monkeypatch.setattr(main, "app_logs", logs)
    monkeypatch.setattr(main.asyncio, "wait_for", timeout_immediately)

    response = await main.api_stream_logs(ConnectedRequest())
    event = await anext(response.body_iterator)
    await response.body_iterator.aclose()

    assert event == ": keep-alive\n\n"
    assert len(logs._subscribers) == 0
