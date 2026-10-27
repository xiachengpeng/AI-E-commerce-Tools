"""Credential-free supplier provenance at the input and scoring boundaries."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

LINK_ALIASES = frozenset(
    {
        "link",
        "url",
        "product_url",
        "meta_url",
        "landing_url",
        "final_url",
        "final_landing_url",
        "source_url",
        "media_url",
        "人工｜广告或落地页链接",
        "人工｜商品链接",
        "AUTO｜商品链接",
        "AUTO｜落地页链接",
    }
)
URL_FIELD_NAMES = LINK_ALIASES | frozenset(
    {
        "advertiser_url",
        "creative_url",
        "input_url",
        "quote_source",
        "supplier_quote_source",
        "target_url",
    }
)

PRODUCT_KEYS = frozenset(
    {
        "id",
        "p",
        "pid",
        "product_id",
        "goods_id",
        "item_id",
        "variant",
        "sku",
        "size",
        "color",
    }
)
SECRET_KEY_PARTS = (
    "token",
    "auth",
    "secret",
    "signature",
    "credential",
    "x-amz-",
    "expires",
)
TRACKING_KEYS = frozenset({"fbclid", "gclid", "mc_cid", "mc_eid"})
FACEBOOK_HOSTS = frozenset(
    {"facebook.com", "www.facebook.com", "m.facebook.com", "fb.com"}
)


def _keep_query_item(host: str, key: str, value: str) -> bool:
    folded = key.casefold()
    if any(part in folded for part in SECRET_KEY_PARTS):
        return False
    if folded.startswith("utm_") or folded in TRACKING_KEYS:
        return False
    approved = {"id"} if host in FACEBOOK_HOSTS else PRODUCT_KEYS
    return (
        folded in approved
        and 0 < len(value) <= 128
        and all(character.isalnum() or character in "-_" for character in value)
    )


def canonical_research_url(value: str) -> str:
    """Retain only explicit, bounded product identifiers; discard all secrets."""
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("research URL must be absolute http(s)")
    host = parsed.hostname.lower()
    host = f"[{host}]" if ":" in host else host
    port = f":{parsed.port}" if parsed.port is not None else ""
    query_host = parsed.hostname.lower().rstrip(".")
    if query_host == "trends.google.com" and parsed.path == "/trends/explore":
        from rabbit_hole.domain.markets import MARKETS

        safe = []
        for key, item in parse_qsl(parsed.query):
            if (key == "q" and 0 < len(item) <= 500 and not any(ord(c) < 32 for c in item)) or (key == "geo" and item in MARKETS) or (key == "date" and item in {"today 12-m", "today 5-y"}):
                safe.append((key, item))
        return urlunsplit((parsed.scheme, host + port, parsed.path, urlencode(safe), ""))
    query = urlencode(
        [
            (key, item)
            for key, item in parse_qsl(parsed.query)
            if _keep_query_item(query_host, key, item)
        ]
    )
    return urlunsplit((parsed.scheme, host + port, parsed.path or "/", query, ""))


def product_identity_url(value: str) -> str:
    """Return the credential-free URL used as a product identity boundary."""

    return canonical_research_url(value)


def sanitize_research_url_fields(value: Any, *, preserve_media: bool = False) -> Any:
    """Copy nested business data while canonicalizing only explicit URL fields."""

    if isinstance(value, Mapping):
        result: dict[Any, Any] = {}
        for key, item in value.items():
            if preserve_media and key == "media":
                from rabbit_hole.domain.ad_media import normalize_ad_media
                result[key] = normalize_ad_media(item)
                continue
            if key in URL_FIELD_NAMES:
                if not isinstance(item, str) or not item.strip():
                    result[key] = None if item is not None else item
                    continue
                try:
                    result[key] = canonical_research_url(item)
                except ValueError:
                    result[key] = None
            else:
                result[key] = sanitize_research_url_fields(item, preserve_media=preserve_media)
        return result
    if isinstance(value, (list, tuple)):
        return [sanitize_research_url_fields(item, preserve_media=preserve_media) for item in value]
    return value


class InvalidSupplierQuoteSource(ValueError):
    """A safe, value-free error suitable for a persisted manual-input failure."""

    detail = "supplier_quote_source must be a bounded http(s) URL without userinfo"

    def __init__(self) -> None:
        super().__init__(self.detail)


def canonical_supplier_quote_source(value: object) -> str | None:
    """Keep only an auditable HTTP(S) origin/path, never URL credentials."""

    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidSupplierQuoteSource()
    source = value.strip()
    if not source:
        return None
    if any(char.isspace() or ord(char) < 32 for char in source):
        raise InvalidSupplierQuoteSource()
    try:
        parsed = urlsplit(source)
        hostname = parsed.hostname
        has_userinfo = parsed.username is not None or parsed.password is not None
        # urllib parses ports lazily; reject malformed ports before persistence.
        _ = parsed.port
    except ValueError:
        raise InvalidSupplierQuoteSource() from None
    if parsed.scheme not in {"http", "https"} or not hostname or has_userinfo:
        raise InvalidSupplierQuoteSource()
    canonical = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    if len(canonical) > 2048:
        raise InvalidSupplierQuoteSource()
    return canonical


def canonical_supplier_inputs(
    fields: Mapping[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Copy supplier inputs, replacing invalid values with null and a safe flag.

    Both supported flat aliases and nested evaluation/order snapshots are
    covered. An invalid field is discarded in full, including unexpected
    structured values, so it cannot enter JSON or a validation error later.
    """

    invalid = False

    def canonicalize(value: Any) -> Any:
        nonlocal invalid
        if isinstance(value, Mapping):
            result = {}
            for key, item in value.items():
                if key in {"supplier_quote_source", "人工｜供应商报价来源"}:
                    try:
                        result[key] = canonical_supplier_quote_source(item)
                    except InvalidSupplierQuoteSource:
                        result[key] = None
                        invalid = True
                elif key in LINK_ALIASES:
                    try:
                        result[key] = (
                            canonical_research_url(item)
                            if isinstance(item, str) and item.strip()
                            else None
                        )
                    except ValueError:
                        result[key] = None
                else:
                    result[key] = canonicalize(item)
            return result
        if isinstance(value, (list, tuple)):
            return [canonicalize(item) for item in value]
        if isinstance(value, str) and value.strip().startswith(("http://", "https://")):
            try:
                return canonical_research_url(value)
            except ValueError:
                return None
        return value

    snapshot: dict[str, Any] = canonicalize(fields)
    return snapshot, invalid
