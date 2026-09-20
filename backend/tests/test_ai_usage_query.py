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
