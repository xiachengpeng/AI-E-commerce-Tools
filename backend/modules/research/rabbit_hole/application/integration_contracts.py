"""Small marketing projections; never export raw research state or secrets."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from rabbit_hole.input_urls import canonical_research_url

FACT_KEYS = frozenset(
    {"product_name", "category", "material", "dimensions", "features", "warranty"}
)


def source_url(value: Any) -> str | None:
    try:
        p = urlsplit(str(value or ""))
        if (
            p.scheme not in {"http", "https"}
            or not p.hostname
            or p.username
            or p.password
        ):
            return None
        return canonical_research_url(str(value))
    except ValueError:
        return None


def source_ref(project: dict[str, Any], product: dict[str, Any]) -> dict[str, Any]:
    return {
        "system": "rabbit_hole",
        "project_id": project["id"],
        "product_id": product["id"],
        "identity_revision": product.get("identity_revision", 1),
        "source_version": project["version"],
    }


def _time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
        return parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    except (TypeError, ValueError):
        return None


def product_snapshot(
    project: dict[str, Any], product: dict[str, Any]
) -> dict[str, Any]:
    ref = source_ref(project, product)
    url = source_url(product.get("url"))
    facts: dict[str, dict[str, Any]] = {
        "product_name": {
            "key": "product_name",
            "value": str(product.get("name", ""))[:500],
            "state": "inferred",
            "confirmation_method": None,
            "confirmed_at": None,
            "evidence_refs": [url] if url else [],
        }
    }
    now = datetime.now(UTC)
    for record in product.get("marketing_facts", []):
        if not isinstance(record, dict) or record.get("key") not in FACT_KEYS:
            continue
        key = record["key"]
        observed = _time(record.get("confirmed_at"))
        expiry = _time(record.get("valid_until")) if record.get("valid_until") else None
        reference = source_url(record.get("source_url"))
        state = "unknown"
        if (
            record.get("identity_revision") != ref["identity_revision"]
            or record.get("market") != project["market"]
            or (
                record.get("valid_until") is not None
                and (expiry is None or expiry <= now)
            )
        ):
            state = "stale"
        elif (
            record.get("provenance") == "manual"
            and record.get("own_product") is True
            and record.get("operator") == "local_user"
            and observed is not None
            and observed <= now
            and reference
            and isinstance(record.get("value"), str)
            and record["value"].strip()
        ):
            state = "confirmed"
        facts[key] = {
            "key": key,
            "value": str(record.get("value", ""))[:2000],
            "state": state,
            "confirmation_method": "manual" if state == "confirmed" else None,
            "confirmed_at": observed.isoformat()
            if state == "confirmed" and observed
            else None,
            "evidence_refs": [reference] if reference else [],
        }
    steps = [
        {
            "key": s.get("key"),
            "label": s.get("label"),
            "state": s.get("state"),
            "reason": str(s.get("reason", ""))[:1000],
        }
        for s in product.get("steps", [])[:20]
    ]
    return {
        "contract_version": 1,
        "source_ref": ref,
        "market": project["market"],
        "name": str(product.get("name", ""))[:500],
        "url": url,
        "facts": list(facts.values()),
        "steps": steps,
        "decision": (product.get("decision") or {}).get("pool"),
        "merged": bool(product.get("merged_into")),
    }


def project_snapshot(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "contract_version": 1,
        "id": project["id"],
        "title": project["title"],
        "direction": project["direction"],
        "market": project["market"],
        "source_version": project["version"],
        "updated_at": project["updated_at"],
        "products": [
            product_snapshot(project, p) for p in project.get("products", [])[:200]
        ],
        "keyword_count": len(project.get("keywords", [])),
    }
