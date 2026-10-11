"""Read-only research summaries preserve denominators and source uncertainty."""

from datetime import UTC, datetime

from rabbit_hole.application.intelligence import (
    confirmed_run_outcomes,
    intelligence_snapshot,
)
from rabbit_hole.domain.project import apply_command, new_project

NOW = datetime(2026, 9, 29, 4, 0, tzinfo=UTC)


def _project():
    return new_project("Research", "travel storage", "US", now=NOW)


def _keyword(project, text, kind):
    apply_command(project, "add_keyword", {"text": text, "type": kind}, now=NOW)
    return project["keywords"][-1]


def _product(project, name, sources):
    apply_command(
        project,
        "add_product",
        {
            "name": name,
            "url": f"https://shop.example/p/{name}",
            "source_keyword_ids": sources,
        },
        now=NOW,
    )
    return project["products"][-1]


def test_empty_keyword_ratios_show_zero_denominator_and_unknown_scan_history():
    project = _project()
    word = _keyword(project, "travel organizer", "category")
    word["status"] = "complete"  # old saved state, no action row to count

    snapshot = intelligence_snapshot(project, {}, NOW)
    row = snapshot["keywords"][0]

    assert row["scan_attempts"] is None
    assert row["scan_completed"] is None
    assert row["scan_note"] == "旧记录不可还原"
    assert row["retained_rate"] == {
        "numerator": 0,
        "denominator": 0,
        "sample_size": 0,
        "percent": None,
        "window_start": "2026-09-29T04:00:00Z",
        "window_end": "2026-09-29T04:00:00+00:00",
    }
    assert snapshot["calibration"] == []
    assert snapshot["review_prompts"] == []


def test_keyword_type_and_source_rows_deduplicate_without_causal_attribution():
    project = _project()
    pain = _keyword(project, "messy suitcase travel", "pain_scenario")
    audience = _keyword(project, "office traveler", "scenario_audience")
    ad = {"id": "ad-1", "landing_url": "https://shop.example/p/item"}
    pain["ads"] = [ad, ad]
    item = _product(project, "item", [pain["id"], audience["id"], pain["id"]])
    item["triage"]["state"] = "retained"
    item["candidate_sources"] = [
        {"keyword_id": pain["id"], "ad_id": "ad-1"},
        {"keyword_id": pain["id"], "ad_id": "ad-1"},
    ]
    item["decision"] = {
        "pool": "test",
        "stale": False,
        "score_revision": item["revision"],
    }
    manual = _product(project, "manual", [audience["id"]])
    manual["triage"]["state"] = "observing"
    duplicate = _product(project, "duplicate", [pain["id"]])
    duplicate["merged_into"] = item["id"]
    item["steps"] = [{"key": "decision", "state": "passed"}]

    snapshot = intelligence_snapshot(
        project,
        {pain["id"]: {"attempts": 3, "completed": 2}},
        NOW,
    )
    rows = {row["id"]: row for row in snapshot["keywords"]}
    assert rows[pain["id"]]["ads_found"] == 1
    assert rows[pain["id"]]["scan_attempts"] == 3
    assert rows[pain["id"]]["scan_completed"] == 2
    assert rows[pain["id"]]["associated_products"] == 1
    assert rows[pain["id"]]["primary_products"] == 1
    assert rows[pain["id"]]["retained_rate"]["numerator"] == 1
    assert rows[pain["id"]]["retained_rate"]["denominator"] == 1
    assert rows[pain["id"]]["test_pool_rate"]["percent"] == 100.0
    assert rows[audience["id"]]["associated_products"] == 2
    assert rows[audience["id"]]["assisting_products"] == 1
    assert rows[audience["id"]]["retained_rate"]["percent"] == 50.0

    types = {row["type"]: row for row in snapshot["keyword_types"]}
    assert types["pain_scenario"]["associated_products"] == 1
    assert types["scenario_audience"]["associated_products"] == 2
    assert snapshot["unique_active_products"] == 2
    assert snapshot["confirmed_concept_groups"] == 0
    assert "不可相加" in snapshot["association_note"]

    sources = {row["source"]: row for row in snapshot["discovery_sources"]}
    assert sources["meta"]["candidate_products"] == 1
    assert sources["unattributed"]["candidate_products"] == 1
    for source in ("amazon", "tiktok", "pinterest", "similarweb"):
        assert sources[source]["status"] == "not_observed"
        assert sources[source]["candidate_products"] is None
        assert sources[source]["retained_rate"]["percent"] is None


def test_concept_group_counts_offer_records_without_claiming_unique_physical_products():
    project = _project()
    first = _product(project, "shop-a", [])
    second = _product(project, "shop-b", [])
    first["concept_id"] = second["concept_id"] = "confirmed-concept"
    project["product_concepts"] = [{"id": "confirmed-concept", "status": "active"}]
    snapshot = intelligence_snapshot(project, {}, NOW)
    assert snapshot["unique_active_products"] == 2
    assert snapshot["confirmed_concept_groups"] == 1
    assert "卖家档案" in snapshot["association_note"]

def test_missing_keyword_link_and_wrong_ad_identity_do_not_gain_meta_credit():
    project = _project()
    word = _keyword(project, "travel case", "category")
    word["ads"] = [{"id": "ad-1", "landing_url": "https://shop.example/p/other"}]
    product = _product(project, "item", [word["id"]])
    product["source_keyword_ids"] = []
    product["candidate_sources"] = [{"keyword_id": word["id"], "ad_id": "ad-1"}]

    snapshot = intelligence_snapshot(project, {}, NOW)
    sources = {row["source"]: row for row in snapshot["discovery_sources"]}
    assert snapshot["keywords"][0]["primary_products"] == 0
    assert sources["meta"]["candidate_products"] == 0
    assert sources["unattributed"]["candidate_products"] == 1


def _run_product():
    project = _project()
    word = _keyword(project, "packing cubes", "category")
    product = _product(project, "item", [word["id"]])
    product["scores"] = [{"id": "score-1", "total": 82, "status": "complete", "rule_version": 1, "dimensions": []}]
    product["decision"] = {"id": "decision-1", "pool": "test", "score_id": "score-1"}
    product["test_runs"] = [
        {
            "id": "run-1", "status": "superseded", "decision_id": "decision-1",
            "plan": {"success_cpa": 20, "created_at": "2026-09-01T00:00:00Z"},
        },
        {"id": "run-2", "status": "active", "decision_id": "decision-1", "plan": {"success_cpa": 18}},
    ]
    product["test_results"] = [
        {"id": "old", "test_run_id": "run-1", "state": "confirmed", "confirmed": True, "spend": 100, "orders": 10},
        {"id": "new", "supersedes_id": "old", "test_run_id": "run-1", "state": "confirmed", "confirmed": True, "spend": 120, "orders": 4},
        {"id": "draft", "test_run_id": "run-1", "state": "draft", "confirmed": False, "spend": 50, "orders": 10},
        {"id": "voided", "test_run_id": "run-1", "state": "confirmed", "confirmed": True, "spend": 50, "orders": 10},
        {"id": "void", "supersedes_id": "voided", "test_run_id": "run-1", "state": "void", "confirmed": False, "spend": 50, "orders": 10},
        {"id": "legacy", "state": "confirmed", "confirmed": True, "spend": 1, "orders": 100},
        {"id": "zero", "test_run_id": "run-2", "state": "confirmed", "confirmed": True, "spend": 12, "orders": 0},
    ]
    return project, product


def test_confirmed_run_outcomes_keep_historical_runs_and_exclude_inactive_revisions():
    project, product = _run_product()
    outcomes = confirmed_run_outcomes(product)
    assert len(outcomes) == 2
    old, current = outcomes
    assert old["run_id"] == "run-1"
    assert old["status"] == "superseded"
    assert old["confirmed_records"] == 1
    assert old["spend"] == 120
    assert old["orders"] == 4
    assert old["actual_cpa"] == 30
    assert old["target_cpa"] == 20
    assert old["comparison"] == "above_target"
    assert old["score_total"] == 82
    assert current["actual_cpa"] is None
    assert current["comparison"] == "unknown"
    snapshot = intelligence_snapshot(project, {}, NOW)
    assert len(snapshot["calibration"]) == 1
    assert snapshot["calibration"][0]["run_id"] == "run-1"
    assert len(snapshot["review_prompts"]) == 1
    assert "人工复核" in snapshot["review_prompts"][0]["message"]


def test_calibration_requires_original_target_score_and_confirmed_result():
    project, product = _run_product()
    product["scores"] = []
    product["test_runs"][0]["plan"].pop("success_cpa")
    product["test_results"] = [result for result in product["test_results"] if result["id"] in {"draft", "zero"}]
    snapshot = intelligence_snapshot(project, {}, NOW)
    assert snapshot["calibration"] == []
    assert snapshot["review_prompts"] == []
    outcomes = confirmed_run_outcomes(product)
    assert outcomes[0]["confirmed_records"] == 0
    assert outcomes[0]["comparison"] == "unknown"
    assert outcomes[1]["actual_cpa"] is None
