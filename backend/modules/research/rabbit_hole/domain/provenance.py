"""Deterministic, product-bound passages for keyword expansion."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from hashlib import sha256
from typing import Any, Literal

from rabbit_hole.domain.ad_copy import usable_ad_copy
from rabbit_hole.input_urls import product_identity_url

MAX_PASSAGE_TEXT = 10_000
MAX_PASSAGES = 200
MAX_TOTAL_TEXT = 25_000


@dataclass(frozen=True, slots=True)
class SourcePassage:
    source_id: str
    source_kind: Literal["landing", "ad"]
    product_id: str
    identity_revision: int
    text: str
    content_hash: str
    keyword_id: str | None = None
    ad_id: str | None = None

    def public_view(self) -> dict[str, Any]:
        return asdict(self)


def _identity_revision(product: Mapping[str, Any]) -> int:
    value = product.get("identity_revision", 1)
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 1
        else 1
    )


def _identity_key(product: Mapping[str, Any]) -> str | None:
    value = product.get("identity_key") or product.get("url")
    if not isinstance(value, str):
        return None
    try:
        return product_identity_url(value)
    except ValueError:
        return None


def _safe_identity(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return product_identity_url(value)
    except ValueError:
        return None


def _bounded_text(value: Any) -> str:
    return value[:MAX_PASSAGE_TEXT] if isinstance(value, str) else ""


def source_passages(
    project: Mapping[str, Any], product_id: str
) -> tuple[SourcePassage, ...]:
    products = project.get("products", [])
    if not isinstance(products, list):
        return ()
    product = next(
        (
            item
            for item in products
            if isinstance(item, Mapping)
            and item.get("id") == product_id
            and not item.get("merged_into")
        ),
        None,
    )
    if product is None:
        return ()
    revision = _identity_revision(product)
    identity = _identity_key(product)
    if identity is None:
        return ()

    passages: list[SourcePassage] = []
    landing = product.get("landing_snapshot")
    if isinstance(landing, Mapping) and landing.get("identity_revision", 1) == revision:
        text = _bounded_text(landing.get("body_text"))
        if text:
            content_hash = landing.get("content_hash")
            if not isinstance(content_hash, str) or not content_hash:
                content_hash = sha256(text.encode()).hexdigest()
            passages.append(
                SourcePassage(
                    source_id=f"landing:{product_id}:{revision}:{content_hash}",
                    source_kind="landing",
                    product_id=product_id,
                    identity_revision=revision,
                    text=text,
                    content_hash=content_hash,
                )
            )

    keywords = {
        item.get("id"): item
        for item in project.get("keywords", [])
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    allowed_keywords = {
        item for item in product.get("source_keyword_ids", []) if isinstance(item, str)
    }
    candidates = [
        item
        for item in product.get("candidate_sources", [])
        if isinstance(item, Mapping)
    ]
    candidates.sort(
        key=lambda item: (
            str(item.get("recorded_at", "")),
            str(item.get("keyword_id", "")),
            str(item.get("ad_id", "")),
        )
    )
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        keyword_id, ad_id = candidate.get("keyword_id"), candidate.get("ad_id")
        if (
            not isinstance(keyword_id, str)
            or keyword_id not in allowed_keywords
            or not isinstance(ad_id, str)
            or (keyword_id, ad_id) in seen
            or _safe_identity(candidate.get("landing_url")) != identity
        ):
            continue
        keyword = keywords.get(keyword_id)
        if not isinstance(keyword, Mapping):
            continue
        ad = next(
            (
                item
                for item in keyword.get("ads", [])
                if isinstance(item, Mapping) and item.get("id") == ad_id
            ),
            None,
        )
        if (
            ad is None
            or _safe_identity(ad.get("landing_url")) != identity
            or not usable_ad_copy(text := _bounded_text(ad.get("primary_text")))
        ):
            continue
        content_hash = sha256(text.encode()).hexdigest()
        passages.append(
            SourcePassage(
                source_id=f"ad:{product_id}:{revision}:{keyword_id}:{ad_id}",
                source_kind="ad",
                product_id=product_id,
                identity_revision=revision,
                text=text,
                content_hash=content_hash,
                keyword_id=keyword_id,
                ad_id=ad_id,
            )
        )
        seen.add((keyword_id, ad_id))

    bounded: list[SourcePassage] = []
    total = 0
    for passage in passages[:MAX_PASSAGES]:
        if total + len(passage.text) > MAX_TOTAL_TEXT:
            break
        bounded.append(passage)
        total += len(passage.text)
    return tuple(bounded)


def resolve_source_passage(
    project: Mapping[str, Any],
    product_id: str,
    source_id: str,
    source_kind: str,
) -> SourcePassage | None:
    return next(
        (
            item
            for item in source_passages(project, product_id)
            if item.source_id == source_id and item.source_kind == source_kind
        ),
        None,
    )
