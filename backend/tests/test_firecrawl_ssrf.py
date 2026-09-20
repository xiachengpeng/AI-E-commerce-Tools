import pytest
from fastapi.testclient import TestClient

from main import app
from services.firecrawl import test_firecrawl_connection as run_test_firecrawl_connection


@pytest.fixture
def client():
    return TestClient(app)


@pytest.mark.asyncio
async def test_crawler_connection_blocks_metadata_ip():
    success, duration, msg = await run_test_firecrawl_connection(
        api_url="http://169.254.169.254/latest/meta-data/",
        api_key="test-key"
    )
    assert success is False
    assert any(k in msg for k in ["云主机元数据", "受限", "非法", "禁止"])


@pytest.mark.asyncio
async def test_crawler_connection_blocks_metadata_hostname():
    success, duration, msg = await run_test_firecrawl_connection(
        api_url="http://metadata.google.internal/computeMetadata/v1/",
        api_key="test-key"
    )
    assert success is False
    assert any(k in msg for k in ["云主机元数据", "受限", "非法", "禁止"])


def test_api_crawler_settings_blocks_metadata_url(client):
    payload = {
        "api_url": "http://169.254.169.254/latest/meta-data/",
        "api_key": "fc-key",
    }
    res = client.put("/api/settings/crawler", json=payload)
    assert res.status_code == 400
    assert any(k in res.json().get("detail", "") for k in ["非法", "禁止", "元数据"])


def test_api_crawler_test_blocks_metadata_url(client):
    payload = {
        "api_url": "http://169.254.169.254/v1/scrape",
        "api_key": "fc-key",
    }
    res = client.post("/api/settings/crawler/test", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "error"
    assert any(k in data["message"] for k in ["云主机元数据", "受限", "非法", "禁止"])
