"""Explicit third-party page reading; no inferred facts or paid request retries."""
from __future__ import annotations

import json

import httpx

from rabbit_hole.input_urls import canonical_research_url
from rabbit_hole.integrations.collectors.landing import (
    LandingCollector,
    LandingSnapshot,
)
from rabbit_hole.integrations.collectors.provider_api import ProviderError
from rabbit_hole.security import SafeUrlClient, UnsafeUrl


async def scrape_landing(
    client: httpx.AsyncClient, key: str, url: str, guard: SafeUrlClient
) -> LandingSnapshot:
    try:
        await guard.pinned_address(url)
        requested = canonical_research_url(url)
    except (UnsafeUrl, ValueError):
        raise ProviderError("unsafe_url", "商品页链接不是可访问的公网地址") from None
    try:
        async with client.stream(
            "POST", "https://api.firecrawl.dev/v2/scrape",
            headers={"Authorization": "Bearer " + key},
            json={"url": requested, "formats": ["rawHtml"], "maxAge": 0,
                  "timeout": 60000, "skipTlsVerification": False, "parsers": []},
        ) as response:
            status = response.status_code
            if status >= 300:
                code = "budget" if status == 402 else "access_restricted" if status in {401, 403, 429} else "source_error"
                reason = {401: "密钥无效", 402: "额度不足", 403: "访问被拒绝", 429: "请求限流"}.get(status, "接口请求失败")
                raise ProviderError(code, f"Firecrawl {reason}（HTTP {status}）；未改用其他方式")
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > SafeUrlClient.max_body_bytes:
                    raise ProviderError("source_error", "Firecrawl 返回内容超过保存上限")
    except httpx.TimeoutException:
        raise ProviderError("source_error", "Firecrawl 请求超时，云端可能已计费；请核对后手动重试") from None
    except httpx.HTTPError:
        raise ProviderError("source_error", "Firecrawl 连接失败，无法确认云端结果；请核对后手动重试") from None
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ProviderError("schema_drift", "Firecrawl 未返回有效 JSON") from None
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise ProviderError("source_error", "Firecrawl 返回读取失败；未保存为商品页证据")
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("metadata"), dict):
        raise ProviderError("schema_drift", "Firecrawl 缺少商品页元数据")
    meta = data["metadata"]
    page_status = meta.get("statusCode")
    if type(page_status) is not int or not 200 <= page_status < 300 or meta.get("error"):
        status_text = str(page_status) if type(page_status) is int else "未知"
        raise ProviderError("source_error", f"Firecrawl 商品页返回 HTTP {status_text}，未作为有效证据保存")
    final = meta.get("url") or meta.get("sourceURL")
    if not isinstance(final, str):
        raise ProviderError("schema_drift", "Firecrawl 未提供商品页来源链接")
    try:
        final = canonical_research_url(final)
        if final != requested:
            await guard.pinned_address(final)
    except (UnsafeUrl, ValueError):
        raise ProviderError("unsafe_url", "Firecrawl 来源链接校验失败，请检查链接或 DNS 连接") from None
    html = data.get("rawHtml")
    if not isinstance(html, str) or not html.strip():
        raise ProviderError("schema_drift", "Firecrawl 未返回商品页 HTML；未生成虚假结果")
    try:
        snapshot = LandingCollector._snapshot(
            html.encode("utf-8"), final, requested_url=requested,
            http_final_url=final, http_status_code=page_status, rendering_mode="firecrawl",
        )
    except (ValueError, UnicodeError):
        raise ProviderError("schema_drift", "Firecrawl 商品页内容无法解析") from None
    if not snapshot.body_text.strip():
        raise ProviderError("schema_drift", "Firecrawl 商品页没有可读取正文")
    title = meta.get("title")
    if isinstance(title, str) and title.strip():
        snapshot = snapshot.model_copy(update={"title": title.strip()[:500]})
    return snapshot
