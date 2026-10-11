"""Canonical configurable rules for the business workbench."""

from __future__ import annotations

from copy import deepcopy
from math import isfinite
from typing import Any, Final

EVIDENCE_REQUIREMENT_LEVELS: Final[frozenset[str]] = frozenset(
    {"required", "recommended", "optional"}
)
DEFAULT_EVIDENCE_REQUIREMENT_LEVELS: Final[dict[str, str]] = {
    "pinterest": "recommended",
    "tiktok": "recommended",
    "amazon": "recommended",
    "similarweb": "recommended",
}

DEFAULT_RULES: Final[dict[str, int | float]] = {
    "min_active_days": 30,
    "min_creatives": 3,
    "min_margin_percent": 60,
    "min_aov": 50,
    "max_aov": 100,
    "max_weight_kg": 2,
    "max_direct_share_percent": 50,
    "quote_valid_days": 14,
    "test_score": 18,
    "backup_score": 15,
    "scan_batch_limit": 20,
    "daily_scan_budget": 20,
    "max_depth": 3,
    "expansion_limit": 5,
    "ai_daily_limit": 10,
}

_INTEGER_RULES = {
    "min_active_days",
    "min_creatives",
    "quote_valid_days",
    "test_score",
    "backup_score",
    "scan_batch_limit",
    "daily_scan_budget",
    "max_depth",
    "expansion_limit",
    "ai_daily_limit",
}
_MAXIMUMS: dict[str, int | float] = {
    "min_active_days": 10_000,
    "min_creatives": 200,
    "min_margin_percent": 100,
    "max_direct_share_percent": 100,
    "quote_valid_days": 3_650,
    "test_score": 25,
    "backup_score": 25,
    "scan_batch_limit": 200,
    "daily_scan_budget": 1_000,
    "max_depth": 20,
    "expansion_limit": 200,
    "ai_daily_limit": 1_000,
}


class RuleConfigError(ValueError):
    """A caller-provided rule patch is invalid."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def effective_rules(state: dict[str, Any]) -> dict[str, int | float]:
    """Return a detached full rules snapshot, including defaults for legacy state."""

    result = deepcopy(DEFAULT_RULES)
    stored = state.get("rules")
    if isinstance(stored, dict):
        result.update({key: stored[key] for key in DEFAULT_RULES if key in stored})
        legacy_scan_limit = stored.get("scan_limit")
        if (
            "scan_batch_limit" not in stored
            and type(legacy_scan_limit) is int
            and legacy_scan_limit > 0
        ):
            result["scan_batch_limit"] = legacy_scan_limit
    elif isinstance(state.get("limits"), dict):
        # Older projects persisted these two fixed limits before rules were versioned.
        legacy_scan_limit = state["limits"].get("scan_limit")
        if type(legacy_scan_limit) is int and legacy_scan_limit > 0:
            result["scan_batch_limit"] = legacy_scan_limit
        max_depth = state["limits"].get("max_depth")
        if type(max_depth) is int and max_depth > 0:
            result["max_depth"] = max_depth
    return result


def effective_rules_version(state: dict[str, Any]) -> int:
    """Return the canonical version; unversioned legacy state is version 1."""

    value = state.get("rules_version", 1)
    return value if type(value) is int and value >= 1 else 1


def effective_evidence_requirement_levels(state: dict[str, Any]) -> dict[str, str]:
    """Return versioned channel levels, ignoring malformed legacy overrides."""

    result = deepcopy(DEFAULT_EVIDENCE_REQUIREMENT_LEVELS)
    stored = state.get("evidence_requirement_levels")
    if isinstance(stored, dict):
        for key, level in stored.items():
            if key in result and level in EVIDENCE_REQUIREMENT_LEVELS:
                result[key] = level
    return result


def validate_evidence_requirement_patch(
    current: dict[str, str], patch: Any
) -> dict[str, str]:
    """Validate explicit per-project requirement levels for supported channels."""

    if not isinstance(patch, dict):
        raise RuleConfigError(
            "invalid_evidence_requirements",
            "evidence_requirement_levels must be an object",
        )
    unknown = sorted(set(patch) - set(DEFAULT_EVIDENCE_REQUIREMENT_LEVELS))
    if unknown:
        raise RuleConfigError(
            "unknown_evidence_requirement",
            f"Unknown evidence channels: {', '.join(str(key) for key in unknown)}",
        )
    result = deepcopy(current)
    for key, level in patch.items():
        if level not in EVIDENCE_REQUIREMENT_LEVELS:
            raise RuleConfigError(
                "invalid_evidence_requirement",
                f"{key} level must be required, recommended, or optional",
            )
        result[key] = level
    return result


def validate_rule_patch(
    current: dict[str, int | float], patch: Any
) -> dict[str, int | float]:
    """Strictly validate a partial patch and return its complete effective snapshot."""

    if not isinstance(patch, dict):
        raise RuleConfigError("invalid_rules", "rules must be an object")
    patch = dict(patch)
    if "scan_limit" in patch:
        if "scan_batch_limit" in patch:
            raise RuleConfigError(
                "invalid_rules",
                "Use scan_batch_limit only; scan_limit is a legacy alias",
            )
        patch["scan_batch_limit"] = patch.pop("scan_limit")
    unknown = sorted(set(patch) - set(DEFAULT_RULES))
    if unknown:
        raise RuleConfigError(
            "unknown_rule", f"Unknown rule keys: {', '.join(str(k) for k in unknown)}"
        )
    result = deepcopy(current)
    for key, value in patch.items():
        if key in _INTEGER_RULES:
            if type(value) is not int:
                raise RuleConfigError("invalid_rule", f"{key} must be an integer")
        elif type(value) not in {int, float}:
            raise RuleConfigError("invalid_rule", f"{key} must be numeric")
        if not isfinite(float(value)):
            raise RuleConfigError("invalid_rule", f"{key} must be finite")
        if value <= 0:
            raise RuleConfigError("invalid_rule", f"{key} must be positive")
        maximum = _MAXIMUMS.get(key)
        if maximum is not None and value > maximum:
            raise RuleConfigError("invalid_rule", f"{key} must be at most {maximum:g}")
        result[key] = value
    if result["min_aov"] > result["max_aov"]:
        raise RuleConfigError("invalid_rules", "min_aov must not exceed max_aov")
    if result["backup_score"] > result["test_score"]:
        raise RuleConfigError(
            "invalid_rules", "backup_score must not exceed test_score"
        )
    return result
