"""Explicit ad-age and point-in-time observation semantics for the workbench."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import date, datetime
from hashlib import sha256
from typing import Any, Literal

CONTINUITY_STATUSES = frozenset({"unknown", "verified", "interrupted"})


@dataclass(frozen=True, slots=True)
class GateResult:
    """A persisted, explainable snapshot of one business-rule evaluation."""

    key: str
    kind: Literal["stage_gate", "final_hard_gate"]
    status: Literal["pass", "fail", "unknown", "not_applicable"]
    reason: str
    rule_version: int
    evidence_ids: tuple[str, ...]
    evaluated_at: str

    def public_view(self) -> dict[str, Any]:
        result = asdict(self)
        result["evidence_ids"] = list(self.evidence_ids)
        return result


def creative_evidence_id(
    identity_revision: int, creative_id: str, source_url: str
) -> str:
    """Return a stable identifier for manually confirmed creative evidence."""

    digest = sha256(
        f"{identity_revision}\0{creative_id}\0{source_url}".encode()
    ).hexdigest()[:20]
    return f"creative:{identity_revision}:{digest}"


def _timestamp(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    return None


def _optional_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _history(value: Mapping[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    raw = value.get("observation_history")
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            observed_at = _timestamp(item.get("observed_at"))
            currently_active = _optional_bool(item.get("currently_active"))
            if observed_at is None or currently_active is None:
                continue
            result.append(
                {
                    "observed_at": observed_at,
                    "currently_active": currently_active,
                    "ad_age_days": _nonnegative_int(item.get("ad_age_days")),
                }
            )
    observed_at = _timestamp(value.get("observed_at"))
    currently_active = _optional_bool(
        value.get("currently_active", value.get("active", value.get("is_active")))
    )
    if observed_at is not None and currently_active is not None:
        result.append(
            {
                "observed_at": observed_at,
                "currently_active": currently_active,
                "ad_age_days": _nonnegative_int(
                    value.get(
                        "ad_age_days",
                        value.get("observable_active_days", value.get("active_days")),
                    )
                ),
            }
        )
    unique: dict[tuple[str, bool], dict[str, Any]] = {}
    for item in result:
        unique[(item["observed_at"], item["currently_active"])] = item
    return sorted(unique.values(), key=lambda item: item["observed_at"])


def normalize_ad_observation(value: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize new and legacy facts without inferring continuous activity."""

    history = _history(value)
    continuity = value.get("continuity_status")
    if continuity not in CONTINUITY_STATUSES:
        continuity = "unknown"
    if any(item["currently_active"] is False for item in history):
        continuity = "interrupted"
    first = _timestamp(value.get("first_observed_at"))
    last = _timestamp(value.get("last_observed_at"))
    if history:
        first = min([item["observed_at"] for item in history] + ([first] if first else []))
        last = max([item["observed_at"] for item in history] + ([last] if last else []))
    age = _nonnegative_int(
        value.get(
            "ad_age_days",
            value.get("observable_active_days", value.get("active_days")),
        )
    )
    current = _optional_bool(
        value.get("currently_active", value.get("active", value.get("is_active")))
    )
    return {
        "started_at": _timestamp(value.get("started_at", value.get("start_date"))),
        "ad_age_days": age,
        "currently_active": current,
        "observed_at": _timestamp(value.get("observed_at")),
        "first_observed_at": first,
        "last_observed_at": last,
        "active_observation_count": sum(
            item["currently_active"] is True for item in history
        ),
        "continuity_status": continuity,
        "observation_history": history,
    }


def merge_ad_observation(
    existing: Mapping[str, Any], incoming: Mapping[str, Any]
) -> dict[str, Any]:
    """Append a point-in-time observation; never infer verified continuity."""

    left = normalize_ad_observation(existing)
    right = normalize_ad_observation(incoming)
    combined = {
        **left,
        **{
            key: value
            for key, value in right.items()
            if value is not None and key != "observation_history"
        },
        "observation_history": [
            *left["observation_history"],
            *right["observation_history"],
        ],
    }
    if left["continuity_status"] == "interrupted":
        combined["continuity_status"] = "interrupted"
    elif right["continuity_status"] != "verified":
        combined["continuity_status"] = left["continuity_status"]
    return normalize_ad_observation(combined)
