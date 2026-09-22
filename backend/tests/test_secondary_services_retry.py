import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import httpx
import pytest

from services.image_response_fetcher import fetch_public_image
from services.ai_balance_service import AIBalanceService
from services.firecrawl import fetch_markdown


# 1x1 PNG bytes
_PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0"
    b"\x00\x00\x03\x01\x01\x00\xc9\xfe\x92\xef\x00\x00\x00\x00IEND\xaeB`\x82"
)


class DummyStreamContext:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass


@pytest.mark.asyncio
async def test_image_fetcher_retries_transient_error_and_succeeds():
    """fetch_public_image retries transient network error and succeeds."""
    success_resp = MagicMock()
    success_resp.status_code = 200
    success_resp.headers = {"content-type": "image/png", "content-length": str(len(_PNG_BYTES))}

    async def aiter_bytes():
        yield _PNG_BYTES

    success_resp.aiter_bytes = aiter_bytes
    success_resp.raise_for_status = MagicMock()

    client = MagicMock()
    # 1st attempt: stream context raises ConnectTimeout; 2nd attempt: returns success
    call_count = 0

    def stream_mock(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise httpx.ConnectTimeout("Connection timeout")
        return DummyStreamContext(success_resp)

    client.stream = stream_mock

    sleeps = []

    async def fake_sleep(seconds: float):
        sleeps.append(seconds)

    with patch("asyncio.sleep", side_effect=fake_sleep):
        result = await fetch_public_image(
            "https://93.184.216.34/image.png",
            client,
            timeout_seconds=5,
            resolver=lambda host: ["93.184.216.34"],
        )

        assert result.mime_type == "image/png"
        assert result.data == _PNG_BYTES
        assert call_count == 2
        assert len(sleeps) >= 1


@pytest.mark.asyncio
async def test_balance_query_retries_transient_503_and_succeeds():
    """AIBalanceService retries 503 and returns balance on subsequent success."""
    service = AIBalanceService()

    resp_503 = httpx.Response(503, text="Service Unavailable", request=httpx.Request("GET", "https://api.deepseek.com/user/balance"))
    resp_200 = httpx.Response(
        200,
        json={"balance_infos": [{"currency": "CNY", "total_balance": "100.50"}]},
        request=httpx.Request("GET", "https://api.deepseek.com/user/balance"),
    )

    sleeps = []

    async def fake_sleep(seconds: float):
        sleeps.append(seconds)

    with patch("httpx.AsyncClient.get") as mock_get, \
         patch("asyncio.sleep", side_effect=fake_sleep):
        mock_get.side_effect = [resp_503, resp_200]

        res = await service.query_balance(
            protocol="openai_compatible",
            base_url="https://api.deepseek.com",
            api_key="sk-test-12345",
        )

        assert res.status == "success"
        assert res.balance_text == "¥100.50"
        assert mock_get.call_count == 2
        assert len(sleeps) >= 1


@pytest.mark.asyncio
async def test_firecrawl_retries_transient_error_and_succeeds():
    """fetch_markdown retries 503 from Firecrawl API and succeeds."""
    resp_503 = httpx.Response(503, text="Overloaded", request=httpx.Request("POST", "https://api.firecrawl.dev/v1/scrape"))
    resp_200 = httpx.Response(
        200,
        json={"markdown": "# Product Page\nPrice: $29.99\n"},
        request=httpx.Request("POST", "https://api.firecrawl.dev/v1/scrape"),
    )

    sleeps = []

    async def fake_sleep(seconds: float):
        sleeps.append(seconds)

    with patch("services.firecrawl._get_client") as mock_get_client, \
         patch("asyncio.sleep", side_effect=fake_sleep):
        mock_client = MagicMock()
        mock_client.post = AsyncMock(side_effect=[resp_503, resp_200])
        mock_get_client.return_value = mock_client

        md = await fetch_markdown("https://example.com/product", fallback_to_native=False)
        assert "# Product Page" in md
        assert mock_client.post.call_count == 2
        assert len(sleeps) >= 1
