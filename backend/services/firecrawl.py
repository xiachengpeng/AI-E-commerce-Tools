import logging
import time

import httpx

from config import FIRECRAWL_API_URL
from services.app_log_service import app_logs

logger = logging.getLogger(__name__)

# 可复用的客户端
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=30.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
    return _client


async def fetch_markdown(url: str, max_age: int = 3600) -> str:
    """
    异步调用 Firecrawl API 抓取页面并返回 Markdown 内容。
    """
    payload = {
        "url": url,
        "formats": ["markdown"],
        "onlyMainContent": False,
        "includeTags": [],
        "excludeTags": [],
        "maxAge": max_age,
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/122.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Cookie": "i18n-prefs=USD; lc-main=en_US;",
        },
        "waitFor": 1000,
        "mobile": False,
        "skipTlsVerification": False,
        "timeout": 60000,
        "removeBase64Images": True,
        "blockAds": True,
        "proxy": "auto",
    }

    headers = {"Content-Type": "application/json"}
    client = _get_client()
    started = time.monotonic()

    logger.info("Firecrawl request started")
    app_logs.emit(
        level="info",
        source="crawler",
        message="爬虫请求开始",
    )
    try:
        response = await client.post(
            FIRECRAWL_API_URL,
            json=payload,
            headers=headers,
        )
        response.raise_for_status()
        data = response.json()

        # V2 响应结构兼容性处理
        if "data" in data and isinstance(data["data"], dict) and "markdown" in data["data"]:
            md = data["data"]["markdown"]
        elif "markdown" in data:
            md = data["markdown"]
        else:
            logger.error(
                "Firecrawl response missing markdown: field_count=%s",
                len(data) if isinstance(data, dict) else 0,
            )
            raise ValueError("Markdown content not found in Firecrawl response.")

        duration_ms = round((time.monotonic() - started) * 1000)
        logger.info(
            "Firecrawl request completed: content_length=%s duration_ms=%s",
            len(md),
            duration_ms,
        )
        app_logs.emit(
            level="success",
            source="crawler",
            message="爬虫请求完成",
            duration_ms=duration_ms,
        )
        return md
    except httpx.HTTPStatusError as e:
        status_code = getattr(e.response, "status_code", None)
        logger.error("Firecrawl HTTP failure: status=%s", status_code)
        app_logs.emit(
            level="error",
            source="crawler",
            message="爬虫请求失败",
            duration_ms=round((time.monotonic() - started) * 1000),
        )
        raise Exception(
            f"Firecrawl HTTP {status_code}"
        ) from None
    except ValueError as exc:
        app_logs.emit(
            level="error",
            source="crawler",
            message="爬虫请求失败",
            duration_ms=round((time.monotonic() - started) * 1000),
        )
        raise Exception(str(exc)) from None
    except Exception:
        logger.error("Firecrawl request failed")
        app_logs.emit(
            level="error",
            source="crawler",
            message="爬虫请求失败",
            duration_ms=round((time.monotonic() - started) * 1000),
        )
        raise Exception("Failed to fetch content from Firecrawl") from None


async def close_client() -> None:
    global _client
    client = _client
    _client = None
    if client is not None:
        await client.aclose()
