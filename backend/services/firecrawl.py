import html
import json
import logging
import re
import time

import httpx

from config import FIRECRAWL_API_KEY, FIRECRAWL_API_URL
from services.app_log_service import app_logs
from services.security_utils import validate_outbound_url

logger = logging.getLogger(__name__)

# 可复用的客户端
_client: httpx.AsyncClient | None = None

_ORIG_FIRECRAWL_API_KEY = FIRECRAWL_API_KEY
_ORIG_FIRECRAWL_API_URL = FIRECRAWL_API_URL


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    val = value.strip()
    if len(val) <= 8:
        return "••••••••"
    return f"{val[:3]}••••{val[-3:]}"


def is_masked_or_empty(value: str | None) -> bool:
    if not value or not value.strip():
        return True
    return "••••" in value


def get_firecrawl_config(db=None) -> tuple[str, str]:
    """获取当前生效的 Firecrawl 配置 (api_url, api_key)。
    若单元测试显式 monkeypatch 了模块级变量，优先尊重测试配置；
    生产环境下优先从数据库中读取，数据库未配置时回退至环境变量/默认值。
    """
    if FIRECRAWL_API_KEY != _ORIG_FIRECRAWL_API_KEY or FIRECRAWL_API_URL != _ORIG_FIRECRAWL_API_URL:
        return FIRECRAWL_API_URL, FIRECRAWL_API_KEY

    api_url = FIRECRAWL_API_URL
    api_key = FIRECRAWL_API_KEY

    try:
        from db import FirecrawlConfig, SessionLocal
        session = db or SessionLocal()
        try:
            cfg = session.query(FirecrawlConfig).first()
            if cfg is not None:
                if cfg.api_url and cfg.api_url.strip():
                    api_url = cfg.api_url.strip()
                if cfg.api_key is not None:
                    api_key = cfg.api_key.strip()
        finally:
            if db is None:
                session.close()
    except Exception as exc:
        logger.debug("读取 Firecrawl 数据库配置异常，使用默认配置: %s", exc)

    return api_url, api_key


async def test_firecrawl_connection(
    api_url: str | None = None,
    api_key: str | None = None,
    db=None,
) -> tuple[bool, int, str]:
    """测试 Firecrawl 连接性并测量端到端往返耗时。"""
    current_url, current_key = get_firecrawl_config(db=db)
    target_url = (api_url or "").strip() or current_url or "https://api.firecrawl.dev/v1/scrape"

    if api_key is not None and not is_masked_or_empty(api_key):
        target_key = api_key.strip()
    else:
        target_key = current_key

    if "api.firecrawl.dev" in target_url.lower() and not target_key:
        return False, 0, "未配置 API Key，官方 Firecrawl 服务需要提供有效的 API Key"

    headers = {"Content-Type": "application/json"}
    if target_key:
        headers["Authorization"] = f"Bearer {target_key}"

    payload = {
        "url": "https://example.com",
        "formats": ["markdown"],
        "onlyMainContent": True,
        "timeout": 15000,
    }

    client = _get_client()
    started = time.monotonic()
    try:
        response = await client.post(target_url, json=payload, headers=headers)
        duration_ms = round((time.monotonic() - started) * 1000)
        status_code = response.status_code
        if status_code == 200:
            return True, duration_ms, "连接成功"
        elif status_code == 401:
            return False, duration_ms, "Firecrawl API Key 无效或未授权 (401 Unauthorized)"
        elif status_code == 402:
            return False, duration_ms, "Firecrawl 账户额度不足 (402 Payment Required)"
        elif status_code == 429:
            return False, duration_ms, "Firecrawl 请求过于频繁 (429 Rate Limit)"
        elif status_code == 500:
            return False, duration_ms, "Firecrawl 服务端错误 (500 Internal Server Error)"
        else:
            return False, duration_ms, f"Firecrawl HTTP {status_code}"
    except httpx.ConnectTimeout:
        duration_ms = round((time.monotonic() - started) * 1000)
        return False, duration_ms, "连接超时，请检查服务地址与网络状态"
    except httpx.ConnectError as exc:
        duration_ms = round((time.monotonic() - started) * 1000)
        return False, duration_ms, f"无法建立网络连接: {exc}"
    except Exception as exc:
        duration_ms = round((time.monotonic() - started) * 1000)
        return False, duration_ms, f"连接测试失败: {exc}"


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=30.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
    return _client


def _clean_html_text(text: str) -> str:
    if not text:
        return ""
    clean = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.IGNORECASE)
    clean = re.sub(r"<style[\s\S]*?</style>", " ", clean, flags=re.IGNORECASE)
    clean = re.sub(r"<noscript[\s\S]*?</noscript>", " ", clean, flags=re.IGNORECASE)
    clean = re.sub(r"<svg[\s\S]*?</svg>", " ", clean, flags=re.IGNORECASE)
    clean = re.sub(r"<br\s*/?>", "\n", clean, flags=re.IGNORECASE)
    clean = re.sub(r"</p>", "\n\n", clean, flags=re.IGNORECASE)
    clean = re.sub(r"</li>", "\n", clean, flags=re.IGNORECASE)
    clean = re.sub(r"<[^>]+>", " ", clean)
    clean = html.unescape(clean)
    clean = re.sub(r"[ \t]+", " ", clean)
    clean = re.sub(r"\n\s*\n+", "\n\n", clean)
    return clean.strip()


def _extract_markdown_from_html(raw_html: str, target_url: str = "") -> str:
    from services.cleaner import check_block
    if check_block(raw_html):
        raise Exception("目标网页触发反爬虫验证机制 (Captcha/Block)")

    title = ""
    price = ""
    bullets = []
    description = ""

    # 1. 尝试解析 JSON-LD Product Schema
    ld_matches = re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>', raw_html, re.IGNORECASE)
    for ld in ld_matches:
        try:
            parsed = json.loads(ld.strip())
            items = parsed if isinstance(parsed, list) else [parsed]
            for item in items:
                if isinstance(item, dict) and item.get("@type") in ("Product", "IndividualProduct"):
                    if not title and item.get("name"):
                        title = str(item.get("name")).strip()
                    if not description and item.get("description"):
                        description = str(item.get("description")).strip()
                    offers = item.get("offers")
                    cur_map = {"USD": "$", "EUR": "€", "GBP": "£", "CNY": "¥", "JPY": "¥"}
                    if isinstance(offers, dict) and not price:
                        p = offers.get("price")
                        cur = offers.get("priceCurrency", "$")
                        sym = cur_map.get(str(cur).upper(), str(cur))
                        if p:
                            price = f"{sym}{p}".strip()
                    elif isinstance(offers, list) and offers and not price:
                        p = offers[0].get("price")
                        cur = offers[0].get("priceCurrency", "$")
                        sym = cur_map.get(str(cur).upper(), str(cur))
                        if p:
                            price = f"{sym}{p}".strip()
        except Exception:
            continue

    # 2. 尝试解析 Amazon 常见 DOM 结构
    if not title:
        m_title = re.search(r'<span[^>]*id=["\']productTitle["\'][^>]*>([\s\S]*?)</span>', raw_html, re.IGNORECASE)
        if m_title:
            title = _clean_html_text(m_title.group(1))

    if not price:
        m_price_whole = re.search(r'<span[^>]*class=["\'][^"\']*a-price-whole[^"\']*["\'][^>]*>([\s\S]*?)</span>', raw_html, re.IGNORECASE)
        m_price_frac = re.search(r'<span[^>]*class=["\'][^"\']*a-price-fraction[^"\']*["\'][^>]*>([\s\S]*?)</span>', raw_html, re.IGNORECASE)
        if m_price_whole:
            w = _clean_html_text(m_price_whole.group(1)).rstrip(".")
            f = _clean_html_text(m_price_frac.group(1)) if m_price_frac else "00"
            price = f"${w}.{f}"
        else:
            m_price_alt = re.search(r'<span[^>]*id=["\'](?:priceblock_ourprice|corePrice_desktop)[^"\']*["\'][^>]*>([\s\S]*?)</span>', raw_html, re.IGNORECASE)
            if m_price_alt:
                price = _clean_html_text(m_price_alt.group(1))

    # Amazon 特性列表 (feature-bullets)
    m_bullets_div = re.search(r'<div[^>]*id=["\']feature-bullets["\'][^>]*>([\s\S]*?)</div>', raw_html, re.IGNORECASE)
    if m_bullets_div:
        items = re.findall(r'<span[^>]*class=["\'][^"\']*a-list-item[^"\']*["\'][^>]*>([\s\S]*?)</span>', m_bullets_div.group(1), re.IGNORECASE)
        for it in items:
            cleaned_it = _clean_html_text(it)
            if cleaned_it and len(cleaned_it) > 5:
                bullets.append(cleaned_it)

    # Amazon 描述
    if not description:
        m_desc = re.search(r'<div[^>]*id=["\']productDescription["\'][^>]*>([\s\S]*?)</div>', raw_html, re.IGNORECASE)
        if m_desc:
            description = _clean_html_text(m_desc.group(1))

    # 3. 通用 HTML Meta 标签回退
    if not title:
        m_og_title = re.search(r'<meta[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\']*)["\']', raw_html, re.IGNORECASE)
        if m_og_title:
            title = html.unescape(m_og_title.group(1)).strip()
        else:
            m_tag_title = re.search(r'<title[^>]*>([\s\S]*?)</title>', raw_html, re.IGNORECASE)
            if m_tag_title:
                title = _clean_html_text(m_tag_title.group(1))

    if not description:
        m_og_desc = re.search(r'<meta[^>]*property=["\']og:description["\'][^>]*content=["\']([^"\']*)["\']', raw_html, re.IGNORECASE)
        if not m_og_desc:
            m_og_desc = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']*)["\']', raw_html, re.IGNORECASE)
        if m_og_desc:
            description = html.unescape(m_og_desc.group(1)).strip()

    if not price:
        m_og_price = re.search(r'<meta[^>]*property=["\']product:price:amount["\'][^>]*content=["\']([^"\']*)["\']', raw_html, re.IGNORECASE)
        if m_og_price:
            price = f"${html.unescape(m_og_price.group(1)).strip()}"

    # 组装 Markdown
    out = []
    if title:
        out.append(f"# {title}\n")
    if price:
        out.append(f"Price: {price}\n")
    if bullets:
        out.append("## About this item\n")
        for b in bullets:
            out.append(f"- {b}")
        out.append("")
    if description:
        out.append("## Product description\n")
        out.append(description)
        out.append("")

    # 如果提取到的内容过短，补全页面文本
    if len("\n".join(out).strip()) < 100:
        cleaned_body = _clean_html_text(raw_html)
        if cleaned_body:
            out.append("## Page Content\n")
            out.append(cleaned_body[:8000])

    return "\n".join(out).strip()


async def native_fetch_markdown(url: str) -> str:
    """
    原生抓取降级器：当未配置 Firecrawl API Key、官方额度耗尽或请求失败时，
    直接使用 HTTP 请求页面 HTML 并解析商品结构化数据与关键 DOM，拼接为标准 Markdown。
    """
    if not url or not url.strip():
        raise ValueError("URL 不能为空")
    target_url = url.strip()
    if not (target_url.startswith("http://") or target_url.startswith("https://")):
        raise ValueError("URL 格式无效，必须以 http:// 或 https:// 开头")

    safe, ssrf_err = validate_outbound_url(target_url, allow_local=False, require_http=True)
    if not safe:
        app_logs.emit(
            level="error",
            source="crawler",
            message=f"原生网页抓取地址不合规: {ssrf_err}",
        )
        raise ValueError(f"目标地址安全校验未通过: {ssrf_err}")

    started = time.monotonic()
    app_logs.emit(
        level="info",
        source="crawler",
        message="启动原生网页抓取降级",
    )
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    }

    client = _get_client()
    try:
        resp = await client.get(target_url, headers=headers, follow_redirects=True)
        resp.raise_for_status()
        raw_html = resp.text
    except Exception as exc:
        duration_ms = round((time.monotonic() - started) * 1000)
        app_logs.emit(
            level="error",
            source="crawler",
            message="原生网页抓取失败",
            duration_ms=duration_ms,
        )
        raise Exception(f"原生网页抓取网络请求失败: {exc}") from None

    md = _extract_markdown_from_html(raw_html, target_url)
    if not md or len(md.strip()) < 30:
        duration_ms = round((time.monotonic() - started) * 1000)
        app_logs.emit(
            level="error",
            source="crawler",
            message="原生网页抓取内容解析为空",
            duration_ms=duration_ms,
        )
        raise Exception("原生抓取未能提取到有效的商品或页面内容")

    duration_ms = round((time.monotonic() - started) * 1000)
    app_logs.emit(
        level="success",
        source="crawler",
        message="原生网页抓取完成",
        duration_ms=duration_ms,
    )
    return md


async def fetch_markdown(url: str, max_age: int = 3600, fallback_to_native: bool = False) -> str:
    """
    异步调用 Firecrawl API 抓取页面并返回 Markdown 内容。
    支持自动降级到原生抓取器。
    """
    current_url, current_key = get_firecrawl_config()
    if "api.firecrawl.dev" in (current_url or "").lower() and not current_key:
        if fallback_to_native:
            logger.info("未配置 FIRECRAWL_API_KEY，自动切换至原生抓取降级模式")
            return await native_fetch_markdown(url)
        raise ValueError("未配置 FIRECRAWL_API_KEY，请在“系统设置”页面中配置 Firecrawl API 密钥")

    payload = {
        "url": url,
        "formats": ["markdown"],
        "onlyMainContent": False,
        "includeTags": [],
        "excludeTags": [],
        "maxAge": max_age,
        "waitFor": 1000,
        "mobile": False,
        "skipTlsVerification": False,
        "timeout": 60000,
        "removeBase64Images": True,
        "blockAds": True,
        "proxy": "auto",
    }

    headers = {"Content-Type": "application/json"}
    if current_key:
        headers["Authorization"] = f"Bearer {current_key}"

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
            current_url,
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
        if fallback_to_native:
            logger.warning("Firecrawl 请求返回 HTTP %s，触发原生抓取降级", status_code)
            try:
                return await native_fetch_markdown(url)
            except Exception as fb_exc:
                logger.error("原生网页抓取降级失败: %s", fb_exc)
        if status_code == 401:
            raise Exception("Firecrawl API Key 无效或未授权 (401 Unauthorized)") from None
        if status_code == 402:
            raise Exception("Firecrawl 账户额度不足 (402 Payment Required)") from None
        if status_code == 429:
            raise Exception("Firecrawl 请求过于频繁 (429 Rate Limit)") from None
        if status_code == 500:
            raise Exception("Firecrawl 服务端错误 (500 Internal Server Error)") from None
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
    except Exception as exc:
        logger.error("Firecrawl request failed: %s", exc)
        app_logs.emit(
            level="error",
            source="crawler",
            message="爬虫请求失败",
            duration_ms=round((time.monotonic() - started) * 1000),
        )
        if fallback_to_native:
            logger.warning("Firecrawl 异常 (%s)，触发原生抓取降级", exc)
            try:
                return await native_fetch_markdown(url)
            except Exception as fb_exc:
                logger.error("原生网页抓取降级失败: %s", fb_exc)
        raise Exception("Failed to fetch content from Firecrawl") from None


async def close_client() -> None:
    global _client
    client = _client
    _client = None
    if client is not None:
        await client.aclose()
