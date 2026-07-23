"""
测试 firecrawl.fetch_markdown —— 异步页面抓取
"""
import pytest
import httpx
from unittest.mock import AsyncMock, MagicMock, patch

from services import firecrawl
from tests.conftest import make_http_response


@pytest.fixture(autouse=True)
def reset_client():
    firecrawl._client = None
    yield
    firecrawl._client = None


@pytest.mark.asyncio
async def test_fetch_markdown_success_v1():
    """Firecrawl V1 响应结构：顶层 markdown 字段"""
    resp = make_http_response(200, {"markdown": "# Hello\n\nProduct info"})
    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.post = AsyncMock(return_value=resp)
        result = await firecrawl.fetch_markdown("https://example.com")
        assert result == "# Hello\n\nProduct info"


@pytest.mark.asyncio
async def test_fetch_markdown_emits_safe_start_and_success_events(monkeypatch):
    secret_url = "https://example.com/product?token=query-secret"
    resp = make_http_response(200, {"markdown": "# Safe"})
    emit = MagicMock()
    monkeypatch.setattr("services.firecrawl.app_logs.emit", emit)

    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.post = AsyncMock(return_value=resp)
        await firecrawl.fetch_markdown(secret_url)

    assert [call.kwargs["message"] for call in emit.call_args_list] == [
        "爬虫请求开始",
        "爬虫请求完成",
    ]
    assert all(call.kwargs["source"] == "crawler" for call in emit.call_args_list)
    assert "query-secret" not in repr(emit.call_args_list)
    assert secret_url not in repr(emit.call_args_list)


@pytest.mark.asyncio
async def test_fetch_markdown_success_v2():
    """Firecrawl V2 响应结构：data.markdown"""
    resp = make_http_response(200, {"data": {"markdown": "# V2 Content"}})
    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.post = AsyncMock(return_value=resp)
        result = await firecrawl.fetch_markdown("https://example.com")
        assert result == "# V2 Content"


@pytest.mark.asyncio
async def test_fetch_markdown_no_markdown():
    """响应中无 markdown 字段 → ValueError"""
    resp = make_http_response(200, {"foo": "bar"})
    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.post = AsyncMock(return_value=resp)
        with pytest.raises(Exception, match="Markdown content not found"):
            await firecrawl.fetch_markdown("https://example.com")


@pytest.mark.asyncio
async def test_fetch_markdown_http_error():
    """HTTP 4xx → 抛出异常"""
    resp = make_http_response(403, {"error": "forbidden"})
    resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "forbidden", request=MagicMock(), response=resp
    )
    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.post = AsyncMock(return_value=resp)
        with pytest.raises(Exception):
            await firecrawl.fetch_markdown("https://blocked.com")


@pytest.mark.asyncio
async def test_fetch_markdown_failure_event_excludes_url_and_response_body(
    monkeypatch,
):
    secret_url = "https://blocked.com/?key=query-secret"
    resp = make_http_response(403, {"error": "body-secret"})
    resp.text = "body-secret"
    resp.raise_for_status.side_effect = httpx.HTTPStatusError(
        "provider-secret",
        request=MagicMock(),
        response=resp,
    )
    emit = MagicMock()
    monkeypatch.setattr("services.firecrawl.app_logs.emit", emit)

    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.post = AsyncMock(return_value=resp)
        with pytest.raises(Exception) as raised:
            await firecrawl.fetch_markdown(secret_url)

    assert emit.call_args_list[-1].kwargs["message"] == "爬虫请求失败"
    rendered = f"{raised.value!s} {emit.call_args_list!r}"
    assert "query-secret" not in rendered
    assert "body-secret" not in rendered
    assert "provider-secret" not in rendered
