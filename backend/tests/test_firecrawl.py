"""
测试 firecrawl.fetch_markdown —— 异步页面抓取
"""
import pytest
import httpx
from unittest.mock import AsyncMock, MagicMock, patch

from services import firecrawl
from tests.conftest import make_http_response


@pytest.fixture(autouse=True)
def reset_client(monkeypatch):
    firecrawl._client = None
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_KEY", "fc-test-key")
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


@pytest.mark.asyncio
async def test_fetch_markdown_with_api_key_adds_auth_header(monkeypatch):
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_KEY", "fc-test-key-12345")
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_URL", "https://api.firecrawl.dev/v1/scrape")
    resp = make_http_response(200, {"markdown": "# Content with key"})
    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_post = AsyncMock(return_value=resp)
        mock_get.return_value.post = mock_post
        result = await firecrawl.fetch_markdown("https://example.com")
        assert result == "# Content with key"
        call_kwargs = mock_post.call_args.kwargs
        assert call_kwargs["headers"].get("Authorization") == "Bearer fc-test-key-12345"


@pytest.mark.asyncio
async def test_fetch_markdown_official_api_missing_key_raises(monkeypatch):
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_KEY", "")
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_URL", "https://api.firecrawl.dev/v1/scrape")
    with pytest.raises(Exception, match="未配置 FIRECRAWL_API_KEY"):
        await firecrawl.fetch_markdown("https://example.com")


@pytest.mark.asyncio
async def test_fetch_markdown_status_error_mappings(monkeypatch):
    import re
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_KEY", "test-key")
    for status_code, expected_msg in [
        (401, "Firecrawl API Key 无效或未授权 (401 Unauthorized)"),
        (402, "Firecrawl 账户额度不足 (402 Payment Required)"),
        (429, "Firecrawl 请求过于频繁 (429 Rate Limit)"),
        (500, "Firecrawl 服务端错误 (500 Internal Server Error)"),
    ]:
        resp = make_http_response(status_code, {"error": "test"})
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            "err", request=MagicMock(), response=resp
        )
        with patch.object(firecrawl, "_get_client") as mock_get:
            mock_get.return_value.post = AsyncMock(return_value=resp)
            with pytest.raises(Exception, match=re.escape(expected_msg)):
                await firecrawl.fetch_markdown("https://example.com")


@pytest.mark.asyncio
async def test_native_fetch_markdown_json_ld():
    """原生抓取器通过 JSON-LD 解析商品基本信息"""
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Old Title</title>
        <script type="application/ld+json">
        {
            "@type": "Product",
            "name": "Wireless Noise Canceling Headphones",
            "description": "High fidelity audio with active noise cancellation and 40h battery.",
            "offers": {
                "price": "99.99",
                "priceCurrency": "USD"
            }
        }
        </script>
    </head>
    <body>
        <p>Some extra body text</p>
    </body>
    </html>
    """
    resp = make_http_response(200, {})
    resp.text = html_content
    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.get = AsyncMock(return_value=resp)
        result = await firecrawl.native_fetch_markdown("https://example.com/product/1")
        assert "Wireless Noise Canceling Headphones" in result
        assert "$ 99.99" in result or "$99.99" in result
        assert "High fidelity audio" in result


@pytest.mark.asyncio
async def test_native_fetch_markdown_amazon_dom():
    """原生抓取器通过 Amazon 常见 DOM 提取标题、价格与子弹点"""
    html_content = """
    <html>
    <body>
        <span id="productTitle">Ultra Fast USB-C GaN Charger 65W</span>
        <span class="a-price-whole">29.</span>
        <span class="a-price-fraction">99</span>
        <div id="feature-bullets">
            <ul>
                <li><span class="a-list-item">GaN III Technology for cooler operation</span></li>
                <li><span class="a-list-item">Foldable plug design ideal for travel</span></li>
            </ul>
        </div>
        <div id="productDescription">
            <p>Compact 65W dual-port wall charger supporting PD 3.0.</p>
        </div>
    </body>
    </html>
    """
    resp = make_http_response(200, {})
    resp.text = html_content
    with patch.object(firecrawl, "_get_client") as mock_get:
        mock_get.return_value.get = AsyncMock(return_value=resp)
        result = await firecrawl.native_fetch_markdown("https://amazon.com/dp/B000TEST")
        assert "Ultra Fast USB-C GaN Charger 65W" in result
        assert "$29.99" in result
        assert "GaN III Technology" in result
        assert "Foldable plug design" in result
        assert "Compact 65W dual-port" in result


@pytest.mark.asyncio
async def test_fetch_markdown_fallback_on_missing_key(monkeypatch):
    """当未配置 Firecrawl API Key 且启用 fallback_to_native 时自动切换至原生抓取"""
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_KEY", "")
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_URL", "https://api.firecrawl.dev/v1/scrape")
    with patch.object(firecrawl, "native_fetch_markdown", new=AsyncMock(return_value="# Native Extracted Title\n\nPrice: $19.99")):
        result = await firecrawl.fetch_markdown("https://example.com/item", fallback_to_native=True)
        assert "Native Extracted Title" in result
        assert "$19.99" in result


@pytest.mark.asyncio
async def test_fetch_markdown_fallback_on_status_error(monkeypatch):
    """当 Firecrawl 返回 402 且启用 fallback_to_native 时自动切换至原生抓取"""
    monkeypatch.setattr(firecrawl, "FIRECRAWL_API_KEY", "test-key")
    resp = make_http_response(402, {"error": "Quota exceeded"})
    resp.raise_for_status.side_effect = httpx.HTTPStatusError("Quota exceeded", request=MagicMock(), response=resp)
    with patch.object(firecrawl, "_get_client") as mock_get, \
         patch.object(firecrawl, "native_fetch_markdown", new=AsyncMock(return_value="# Fallback Markdown")):
        mock_get.return_value.post = AsyncMock(return_value=resp)
        result = await firecrawl.fetch_markdown("https://example.com", fallback_to_native=True)
        assert result == "# Fallback Markdown"


@pytest.mark.asyncio
async def test_native_fetch_markdown_blocks_ssrf():
    # 1. Cloud metadata IP blocked
    with pytest.raises(ValueError, match="安全校验未通过"):
        await firecrawl.native_fetch_markdown("http://169.254.169.254/latest/meta-data")

    # 2. Localhost loopback blocked
    with pytest.raises(ValueError, match="安全校验未通过"):
        await firecrawl.native_fetch_markdown("http://127.0.0.1:9503/api/settings")

    # 3. Cloud metadata hostname blocked
    with pytest.raises(ValueError, match="安全校验未通过"):
        await firecrawl.native_fetch_markdown("http://metadata.google.internal/computeMetadata/v1")
