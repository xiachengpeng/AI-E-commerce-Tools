import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
import httpx

from backend.main import app
from backend.services.ai_balance_service import AIBalanceService
from backend.models.settings import ProviderBalanceResult


def test_new_api_balance_query_with_access_token_and_user_id():
    service = AIBalanceService()

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "success": True,
        "data": {
            "quota": 10000000,  # 10,000,000 / 500,000 = $20.00
            "username": "test_user"
        }
    }

    with patch("httpx.AsyncClient.get", return_value=mock_resp) as mock_get:
        result = pytest.importorskip("asyncio").run(
            service.query_balance(
                protocol="openai_compatible",
                base_url="https://api.my-newapi.com/v1",
                api_key="sk-model-key-12345",
                balance_access_token="ey-system-access-token-abcde",
                balance_user_id="888",
            )
        )

        assert result.status == "success"
        assert result.balance_text == "$20.00"
        assert result.remaining_balance == 20.0
        assert result.currency == "USD"

        # Verify headers used access token instead of model key, and included New-Api-User
        call_args = mock_get.call_args
        assert call_args is not None
        headers = call_args.kwargs.get("headers", {})
        assert headers.get("Authorization") == "Bearer ey-system-access-token-abcde"
        assert headers.get("New-Api-User") == "888"


def test_one_api_subscription_fallback_with_model_api_key():
    service = AIBalanceService()

    def mock_get_dispatch(url, *args, **kwargs):
        resp = MagicMock()
        if "/api/user/self" in str(url):
            resp.status_code = 404
            return resp
        if "subscription" in str(url):
            resp.status_code = 200
            resp.json.return_value = {
                "hard_limit_usd": 50.0,
                "has_payment_method": True
            }
            return resp
        if "usage" in str(url):
            resp.status_code = 200
            resp.json.return_value = {
                "total_usage": 15.25
            }
            return resp
        resp.status_code = 404
        return resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get_dispatch):
        result = pytest.importorskip("asyncio").run(
            service.query_balance(
                protocol="openai_compatible",
                base_url="https://api.standard-oneapi.com/v1",
                api_key="sk-model-token-xyz",
            )
        )

        assert result.status == "success"
        assert result.balance_text == "$34.75"
        assert result.remaining_balance == 34.75
        assert result.currency == "USD"


def test_deepseek_official_balance_query():
    service = AIBalanceService()

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "is_available": True,
        "balance_infos": [
            {
                "currency": "CNY",
                "total_balance": "88.50",
                "granted_balance": "10.00",
                "topped_up_balance": "78.50"
            }
        ]
    }

    with patch("httpx.AsyncClient.get", return_value=mock_resp):
        result = pytest.importorskip("asyncio").run(
            service.query_balance(
                protocol="openai_compatible",
                base_url="https://api.deepseek.com",
                api_key="sk-deepseek-key",
            )
        )

        assert result.status == "success"
        assert result.balance_text == "¥88.50"
        assert result.remaining_balance == 88.50
        assert result.currency == "CNY"


def test_siliconflow_official_balance_query():
    service = AIBalanceService()

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "code": 20000,
        "data": {
            "balance": "66.20"
        }
    }

    with patch("httpx.AsyncClient.get", return_value=mock_resp):
        result = pytest.importorskip("asyncio").run(
            service.query_balance(
                protocol="openai_compatible",
                base_url="https://api.siliconflow.cn/v1",
                api_key="sk-siliconflow-key",
            )
        )

        assert result.status == "success"
        assert result.balance_text == "¥66.20"
        assert result.remaining_balance == 66.20


def test_custom_balance_url_query():
    service = AIBalanceService()

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "balance": 15.8,
        "currency": "USD"
    }

    with patch("httpx.AsyncClient.get", return_value=mock_resp) as mock_get:
        result = pytest.importorskip("asyncio").run(
            service.query_balance(
                protocol="openai_compatible",
                base_url="https://api.custom-proxy.com/v1",
                api_key="sk-my-key",
                custom_balance_url="https://api.custom-proxy.com/my-custom-balance-api",
            )
        )

        assert result.status == "success"
        assert result.balance_text == "$15.80"
        assert result.remaining_balance == 15.8
        # Ensure it requested the custom url
        assert mock_get.call_args[0][0] == "https://api.custom-proxy.com/my-custom-balance-api"


def test_balance_query_error_handling_and_secret_redaction():
    service = AIBalanceService()

    # 401 Unauthorized
    mock_resp = MagicMock()
    mock_resp.status_code = 401
    mock_resp.text = "Invalid API Key: sk-secret-12345678"

    with patch("httpx.AsyncClient.get", return_value=mock_resp):
        result = pytest.importorskip("asyncio").run(
            service.query_balance(
                protocol="openai_compatible",
                base_url="https://api.fail-proxy.com/v1",
                api_key="sk-secret-12345678",
            )
        )

        assert result.status == "error"
        assert "401" in result.message or "认证" in result.message or "凭据" in result.message
        # Crucial security requirement: raw secret must NEVER be exposed in message
        assert "sk-secret-12345678" not in result.message


def test_api_provider_balance_endpoint(client: TestClient = None):
    test_client = TestClient(app)

    # 1. Create a provider with balance config
    create_payload = {
        "name": "Balance Test Provider",
        "protocol": "openai_compatible",
        "base_url": "https://api.test-newapi.com/v1",
        "api_key": "sk-model-test-key",
        "balance_access_token": "ey-access-token-test",
        "balance_user_id": "999",
        "custom_balance_url": "https://api.test-newapi.com/api/user/self",
        "text_model": "gpt-4o-mini",
        "supports_text": 1,
        "supports_image": 0,
    }
    create_res = test_client.post("/api/settings/ai/providers", json=create_payload)
    assert create_res.status_code in (200, 201)
    provider_id = create_res.json()["id"]

    # 2. Mock balance query and call POST /api/settings/ai/providers/{id}/balance
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "success": True,
        "data": {
            "quota": 25000000  # $50.00
        }
    }

    with patch("httpx.AsyncClient.get", return_value=mock_resp):
        balance_res = test_client.post(f"/api/settings/ai/providers/{provider_id}/balance")
        assert balance_res.status_code == 200
        data = balance_res.json()
        assert data["status"] == "success"
        assert data["balance_text"] == "$50.00"
        assert data["remaining_balance"] == 50.0

    # Cleanup
    test_client.delete(f"/api/settings/ai/providers/{provider_id}")


def test_api_provider_balance_test_draft():
    test_client = TestClient(app)

    draft_payload = {
        "protocol": "openai_compatible",
        "base_url": "https://api.newapi-test.com/v1",
        "api_key": "sk-draft-key",
        "balance_access_token": "token-draft-123",
        "balance_user_id": "888",
        "custom_balance_url": "https://api.newapi-test.com/api/user/self",
    }

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "success": True,
        "data": {
            "quota": 15000000  # $30.00
        }
    }

    with patch("httpx.AsyncClient.get", return_value=mock_resp):
        res = test_client.post("/api/settings/ai/providers/balance/test", json=draft_payload)
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "success"
        assert data["balance_text"] == "$30.00"


def test_api_provider_balance_test_saved_inheritance():
    test_client = TestClient(app)

    create_payload = {
        "name": "Inherit Test Provider",
        "protocol": "openai_compatible",
        "base_url": "https://api.inherit-test.com/v1",
        "api_key": "sk-saved-inherited-secret",
        "balance_access_token": "token-saved-inherited-secret",
        "text_model": "gpt-4o-mini",
        "supports_text": 1,
        "supports_image": 0,
    }
    create_res = test_client.post("/api/settings/ai/providers", json=create_payload)
    assert create_res.status_code in (200, 201)
    provider_id = create_res.json()["id"]

    try:
        # Call draft test with provider_id, leaving api_key and balance_access_token empty
        draft_payload = {
            "provider_id": provider_id,
            "protocol": "openai_compatible",
            "base_url": "https://api.inherit-test.com/v1",
            "api_key": "",
            "balance_access_token": "",
            "balance_user_id": "102",
        }

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "success": True,
            "data": {
                "quota": 10000000  # $20.00
            }
        }

        with patch("httpx.AsyncClient.get", return_value=mock_resp) as mock_get:
            res = test_client.post("/api/settings/ai/providers/balance/test", json=draft_payload)
            assert res.status_code == 200
            data = res.json()
            assert data["status"] == "success"
            assert data["balance_text"] == "$20.00"

            # Check that inherited token was used in Authorization header
            call_kwargs = mock_get.call_args.kwargs
            headers = call_kwargs.get("headers", {})
            assert headers.get("Authorization") == "Bearer token-saved-inherited-secret"
    finally:
        test_client.delete(f"/api/settings/ai/providers/{provider_id}")
