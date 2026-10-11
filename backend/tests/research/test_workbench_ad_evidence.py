from __future__ import annotations

import importlib
import importlib.util


def _module():
    spec = importlib.util.find_spec("rabbit_hole.domain.ad_evidence")
    assert spec is not None, "workbench ad evidence contract is missing"
    return importlib.import_module("rabbit_hole.domain.ad_evidence")


def test_legacy_active_days_becomes_age_without_claiming_continuity() -> None:
    result = _module().normalize_ad_observation(
        {"active_days": 90, "active": True}
    )

    assert result["ad_age_days"] == 90
    assert result["currently_active"] is True
    assert result["continuity_status"] == "unknown"
    assert result["active_observation_count"] == 0


def test_two_active_observations_do_not_verify_continuity() -> None:
    merge = _module().merge_ad_observation
    first = {
        "started_at": "2026-09-01",
        "ad_age_days": 10,
        "currently_active": True,
        "observed_at": "2026-09-11T00:00:00Z",
        "continuity_status": "unknown",
    }
    second = {
        "started_at": "2026-09-01",
        "ad_age_days": 20,
        "currently_active": True,
        "observed_at": "2026-09-21T00:00:00Z",
        "continuity_status": "unknown",
    }

    result = merge(first, second)

    assert result["first_observed_at"] == "2026-09-11T00:00:00Z"
    assert result["last_observed_at"] == "2026-09-21T00:00:00Z"
    assert result["active_observation_count"] == 2
    assert result["continuity_status"] == "unknown"
    assert len(result["observation_history"]) == 2


def test_inactive_observation_proves_interruption_but_not_prior_continuity() -> None:
    merge = _module().merge_ad_observation

    result = merge(
        {
            "currently_active": True,
            "observed_at": "2026-09-01T00:00:00Z",
        },
        {
            "currently_active": False,
            "observed_at": "2026-09-05T00:00:00Z",
        },
    )

    assert result["continuity_status"] == "interrupted"
    assert result["active_observation_count"] == 1


def test_gate_result_has_a_json_safe_audit_snapshot() -> None:
    gate = _module().GateResult(
        key="coarse_screen",
        kind="stage_gate",
        status="pass",
        reason="Evidence satisfies the configured coarse screen.",
        rule_version=3,
        evidence_ids=("creative:a", "creative:b"),
        evaluated_at="2026-09-22T08:00:00Z",
    )

    assert gate.public_view() == {
        "key": "coarse_screen",
        "kind": "stage_gate",
        "status": "pass",
        "reason": "Evidence satisfies the configured coarse screen.",
        "rule_version": 3,
        "evidence_ids": ["creative:a", "creative:b"],
        "evaluated_at": "2026-09-22T08:00:00Z",
    }
