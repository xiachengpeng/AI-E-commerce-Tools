import logging

import httpx

from config import FIRECRAWL_API_URL

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


async def fetch_markdown(url: str) -> str:
    """
    异步调用 Firecrawl API 抓取页面并返回 Markdown 内容。
    """
    payload = {
        "url": url,
        "formats": ["markdown"],
        "onlyMainContent": False,
        "includeTags": [],
        "excludeTags": [],
        "maxAge": 3600,
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

    logger.info(f"🕸️ [爬虫] 正在通过 Firecrawl 异步抓取页面: {url}...")
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
            logger.error(f"❌ [爬虫] 响应格式不匹配: {data.keys()}")
            raise ValueError("Markdown content not found in Firecrawl response.")

        logger.info(f"✅ [爬虫] 页面抓取成功: {url} (长度: {len(md)})")
        return md
    except httpx.HTTPStatusError as e:
        logger.error(f"❌ [爬虫] HTTP {e.response.status_code}: {e.response.text}")
        raise Exception(f"Firecrawl HTTP {e.response.status_code}: {e.response.text}")
    except Exception as e:
        logger.error(f"❌ [爬虫] 抓取失败: {e}")
        raise Exception(f"Failed to fetch content from Firecrawl: {e}")
