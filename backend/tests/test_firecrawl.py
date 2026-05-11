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
