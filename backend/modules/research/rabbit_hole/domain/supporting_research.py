"""Conservative, read-only signals for optional product research."""

from __future__ import annotations

from typing import Any


def evergreen_signal(product: dict[str, Any]) -> dict[str, Any]:
    """Report an ad-survival observation, never an economic conclusion."""
    identity = product.get("identification") or {}
    reason = "长期广告存续仅是线索，不证明持续投放或盈利。"
    result: dict[str, Any] = {
        "status": "unknown", "age_days": identity.get("ad_age_days"),
        "source_ad_ids": [], "reason": reason,
    }
    if identity.get("identity_revision", 1) != product.get("identity_revision", 1):
        return result
    if identity.get("relevance_confirmed") is not True:
        return result
    if identity.get("currently_active") is False:
        result["status"] = "not_observed"
        return result
    if identity.get("currently_active") is not True:
        return result
    age = identity.get("ad_age_days")
    if not isinstance(age, (int, float)) or isinstance(age, bool) or age < 0:
        return result
    creatives = identity.get("creatives") or []
    linked = [
        creative for creative in creatives
        if isinstance(creative, dict)
        and creative.get("active") is True
        and creative.get("distinct") is True
        and creative.get("source_url")
        and creative.get("id")
    ]
    if not linked:
        return result
    result["source_ad_ids"] = list(dict.fromkeys(str(item["id"]) for item in linked))
    result["status"] = "observed" if age >= 365 else "not_observed"
    return result
