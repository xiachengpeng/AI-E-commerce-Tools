from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from math import nan

import pytest

from rabbit_hole.domain.project import (
    WorkbenchError,
    active_test_results,
    apply_command,
    new_project,
    project_view,
)

NOW = datetime(2026, 9, 13, 4, 0, tzinfo=UTC)


def test_creative_reference_is_text_only_bound_to_current_identity():
    state = project()
    item = add_product(state)
    command(state, "add_creative_reference", {
        "product_id": item["id"], "source_ad_id": "ad-100",
        "source_url": "https://facebook.com/ad/100",
        "observed_at": NOW.isoformat(), "format": "UGC video",
        "hook": "Shows messy suitcase", "pattern_note": "Quick before/after demo",
        "audience": "frequent travelers", "scene": "packing",
    })
    record = item["creative_references"][0]
    assert record["product_id"] == item["id"]
    assert record["identity_revision"] == item["identity_revision"]
    assert record["provenance"] == "manual"
    assert "media_blob" not in record
    with pytest.raises(WorkbenchError):
        command(state, "add_creative_reference", {
            "product_id": item["id"], "source_ad_id": "ad-2",
            "source_url": "https://facebook.com/ad/2",
            "observed_at": NOW.isoformat(), "format": "UGC",
            "hook": "Hook", "pattern_note": "Pattern",
        }, actor="automation")
    command(state, "confirm_product", {
        "product_id": item["id"], "name": item["name"],
        "url": "https://shop.example/p/new", "reason": "不同商品", "relevance_confirmed": True,
    })
    viewed = project_view(state, now=NOW)["products"][0]
    assert viewed["creative_references"][0]["stale_identity"] is True


def test_funnel_investigation_separates_script_observation_from_confirmed_flow():
    state = project()
    item = add_product(state)
    base = {
        "product_id": item["id"], "area": "abandoned_cart",
        "source_url": "https://shop.example/p/cubes", "observed_at": NOW.isoformat(),
    }
    command(state, "record_funnel_investigation", {
        **base, "status": "observed", "method": "script_detected",
        "notes": "Klaviyo JS observed; no cart flow tested",
    })
    assert item["funnel_investigations"][0]["status"] == "observed"
    with pytest.raises(WorkbenchError):
        command(state, "record_funnel_investigation", {
            **base, "status": "confirmed", "method": "script_detected",
        })
    with pytest.raises(WorkbenchError):
        command(state, "record_funnel_investigation", {
            **base, "status": "confirmed", "method": "actual_subscription",
        })
    command(state, "record_funnel_investigation", {
        **base, "status": "confirmed", "method": "actual_abandonment",
        "notes": "Placed a test cart and received a recovery email",
    })
    viewed = project_view(state, now=NOW)["products"][0]
    assert viewed["funnel_investigations"][-1]["status"] == "confirmed"
    assert len(viewed["funnel_investigations"]) == 2
    assert viewed["funnel"] == {}


def test_optional_research_does_not_invalidate_decision_or_test_plan():
    state = project()
    item = add_product(state)
    item["decision"] = {"pool": "observe", "stale": False}
    item["test_plan"] = {"approved": True, "stale": False}
    command(state, "add_creative_reference", {
        "product_id": item["id"], "source_ad_id": "ad-1",
        "source_url": "https://facebook.com/ad/1", "observed_at": NOW.isoformat(),
        "format": "video", "hook": "packing", "pattern_note": "demonstration",
    })
    assert item["decision"]["stale"] is False
    assert item["test_plan"]["approved"] is True
    command(state, "record_funnel_investigation", {
        "product_id": item["id"], "area": "email_marketing", "status": "not_checked",
    })
    assert item["decision"]["stale"] is False
    assert item["test_plan"]["stale"] is False


def test_review_duplicate_keyword_does_not_reassign_unrelated_keyword():
    state = project()
    command(state, "add_keyword", {"text": "bags", "type": "category"})
    command(state, "add_keyword", {"text": "travel", "type": "scenario"})
    pid = add_product(state)["id"]
    command(state, "decide", {"product_id": pid, "pool": "observe", "reason": "缺证据"})
    before = deepcopy(state["keywords"])
    command(
        state,
        "review",
        {
            "product_id": pid,
            "conclusion": "继续核对",
            "lessons": "需报价",
            "next_keywords": ["bags"],
        },
    )
    assert state["keywords"] == before


def test_replacing_decision_preserves_history():
    state = project()
    pid = add_product(state)["id"]
    command(state, "decide", {"product_id": pid, "pool": "observe", "reason": "缺证据"})
    prior = deepcopy(state["products"][0]["decision"])
    command(state, "decide", {"product_id": pid, "pool": "reject", "reason": "不继续"})
    assert state["products"][0]["decision_history"] == [prior]


DEFAULT_RULES = {
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


def test_legacy_identification_age_is_read_without_continuity_claim() -> None:
    state = project()
    product = add_product(state)
    product["identification"] = {
        "relevance_confirmed": True,
        "active_days": 90,
        "creatives": [],
        "distinct_active_creatives": 0,
    }
    before = deepcopy(state)

    viewed = project_view(state, now=NOW)["products"][0]["identification"]

    assert viewed["ad_age_days"] == 90
    assert viewed["continuity_status"] == "unknown"
    assert viewed["active_observation_count"] == 0
    assert state == before


def test_keyword_types_accept_explicit_combinations_without_reclassifying_old_words() -> None:
    state = project()
    for text, kind in [
        ("travel organizer", "category"),
        ("messy suitcase travel", "pain_scenario"),
        ("office traveler", "scenario_audience"),
    ]:
        command(state, "add_keyword", {"text": text, "type": kind})

    assert [word["type"] for word in state["keywords"]] == [
        "category",
        "pain_scenario",
        "scenario_audience",
    ]
    assert [word["type"] for word in project_view(state, now=NOW)["keywords"]] == [
        "category",
        "pain_scenario",
        "scenario_audience",
    ]


def test_inactive_ad_cannot_pass_coarse_screen_despite_age_and_creatives() -> None:
    state = project()
    product = identified_product(state)
    command(
        state,
        "confirm_creatives",
        {
            "product_id": product["id"],
            "identity_revision": product["identity_revision"],
            "ad_age_days": 45,
            "currently_active": False,
            "creatives": [
                {
                    "id": f"creative-{index}",
                    "source_url": f"https://facebook.com/ads/library/?id={index}",
                    "distinct": True,
                    "active": True,
                }
                for index in range(3)
            ],
        },
    )

    viewed = project_view(state, now=NOW)["products"][0]
    assert viewed["identification"]["ad_age_days"] == 45
    assert viewed["identification"]["distinct_active_creatives"] == 3
    assert viewed["identification"]["passed"] is False
    assert viewed["gates"]["coarse_screen"]["status"] == "fail"


def test_coarse_screen_guidance_separates_ad_age_from_current_status() -> None:
    state = project()
    add_product(state)

    viewed = project_view(state, now=NOW)["products"][0]
    summary = viewed["steps"][0]["reason"]
    assert "首次投放距今" in summary
    assert "当前仍在投放" in summary
    assert "活跃时间" not in summary


def test_logistics_profile_is_versioned_and_derives_only_known_weights() -> None:
    state = project()
    product = add_product(state)
    command(
        state,
        "economics",
        {
            "product_id": product["id"],
            "weight_kg": 0.8,
            "package_length_cm": 30,
            "package_width_cm": 20,
            "package_height_cm": 10,
            "fragile": False,
            "battery": True,
        },
    )
    before = deepcopy(state)
    viewed = project_view(state, now=NOW)
    economics = viewed["products"][0]["economics"]
    assert economics["actual_weight_kg"] == 0.8
    assert economics["volumetric_weight_kg"] is None
    assert economics["chargeable_weight_kg"] is None
    assert economics["battery"] is True
    assert state == before

    command(
        state,
        "set_logistics_profile",
        {
            "carrier": "Example Express",
            "service": "US line",
            "source_url": "https://carrier.example/rates",
            "observed_at": NOW.isoformat(),
            "confirmed": True,
            "volumetric_divisor_cm3_per_kg": 6000,
        },
    )
    viewed = project_view(state, now=NOW)
    assert viewed["logistics_profile"]["version"] == 1
    assert viewed["products"][0]["economics"]["volumetric_weight_kg"] == 1.0
    assert viewed["products"][0]["economics"]["chargeable_weight_kg"] == 1.0

    command(
        state,
        "set_logistics_profile",
        {
            "carrier": "Example Express",
            "service": "US line",
            "source_url": "https://carrier.example/rates-v2",
            "observed_at": NOW.isoformat(),
            "confirmed": True,
            "volumetric_divisor_cm3_per_kg": 5000,
        },
    )
    viewed = project_view(state, now=NOW)
    assert viewed["logistics_profile"]["version"] == 2
    assert len(viewed["logistics_profile_history"]) == 1
    assert viewed["products"][0]["economics"]["volumetric_weight_kg"] == 1.2


def test_logistics_rejects_invalid_dimensions_and_old_identity_projection() -> None:
    state = project()
    product = add_product(state)
    with pytest.raises(WorkbenchError):
        command(
            state,
            "economics",
            {"product_id": product["id"], "package_length_cm": 0},
        )
    command(
        state,
        "economics",
        {
            "product_id": product["id"],
            "weight_kg": 0.8,
            "package_length_cm": 30,
            "package_width_cm": 20,
            "package_height_cm": 10,
        },
    )
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": "Different product",
            "url": "https://shop.example/p/different",
            "reason": "来源商品已经改变",
            "relevance_confirmed": True,
        },
    )
    viewed = project_view(state, now=NOW)["products"][0]["economics"]
    assert viewed["logistics_stale"] is True
    assert viewed["chargeable_weight_kg"] is None


def test_invalid_logistics_profile_does_not_append_history() -> None:
    state = project()
    payload = {
        "carrier": "Example Express",
        "service": "US line",
        "source_url": "https://carrier.example/rates",
        "observed_at": NOW.isoformat(),
        "confirmed": True,
        "volumetric_divisor_cm3_per_kg": 6000,
    }
    command(state, "set_logistics_profile", payload)
    before = deepcopy(state)

    with pytest.raises(WorkbenchError):
        command(state, "set_logistics_profile", {**payload, "source_url": "invalid"})

    assert state == before


def test_sales_estimate_is_append_only_and_scope_safe() -> None:
    state = project()
    product = identified_product(state)
    command(state, "economics", {"product_id": product["id"], "aov": 75})
    evidence(
        state,
        product["id"],
        "similarweb",
        direct_share=35,
        monthly_visits=100_000,
        traffic_scope="domain",
        traffic_url="https://shop.example/",
        traffic_period="2026-09",
    )
    traffic_id = product["evidence"][-1]["id"]
    command(
        state,
        "add_sales_estimate",
        {
            "product_id": product["id"],
            "traffic_evidence_id": traffic_id,
            "cvr_low": 1,
            "cvr_base": 2,
            "cvr_high": 3,
            "cvr_source": "用户手工情景，尚无实际测试",
        },
    )

    viewed = project_view(state, now=NOW)["products"][0]
    estimate = viewed["estimates"][0]
    assert estimate["kind"] == "estimate"
    assert estimate["scenarios"]["scope"] == "domain"
    assert estimate["scenarios"]["product_monthly_revenue"] is None
    assert viewed["test_results"] == []
    assert estimate["stale"] is False

    command(state, "economics", {"product_id": product["id"], "aov": 80})
    viewed = project_view(state, now=NOW)["products"][0]
    assert viewed["estimates"][0]["stale"] is True
    assert len(viewed["estimates"]) == 1


def test_sales_estimate_tracks_explicit_traffic_expiry() -> None:
    state = project()
    product = identified_product(state)
    command(state, "economics", {"product_id": product["id"], "aov": 75})
    evidence(
        state,
        product["id"],
        "similarweb",
        monthly_visits=100_000,
        traffic_scope="domain",
        traffic_url="https://shop.example/",
        traffic_period="2026-09",
        valid_until=(NOW + timedelta(days=1)).isoformat(),
    )
    traffic_id = product["evidence"][-1]["id"]
    payload = {
        "product_id": product["id"],
        "traffic_evidence_id": traffic_id,
        "cvr_low": 1,
        "cvr_base": 2,
        "cvr_high": 3,
        "cvr_source": "人工情景假设",
    }
    command(state, "add_sales_estimate", payload)

    assert project_view(state, now=NOW)["products"][0]["estimates"][0]["stale"] is False
    assert (
        project_view(state, now=NOW + timedelta(days=2))["products"][0]["estimates"][0]["stale"]
        is True
    )

    evidence(
        state,
        product["id"],
        "similarweb",
        observed_at=(NOW - timedelta(days=3)).isoformat(),
        valid_until=(NOW - timedelta(days=1)).isoformat(),
        monthly_visits=100_000,
        traffic_scope="domain",
        traffic_url="https://shop.example/",
        traffic_period="2026-09",
    )
    payload["traffic_evidence_id"] = product["evidence"][-1]["id"]
    with pytest.raises(WorkbenchError, match="expired"):
        command(state, "add_sales_estimate", payload)


def test_product_estimate_requires_matching_scope_and_source() -> None:
    state = project()
    product = identified_product(state)
    command(state, "economics", {"product_id": product["id"], "aov": 75})
    with pytest.raises(WorkbenchError):
        evidence(
            state,
            product["id"],
            "similarweb",
            monthly_visits=1000,
            traffic_scope="product",
            traffic_url="https://other.example/p/not-this",
            traffic_period="2026-09",
        )
    evidence(
        state,
        product["id"],
        "similarweb",
        monthly_visits=1000,
        traffic_scope="product",
        traffic_url=product["url"],
        traffic_period="2026-09",
    )
    traffic_id = product["evidence"][-1]["id"]
    with pytest.raises(WorkbenchError):
        command(
            state,
            "add_sales_estimate",
            {
                "product_id": product["id"],
                "traffic_evidence_id": traffic_id,
                "cvr_low": 3,
                "cvr_base": 2,
                "cvr_high": 4,
                "cvr_source": "",
            },
        )
    command(
        state,
        "add_sales_estimate",
        {
            "product_id": product["id"],
            "traffic_evidence_id": traffic_id,
            "cvr_low": 1,
            "cvr_base": 2,
            "cvr_high": 3,
            "cvr_source": "用户手工情景",
        },
    )
    viewed = project_view(state, now=NOW)["products"][0]
    assert viewed["estimates"][0]["scenarios"]["product_monthly_revenue"]["base"] == 1500

    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": "Changed product",
            "url": "https://shop.example/p/changed",
            "reason": "商品身份已改变",
            "relevance_confirmed": True,
        },
    )
    assert project_view(state, now=NOW)["products"][0]["estimates"][0]["stale"] is True


def test_legacy_visits_have_unknown_scope_without_rewriting_state() -> None:
    state = project()
    product = add_product(state)
    product["evidence"].append(
        {
            "id": "legacy-visits",
            "channel": "similarweb",
            "monthly_visits": 100_000,
            "confirmed": True,
            "observed_at": NOW.isoformat(),
        }
    )
    before = deepcopy(state)
    viewed = project_view(state, now=NOW)["products"][0]
    assert viewed["evidence"][0]["traffic_scope"] == "unknown"
    assert state == before


def test_explicit_evidence_deadlines_project_four_freshness_states() -> None:
    state = project()
    product = add_product(state)
    evidence(state, product["id"], "amazon")
    evidence(
        state,
        product["id"],
        "tiktok",
        review_due_at=(NOW + timedelta(days=1)).isoformat(),
        valid_until=(NOW + timedelta(days=2)).isoformat(),
    )
    evidence(
        state,
        product["id"],
        "pinterest",
        observed_at=(NOW - timedelta(days=3)).isoformat(),
        review_due_at=(NOW - timedelta(days=1)).isoformat(),
        valid_until=(NOW + timedelta(days=2)).isoformat(),
    )
    evidence(
        state,
        product["id"],
        "meta",
        observed_at=(NOW - timedelta(days=3)).isoformat(),
        valid_until=(NOW - timedelta(days=1)).isoformat(),
        advertiser_count=4,
        brand_concentration="low",
        differentiation="high",
    )
    before = deepcopy(state)

    viewed = project_view(state, now=NOW)["products"][0]
    statuses = {row["channel"]: row["freshness_status"] for row in viewed["evidence"]}
    assert statuses == {
        "amazon": "unknown",
        "tiktok": "fresh",
        "pinterest": "stale",
        "meta": "expired",
    }
    assert state == before
    meta_requirement = next(
        row for row in viewed["requirement_statuses"] if row["key"] == "meta"
    )
    assert meta_requirement["status"] == "unknown"
    assert meta_requirement["blocks_scoring"] is True


def test_quote_freshness_uses_configured_fourteen_day_boundary() -> None:
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    at_boundary = project_view(state, now=NOW + timedelta(days=14))["products"][0]
    expired = project_view(state, now=NOW + timedelta(days=14, seconds=1))["products"][0]

    assert at_boundary["economics"]["quote_freshness"]["status"] == "fresh"
    assert expired["economics"]["quote_freshness"]["status"] == "expired"
    assert expired["economics"]["quote_freshness"]["valid_until"] == (
        NOW + timedelta(days=14)
    ).isoformat().replace("+00:00", "Z")
    assert any(
        row["blocking_key"] == "fresh_supplier_quote"
        for row in expired["requirement_statuses"]
    )


def test_new_product_todos_focus_on_identification_not_future_costs():
    state = project()
    add_product(state)
    assert {todo["step"] for todo in state["todos"]} == {"identification"}


def test_product_rejection_is_reversible_and_non_destructive():
    state = project()
    product = add_product(state)
    product_id = product["id"]

    command(
        state,
        "triage_product",
        {
            "product_id": product_id,
            "disposition": "rejected",
            "reason": "广告与商品无关",
        },
    )

    assert len(state["products"]) == 1
    assert product["triage"]["state"] == "rejected"
    assert product["triage"]["history"][-1]["from"] == "pending"
    assert state["queues"]["rejected"][0]["product_id"] == product_id
    assert all(todo["product_id"] != product_id for todo in state["todos"])

    apply_command(
        state,
        "restore_product",
        {"product_id": product_id, "reason": "获得新的可核验链接"},
        now=NOW + timedelta(minutes=1),
    )
    assert product["triage"]["state"] == "pending"
    assert state["queues"]["triage"][0]["product_id"] == product_id


@pytest.mark.parametrize("disposition", ["retained", "observing", "rejected"])
def test_product_triage_requires_reason_and_records_each_supported_state(disposition):
    state = project()
    product = add_product(state)
    with pytest.raises(WorkbenchError, match="reason"):
        command(
            state,
            "triage_product",
            {"product_id": product["id"], "disposition": disposition, "reason": ""},
        )
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": disposition,
            "reason": "人工核对完成",
        },
    )
    assert product["triage"]["state"] == disposition
    assert product["triage"]["history"][-1]["to"] == disposition


def test_product_triage_rejects_invalid_or_repeated_transition():
    state = project()
    product = add_product(state)
    with pytest.raises(WorkbenchError, match="disposition"):
        command(
            state,
            "triage_product",
            {
                "product_id": product["id"],
                "disposition": "passed",
                "reason": "unsupported",
            },
        )
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": "observing",
            "reason": "等待来源",
        },
    )
    with pytest.raises(WorkbenchError, match="already"):
        command(
            state,
            "triage_product",
            {
                "product_id": product["id"],
                "disposition": "observing",
                "reason": "重复操作",
            },
        )


def test_undo_triage_returns_retained_focus_to_pending_and_keeps_audit_history():
    state = project()
    product = add_product(state)
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": "retained",
            "reason": "商品明确，值得深挖",
        },
    )
    command(state, "focus_product", {"product_id": product["id"]})
    original = deepcopy(product["triage"]["history"][0])

    apply_command(
        state,
        "undo_triage_product",
        {"product_id": product["id"]},
        now=NOW + timedelta(minutes=1),
    )

    assert product["triage"]["state"] == "pending"
    assert state["focus_product_id"] is None
    assert product["triage"]["history"][0] == original
    assert product["triage"]["history"][1]["from"] == "retained"
    assert product["triage"]["history"][1]["to"] == "pending"
    assert product["triage"]["history"][1]["undo_of_at"] == original["at"]


def test_undo_triage_rejects_product_without_a_reversible_decision():
    state = project()
    product = add_product(state)

    with pytest.raises(WorkbenchError, match="可撤销"):
        command(
            state,
            "undo_triage_product",
            {"product_id": product["id"]},
        )


def test_undo_triage_restores_retained_state_and_focus_after_rejection():
    state = project()
    product = add_product(state)
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": "retained",
            "reason": "商品明确，值得深挖",
        },
    )
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": "rejected",
            "reason": "复核时误判",
        },
    )

    apply_command(
        state,
        "undo_triage_product",
        {"product_id": product["id"]},
        now=NOW + timedelta(minutes=1),
    )

    assert product["triage"]["state"] == "retained"
    assert state["focus_product_id"] == product["id"]
    assert len(product["triage"]["history"]) == 3
    assert product["triage"]["history"][-1]["to"] == "retained"


def test_guidance_prioritizes_explicit_focus_then_retained_then_pending():
    state = project()
    pending = add_product(state)
    command(
        state,
        "add_product",
        {"name": "Retained", "url": "https://shop.example/p/retained"},
    )
    retained = state["products"][1]
    command(
        state,
        "triage_product",
        {
            "product_id": retained["id"],
            "disposition": "retained",
            "reason": "相关商品，值得深入",
        },
    )
    assert state["guidance"]["kind"] == "deep_dive"
    assert state["guidance"]["product_id"] == retained["id"]

    command(
        state,
        "triage_product",
        {
            "product_id": pending["id"],
            "disposition": "retained",
            "reason": "第二个相关商品",
        },
    )
    command(
        state,
        "focus_product",
        {"product_id": pending["id"]},
    )
    assert state["focus_product_id"] == pending["id"]
    assert state["guidance"]["product_id"] == pending["id"]


def test_guidance_uses_named_queue_rows_and_skips_non_actionable_products():
    state = project()
    command(state, "add_keyword", {"text": "portable organizer", "type": "function"})
    keyword_id = state["keywords"][0]["id"]
    command(state, "approve_keyword", {"keyword_id": keyword_id, "approved": True})
    command(
        state,
        "add_product",
        {
            "name": "Pending lead",
            "url": "https://shop.example/p/pending",
            "source_keyword_ids": [keyword_id],
        },
    )
    pending = state["products"][0]
    command(
        state,
        "add_product",
        {"name": "Observe lead", "url": "https://shop.example/p/observe"},
    )
    observing = state["products"][1]
    command(
        state,
        "triage_product",
        {
            "product_id": observing["id"],
            "disposition": "observing",
            "reason": "等待来源",
        },
    )

    row = state["queues"]["triage"][0]
    assert row == {
        "product_id": pending["id"],
        "name": "Pending lead",
        "source_keyword": '"portable organizer"',
        "step": "identification",
        "reason": "尚未确认广告对应哪个具体商品。",
        "action_label": "筛选这条线索",
        "source_ad_count": 0,
        "source_advertiser": "",
        "source_active_since": "",
        "landing_observed": False,
    }
    assert state["guidance"]["kind"] == "triage"
    assert state["guidance"]["product_id"] == pending["id"]
    assert state["queues"]["observing"][0]["product_id"] == observing["id"]


def test_queue_exact_source_does_not_claim_shared_keyword_ads_for_manual_lead():
    state = project()
    command(state, "add_keyword", {"text": "portable organizer", "type": "function"})
    keyword_id = state["keywords"][0]["id"]
    command(state, "approve_keyword", {"keyword_id": keyword_id, "approved": True})
    command(
        state,
        "add_product",
        {
            "name": "Manual keyword-only lead",
            "url": "https://shop.example/p/manual",
            "source_keyword_ids": [keyword_id],
        },
    )
    manual_id = state["products"][0]["id"]
    command(
        state,
        "collection_result",
        {
            "keyword_id": keyword_id,
            "status": "complete",
            "ads": [
                {
                    "id": "ad-1",
                    "advertiser": "Exact advertiser",
                    "start_date": "2026-08-01",
                    "landing_url": "https://shop.example/p/exact",
                    "primary_text": "Exact portable organizer",
                    "active": True,
                }
            ],
        },
        actor="automation",
    )

    rows = {row["product_id"]: row for row in project_view(state)["queues"]["triage"]}
    exact = next(product for product in state["products"] if product["id"] != manual_id)
    assert (
        rows[exact["id"]]["source_ad_count"],
        rows[exact["id"]]["source_advertiser"],
        rows[exact["id"]]["source_active_since"],
        rows[exact["id"]]["landing_observed"],
    ) == (1, "Exact advertiser", "2026-08-01", False)
    assert rows[manual_id]["source_ad_count"] == 0
    assert rows[manual_id]["source_advertiser"] == ""
    assert rows[manual_id]["source_active_since"] == ""


def test_repeated_collection_appends_ad_observations_without_claiming_continuity():
    state = project()
    command(state, "add_keyword", {"text": "portable organizer", "type": "function"})
    keyword = state["keywords"][0]
    command(state, "approve_keyword", {"keyword_id": keyword["id"], "approved": True})

    def collect(observed_at: str, age: int) -> None:
        apply_command(
            state,
            "collection_result",
            {
                "keyword_id": keyword["id"],
                "status": "complete",
                "ads": [
                    {
                        "id": "ad-repeat",
                        "advertiser": "Example",
                        "start_date": "2026-08-01",
                        "started_at": "2026-08-01",
                        "landing_url": "https://shop.example/p/repeat",
                        "primary_text": "Same ad",
                        "active": True,
                        "currently_active": True,
                        "ad_age_days": age,
                        "observed_at": observed_at,
                        "continuity_status": "unknown",
                    }
                ],
            },
            actor="automation",
            now=datetime.fromisoformat(observed_at),
        )

    collect("2026-09-01T00:00:00Z", 31)
    collect("2026-09-20T00:00:00Z", 50)

    ad = keyword["ads"][0]
    assert len(keyword["ads"]) == 1
    assert ad["ad_age_days"] == 50
    assert ad["active_observation_count"] == 2
    assert ad["continuity_status"] == "unknown"
    assert [item["observed_at"] for item in ad["observation_history"]] == [
        "2026-09-01T00:00:00Z",
        "2026-09-20T00:00:00Z",
    ]


def test_queue_prioritizes_actionable_exact_source_over_older_keyword_only_lead():
    state = project()
    command(state, "add_keyword", {"text": "portable organizer", "type": "function"})
    keyword_id = state["keywords"][0]["id"]
    command(state, "approve_keyword", {"keyword_id": keyword_id, "approved": True})
    command(
        state,
        "add_product",
        {
            "name": "Older manual lead",
            "url": "https://shop.example/p/manual",
            "source_keyword_ids": [keyword_id],
        },
    )
    command(
        state,
        "collection_result",
        {
            "keyword_id": keyword_id,
            "status": "complete",
            "ads": [
                {
                    "id": "ad-1",
                    "advertiser": "Later exact lead",
                    "start_date": "2026-08-01",
                    "landing_url": "https://shop.example/p/exact",
                    "primary_text": "Bound evidence",
                    "active": True,
                }
            ],
        },
        actor="automation",
    )

    assert state["queues"]["triage"][0]["name"] == "Later exact lead"
    assert state["queues"]["triage"][1]["name"] == "Older manual lead"


def test_guidance_is_complete_when_project_has_no_actionable_work():
    state = project()
    assert project_view(state, now=NOW)["guidance"]["kind"] == "complete"


def test_rejecting_focused_product_clears_focus():
    state = project()
    product = add_product(state)
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": "retained",
            "reason": "值得深入",
        },
    )
    command(state, "focus_product", {"product_id": product["id"]})
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": "rejected",
            "reason": "后续核对发现不相关",
        },
    )
    assert state.get("focus_product_id") is None
    assert state["guidance"]["kind"] == "complete"


def test_keyword_can_be_revised_before_search_and_archived_without_losing_history():
    state = project()
    command(state, "add_keyword", {"text": "bags", "type": "category"})
    kid = state["keywords"][0]["id"]
    command(
        state,
        "edit_keyword",
        {
            "keyword_id": kid,
            "text": "travel bags",
            "type": "scenario",
            "meaning": "旅行包",
        },
    )
    word = state["keywords"][0]
    assert word["text"] == '"travel bags"'
    assert word["history"][0]["text"] == '"bags"'
    command(state, "archive_keyword", {"keyword_id": kid})
    assert word["status"] == "archived" and word["approved"] is False
    assert len(state["keywords"]) == 1


def test_add_keyword_removes_nested_quotes():
    state = project()
    command(
        state,
        "add_keyword",
        {"text": '"portable organizer" travel', "type": "scenario"},
    )
    assert state["keywords"][0]["text"] == '"portable organizer travel"'


def test_legacy_malformed_pending_keyword_cannot_be_approved():
    state = project()
    command(state, "add_keyword", {"text": "placeholder", "type": "scenario"})
    keyword = state["keywords"][0]
    keyword["text"] = '""portable organizer" travel"'

    view = project_view(state, now=NOW)
    projected = view["keywords"][0]
    assert projected["needs_normalization"] is True
    assert projected["normalization_suggestion"] == '"portable organizer travel"'

    with pytest.raises(WorkbenchError, match="规范"):
        command(
            state,
            "approve_keyword",
            {"keyword_id": keyword["id"], "approved": True},
        )


def test_started_keyword_must_not_be_rewritten():
    state = project()
    command(state, "add_keyword", {"text": "bags", "type": "category"})
    kid = state["keywords"][0]["id"]
    command(state, "approve_keyword", {"keyword_id": kid, "approved": True})
    command(
        state,
        "keyword_state",
        {"keyword_id": kid, "status": "queued"},
        actor="automation",
    )
    with pytest.raises(WorkbenchError):
        command(
            state,
            "edit_keyword",
            {"keyword_id": kid, "text": "other bags", "type": "category"},
        )


@pytest.mark.parametrize("previous", ["ready", "blocked", "complete"])
def test_restore_keyword_preserves_search_and_requires_review(previous):
    state = project()
    command(state, "add_keyword", {"text": "bags", "type": "category"})
    word = state["keywords"][0]
    word.update(status=previous, approved=True, ads=[{"id": "ad-1"}], scan_counted=True)
    command(state, "archive_keyword", {"keyword_id": word["id"]})
    command(state, "restore_keyword", {"keyword_id": word["id"]})
    assert word["status"] == "pending_review"
    assert word["approved"] is False
    assert word["ads"] == [{"id": "ad-1"}]
    assert word["scan_counted"] is True
    command(state, "approve_keyword", {"keyword_id": word["id"], "approved": True})
    assert word["status"] == previous
    assert [e["action"] for e in word["lifecycle_history"]] == [
        "archive",
        "restore",
        "approve",
    ]


def test_restore_keyword_rejects_active_duplicate_path():
    from copy import deepcopy

    state = project()
    command(state, "add_keyword", {"text": "bags", "type": "category"})
    word = state["keywords"][0]
    other = deepcopy(word)
    other["id"] = "other-word"
    command(state, "archive_keyword", {"keyword_id": word["id"]})
    state["keywords"].append(other)
    with pytest.raises(WorkbenchError) as raised:
        command(state, "restore_keyword", {"keyword_id": word["id"]})
    assert raised.value.code == "duplicate_keyword"
    assert word["status"] == "archived"


def test_restore_legacy_archive_requires_review_without_guessing_completion():
    state = project()
    command(state, "add_keyword", {"text": "bags", "type": "category"})
    word = state["keywords"][0]
    word.update(status="archived", approved=False)
    command(state, "restore_keyword", {"keyword_id": word["id"]})
    command(state, "approve_keyword", {"keyword_id": word["id"], "approved": True})
    assert word["status"] == "ready"


def project():
    return new_project("Travel research", "travel storage", "US", now=NOW)


def command(state, action, payload, actor="local_user"):
    return apply_command(state, action, payload, actor=actor, now=NOW)


def add_product(state):
    command(
        state,
        "add_product",
        {"name": "Compression cubes", "url": "https://shop.example/p/cubes"},
    )
    return state["products"][0]


def identified_product(state):
    product = add_product(state)
    command(
        state,
        "identify",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "relevance_confirmed": True,
            "active_days": 45,
            "reason": "The ad and product page show the same compression cube.",
            "creatives": [
                {
                    "id": f"creative-{i}",
                    "source_url": f"https://facebook.com/ads/library/?id={i}",
                    "distinct": True,
                    "active": True,
                }
                for i in range(3)
            ],
        },
    )
    return product


def evidence(state, product_id, channel, **extra):
    payload = {
        "product_id": product_id,
        "channel": channel,
        "source_url": f"https://evidence.example/{channel}",
        "observed_at": NOW.isoformat(),
        "conclusion": "representative evidence",
        "notes": "Manually reviewed from the linked source.",
        "confirmed": True,
    }
    payload.update(extra)
    if channel == "trends":
        payload.setdefault("market", "US")
    command(state, "evidence", payload)


def complete_research(state, product):
    evidence(
        state,
        product["id"],
        "meta",
        advertiser_count=8,
        brand_concentration="low",
        differentiation="high",
    )
    evidence(
        state,
        product["id"],
        "trends",
        query="compression packing cubes",
        window="12m",
        conclusion="rising",
    )
    evidence(
        state,
        product["id"],
        "trends",
        query="compression packing cubes",
        window="5y",
        conclusion="stable-high",
    )
    for channel in ("pinterest", "tiktok", "amazon", "similarweb"):
        extra = {"direct_share": 35} if channel == "similarweb" else {}
        evidence(state, product["id"], channel, **extra)
    command(
        state,
        "funnel",
        {
            "product_id": product["id"],
            "hook": "Pack twice as much",
            "creative_formats": ["demo", "ugc", "comparison"],
            "scenarios": ["carry-on", "family travel", "business travel"],
            "angles": ["space", "organization", "speed"],
            "cta": "Shop now",
            "trust": "Linked reviews",
            "faq": "Shipping and returns",
            "bundle": "Set of four",
            "notes": "Observed page and ad facts only.",
            "source_url": "https://shop.example/p/cubes",
            "confirmed": True,
        },
    )
    command(
        state,
        "economics",
        {
            "product_id": product["id"],
            "unit_price": 30,
            "quantity": 2,
            "aov": 75,
            "goods_cost": 8,
            "shipping": 5,
            "packaging": 2,
            "tax": 3,
            "ad_cost": 5,
            "payment_percent": 3,
            "payment_fixed": 0.3,
            "reserve_percent": 2,
            "weight_kg": 1.2,
            "quote_source": "https://supplier.example/quote/123",
            "quote_date": NOW.isoformat(),
            "quote_confirmed": True,
            "logistics_risk": "low",
            "compliance_risk": "low",
            "ip_risk": "low",
            "bundle_reason": "The observed store sells a two-pack.",
            "certification_required": False,
            "certification_verified": False,
        },
    )


def test_isolated_business_chain_reaches_explainable_human_decision():
    state = project()
    product = add_product(state)
    command(
        state,
        "triage_product",
        {
            "product_id": product["id"],
            "disposition": "retained",
            "reason": "商品明确，值得进入隔离验收链路",
        },
    )
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "reason": "广告与详情页展示同一商品",
            "relevance_confirmed": True,
        },
    )
    command(
        state,
        "confirm_creatives",
        {
            "product_id": product["id"],
            "identity_revision": product["identity_revision"],
            "ad_age_days": 45,
            "currently_active": True,
            "continuity_status": "unknown",
            "creatives": [
                {
                    "id": f"acceptance-creative-{index}",
                    "source_url": (
                        "https://facebook.com/ads/library/"
                        f"?id=acceptance-{index}"
                    ),
                    "distinct": True,
                    "active": True,
                }
                for index in range(3)
            ],
        },
    )
    complete_research(state, product)
    command(state, "evaluate", {"product_id": product["id"]})
    command(
        state,
        "decide",
        {
            "product_id": product["id"],
            "pool": "test",
            "reason": "Required 证据与硬门槛均已核对",
        },
    )

    viewed = project_view(state, now=NOW)["products"][0]
    assert viewed["triage"]["state"] == "retained"
    assert viewed["identification"]["continuity_status"] == "unknown"
    assert viewed["requirement_summary"]["required_gaps"] == 0
    assert viewed["scores"][-1]["status"] == "complete"
    assert viewed["scores"][-1]["dimensions"][0]["rule_ids"]
    assert viewed["decision"]["pool"] == "test"


def approved_test_product(state):
    product = identified_product(state)
    complete_research(state, product)
    command(state, "evaluate", {"product_id": product["id"]})
    command(
        state,
        "decide",
        {"product_id": product["id"], "pool": "test", "reason": "Bounded test"},
    )
    command(
        state,
        "test_plan",
        {
            "product_id": product["id"],
            "budget": 500,
            "days": 7,
            "success_cpa": 20,
            "stop_loss": 150,
            "approved": True,
        },
    )
    return product


def valid_test_result(product, *, confirmed=True):
    return {
        "product_id": product["id"],
        "period_start": "2026-09-01",
        "period_end": "2026-09-07",
        "spend": 100,
        "impressions": 1000,
        "clicks": 100,
        "add_to_carts": 20,
        "checkouts": 10,
        "orders": 5,
        "revenue": 375,
        "refunds": 0,
        "source_url": "https://ads.example/report/test-run",
        "confirmed": confirmed,
    }


def test_new_project_has_stable_public_shape_and_read_does_not_mutate():
    state = project()
    before = deepcopy(state)

    view = project_view(state)

    assert state == before
    assert view["market"] == "US"
    assert view["version"] == 0
    assert view["limits"] == {
        "scan_batch_limit": 20,
        "daily_scan_budget": 20,
        "scan_limit": 20,
        "max_depth": 3,
    }
    assert view["summary"] == {
        "projects": 1,
        "keywords": 0,
        "products": 0,
        "qualified": 0,
        "todos": 0,
        "pending_triage": 0,
        "retained": 0,
        "observing": 0,
        "rejected": 0,
    }


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "http://localhost/admin",
        "http://127.0.0.1/private",
        "https://user:secret@example.com/product",
        "javascript:alert(1)",
    ],
)
def test_add_product_rejects_non_public_or_credentialed_urls(url):
    with pytest.raises(WorkbenchError) as raised:
        command(project(), "add_product", {"name": "Bad", "url": url})
    assert raised.value.code == "invalid_url"


def test_add_product_keeps_identity_query_but_discards_sensitive_query() -> None:
    state = project()

    command(
        state,
        "add_product",
        {
            "name": "Query product",
            "url": (
                "https://shop.example/?p=123&utm_source=meta"
                "&token=SYNTHETIC_BEARER&X-Amz-Signature=SYNTHETIC_SIGNATURE"
            ),
        },
    )

    assert state["products"][0]["url"] == "https://shop.example/?p=123"
    assert "SYNTHETIC" not in str(state)


def test_keyword_quote_normalization_dedup_and_evidenced_expansion():
    state = project()
    command(state, "add_keyword", {"text": "  “packing cubes”  ", "type": "category"})
    root = state["keywords"][0]
    assert root["text"] == '"packing cubes"'
    assert root["approved"] is False

    with pytest.raises(WorkbenchError, match="source"):
        command(
            state,
            "add_keyword",
            {
                "text": "carry on organizer",
                "type": "scenario",
                "parent_id": root["id"],
                "product_id": "missing",
            },
        )

    product = identified_product(state)
    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "body_text": "The organizer fits inside carry-on luggage.",
                "content_hash": "expansion-source",
            },
        },
        actor="automation",
    )
    source = project_view(state, now=NOW)["products"][0]["expansion_sources"][0]
    command(
        state,
        "add_keyword",
        {
            "text": "carry on organizer",
            "type": "scenario",
            "meaning": "Observed travel scenario",
            "parent_id": root["id"],
            "product_id": product["id"],
            "source_id": source["source_id"],
            "source_kind": source["source_kind"],
            "source_quote": "fits inside carry-on luggage",
        },
    )
    child = state["keywords"][-1]
    assert child["depth"] == 1
    assert child["parent_id"] == root["id"]
    assert child["source_quote"] == "fits inside carry-on luggage"


def test_expansion_is_bound_to_one_current_product_source() -> None:
    from rabbit_hole.domain.provenance import source_passages

    state = project()
    command(state, "add_keyword", {"text": "packing cubes", "type": "category"})
    parent = state["keywords"][0]
    product = identified_product(state)
    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "title": "Compression cubes",
                "page_type": "product",
                "body_text": "These cubes fit inside carry-on luggage.",
                "content_hash": "landing-content-hash",
            },
        },
        actor="automation",
    )
    passage = source_passages(state, product["id"])[0]

    command(
        state,
        "add_keyword",
        {
            "text": "carry on organizer",
            "type": "scenario",
            "parent_id": parent["id"],
            "product_id": product["id"],
            "source_id": passage.source_id,
            "source_kind": passage.source_kind,
            "source_quote": "fit inside carry-on luggage",
        },
    )

    child = state["keywords"][-1]
    assert child["source_id"] == passage.source_id
    assert child["source_kind"] == "landing"
    assert child["source_product_id"] == product["id"]
    assert child["source_identity_revision"] == product["identity_revision"]
    assert child["source_content_hash"] == "landing-content-hash"


def test_expansion_rejects_unknown_or_cross_product_source() -> None:
    state = project()
    command(state, "add_keyword", {"text": "packing cubes", "type": "category"})
    parent = state["keywords"][0]
    product = identified_product(state)

    with pytest.raises(WorkbenchError, match="source") as raised:
        command(
            state,
            "add_keyword",
            {
                "text": "carry on organizer",
                "type": "scenario",
                "parent_id": parent["id"],
                "product_id": product["id"],
                "source_id": "landing:another-product:1:hash",
                "source_kind": "landing",
                "source_quote": "fits inside carry-on luggage",
            },
        )

    assert raised.value.code == "invalid_expansion_source"
    assert len(state["keywords"]) == 1


def test_project_view_exposes_only_resolved_expansion_sources() -> None:
    state = project()
    product = identified_product(state)
    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "body_text": "Observed product copy.",
                "content_hash": "current-content",
            },
        },
        actor="automation",
    )

    viewed = project_view(state, now=NOW)["products"][0]

    assert viewed["expansion_sources"] == [
        {
            "source_id": (
                f"landing:{product['id']}:{product['identity_revision']}:current-content"
            ),
            "source_kind": "landing",
            "product_id": product["id"],
            "identity_revision": product["identity_revision"],
            "text": "Observed product copy.",
            "content_hash": "current-content",
            "keyword_id": None,
            "ad_id": None,
        }
    ]


def test_merge_same_identity_keeps_tombstone_and_active_view() -> None:
    from copy import deepcopy

    state = project()
    target = add_product(state)
    source = deepcopy(target)
    source["id"] = "source-product"
    source["name"] = "Duplicate compression cubes"
    source["source_keyword_ids"] = ["source-keyword"]
    source["candidate_sources"] = [
        {"keyword_id": "source-keyword", "ad_id": "ad-1", "landing_url": target["url"]}
    ]
    state["products"].append(source)

    command(
        state,
        "merge_products",
        {
            "target_product_id": target["id"],
            "source_product_id": source["id"],
            "reason": "同一商品由两个广告关键词发现",
        },
    )

    view = project_view(state, now=NOW)
    merged = next(item for item in state["products"] if item["id"] == source["id"])
    kept = next(item for item in state["products"] if item["id"] == target["id"])
    assert merged["merged_into"] == target["id"]
    assert merged["merge_reason"] == "同一商品由两个广告关键词发现"
    assert source["id"] not in {item["id"] for item in view["products"]}
    assert view["merged_products"][0]["id"] == source["id"]
    assert view["summary"]["products"] == 1
    assert "source-keyword" in kept["source_keyword_ids"]
    assert kept["merge_history"][0]["source_product_id"] == source["id"]


def test_cross_store_offers_link_without_moving_seller_evidence_and_can_split() -> None:
    state = project()
    first = add_product(state)
    command(state, "add_product", {"name": "Travel cube bundle", "url": "https://other.example/item/42"})
    second = state["products"][1]
    first["evidence"].append({"id": "first-only", "channel": "amazon", "identity_revision": 1})
    second["reviews"].append({"id": "second-only", "summary": "Separate offer"})
    assert project_view(state, now=NOW)["product_concepts"] == []

    command(state, "link_product_offers", {
        "first_product_id": first["id"], "second_product_id": second["id"],
        "name": "Same physical travel cubes", "reason": "Compared photos and dimensions",
    })
    concept = state["product_concepts"][0]
    view = project_view(state, now=NOW)
    assert concept["status"] == "active"
    assert set(view["product_concepts"][0]["offer_ids"]) == {first["id"], second["id"]}
    assert first["concept_id"] == second["concept_id"] == concept["id"]
    assert first["evidence"][0]["id"] == "first-only"
    assert second["reviews"][0]["id"] == "second-only"
    assert not second["evidence"] and not first["reviews"]

    command(state, "split_product_offer", {"product_id": second["id"], "reason": "Bundle differs"})
    assert first["concept_id"] is None and second["concept_id"] is None
    assert concept["status"] == "dissolved"
    assert [entry["action"] for entry in concept["history"]] == ["linked", "split", "dissolved"]


def test_cross_store_offer_link_supports_third_offer_and_exact_last_undo() -> None:
    state = project()
    first = add_product(state)
    for suffix in ("second", "third"):
        command(state, "add_product", {"name": suffix, "url": f"https://{suffix}.example/p/1"})
    second, third = state["products"][1:]
    command(state, "link_product_offers", {
        "first_product_id": first["id"], "second_product_id": second["id"],
        "name": "Travel cubes", "reason": "Same physical item",
    })
    concept_id = first["concept_id"]
    command(state, "link_product_offers", {
        "first_product_id": first["id"], "second_product_id": third["id"],
        "reason": "Same packaging and dimensions",
    })
    assert len(project_view(state, now=NOW)["product_concepts"][0]["offer_ids"]) == 3
    command(state, "undo_offer_link", {"concept_id": concept_id})
    assert third["concept_id"] is None
    assert first["concept_id"] == second["concept_id"] == concept_id
    command(state, "undo_offer_link", {"concept_id": concept_id})
    assert first["concept_id"] is None and second["concept_id"] is None
    assert state["product_concepts"][0]["status"] == "dissolved"


def test_legacy_offers_without_identity_keys_can_still_be_compared_by_url() -> None:
    state = project()
    first = add_product(state)
    command(state, "add_product", {"name": "Other seller", "url": "https://other.example/item/42"})
    second = state["products"][1]
    first.pop("identity_key")
    second.pop("identity_key")
    command(state, "link_product_offers", {
        "first_product_id": first["id"], "second_product_id": second["id"],
        "name": "Same physical product", "reason": "Manually matched photos",
    })
    assert first["concept_id"] == second["concept_id"]


def test_automation_cannot_group_or_merge_products_without_human_confirmation() -> None:
    from copy import deepcopy

    state = project()
    first = add_product(state)
    command(state, "add_product", {"name": "Other seller", "url": "https://other.example/item/42"})
    second = state["products"][1]
    with pytest.raises(WorkbenchError, match="人工"):
        command(state, "link_product_offers", {
            "first_product_id": first["id"], "second_product_id": second["id"],
            "name": "Same item", "reason": "Automated suggestion",
        }, actor="automation")
    duplicate = deepcopy(first)
    duplicate["id"] = "duplicate-for-automation"
    state["products"].append(duplicate)
    with pytest.raises(WorkbenchError, match="人工"):
        command(state, "merge_products", {
            "target_product_id": first["id"], "source_product_id": duplicate["id"],
            "reason": "Automated suggestion",
        }, actor="automation")


def test_offer_group_rejects_invalid_link_and_detaches_changed_identity() -> None:
    state = project()
    first = add_product(state)
    command(state, "add_product", {"name": "Other seller", "url": "https://other.example/p/1"})
    second = state["products"][1]
    with pytest.raises(WorkbenchError):
        command(state, "link_product_offers", {
            "first_product_id": first["id"], "second_product_id": second["id"],
            "name": "Same product", "reason": "",
        })
    command(state, "link_product_offers", {
        "first_product_id": first["id"], "second_product_id": second["id"],
        "name": "Same product", "reason": "Manually compared",
    })
    from copy import deepcopy

    duplicate = deepcopy(first)
    duplicate["id"] = "duplicate-same-url"
    duplicate["concept_id"] = None
    state["products"].append(duplicate)
    with pytest.raises(WorkbenchError, match="分组"):
        command(state, "merge_products", {
            "target_product_id": first["id"], "source_product_id": duplicate["id"],
            "reason": "Same URL, but target belongs to a concept",
        })
    with pytest.raises(WorkbenchError):
        command(state, "merge_products", {
            "target_product_id": first["id"], "source_product_id": second["id"],
            "reason": "Not same URL",
        })
    command(state, "confirm_product", {
        "product_id": second["id"], "name": second["name"],
        "url": "https://new.example/p/2", "reason": "Corrected product", "relevance_confirmed": True,
    })
    assert second["concept_id"] is None
    assert first["concept_id"] is None
    assert state["product_concepts"][0]["status"] == "dissolved"


def test_merge_marks_unresolvable_structured_expansion_for_review() -> None:
    from copy import deepcopy

    state = project()
    target = add_product(state)
    target["landing_snapshot"] = {
        "body_text": "Target product copy.",
        "content_hash": "target-content",
        "identity_revision": target["identity_revision"],
    }
    source = deepcopy(target)
    source["id"] = "source-product"
    source["landing_snapshot"] = {
        "body_text": "Source-only phrase.",
        "content_hash": "source-content",
        "identity_revision": source["identity_revision"],
    }
    state["products"].append(source)
    state["keywords"].append(
        {
            "id": "expanded-keyword",
            "text": '"source phrase"',
            "type": "scenario",
            "meaning": "",
            "parent_id": "parent-keyword",
            "product_id": source["id"],
            "depth": 1,
            "status": "ready",
            "approved": True,
            "ads": [],
            "source_id": f"landing:{source['id']}:1:source-content",
            "source_kind": "landing",
            "source_quote": "Source-only phrase.",
            "source_product_id": source["id"],
            "source_identity_revision": 1,
            "source_keyword_id": None,
            "source_ad_id": None,
            "source_content_hash": "source-content",
        }
    )

    command(
        state,
        "merge_products",
        {
            "target_product_id": target["id"],
            "source_product_id": source["id"],
            "reason": "同一商品的来源档案重复",
        },
    )

    keyword = state["keywords"][-1]
    assert keyword["product_id"] == target["id"]
    assert keyword["origin_product_id"] == source["id"]
    assert keyword["source_product_id"] == source["id"]
    assert keyword["source_id"] == f"landing:{source['id']}:1:source-content"
    assert keyword["stale_source"] is True
    assert keyword["approved"] is False
    assert keyword["status"] == "pending_review"


def test_new_sources_after_merge_attach_only_to_active_target() -> None:
    from copy import deepcopy

    state = project()
    target = add_product(state)
    source = deepcopy(target)
    source["id"] = "source-product"
    state["products"].insert(0, source)
    command(
        state,
        "merge_products",
        {
            "target_product_id": target["id"],
            "source_product_id": source["id"],
            "reason": "同一商品重复档案",
        },
    )
    command(state, "add_keyword", {"text": "packing cubes", "type": "category"})
    manual_keyword = state["keywords"][-1]

    command(
        state,
        "add_product",
        {
            "name": "Same active product",
            "url": target["url"],
            "source_keyword_ids": [manual_keyword["id"]],
        },
    )

    assert manual_keyword["id"] in target["source_keyword_ids"]
    assert manual_keyword["id"] not in source["source_keyword_ids"]

    command(state, "add_keyword", {"text": "travel organizer", "type": "category"})
    collected_keyword = state["keywords"][-1]
    command(
        state,
        "approve_keyword",
        {"keyword_id": collected_keyword["id"], "approved": True},
    )
    command(
        state,
        "collection_result",
        {
            "keyword_id": collected_keyword["id"],
            "status": "complete",
            "ads": [
                {
                    "id": "new-ad",
                    "advertiser": "Observed advertiser",
                    "start_date": "2026-09-01",
                    "landing_url": target["url"],
                    "primary_text": "Observed ad copy",
                    "active": True,
                }
            ],
        },
        actor="automation",
    )

    assert collected_keyword["id"] in target["source_keyword_ids"]
    assert collected_keyword["id"] not in source["source_keyword_ids"]
    assert any(item["ad_id"] == "new-ad" for item in target["candidate_sources"])
    assert not any(item["ad_id"] == "new-ad" for item in source["candidate_sources"])


def test_stale_approved_expansion_cannot_queue_and_changes_scan_fingerprint() -> None:
    from rabbit_hole.application.actions import target_signature

    state = project()
    product = identified_product(state)
    command(state, "add_keyword", {"text": "packing cubes", "type": "category"})
    parent = state["keywords"][0]
    command(state, "approve_keyword", {"keyword_id": parent["id"], "approved": True})
    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "body_text": "Fits inside carry-on luggage.",
                "content_hash": "original-content",
            },
        },
        actor="automation",
    )
    source = project_view(state, now=NOW)["products"][0]["expansion_sources"][0]
    command(
        state,
        "add_keyword",
        {
            "text": "carry on pouch",
            "type": "scenario",
            "parent_id": parent["id"],
            "product_id": product["id"],
            "source_id": source["source_id"],
            "source_kind": source["source_kind"],
            "source_quote": "Fits inside carry-on luggage.",
        },
    )
    child = state["keywords"][-1]
    command(state, "approve_keyword", {"keyword_id": child["id"], "approved": True})
    payload = {"keyword_id": child["id"]}
    before = target_signature(project_view(state, now=NOW), "scan", payload)

    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "body_text": "Replacement product copy.",
                "content_hash": "replacement-content",
            },
        },
        actor="automation",
    )

    after = target_signature(project_view(state, now=NOW), "scan", payload)
    assert before != after
    with pytest.raises(WorkbenchError, match="source"):
        command(
            state,
            "keyword_state",
            {"keyword_id": child["id"], "status": "queued"},
            actor="automation",
        )
    with pytest.raises(WorkbenchError, match="source"):
        command(
            state,
            "collection_result",
            {"keyword_id": child["id"], "status": "complete", "ads": []},
            actor="automation",
        )


def test_merge_rejects_different_identity_or_already_merged_product() -> None:
    from copy import deepcopy

    state = project()
    target = add_product(state)
    source = deepcopy(target)
    source["id"] = "source-product"
    source["identity_key"] = "https://shop.example/p/other"
    source["url"] = "https://shop.example/p/other"
    state["products"].append(source)

    with pytest.raises(WorkbenchError, match="identity"):
        command(
            state,
            "merge_products",
            {
                "target_product_id": target["id"],
                "source_product_id": source["id"],
                "reason": "不同商品",
            },
        )

    source["identity_key"] = target["identity_key"]
    command(
        state,
        "merge_products",
        {
            "target_product_id": target["id"],
            "source_product_id": source["id"],
            "reason": "确认重复",
        },
    )
    with pytest.raises(WorkbenchError, match="merged"):
        command(
            state,
            "merge_products",
            {
                "target_product_id": target["id"],
                "source_product_id": source["id"],
                "reason": "再次合并",
            },
        )

    with pytest.raises(WorkbenchError) as raised:
        command(
            state,
            "evaluate",
            {"product_id": source["id"]},
        )
    assert raised.value.code == "product_merged"
    assert raised.value.status == 409


def test_duplicate_creative_ids_do_not_pass_identification():
    state = project()
    product = add_product(state)
    command(
        state,
        "identify",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "relevance_confirmed": True,
            "active_days": 40,
            "reason": "Manually matched product and ad.",
            "creatives": [
                {
                    "id": "same",
                    "source_url": f"https://facebook.com/ad/{i}",
                    "distinct": True,
                    "active": True,
                }
                for i in range(3)
            ],
        },
    )
    assert product["identification"]["passed"] is False
    assert product["steps"][0]["state"] == "passed"
    assert product["steps"][1]["state"] == "needs_input"


def test_confirm_product_passes_identity_only():
    state = project()
    product = add_product(state)

    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": "Pilly travel organizer",
            "url": "https://shop.example/products/pilly",
            "reason": "广告和详情页展示同一商品",
            "relevance_confirmed": True,
        },
    )

    assert (
        next(s for s in product["steps"] if s["key"] == "identification")["state"]
        == "passed"
    )
    assert (
        next(s for s in product["steps"] if s["key"] == "coarse")["state"]
        == "needs_input"
    )
    assert product["identification"]["passed"] is False
    assert product["identification"]["identity_revision"] == 2
    assert product["identification"]["ad_age_days"] is None


@pytest.mark.parametrize(
    "active_days,creatives,expected_distinct,expected_passed",
    [
        (
            29,
            [("a", "1", True, True), ("b", "2", True, True), ("c", "3", True, True)],
            3,
            False,
        ),
        (30, [("a", "1", True, True), ("b", "2", True, True)], 2, False),
        (
            30,
            [("a", "1", True, True), ("b", "2", True, True), ("c", "3", True, True)],
            3,
            True,
        ),
        (
            30,
            [
                ("same", "1", True, True),
                ("same", "2", True, True),
                ("same", "3", True, True),
            ],
            1,
            False,
        ),
        (
            30,
            [
                ("a", "same", True, True),
                ("b", "same", True, True),
                ("c", "same", True, True),
            ],
            1,
            False,
        ),
        (
            30,
            [
                ("a", "1", True, True),
                ("b", "1", True, True),
                ("c", "1", True, True),
                ("c", "2", True, True),
                ("c", "3", True, True),
            ],
            1,
            False,
        ),
        (
            30,
            [("a", "1", True, True), ("b", "2", True, False), ("c", "3", False, True)],
            1,
            False,
        ),
    ],
)
def test_confirm_creatives_enforces_coarse_screen_boundaries(
    active_days, creatives, expected_distinct, expected_passed
):
    state = project()
    product = add_product(state)
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "reason": "广告和详情页展示同一商品",
            "relevance_confirmed": True,
        },
    )

    command(
        state,
        "confirm_creatives",
        {
            "product_id": product["id"],
            "identity_revision": product["identity_revision"],
            "active_days": active_days,
            "creatives": [
                {
                    "id": creative_id,
                    "source_url": f"https://facebook.com/ads/library/?id={source_id}",
                    "distinct": distinct,
                    "active": active,
                }
                for creative_id, source_id, distinct, active in creatives
            ],
        },
    )

    assert product["identification"]["distinct_active_creatives"] == expected_distinct
    assert product["identification"]["passed"] is expected_passed
    assert next(s for s in product["steps"] if s["key"] == "coarse")["state"] == (
        "passed" if expected_passed else "needs_input"
    )


def test_manual_creative_confirmation_keeps_per_item_audit_and_gate_evidence():
    state = project()
    product = add_product(state)
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "reason": "广告和详情页展示同一商品",
            "relevance_confirmed": True,
        },
    )

    command(
        state,
        "confirm_creatives",
        {
            "product_id": product["id"],
            "identity_revision": product["identity_revision"],
            "ad_age_days": 30,
            "creatives": [
                {
                    "id": f"creative-{index}",
                    "source_url": f"https://facebook.com/ads/library/?id={index}",
                    "distinct": True,
                    "active": True,
                }
                for index in range(3)
            ],
        },
    )

    creatives = product["identification"]["creatives"]
    assert all(item["confirmed_by"] == "local_user" for item in creatives)
    assert all(item["confirmed_at"] for item in creatives)
    assert all(item["evidence"]["source_url"] for item in creatives)
    assert len({item["evidence_id"] for item in creatives}) == 3

    gate = product["gates"]["coarse_screen"]
    assert gate["kind"] == "stage_gate"
    assert gate["status"] == "pass"
    assert gate["rule_version"] == state["rules_version"]
    assert gate["evidence_ids"] == [item["evidence_id"] for item in creatives]
    assert gate["evaluated_at"]


def test_failed_coarse_stage_gate_does_not_write_a_final_decision():
    state = project()
    product = add_product(state)
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "reason": "广告和详情页展示同一商品",
            "relevance_confirmed": True,
        },
    )
    command(
        state,
        "confirm_creatives",
        {
            "product_id": product["id"],
            "identity_revision": product["identity_revision"],
            "ad_age_days": 29,
            "creatives": [
                {
                    "id": "creative-1",
                    "source_url": "https://facebook.com/ads/library/?id=1",
                    "distinct": True,
                    "active": True,
                }
            ],
        },
    )

    gate = product["gates"]["coarse_screen"]
    assert gate["kind"] == "stage_gate"
    assert gate["status"] == "fail"
    assert product["decision"] is None


def test_unconfirmed_coarse_stage_gate_is_unknown_not_failed():
    state = project()
    product = add_product(state)
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "reason": "广告和详情页展示同一商品",
            "relevance_confirmed": True,
        },
    )

    gate = product["gates"]["coarse_screen"]
    assert gate["kind"] == "stage_gate"
    assert gate["status"] == "unknown"
    assert gate["evidence_ids"] == []


def test_confirm_creatives_rejects_stale_identity_revision():
    state = project()
    product = add_product(state)
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "reason": "广告和详情页展示同一商品",
            "relevance_confirmed": True,
        },
    )

    with pytest.raises(WorkbenchError, match="identity_revision"):
        command(
            state,
            "confirm_creatives",
            {
                "product_id": product["id"],
                "identity_revision": product["identity_revision"] - 1,
                "active_days": 30,
                "creatives": [],
            },
        )


def test_split_identification_identity_change_invalidates_dependent_state():
    state = project()
    product = add_product(state)
    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "reason": "初次确认商品",
            "relevance_confirmed": True,
        },
    )
    command(
        state,
        "confirm_creatives",
        {
            "product_id": product["id"],
            "identity_revision": product["identity_revision"],
            "active_days": 30,
            "creatives": [
                {
                    "id": f"creative-{i}",
                    "source_url": f"https://facebook.com/ads/library/?id={i}",
                    "distinct": True,
                    "active": True,
                }
                for i in range(3)
            ],
        },
    )
    complete_research(state, product)
    command(state, "evaluate", {"product_id": product["id"]})
    command(
        state,
        "decide",
        {"product_id": product["id"], "pool": "test", "reason": "进入小额测试"},
    )
    command(
        state,
        "test_plan",
        {
            "product_id": product["id"],
            "budget": 500,
            "days": 7,
            "success_cpa": 20,
            "stop_loss": 150,
            "approved": True,
        },
    )
    old_identity_key = product["identity_key"]

    command(
        state,
        "confirm_product",
        {
            "product_id": product["id"],
            "name": "Different compression product",
            "url": "https://shop.example/p/other",
            "reason": "新证据表明广告指向另一个商品",
            "relevance_confirmed": True,
        },
    )

    assert product["identity_revision"] == 2
    assert product["identity_history"][-1]["identity_key"] == old_identity_key
    assert product["identification"]["active_days"] == 0
    assert product["identification"]["creatives"] == []
    assert product["identification"]["passed"] is False
    assert product["scores"][-1]["revision"] != product["revision"]
    assert product["decision"]["stale"] is True
    assert product["test_plan"]["stale"] is True
    assert product["test_runs"][-1]["status"] == "stale"


def test_missing_costs_produces_incomplete_score_without_total():
    state = project()
    product = identified_product(state)
    command(state, "evaluate", {"product_id": product["id"]})
    score = product["scores"][-1]
    assert score["status"] == "incomplete"
    assert score["total"] is None
    assert "economics" in score["missing"]
    assert (
        next(step for step in product["steps"] if step["key"] == "score")["state"]
        == "needs_input"
    )


def test_invalid_nan_future_evidence_and_old_quote_are_rejected():
    state = project()
    product = identified_product(state)
    with pytest.raises(WorkbenchError, match="finite"):
        command(
            state,
            "economics",
            {
                "product_id": product["id"],
                "unit_price": nan,
                "quantity": 1,
                "aov": 50,
            },
        )
    with pytest.raises(WorkbenchError, match="future"):
        evidence(
            state,
            product["id"],
            "amazon",
            observed_at=(NOW + timedelta(minutes=6)).isoformat(),
        )
    old = NOW - timedelta(days=15)
    payload = {
        "product_id": product["id"],
        "unit_price": 30,
        "quantity": 1,
        "aov": 75,
        "goods_cost": 10,
        "shipping": 5,
        "packaging": 2,
        "tax": 3,
        "ad_cost": 8,
        "payment_percent": 3,
        "payment_fixed": 0.3,
        "reserve_percent": 2,
        "weight_kg": 1,
        "quote_source": "https://supplier.example/q",
        "quote_date": old.isoformat(),
        "quote_confirmed": True,
        "logistics_risk": "low",
        "compliance_risk": "low",
        "ip_risk": "low",
    }
    command(state, "economics", payload)
    command(state, "evaluate", {"product_id": product["id"]})
    assert product["scores"][-1]["status"] == "incomplete"
    assert "fresh_supplier_quote" in product["scores"][-1]["missing"]


def test_complete_current_score_can_be_decided_but_mutation_makes_it_stale():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    command(state, "evaluate", {"product_id": product["id"]})
    score = product["scores"][-1]
    assert score["status"] == "complete"
    assert score["total"] is not None and score["total"] >= 18
    command(
        state,
        "decide",
        {
            "product_id": product["id"],
            "pool": "test",
            "reason": "Meets current rubric.",
        },
    )

    evidence(state, product["id"], "amazon", conclusion="newer evidence")
    assert product["decision"]["stale"] is True
    with pytest.raises(WorkbenchError, match="current complete score"):
        command(
            state,
            "decide",
            {"product_id": product["id"], "pool": "test", "reason": "Use old score"},
        )


def test_channel_waiver_is_limited_and_meta_trends_cannot_be_waived():
    state = project()
    product = identified_product(state)
    evidence(
        state,
        product["id"],
        "pinterest",
        source_url="",
        confirmed=False,
        not_applicable=True,
        reason="No relevant category presence after documented search.",
    )
    assert product["evidence"][-1]["limited"] is True
    with pytest.raises(WorkbenchError, match="cannot be waived"):
        evidence(
            state,
            product["id"],
            "meta",
            source_url="",
            confirmed=False,
            not_applicable=True,
            reason="Unavailable",
        )


def test_test_results_validate_funnel_and_derive_null_safe_metrics():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    command(state, "evaluate", {"product_id": product["id"]})
    command(
        state,
        "decide",
        {
            "product_id": product["id"],
            "pool": "test",
            "reason": "Evidence supports a bounded test.",
        },
    )
    command(
        state,
        "test_plan",
        {
            "product_id": product["id"],
            "budget": 500,
            "days": 7,
            "success_cpa": 20,
            "stop_loss": 150,
            "notes": "Manual launch only.",
            "approved": True,
        },
    )
    bad = {
        "product_id": product["id"],
        "period_start": "2026-09-01",
        "period_end": "2026-09-07",
        "spend": 50,
        "impressions": 10,
        "clicks": 11,
        "add_to_carts": 0,
        "checkouts": 0,
        "orders": 0,
        "revenue": 0,
        "refunds": 0,
        "source_url": "https://ads.example/report/1",
        "confirmed": True,
    }
    with pytest.raises(WorkbenchError, match="impressions"):
        command(state, "test_result", bad)
    good = {**bad, "clicks": 0}
    command(state, "test_result", good)
    assert product["test_results"][-1]["metrics"] == {
        "ctr": 0.0,
        "cpc": None,
        "cvr": None,
        "cpa": None,
        "aov": None,
    }
    with pytest.raises(WorkbenchError, match="duplicate"):
        command(state, "test_result", good)


def test_automation_results_are_sanitized_and_do_not_claim_human_confirmation():
    state = project()
    command(state, "add_keyword", {"text": "packing cubes", "type": "category"})
    keyword = state["keywords"][0]
    command(state, "approve_keyword", {"keyword_id": keyword["id"], "approved": True})
    command(
        state,
        "keyword_state",
        {"keyword_id": keyword["id"], "status": "queued"},
        actor="automation",
    )
    command(
        state,
        "collection_result",
        {
            "keyword_id": keyword["id"],
            "status": "complete",
            "observed_at": NOW.isoformat(),
            "source_url": "https://www.facebook.com/ads/library/?q=%22packing+cubes%22",
            "evidence_id": "evidence/US/action-1/screenshot.png",
            "displayed_filters": {"country": "US", "query": '"packing cubes"'},
            "ads": [
                {
                    "id": "ad-1",
                    "advertiser": "Safe <script>alert(1)</script> Brand",
                    "start_date": "2026-08-01",
                    "landing_url": "https://shop.example/p/one",
                    "primary_text": "<b>Pack better</b>",
                    "active": True,
                    "ignored": "must not persist",
                }
            ],
        },
        actor="automation",
    )
    assert keyword["status"] == "complete"
    assert {
        key: keyword["ads"][0][key]
        for key in (
            "id",
            "advertiser",
            "start_date",
            "landing_url",
            "primary_text",
            "active",
        )
    } == {
        "id": "ad-1",
        "advertiser": "Safe  Brand",
        "start_date": "2026-08-01",
        "landing_url": "https://shop.example/p/one",
        "primary_text": "Pack better",
        "active": True,
    }
    assert keyword["ads"][0]["started_at"] == "2026-08-01"
    assert keyword["ads"][0]["continuity_status"] == "unknown"
    assert keyword["last_collection"] == {
        "observed_at": "2026-09-13T04:00:00Z",
        "source_url": "https://www.facebook.com/ads/library",
        "evidence_id": "evidence/US/action-1/screenshot.png",
        "displayed_filters": {"country": "US", "query": '"packing cubes"'},
        "recorded_at": "2026-09-13T04:00:00Z",
    }
    assert state["products"][0]["identification"] == {}


def test_collection_provenance_rejects_unsafe_or_unowned_evidence():
    state = project()
    command(state, "add_keyword", {"text": "packing cubes", "type": "category"})
    keyword = state["keywords"][0]
    command(state, "approve_keyword", {"keyword_id": keyword["id"], "approved": True})
    with pytest.raises(WorkbenchError, match="evidence_id"):
        command(
            state,
            "collection_result",
            {
                "keyword_id": keyword["id"],
                "status": "complete",
                "ads": [],
                "observed_at": NOW.isoformat(),
                "source_url": "https://www.facebook.com/ads/library/",
                "evidence_id": "another-market/private.png",
                "displayed_filters": {},
            },
            actor="automation",
        )


def test_internal_snapshots_remain_unconfirmed():
    from rabbit_hole.trends import TrendSeries, classify_trend_window

    state = project()
    product = add_product(state)
    series = TrendSeries(values=[70] * 52, window="12m")
    classification = classify_trend_window(series)
    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "title": "Cubes",
                "page_type": "product",
                "body_text": "<script>x</script>Observed copy",
            },
        },
        actor="automation",
    )
    command(
        state,
        "trends_result",
        {
            "product_id": product["id"],
            "query": "packing cubes",
            "evidence": [
                {
                    "window": "12m",
                    "conclusion": classification.label.value,
                    "classification": classification.model_dump(mode="json"),
                    "points": series.model_dump(mode="json")["points"],
                    "source_url": "https://trends.google.com/",
                    "observed_at": NOW.isoformat(),
                }
            ],
        },
        actor="automation",
    )
    assert product["landing_snapshot"]["confirmed"] is False
    assert product["automatic_trends"][0]["confirmed"] is False
    assert product["evidence"] == []


@pytest.mark.parametrize("status", [True, 99, 600, "200"])
def test_landing_result_rejects_invalid_http_status_codes(status):
    state = project()
    product = add_product(state)
    with pytest.raises(WorkbenchError, match="status"):
        command(
            state,
            "landing_result",
            {
                "product_id": product["id"],
                "source_url": product["url"],
                "observed_at": NOW.isoformat(),
                "snapshot": {
                    "body_text": "Observed copy",
                    "http_status_code": status,
                },
            },
            actor="automation",
        )


def test_landing_result_preserves_valid_integer_http_status_codes():
    state = project()
    product = add_product(state)
    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "body_text": "Observed copy",
                "http_status_code": 200,
                "browser_status_code": 204,
            },
        },
        actor="automation",
    )

    assert product["landing_snapshot"]["http_status_code"] == 200
    assert type(product["landing_snapshot"]["http_status_code"]) is int
    assert product["landing_snapshot"]["browser_status_code"] == 204


def test_collection_without_landing_url_keeps_ad_without_creating_product():
    state = project()
    command(state, "add_keyword", {"text": "packing cubes", "type": "category"})
    keyword = state["keywords"][0]
    command(state, "approve_keyword", {"keyword_id": keyword["id"], "approved": True})

    command(
        state,
        "collection_result",
        {
            "keyword_id": keyword["id"],
            "status": "complete",
            "ads": [
                {
                    "id": "ad-without-url",
                    "advertiser": "Observed advertiser",
                    "start_date": "2026-09-01",
                    "landing_url": None,
                    "primary_text": "Observed ad copy",
                    "active": True,
                }
            ],
        },
        actor="automation",
    )

    assert keyword["ads"][0]["landing_url"] == ""
    assert state["products"] == []


def test_project_view_tolerates_legacy_product_without_url_identity():
    state = project()
    product = add_product(state)
    product["url"] = ""
    product.pop("identity_key", None)

    view = project_view(state, now=NOW)

    assert view["products"][0]["identity_key"] is None
    assert view["products"][0]["expansion_sources"] == []


def test_review_does_not_pretend_unconfirmed_metrics_were_tested():
    state = project()
    product = add_product(state)
    command(
        state,
        "decide",
        {"product_id": product["id"], "pool": "observe", "reason": "Research only."},
    )
    command(
        state,
        "review",
        {
            "product_id": product["id"],
            "conclusion": "Need more evidence",
            "lessons": "No test was run.",
            "next_keywords": ["travel organizer"],
        },
    )
    assert product["reviews"][-1]["kind"] == "research"
    keyword = state["keywords"][-1]
    assert keyword["approved"] is False
    assert keyword["product_id"] == product["id"]


def test_source_keyword_is_not_completed_expansion():
    state = project()
    command(state, "add_keyword", {"text": "organizer", "type": "category"})
    command(
        state,
        "add_product",
        {
            "name": "Product",
            "url": "https://shop.example/p/a",
            "source_keyword_ids": [state["keywords"][0]["id"]],
        },
    )
    assert (
        next(s for s in state["products"][0]["steps"] if s["key"] == "expansion")[
            "state"
        ]
        != "passed"
    )


@pytest.mark.parametrize(
    "channel,extra,missing",
    [
        (
            "trends",
            {
                "query": "compression packing cubes",
                "window": "12m",
                "conclusion": "insufficient-data",
            },
            "trends_12m",
        ),
        (
            "trends",
            {"query": "unrelated query", "window": "12m", "conclusion": "rising"},
            "trends_query_mismatch",
        ),
    ],
)
def test_missing_channel_facts_cannot_be_scored(channel, extra, missing):
    state = project()
    p = identified_product(state)
    complete_research(state, p)
    evidence(state, p["id"], channel, **extra)
    command(state, "evaluate", {"product_id": p["id"]})
    assert missing in p["scores"][-1]["missing"]
    assert p["scores"][-1]["total"] is None


def test_missing_recommended_channels_do_not_block_scoring():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    product["evidence"] = [
        item
        for item in product["evidence"]
        if item["channel"] not in {"pinterest", "tiktok", "amazon", "similarweb"}
    ]

    command(state, "evaluate", {"product_id": product["id"]})

    assert product["scores"][-1]["status"] == "complete"
    assert product["scores"][-1]["missing"] == []


def test_project_view_exposes_requirement_catalog_and_gap_counts():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    product["evidence"] = [
        item for item in product["evidence"] if item["channel"] != "amazon"
    ]

    view = project_view(state, now=NOW)
    viewed = view["products"][0]

    assert view["evidence_requirements_version"]
    assert view["evidence_requirement_catalog"]
    assert viewed["requirement_summary"]["required_gaps"] == 0
    assert viewed["requirement_summary"]["recommended_gaps"] == 1
    assert viewed["requirement_summary"]["unknown"] >= 1


def test_configure_rules_versions_an_explicit_required_channel_override():
    state = project()

    command(
        state,
        "configure_rules",
        {
            "rules": {},
            "evidence_requirement_levels": {"amazon": "required"},
            "reason": "该项目要求 Amazon 证据作为评分前置项",
        },
    )

    assert state["rules_version"] == 2
    assert state["evidence_requirement_levels"]["amazon"] == "required"
    assert state["rule_history"][-1]["evidence_requirement_levels"]["amazon"] == "required"
    view = project_view(state, now=NOW)
    amazon = next(
        item for item in view["evidence_requirement_catalog"] if item["key"] == "amazon"
    )
    assert amazon["level"] == "required"


def test_changing_product_identity_keeps_history_but_requires_new_evidence() -> None:
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    old_evidence = deepcopy(product["evidence"])
    old_identity_key = product["identity_key"]

    command(
        state,
        "identify",
        {
            "product_id": product["id"],
            "name": "Different compression product",
            "url": "https://shop.example/p/other",
            "relevance_confirmed": True,
            "active_days": 45,
            "reason": "The newly reviewed ads point to a different product.",
            "creatives": product["identification"]["creatives"],
        },
    )
    command(state, "evaluate", {"product_id": product["id"]})

    assert product["evidence"] == old_evidence
    assert product["identity_revision"] == 2
    assert product["identity_history"][-1]["identity_key"] == old_identity_key
    assert product["scores"][-1]["status"] == "incomplete"
    assert "meta" in product["scores"][-1]["missing"]
    viewed = project_view(state, now=NOW)["products"][0]
    assert all(item["stale_identity"] is True for item in viewed["evidence"])
    assert viewed["funnel"]["stale_identity"] is True
    assert viewed["economics"]["stale_identity"] is True


def test_expired_quote_invalidates_visible_score_and_blocks_decision():
    state = project()
    p = identified_product(state)
    complete_research(state, p)
    command(state, "evaluate", {"product_id": p["id"]})
    later = NOW + timedelta(days=15)
    with pytest.raises(WorkbenchError):
        apply_command(
            state,
            "decide",
            {"product_id": p["id"], "pool": "test", "reason": "old evidence"},
            now=later,
        )
    view = project_view(state, now=later)
    assert (
        next(s for s in view["products"][0]["steps"] if s["key"] == "score")["state"]
        == "needs_input"
    )


@pytest.mark.parametrize("window", ["12m", "5y"])
def test_peaked_trend_is_a_hard_gate(window: str) -> None:
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    next(
        item
        for item in product["evidence"]
        if item["channel"] == "trends" and item["window"] == window
    )["conclusion"] = "peaked"

    command(state, "evaluate", {"product_id": product["id"]})

    assert product["scores"][-1]["status"] == "rejected"
    assert "peaked_trend" in product["scores"][-1]["hard_failures"]


@pytest.mark.parametrize("window", ["12m", "5y"])
def test_declining_trend_requires_review_without_hard_rejection(window: str) -> None:
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    next(
        item
        for item in product["evidence"]
        if item["channel"] == "trends" and item["window"] == window
    )["conclusion"] = "declining"

    command(state, "evaluate", {"product_id": product["id"]})

    score = product["scores"][-1]
    assert score["status"] == "incomplete"
    assert score["total"] is None
    assert score["missing"] == ["trend_declining_review"]
    assert score.get("hard_failures", []) == []
    assert score["manual_review_required"] is True


def test_signed_trend_statistics_are_preserved():
    state = project()
    p = add_product(state)
    evidence(
        state,
        p["id"],
        "trends",
        window="12m",
        query="organizer",
        conclusion="declining",
        data={"change_ratio": -0.4},
    )
    assert p["evidence"][-1]["data"]["change_ratio"] == -0.4


def test_quotes_are_kept_for_comparison_without_reusing_old_approval():
    state = project()
    p = identified_product(state)
    complete_research(state, p)
    previous = deepcopy(p["economics"])
    command(state, "economics", {**previous, "product_id": p["id"], "goods_cost": 12})
    assert p["quote_history"][0]["goods_cost"] == 8
    assert p["economics"]["goods_cost"] == 12


def test_test_plan_has_actionable_original_production_brief():
    state = project()
    p = identified_product(state)
    complete_research(state, p)
    command(state, "evaluate", {"product_id": p["id"]})
    command(state, "decide", {"product_id": p["id"], "pool": "test", "reason": "test"})
    command(
        state,
        "test_plan",
        {
            "product_id": p["id"],
            "budget": 500,
            "days": 7,
            "success_cpa": 20,
            "stop_loss": 150,
            "approved": True,
        },
    )
    pack = p["test_plan"]["preparation"]
    assert len(pack["script"]) >= 3
    assert pack["price_hypothesis"]["aov"] == 75
    assert pack["execution_status"] == "未投放，需人工执行"


def test_new_test_run_is_not_completed_by_an_old_result() -> None:
    state = project()
    product = approved_test_product(state)
    first_run = product["test_runs"][-1]["id"]
    command(state, "test_result", valid_test_result(product))
    assert next(s for s in product["steps"] if s["key"] == "test")["state"] == "passed"

    command(
        state,
        "test_plan",
        {
            "product_id": product["id"],
            "budget": 400,
            "days": 5,
            "success_cpa": 18,
            "stop_loss": 120,
            "approved": True,
        },
    )

    assert product["test_runs"][-1]["id"] != first_run
    assert product["test_runs"][-2]["status"] == "superseded"
    assert (
        next(s for s in product["steps"] if s["key"] == "test")["state"]
        == "needs_input"
    )


def test_legacy_test_result_is_visible_but_does_not_complete_a_new_run() -> None:
    state = project()
    product = add_product(state)
    product["test_results"].append(
        {
            "id": "legacy-result",
            "confirmed": True,
            "orders": 2,
            "revenue": 80,
            "spend": 20,
        }
    )
    before = deepcopy(state)

    view = project_view(state, now=NOW)

    assert state == before
    viewed = view["products"][0]
    assert viewed["test_runs"] == []
    assert viewed["test_results"][0]["legacy"] is True


def test_draft_result_can_be_confirmed_without_duplicate_period_error() -> None:
    state = project()
    product = approved_test_product(state)
    command(state, "test_result", valid_test_result(product, confirmed=False))
    draft = deepcopy(product["test_results"][-1])

    command(
        state,
        "confirm_test_result",
        {"product_id": product["id"], "result_id": draft["id"]},
    )

    confirmed = product["test_results"][-1]
    assert confirmed["state"] == "confirmed"
    assert confirmed["supersedes_id"] == draft["id"]
    assert confirmed["revision"] == 2
    assert active_test_results(product) == [confirmed]


def test_confirmed_result_can_be_revised_without_losing_history() -> None:
    state = project()
    product = approved_test_product(state)
    command(state, "test_result", valid_test_result(product))
    original = deepcopy(product["test_results"][-1])

    command(
        state,
        "revise_test_result",
        {
            **valid_test_result(product),
            "result_id": original["id"],
            "reason": "Reconciled against the final platform export.",
            "revenue": 400,
        },
    )

    revised = product["test_results"][-1]
    assert product["test_results"][0] == original
    assert revised["supersedes_id"] == original["id"]
    assert revised["revision"] == 2
    assert revised["state"] == "confirmed"
    assert revised["revenue"] == 400
    assert active_test_results(product) == [revised]


def test_void_result_is_preserved_but_removed_from_current_totals() -> None:
    state = project()
    product = approved_test_product(state)
    command(state, "test_result", valid_test_result(product))
    original = deepcopy(product["test_results"][-1])

    command(
        state,
        "void_test_result",
        {
            "product_id": product["id"],
            "result_id": original["id"],
            "reason": "The source export used the wrong account.",
        },
    )

    tombstone = product["test_results"][-1]
    assert product["test_results"][0] == original
    assert tombstone["state"] == "void"
    assert tombstone["supersedes_id"] == original["id"]
    assert active_test_results(product) == []
    assert (
        next(s for s in product["steps"] if s["key"] == "test")["state"]
        == "needs_input"
    )


def test_reject_decision_blocks_new_test_result() -> None:
    state = project()
    product = approved_test_product(state)
    command(
        state,
        "decide",
        {"product_id": product["id"], "pool": "reject", "reason": "Stop testing"},
    )

    with pytest.raises(WorkbenchError, match="current approved test plan"):
        command(state, "test_result", valid_test_result(product))


def test_legacy_project_exposes_default_rules_without_mutating_saved_state():
    state = project()
    state.pop("rules", None)
    state.pop("rules_version", None)
    state.pop("rule_history", None)
    before = deepcopy(state)

    view = project_view(state, now=NOW)

    assert state == before
    assert view["rules"] == DEFAULT_RULES
    assert view["rules_version"] == 1
    assert view["rule_history"] == []
    assert view["limits"] == {
        "scan_batch_limit": 20,
        "daily_scan_budget": 20,
        "scan_limit": 20,
        "max_depth": 3,
    }


@pytest.mark.parametrize(
    "rules",
    [
        {"unknown": 1},
        {"min_active_days": True},
        {"min_active_days": "30"},
        {"min_active_days": 1.5},
        {"max_weight_kg": float("inf")},
        {"scan_limit": 0},
        {"min_margin_percent": 101},
        {"max_direct_share_percent": 101},
        {"min_aov": 101, "max_aov": 100},
        {"backup_score": 19, "test_score": 18},
        {"test_score": 26},
    ],
)
def test_configure_rules_rejects_invalid_values_without_changing_state(rules):
    state = project()
    before = deepcopy(state)

    with pytest.raises(WorkbenchError):
        command(state, "configure_rules", {"rules": rules, "reason": "Tune rules"})

    assert state == before


def test_configure_rules_requires_object_and_nonempty_reason():
    state = project()
    with pytest.raises(WorkbenchError):
        command(state, "configure_rules", {"rules": [], "reason": "Tune rules"})
    with pytest.raises(WorkbenchError):
        command(state, "configure_rules", {"rules": {}, "reason": "  "})


def test_changed_rule_recomputes_coarse_status_but_noop_does_not_invalidate_again():
    state = project()
    product = identified_product(state)
    evidence_before = deepcopy(product["identification"])

    command(
        state,
        "configure_rules",
        {"rules": {"min_active_days": 46}, "reason": "Require longer proof"},
    )

    assert product["identification"]["active_days"] == evidence_before["active_days"]
    assert product["identification"]["passed"] is False
    assert (
        next(step for step in product["steps"] if step["key"] == "coarse")["state"]
        == "needs_input"
    )
    assert state["rules_version"] == 2
    assert state["rule_history"] == [
        {
            "version": 2,
            "rules": {**DEFAULT_RULES, "min_active_days": 46},
            "reason": "Require longer proof",
            "operator": "local_user",
            "configured_at": "2026-09-13T04:00:00Z",
        }
    ]
    revision = product["revision"]

    command(
        state,
        "configure_rules",
        {"rules": {"min_active_days": 46}, "reason": "No effective change"},
    )

    assert state["rules_version"] == 2
    assert len(state["rule_history"]) == 1
    assert product["revision"] == revision


def test_scores_capture_rule_snapshot_and_rule_changes_preserve_history_only():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    command(state, "evaluate", {"product_id": product["id"]})
    command(
        state,
        "decide",
        {"product_id": product["id"], "pool": "test", "reason": "Qualified"},
    )
    command(
        state,
        "test_plan",
        {
            "product_id": product["id"],
            "budget": 500,
            "days": 7,
            "success_cpa": 20,
            "stop_loss": 150,
            "approved": True,
        },
    )
    command(
        state,
        "test_result",
        {
            "product_id": product["id"],
            "period_start": "2026-09-01",
            "period_end": "2026-09-07",
            "spend": 100,
            "impressions": 1000,
            "clicks": 100,
            "add_to_carts": 20,
            "checkouts": 10,
            "orders": 5,
            "revenue": 375,
            "refunds": 0,
            "source_url": "https://ads.example/report/config-test",
            "confirmed": True,
        },
    )
    score = deepcopy(product["scores"][-1])
    evidence_before = deepcopy(product["evidence"])
    results_before = deepcopy(product["test_results"])

    assert score["rule_version"] == 1
    assert score["rules"] == DEFAULT_RULES
    command(
        state,
        "configure_rules",
        {"rules": {"min_margin_percent": 61}, "reason": "Raise margin floor"},
    )

    assert product["scores"] == [score]
    assert product["decision"]["stale"] is True
    assert product["test_plan"]["stale"] is True
    assert product["test_plan"]["approved"] is False
    assert product["evidence"] == evidence_before
    assert product["test_results"] == results_before

    command(state, "evaluate", {"product_id": product["id"]})
    assert product["scores"][-1]["rule_version"] == 2
    assert product["scores"][-1]["rules"] == state["rules"]


def test_configured_quote_window_and_decision_threshold_use_inclusive_boundaries():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    economics = deepcopy(product["economics"])
    command(
        state,
        "economics",
        {
            **economics,
            "product_id": product["id"],
            "quote_date": (NOW - timedelta(days=15)).isoformat(),
            "compliance_risk": "medium",
        },
    )
    command(
        state,
        "configure_rules",
        {
            "rules": {"quote_valid_days": 15, "test_score": 22},
            "reason": "Use negotiated quote window and score boundary",
        },
    )
    command(state, "evaluate", {"product_id": product["id"]})

    assert product["scores"][-1]["status"] == "complete"
    assert product["scores"][-1]["total"] == 22
    command(
        state,
        "decide",
        {"product_id": product["id"], "pool": "test", "reason": "At threshold"},
    )

    command(
        state,
        "configure_rules",
        {"rules": {"test_score": 23}, "reason": "Require one more point"},
    )
    command(state, "evaluate", {"product_id": product["id"]})
    with pytest.raises(WorkbenchError, match="at least 23"):
        command(
            state,
            "decide",
            {"product_id": product["id"], "pool": "test", "reason": "Below threshold"},
        )


def test_keyword_history_does_not_consume_future_scan_capacity():
    state = project()
    command(
        state,
        "configure_rules",
        {
            "rules": {
                "scan_batch_limit": 1,
                "daily_scan_budget": 1,
                "max_depth": 1,
                "expansion_limit": 1,
            },
            "reason": "Small bounded research run",
        },
    )
    command(state, "add_keyword", {"text": "root", "type": "category"})
    root = state["keywords"][0]
    command(state, "approve_keyword", {"keyword_id": root["id"], "approved": True})
    command(
        state,
        "keyword_state",
        {"keyword_id": root["id"], "status": "queued"},
        actor="automation",
    )
    root["scan_counted"] = True  # legacy audit flag from the old lifetime budget
    command(state, "add_keyword", {"text": "second root", "type": "category"})
    second = state["keywords"][-1]
    command(state, "approve_keyword", {"keyword_id": second["id"], "approved": True})
    command(
        state,
        "keyword_state",
        {"keyword_id": second["id"], "status": "queued"},
        actor="automation",
    )
    assert second["status"] == "queued"
    assert root.get("scan_counted") is True

    product = identified_product(state)
    command(
        state,
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": NOW.isoformat(),
            "snapshot": {
                "body_text": "first observed phrase; second observed phrase; nested observed phrase",
                "content_hash": "budget-expansion-source",
            },
        },
        actor="automation",
    )
    source = project_view(state, now=NOW)["products"][0]["expansion_sources"][0]
    command(
        state,
        "add_keyword",
        {
            "text": "child one",
            "type": "scenario",
            "parent_id": root["id"],
            "product_id": product["id"],
            "source_id": source["source_id"],
            "source_kind": source["source_kind"],
            "source_quote": "first observed phrase",
        },
    )
    child = state["keywords"][-1]
    with pytest.raises(WorkbenchError, match="per parent"):
        command(
            state,
            "add_keyword",
            {
                "text": "child two",
                "type": "scenario",
                "parent_id": root["id"],
                "product_id": product["id"],
                "source_id": source["source_id"],
                "source_kind": source["source_kind"],
                "source_quote": "second observed phrase",
            },
        )
    with pytest.raises(WorkbenchError, match="depth limit"):
        command(
            state,
            "add_keyword",
            {
                "text": "grandchild",
                "type": "pain",
                "parent_id": child["id"],
                "product_id": product["id"],
                "source_id": source["source_id"],
                "source_kind": source["source_kind"],
                "source_quote": "nested observed phrase",
            },
        )

@pytest.mark.parametrize('result,confirmed',[('matched',True),('mismatch',False),('unverified',False)])
def test_identity_outcomes_are_explicit_and_keep_existing_relevance_gate(result,confirmed):
    state=project();item=add_product(state)
    command(state,'confirm_product',{'product_id':item['id'],'name':item['name'],'url':item['url'],'reason':'实际对照外观与链接','relevance_confirmed':confirmed,'relevance_result':result})
    assert item['identification']['relevance_result']==result
    assert item['identification']['relevance_confirmed'] is confirmed
    assert item['triage']['state']=='pending'
    if not confirmed:
        assert item['identification']['passed'] is False


def test_identity_outcome_cannot_contradict_confirmation():
    state=project();item=add_product(state)
    with pytest.raises(WorkbenchError):
        command(state,'confirm_product',{'product_id':item['id'],'name':item['name'],'url':item['url'],'reason':'检查来源','relevance_confirmed':True,'relevance_result':'mismatch'})
