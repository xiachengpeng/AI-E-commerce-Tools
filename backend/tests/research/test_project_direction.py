"""Project setup assistance uses private relay settings and never creates projects."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from rabbit_hole.runtime.server import create_app

DIRECTION = "研究水晶饰品与宗教主题配饰，围绕佩戴、礼赠等场景寻找具体产品，验证加拿大市场的广告线索、搜索趋势及物流成本。"


@pytest.fixture
def direction_ai(tmp_path, monkeypatch):
    import openai

    from rabbit_hole.integrations.ai_settings import AISettings

    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    AISettings().update({"api_key": "private-test-key", "base_url": "https://relay.example/v1", "model": "test-model"})
    create = AsyncMock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=DIRECTION))]))
    close = AsyncMock()
    factory = lambda **kwargs: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), close=close)
    monkeypatch.setattr(openai, "AsyncOpenAI", factory)
    return create, close


async def test_direction_requires_session_and_uses_title_market(direction_ai):
    create, close = direction_ai
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(checks={})), base_url="http://localhost:8000") as client:
        path = "/workbench/api/project-direction"
        data = {"title": "水晶饰品+宗教信仰", "market": "CA"}
        assert (await client.post(path, json=data)).status_code == 403
        create.assert_not_awaited()
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        response = await client.post(path, headers={"X-Workbench-Token": token}, json=data)
        assert response.status_code == 200
        assert response.json() == {"direction": DIRECTION}
        assert "private-test-key" not in response.text
        messages = create.await_args.kwargs["messages"]
        assert "水晶饰品+宗教信仰" in messages[1]["content"]
        assert "Canada" in messages[0]["content"]
        assert "Chinese" in messages[0]["content"]
        close.assert_awaited_once()


@pytest.mark.parametrize("data", [{"title": "", "market": "CA"}, {"title": "x" * 201, "market": "CA"}, {"title": "travel", "market": "ZZ"}, {"title": ["invalid"], "market": "US"}])
async def test_invalid_direction_input_never_calls_ai(direction_ai, data):
    create, _ = direction_ai
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(checks={})), base_url="http://localhost:8000") as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        result = await client.post("/workbench/api/project-direction", headers={"X-Workbench-Token": token}, json=data)
        assert result.status_code == 422
        create.assert_not_awaited()


async def test_direction_failure_redacts_provider_error_and_closes_client(direction_ai):
    create, close = direction_ai
    create.side_effect = RuntimeError("private-test-key provider-debug")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(checks={})), base_url="http://localhost:8000") as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        result = await client.post("/workbench/api/project-direction", headers={"X-Workbench-Token": token}, json={"title": "travel", "market": "GB"})
        assert result.status_code == 503
        assert "private-test-key" not in result.text
        assert "provider-debug" not in result.text
        close.assert_awaited_once()


@pytest.mark.parametrize("content", ["", " ", None, "x" * 1001])
async def test_invalid_ai_draft_rejected(direction_ai, content):
    create, _ = direction_ai
    create.return_value = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(checks={})), base_url="http://localhost:8000") as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        result = await client.post("/workbench/api/project-direction", headers={"X-Workbench-Token": token}, json={"title": "travel", "market": "AU"})
        assert result.status_code == 502


async def test_missing_ai_configuration_has_actionable_error(tmp_path, monkeypatch):
    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "missing.json"))
    monkeypatch.delenv("RABBIT_HOLE_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("RABBIT_HOLE_OPENAI_MODEL", raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(checks={})), base_url="http://localhost:8000") as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        result = await client.post("/workbench/api/project-direction", headers={"X-Workbench-Token": token}, json={"title": "travel", "market": "CA"})
        assert result.status_code == 503
        assert "数据源与配置" in result.text
