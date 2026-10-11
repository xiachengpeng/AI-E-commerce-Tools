"""Keep unresolved dynamic templates out of readable source passages."""
from __future__ import annotations

import re
from typing import Any

_TEMPLATE = re.compile(r"\{\{[^{}]*\}\}")


def usable_ad_copy(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and not _TEMPLATE.search(value)


def snapshot_ad_copy(snapshot: dict[str, Any]) -> str:
    body = snapshot.get("body")
    original = body.get("text", "") if isinstance(body, dict) else ""
    if usable_ad_copy(original):
        return str(original)[:10000]
    cards = snapshot.get("cards")
    # Multiple cards may represent different creatives; never merge or guess.
    if isinstance(cards, list) and len(cards) == 1 and isinstance(cards[0], dict):
        candidate = cards[0].get("body")
        if isinstance(candidate, dict):
            candidate = candidate.get("text")
        if usable_ad_copy(candidate):
            return str(candidate)[:10000]
    # Preserve the provider's original template in durable evidence.
    return original[:10000] if isinstance(original, str) else ""
