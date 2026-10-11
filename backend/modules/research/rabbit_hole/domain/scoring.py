"""Pure assembly helpers for versioned, explainable workbench scores."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Literal

SCORING_VERSION = "workbench-score-v1"

_DIMENSION_RULE_IDS: dict[str, tuple[str, ...]] = {
    "demand_trend": (
        "score.demand_trend.existing_rubric.v1",
        "gate.meta_ad_age",
        "evidence.trends_12m",
        "evidence.trends_5y",
    ),
    "creative_space": (
        "score.creative_space.existing_rubric.v1",
        "gate.distinct_active_creatives",
        "evidence.funnel",
    ),
    "profit_logistics": (
        "score.profit_logistics.existing_rubric.v1",
        "gate.contribution_margin",
        "gate.packed_weight",
    ),
    "competition": (
        "score.competition.existing_rubric.v1",
        "evidence.meta_competition",
    ),
    "compliance_risk": (
        "score.compliance_risk.existing_rubric.v1",
        "gate.compliance_and_ip_risk",
    ),
}

_DIMENSION_EVIDENCE_KEYS: dict[str, tuple[str, ...]] = {
    "demand_trend": ("coarse_screen", "trends_12m", "trends_5y"),
    "creative_space": ("coarse_screen", "funnel"),
    "profit_logistics": ("economics",),
    "competition": ("meta",),
    "compliance_risk": ("economics",),
}


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def dimension_rows(
    values: list[dict[str, Any]],
    requirements: list[dict[str, Any]],
    *,
    calculated_at: str,
) -> list[dict[str, Any]]:
    """Attach stable rule/evidence references without changing numeric scores."""

    requirement_by_key = {
        str(item.get("key")): item for item in requirements if item.get("key")
    }
    rows: list[dict[str, Any]] = []
    for value in values:
        key = str(value["key"])
        evidence_keys = _DIMENSION_EVIDENCE_KEYS.get(key, ())
        evidence_ids = _unique(
            str(evidence_id)
            for evidence_key in evidence_keys
            for evidence_id in requirement_by_key.get(evidence_key, {}).get(
                "evidence_ids", []
            )
        )
        missing_evidence = [
            evidence_key
            for evidence_key in evidence_keys
            if requirement_by_key.get(evidence_key, {}).get("status")
            not in {"pass", "not_applicable"}
        ]
        rows.append(
            {
                **value,
                "rule_ids": list(_DIMENSION_RULE_IDS.get(key, ())),
                "evidence_ids": evidence_ids,
                "missing_evidence": missing_evidence,
                "calculated_at": calculated_at,
            }
        )
    return rows


def final_gate_row(
    *,
    key: str,
    status: Literal["pass", "fail", "unknown", "not_applicable"],
    rule_id: str,
    evidence_ids: Iterable[str],
    reason: str,
) -> dict[str, Any]:
    """Build one normalized final hard-gate result."""

    return {
        "key": key,
        "kind": "final_hard_gate",
        "status": status,
        "rule_id": rule_id,
        "evidence_ids": _unique(str(value) for value in evidence_ids),
        "reason": reason,
    }


def evidence_ids_for(
    requirements: list[dict[str, Any]], *keys: str
) -> list[str]:
    by_key: Mapping[str, dict[str, Any]] = {
        str(item.get("key")): item for item in requirements if item.get("key")
    }
    return _unique(
        str(evidence_id)
        for key in keys
        for evidence_id in by_key.get(key, {}).get("evidence_ids", [])
    )
