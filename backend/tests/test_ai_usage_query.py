import pytest
from pydantic import ValidationError
from backend.models.settings import (
    UsageQueryConfigWrite,
    UsageQueryConfigRead,
    UsageQueryProxyRequest,
    UsageQueryProxyResponse,
)
from backend.db import AIProviderConfig, SessionLocal


def test_usage_query_pydantic_models():
    write_data = {
        "balance_template": "newapi",
        "balance_script": "({ request: {}, extractor: function(r) { return {}; } })",
        "balance_custom_key": "sk-custom-key-123",
        "balance_custom_url": "https://api.test.com/v1",
        "balance_timeout": 15,
        "balance_auto_interval": 60,
    }
    write_cfg = UsageQueryConfigWrite(**write_data)
    assert write_cfg.balance_template == "newapi"
    assert write_cfg.balance_timeout == 15
    assert write_cfg.balance_auto_interval == 60

    read_data = {
        **write_data,
        "has_custom_key": True,
        "custom_key_masked": "sk-c***123",
    }
    read_cfg = UsageQueryConfigRead(**read_data)
    assert read_cfg.has_custom_key is True
    assert read_cfg.custom_key_masked == "sk-c***123"


def test_usage_query_proxy_models():
    proxy_req = UsageQueryProxyRequest(
        provider_id=1,
        url="https://api.relay.com/v1/usage",
        method="GET",
        headers={"Authorization": "Bearer {{apiKey}}"},
        timeout_seconds=12,
    )
    assert proxy_req.url == "https://api.relay.com/v1/usage"
    assert proxy_req.method == "GET"
    assert proxy_req.timeout_seconds == 12

    proxy_resp = UsageQueryProxyResponse(
        ok=True,
        status_code=200,
        data={"remaining": 25.5, "unit": "USD"},
        duration_ms=85,
    )
    assert proxy_resp.ok is True
    assert proxy_resp.status_code == 200
    assert proxy_resp.data["remaining"] == 25.5


def test_db_ai_provider_config_has_usage_query_columns():
    db = SessionLocal()
    try:
        provider = AIProviderConfig(
            name="Usage Test Provider",
            protocol="openai_compatible",
            base_url="https://api.test.com/v1",
            api_key="sk-test",
            balance_template="newapi",
            balance_script="({ request: {} })",
            balance_custom_key="sk-custom",
            balance_custom_url="https://api.test.com/api/user/self",
            balance_timeout=20,
            balance_auto_interval=45,
        )
        db.add(provider)
        db.commit()
        db.refresh(provider)

        assert provider.balance_template == "newapi"
        assert provider.balance_script == "({ request: {} })"
        assert provider.balance_custom_key == "sk-custom"
        assert provider.balance_custom_url == "https://api.test.com/api/user/self"
        assert provider.balance_timeout == 20
        assert provider.balance_auto_interval == 45
    finally:
        if "provider" in locals() and provider.id:
            db.delete(provider)
            db.commit()
        db.close()


def test_api_usage_query_proxy_and_crud():
    from unittest.mock import MagicMock, patch
    from starlette.testclient import TestClient
    from backend.main import app

    client = TestClient(app)

    # 1. Create a provider
    create_res = client.post(
        "/api/settings/ai/providers",
        json={
            "name": "Proxy Test Provider",
            "protocol": "openai_compatible",
            "base_url": "https://api.relay-test.com/v1",
            "api_key": "sk-secret-model-key",
            "text_model": "gpt-4o",
            "supports_text": True,
            "supports_image": False,
        },
    )
    assert create_res.status_code in (200, 201)
    provider_id = create_res.json()["id"]

    try:
        # 2. Test Proxy with Variable Interpolation
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.json.return_value = {
            "success": True,
            "data": {"quota": 5000000, "used_quota": 500000}
        }

        with patch("httpx.AsyncClient.request", return_value=mock_resp) as mock_req:
            proxy_payload = {
                "provider_id": provider_id,
                "url": "{{baseUrl}}/api/user/self",
                "method": "GET",
                "headers": {
                    "Authorization": "Bearer {{apiKey}}",
                    "New-Api-User": "{{userId}}"
                },
                "timeout_seconds": 10
            }
            res = client.post("/api/settings/ai/providers/usage-query/proxy", json=proxy_payload)
            assert res.status_code == 200
            data = res.json()
            assert data["ok"] is True
            assert data["status_code"] == 200
            assert data["data"]["success"] is True

            # Verify interpolation happened in httpx call
            call_kwargs = mock_req.call_args.kwargs
            assert mock_req.call_args.args[0] == "GET"
            assert mock_req.call_args.args[1] == "https://api.relay-test.com/v1/api/user/self"
            assert call_kwargs["headers"]["Authorization"] == "Bearer sk-secret-model-key"

        # 3. Test PUT /api/settings/ai/providers/{id}/usage-query
        put_res = client.put(
            f"/api/settings/ai/providers/{provider_id}/usage-query",
            json={
                "balance_template": "newapi",
                "balance_script": "({ request: {}, extractor: function() {} })",
                "balance_timeout": 12,
                "balance_auto_interval": 45,
            },
        )
        assert put_res.status_code == 200
        put_data = put_res.json()
        assert put_data["balance_template"] == "newapi"
        assert put_data["balance_timeout"] == 12

        # 4. Test GET /api/settings/ai/providers/{id}/usage-query
        get_res = client.get(f"/api/settings/ai/providers/{provider_id}/usage-query")
        assert get_res.status_code == 200
        get_data = get_res.json()
        assert get_data["balance_template"] == "newapi"
        assert get_data["balance_auto_interval"] == 45
    finally:
        client.delete(f"/api/settings/ai/providers/{provider_id}")
