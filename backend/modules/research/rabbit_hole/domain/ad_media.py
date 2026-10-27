"""Bounded public preview references; missing assets never become fake evidence."""
from __future__ import annotations

from ipaddress import ip_address
from typing import Any
from urllib.parse import unquote_plus, urlsplit, urlunsplit

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
        safe = canonical_research_url(value)
        # Meta CDN delivery signatures are not provider credentials. They must
        # remain byte-for-byte intact for playback, only on the actual CDN.
        # Arbitrary URL credentials still follow the normal scrubbed boundary.
        if host == "fbcdn.net" or host.endswith(".fbcdn.net"):
            allowed = {"oh", "oe", "efg", "stp", "edm", "ccb", "vs", "bytestart", "byteend",
                       "_nc_cat", "_nc_sid", "_nc_ss", "_nc_ht", "_nc_ohc", "_nc_oc", "_nc_gid",
                       "_nc_zt", "_nc_eui2", "_nc_rid", "_nc_cb", "_nc_vs", "_nc_vts",
                       "_nc_rnd", "_nc_ad"}
            parts = []
            for part in parsed.query.split("&"):
                key, _, item = part.partition("=")
                key = unquote_plus(key)
                if key in allowed and len(item) <= 1024 and not any(ord(c) < 32 for c in unquote_plus(item)):
                    parts.append(part)
            base = urlsplit(safe)
            return urlunsplit((base.scheme, base.netloc, base.path, "&".join(parts), ""))
        return safe
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
