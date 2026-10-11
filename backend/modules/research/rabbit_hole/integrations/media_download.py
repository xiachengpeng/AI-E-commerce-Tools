"""Bound downloads to saved product/ad media and the existing safe HTTP client."""
from __future__ import annotations

import os
from typing import Any

import httpx

from rabbit_hole.domain.ad_media import normalize_ad_media
from rabbit_hole.security import (
    ResponseTooLarge,
    SafeUrlClient,
    UnsafeUrl,
    google_public_dns,
)


class MediaDownloadError(ValueError):
    pass


def select_media(project: dict[str, Any], keyword_id: str, product_id: str,
                 ad_id: str, source: str, index: int) -> dict[str, str]:
    word = next((w for w in project["keywords"] if w["id"] == keyword_id), None)
    product = next((p for p in project["products"] if p["id"] == product_id), None)
    if not word or (product_id and (not product or keyword_id not in product.get("source_keyword_ids", []))):
        raise MediaDownloadError("当前线索不存在，请刷新后重试")
    if source == "product":
        images = ((product or {}).get("landing_snapshot") or {}).get("images", [])
        items = normalize_ad_media([{"kind": "image", "url": u} for u in images])
    elif source == "ad":
        if product and not any(b.get("keyword_id") == keyword_id and b.get("ad_id") == ad_id
                               for b in product.get("candidate_sources", [])):
            raise MediaDownloadError("广告未绑定当前商品，不能下载其他线索素材")
        ad: dict[str, Any] = next((a for a in word.get("ads", []) if a["id"] == ad_id), {})
        items = normalize_ad_media(ad.get("media"))
    else:
        raise MediaDownloadError("请选择商品图或广告素材")
    if not 0 <= index < len(items):
        raise MediaDownloadError("当前素材未保存或已变化，请刷新后重试")
    return items[index]


class MediaUrlClient(SafeUrlClient):
    max_body_bytes = 50 * 1024 * 1024


async def read_media_download(item: dict[str, str], client: SafeUrlClient | None = None) -> tuple[bytes, str, str]:
    if client is None:
        client = MediaUrlClient(resolver=google_public_dns if os.getenv("RABBIT_HOLE_PUBLIC_DNS") == "google" else None)
    try:
        response = await client.get(item["url"])
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise MediaDownloadError(f"下载失败：来源返回 HTTP {exc.response.status_code}，可打开原来源核对链接。") from exc
    except ResponseTooLarge as exc:
        raise MediaDownloadError("下载失败：素材超过50MB，请打开原来源保存。") from exc
    except (httpx.HTTPError, UnsafeUrl, ValueError) as exc:
        raise MediaDownloadError("下载失败：来源连接失败、超时或链接不安全。可打开原来源保存。") from exc
    media_type = response.headers.get("content-type", "").split(";")[0].lower().strip()
    extensions = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
                  "image/avif": "avif", "image/gif": "gif", "video/mp4": "mp4",
                  "video/webm": "webm", "video/quicktime": "mov"}
    if media_type not in extensions or not response.content:
        raise MediaDownloadError("来源未返回可下载的图片或视频，可能已失效或需要登录")
    return response.content, media_type, extensions[media_type]
