"""Bounded public preview references; missing assets never become fake evidence."""
from __future__ import annotations

from ipaddress import ip_address
from typing import Any
from urllib.parse import urlsplit

from rabbit_hole.input_urls import canonical_research_url


def _public_media_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 2000:
        return None
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
            return None
        if host == "localhost" or host.endswith((".local", ".localhost")):
            return None
        try:
            address = ip_address(host)
        except ValueError:
            if "." not in host:
                return None
        else:
            if not address.is_global:
                return None
        return canonical_research_url(value)
    except ValueError:
        return None


def normalize_ad_media(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in value[:40]:
        if not isinstance(item, dict) or item.get("kind") not in ("video", "image"):
            continue
        url = _public_media_url(item.get("url"))
        if not url or url in seen:
            continue
        media = {"kind": item["kind"], "url": url}
        preview = _public_media_url(item.get("preview_url"))
        if preview:
            media["preview_url"] = preview
        result.append(media)
        seen.add(url)
        if len(result) == 12:
            break
    return result
