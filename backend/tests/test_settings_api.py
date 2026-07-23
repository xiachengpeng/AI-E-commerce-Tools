import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from db import Base, get_db
from main import app


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
    assert item["has_api_key"] is True
    assert item["api_key_masked"] == "sk-****1234"


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

    logs = AppLogService()
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


def test_connection_test_requires_exactly_one_provider_source():
    client, _ = _make_client()
    try:
        neither = client.post(
            "/api/settings/ai/providers/test",
            json={"capability": "text"},
        )
        both = client.post(
            "/api/settings/ai/providers/test",
            json={
                "provider_id": 1,
                "draft": _provider_data(),
                "capability": "text",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert neither.status_code == 422
    assert both.status_code == 422


def test_saved_connection_test_updates_metadata_without_changing_binding(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value={"candidates": []})},
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


def test_draft_connection_test_does_not_persist_or_change_bindings(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {"generate": AsyncMock(return_value={"candidates": []})},
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


class _ProviderFailure(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code


def test_connection_test_maps_failures_and_updates_saved_metadata(
    monkeypatch,
):
    client, testing_session = _make_client()
    adapter = type(
        "Adapter",
        (),
        {
            "generate": AsyncMock(
                side_effect=_ProviderFailure(401, "sk-secret-1234 rejected")
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
    assert response.json()["message"] == "AI 提供商认证失败"
    assert "sk-secret-1234" not in response.text
    assert saved_metadata[0:2] == ("error", "AI 提供商认证失败")
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
                "图片生成接口不可用",
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
        assert response.json()["message"] == expected
        assert "upstream detail" not in response.text


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


def test_frontend_log_is_structured_redacted_and_never_uses_raw_logger(
    monkeypatch,
):
    from services.app_log_service import AppLogService

    logs = AppLogService()
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

    logs = AppLogService()
    monkeypatch.setattr(main, "app_logs", logs)
    logs.emit(level="info", source="test", message="old")

    response = await main.api_stream_logs(ConnectedRequest())
    assert response.media_type == "text/event-stream"
    assert len(logs._subscribers) == 1

    logs.emit(level="success", source="test", message="new")
    event = await anext(response.body_iterator)
    await response.body_iterator.aclose()

    assert '"message": "new"' in event
    assert '"message": "old"' not in event
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
