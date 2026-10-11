"""Source-bound automatic relevance checks; never a business selection decision."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from rabbit_hole.domain.provenance import source_passages
from rabbit_hole.input_urls import product_identity_url


def verification_fingerprint(project: dict[str, Any], product: dict[str, Any]) -> str:
    sources = source_passages(project, product["id"])
    value = {
        "url": product.get("identity_key") or product.get("url"),
        "identity_revision": product.get("identity_revision", 1),
        "landing_type": (product.get("landing_snapshot") or {}).get("page_type"),
        "landing_url": (product.get("landing_snapshot") or {}).get("final_url"),
        "words": [(w["id"], w["text"]) for w in project["keywords"]
                  if w["id"] in product.get("source_keyword_ids", [])],
        "sources": [(s.source_id, s.content_hash) for s in sources],
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def verification_current(project: dict[str, Any], product: dict[str, Any]) -> bool:
    item = product.get("verification") or {}
    return item.get("fingerprint") == verification_fingerprint(project, product)


def batch_signature(project: dict[str, Any], ids: list[str]) -> str:
    # Landing jobs intentionally run before AI. Identity/ad/manual changes fence
    # the whole job; landing contents are checked separately at result commit.
    values = []
    for product_id in ids:
        p = next((p for p in project["products"] if p["id"] == product_id
                  and not p.get("merged_into")), None)
        values.append(None if p is None else {
            "id": p["id"], "name": p["name"], "url": p.get("url"),
            "identity_revision": p.get("identity_revision", 1),
            "confirmation": p.get("identification"),
            "words": [(w["id"], w["text"]) for w in project["keywords"]
                      if w["id"] in p.get("source_keyword_ids", [])],
            "ads": [(s.source_id, s.content_hash) for s in source_passages(project, p["id"])
                    if s.source_kind == "ad"],
        })
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def review_reason(project: dict[str, Any], product: dict[str, Any]) -> str | None:
    sources = source_passages(project, product["id"])
    if not any(s.source_kind == "ad" for s in sources):
        return "缺少与当前商品明确绑定的可用广告原文；请核对原广告。"
    landing = product.get("landing_snapshot") or {}
    if not any(s.source_kind == "landing" for s in sources):
        return "商品页读取未完成或没有可用正文；可重试读取或人工确认。"
    if landing.get("page_type") != "product":
        return "当前落地页不是明确的单品页；请指定准确商品后核对。"
    try:
        final = landing.get("final_url") or landing.get("source_url")
        if not isinstance(final, str):
            return "商品页来源地址不完整；需要核对来源。"
        if product_identity_url(final) != product_identity_url(product["url"]):
            return "商品页跳转到不同地址；需要核对是否仍为同一商品。"
    except (ValueError, TypeError):
        return "商品页来源地址不完整；需要核对来源。"
    return None


def normalize_assessment(project: dict[str, Any], product: dict[str, Any],
                         item: Any) -> dict[str, Any]:
    fingerprint = verification_fingerprint(project, product)
    result: dict[str, Any] = {
        "product_id": product["id"], "status": "needs_review",
        "fingerprint": fingerprint, "name": product["name"],
        "reason": "AI未给出完整可核对的匹配依据，请人工确认。", "citations": [],
    }
    if not isinstance(item, dict):
        return result
    if item.get("fingerprint") != fingerprint:
        result["reason"] = "来源或商品身份已变化，旧自动核对结果未采用；请重新核对。"
        return result
    reason = review_reason(project, product)
    if reason:
        detail = item.get("reason")
        result["reason"] = reason + (" 读取记录：" + detail[:1000] if isinstance(detail, str) and detail != reason else "")
        return result
    passages = {s.source_id: s for s in source_passages(project, product["id"])}
    citations = item.get("citations")
    if not isinstance(citations, list) or not 2 <= len(citations) <= 6:
        return result
    valid = []
    for citation in citations:
        if not isinstance(citation, dict):
            return result
        source_id = citation.get("source_id")
        source = passages.get(source_id) if isinstance(source_id, str) else None
        quote = citation.get("source_quote")
        if (source is None or citation.get("source_kind") != source.source_kind
            or citation.get("content_hash") != source.content_hash
            or not isinstance(quote, str) or not 4 <= len(quote.strip()) <= 800
            or quote not in source.text):
            return result
        valid.append({key: citation[key] for key in (
            "source_id", "source_kind", "source_quote", "content_hash")})
    if {c["source_kind"] for c in valid} != {"ad", "landing"}:
        return result
    reason, name = item.get("reason"), item.get("name")
    if (not isinstance(reason, str) or not 4 <= len(reason.strip()) <= 1000
        or not isinstance(name, str) or not 2 <= len(name.strip()) <= 200):
        return result
    if not any(name.strip().casefold() in s.text.casefold() for s in passages.values()):
        result["reason"] = "AI商品名称无法在来源原文中找到，请确认准确商品名称。"
        return result
    result.update(reason=reason.strip(), name=name.strip(), citations=valid)
    if item.get("status") == "mismatch":
        result["status"] = "mismatch"
    elif (item.get("status") == "matched" and item.get("confidence") == "high"
          and item.get("keyword_relevant") is True):
        result.update(status="matched", confidence="high", keyword_relevant=True)
    else:
        result["reason"] = "AI匹配把握不足或关键词相关性不明确：" + reason.strip()
    return result
