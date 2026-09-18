import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient
import httpx

import main
from main import app
from db import SessionLocal, FirecrawlConfig
from tests.conftest import make_http_response


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def clean_crawler_db():
    db = SessionLocal()
    db.query(FirecrawlConfig).delete()
    db.commit()
    db.close()
    yield
    db = SessionLocal()
    db.query(FirecrawlConfig).delete()
    db.commit()
    db.close()


def test_get_crawler_settings_empty(client):
    response = client.get("/api/settings/crawler")
    assert response.status_code == 200
    data = response.json()
    assert "api_url" in data
    assert "has_api_key" in data
    assert "api_key_masked" in data


def test_put_and_get_crawler_settings(client):
    # 1. Update crawler settings with plaintext key
    payload = {
        "api_key": "fc-live-key-9988776655",
        "api_url": "https://api.firecrawl.dev/v1/scrape",
    }
    put_res = client.put("/api/settings/crawler", json=payload)
    assert put_res.status_code == 200
    data = put_res.json()
    assert data["has_api_key"] is True
    assert "••••" in data["api_key_masked"]
    assert "fc-live-key" not in data["api_key_masked"]
    assert data["api_url"] == "https://api.firecrawl.dev/v1/scrape"

    # Verify secret is stored properly in DB
    db = SessionLocal()
    cfg = db.query(FirecrawlConfig).first()
    assert cfg is not None
    assert cfg.api_key == "fc-live-key-9988776655"
    db.close()

    # 2. Get crawler settings returns masked value
    get_res = client.get("/api/settings/crawler")
    assert get_res.status_code == 200
    get_data = get_res.json()
    assert get_data["has_api_key"] is True
    assert get_data["api_key_masked"] == data["api_key_masked"]


def test_put_crawler_settings_preserves_masked_key(client):
    # Initially save a key
    client.put("/api/settings/crawler", json={
        "api_key": "fc-secret-original-key",
        "api_url": "https://api.firecrawl.dev/v1/scrape",
    })

    # Submit update with masked key and new url
    update_res = client.put("/api/settings/crawler", json={
        "api_key": "fc-••••••••key",
        "api_url": "http://localhost:3002/v1/scrape",
    })
    assert update_res.status_code == 200
    data = update_res.json()
    assert data["api_url"] == "http://localhost:3002/v1/scrape"
    assert data["has_api_key"] is True

    # DB still has original key
    db = SessionLocal()
    cfg = db.query(FirecrawlConfig).first()
    assert cfg.api_key == "fc-secret-original-key"
    assert cfg.api_url == "http://localhost:3002/v1/scrape"
    db.close()


def test_test_crawler_connection_success(client):
    mock_resp = make_http_response(200, {"data": {"markdown": "# Example"}})
    with patch("services.firecrawl._get_client") as mock_get:
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_get.return_value = mock_client

        res = client.post("/api/settings/crawler/test", json={
            "api_key": "fc-test-key-valid",
            "api_url": "https://api.firecrawl.dev/v1/scrape",
        })
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "success"
        assert "连接成功" in data["message"]
        assert data["duration_ms"] >= 0


def test_test_crawler_connection_unauthorized(client):
    mock_resp = make_http_response(401, {"error": "Unauthorized"})
    with patch("services.firecrawl._get_client") as mock_get:
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_get.return_value = mock_client

        res = client.post("/api/settings/crawler/test", json={
            "api_key": "fc-invalid-key",
            "api_url": "https://api.firecrawl.dev/v1/scrape",
        })
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "error"
        assert "401" in data["message"]


def test_test_crawler_connection_network_timeout(client):
    with patch("services.firecrawl._get_client") as mock_get:
        mock_client = MagicMock()
        mock_client.post = AsyncMock(side_effect=httpx.ConnectTimeout("Connection timed out"))
        mock_get.return_value = mock_client

        res = client.post("/api/settings/crawler/test", json={
            "api_key": "fc-timeout-key",
            "api_url": "https://api.firecrawl.dev/v1/scrape",
        })
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "error"
        assert "超时" in data["message"]
