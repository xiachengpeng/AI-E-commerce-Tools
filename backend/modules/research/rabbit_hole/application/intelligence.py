"""Read-only research intelligence derived from saved project facts."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from math import isfinite
from typing import Any

from rabbit_hole.domain.project import active_test_results
from rabbit_hole.input_urls import product_identity_url


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if isfinite(number) and number >= 0 else None


def confirmed_run_outcomes(product: dict[str, Any]) -> list[dict[str, Any]]:
    """Describe confirmed facts from each saved test run."""
    decisions = {
        decision["id"]: decision
        for decision in [product.get("decision"), *(product.get("decision_history") or [])]
        if isinstance(decision, dict) and isinstance(decision.get("id"), str)
    }
    scores = {
        score["id"]: score
        for score in product.get("scores") or []
        if isinstance(score, dict) and isinstance(score.get("id"), str)
    }
    outcomes = []
    for run in product.get("test_runs") or []:
        if not isinstance(run, dict) or not isinstance(run.get("id"), str):
            continue
        plan = run.get("plan")
        if not isinstance(plan, dict):
            plan = {}
        decision = decisions.get(run.get("decision_id"), {})
        score = scores.get(decision.get("score_id"), {})
        confirmed = [
            result for result in active_test_results(product, run["id"])
            if result.get("state") == "confirmed"
            and result.get("confirmed") is True
            and _number(result.get("spend")) is not None
            and _number(result.get("orders")) is not None
        ]
        spend = round(sum(_number(result["spend"]) or 0 for result in confirmed), 4)
        orders = round(sum(_number(result["orders"]) or 0 for result in confirmed), 4)
        actual_cpa = round(spend / orders, 4) if orders > 0 else None
        target = _number(plan.get("success_cpa"))
        target = target if target and target > 0 else None
        score_total = _number(score.get("total"))
        comparison = "unknown"
        if actual_cpa is not None and target is not None and score_total is not None:
            comparison = "above_target" if actual_cpa > target else "at_or_below_target"
        outcomes.append({
            "product_id": product.get("id"),
            "product_name": product.get("name"),
            "run_id": run["id"],
            "status": run.get("status"),
            "plan_created_at": plan.get("created_at") or run.get("created_at"),
            "confirmed_records": len(confirmed),
            "spend": spend if confirmed else None,
            "orders": orders if confirmed else None,
            "actual_cpa": actual_cpa,
            "target_cpa": target,
            "score_id": score.get("id"),
            "score_total": score_total,
            "score_rule_version": score.get("rule_version"),
            "score_dimensions": score.get("dimensions") if isinstance(score.get("dimensions"), list) else [],
            "comparison": comparison,
        })
    return outcomes


def _ratio(numerator: int, denominator: int, start: str, end: str) -> dict[str, Any]:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "sample_size": denominator,
        "percent": round(numerator / denominator * 100, 2) if denominator else None,
        "window_start": start,
        "window_end": end,
    }


def _current_test_pool(product: dict[str, Any]) -> bool:
    decision = product.get("decision") or {}
    if not isinstance(decision, dict):
        return False
    decision_steps = [
        step for step in product.get("steps", [])
        if isinstance(step, dict) and step.get("key") == "decision"
    ]
    return bool(
        (product.get("triage") or {}).get("state") not in {"observing", "rejected"}
        and decision.get("pool") == "test"
        and not decision.get("stale")
        and decision.get("score_revision") == product.get("revision")
        and all(step.get("state") == "passed" for step in decision_steps)
    )


def _meta_source(
    product: dict[str, Any], keywords: Mapping[str, dict[str, Any]]
) -> bool:
    """Only a currently bound, exact Meta ad establishes this discovery source."""
    identity = product.get("identity_key") or product.get("url")
    if not isinstance(identity, str):
        return False
    try:
        identity = product_identity_url(identity)
    except (TypeError, ValueError):
        return False
    valid_sources = set(product.get("source_keyword_ids") or [])
    for source in product.get("candidate_sources") or []:
        if not isinstance(source, dict) or source.get("keyword_id") not in valid_sources:
            continue
        word = keywords.get(source["keyword_id"])
        if not word:
            continue
        for ad in word.get("ads") or []:
            if not isinstance(ad, dict) or ad.get("id") != source.get("ad_id"):
                continue
            landing_url = ad.get("landing_url")
            if not isinstance(landing_url, str):
                continue
            try:
                if product_identity_url(landing_url) == identity:
                    return True
            except (TypeError, ValueError):
                continue
    return False


def intelligence_snapshot(
    project: dict[str, Any],
    scan_stats: Mapping[str, dict[str, int]] | None,
    now: datetime,
) -> dict[str, Any]:
    """Summarize facts without assigning causal credit or changing project state."""
    start = str(project.get("created_at") or "")
    end = now.isoformat()
    keywords = [word for word in project.get("keywords", []) if isinstance(word, dict)]
    keyword_map = {word["id"]: word for word in keywords if isinstance(word.get("id"), str)}
    products = [
        product for product in project.get("products", [])
        if isinstance(product, dict) and not product.get("merged_into")
    ]
    source_ids = {
        product["id"]: list(dict.fromkeys(
            source for source in product.get("source_keyword_ids") or []
            if isinstance(source, str) and source in keyword_map
        ))
        for product in products if isinstance(product.get("id"), str)
    }
    keyword_rows: list[dict[str, Any]] = []
    for word in keywords:
        word_id = word.get("id")
        if not isinstance(word_id, str):
            continue
        linked = [product for product in products if word_id in source_ids.get(product.get("id"), [])]
        retained = sum((product.get("triage") or {}).get("state") == "retained" for product in linked)
        test_pool = sum(_current_test_pool(product) for product in linked)
        stats = scan_stats.get(word_id) if scan_stats is not None else None
        unknown_scan = stats is None and (scan_stats is None or word.get("status") in {"complete", "blocked"})
        keyword_rows.append({
            "id": word_id,
            "text": word.get("text", ""),
            "type": word.get("type", ""),
            "status": word.get("status", ""),
            "ads_found": len({ad.get("id") for ad in word.get("ads") or [] if isinstance(ad, dict) and ad.get("id")}),
            "scan_attempts": None if unknown_scan else (stats or {}).get("attempts", 0),
            "scan_completed": None if unknown_scan else (stats or {}).get("completed", 0),
            "scan_note": "旧记录不可还原" if unknown_scan else "",
            "associated_products": len(linked),
            "primary_products": sum(source_ids.get(product.get("id"), [None])[0] == word_id for product in linked),
            "assisting_products": sum(word_id in source_ids.get(product.get("id"), [])[1:] for product in linked),
            "retained_products": retained,
            "test_pool_products": test_pool,
            "retained_rate": _ratio(retained, len(linked), start, end),
            "test_pool_rate": _ratio(test_pool, len(linked), start, end),
        })
    type_rows = []
    for kind in dict.fromkeys(str(word.get("type", "")) for word in keywords):
        typed = {word["id"] for word in keywords if word.get("type") == kind and word.get("id") in keyword_map}
        linked = [product for product in products if typed.intersection(source_ids.get(product.get("id"), []))]
        retained = sum((product.get("triage") or {}).get("state") == "retained" for product in linked)
        test_pool = sum(_current_test_pool(product) for product in linked)
        type_rows.append({
            "type": kind,
            "keywords": len(typed),
            "associated_products": len(linked),
            "retained_products": retained,
            "test_pool_products": test_pool,
            "retained_rate": _ratio(retained, len(linked), start, end),
            "test_pool_rate": _ratio(test_pool, len(linked), start, end),
        })
    meta = [product for product in products if _meta_source(product, keyword_map)]
    unattributed = [product for product in products if product not in meta]
    discovery_sources = []
    for source, linked in (("meta", meta), ("unattributed", unattributed)):
        retained = sum((product.get("triage") or {}).get("state") == "retained" for product in linked)
        discovery_sources.append({
            "source": source,
            "status": "observed" if linked else "no_records",
            "candidate_products": len(linked),
            "retained_products": retained,
            "retained_rate": _ratio(retained, len(linked), start, end),
        })
    for source in ("amazon", "tiktok", "pinterest", "similarweb"):
        discovery_sources.append({
            "source": source,
            "status": "not_observed",
            "candidate_products": None,
            "retained_products": None,
            "retained_rate": _ratio(0, 0, start, end),
        })
    calibration = [
        outcome
        for product in products
        for outcome in confirmed_run_outcomes(product)
        if outcome["comparison"] != "unknown"
    ]
    review_prompts = [
        {
            "product_id": outcome["product_id"],
            "run_id": outcome["run_id"],
            "message": "该轮实际 CPA 高于人工设定目标；建议人工复核原评分、目标及测试证据，不自动调整规则。",
        }
        for outcome in calibration
        if outcome["comparison"] == "above_target"
    ]
    confirmed_concept_groups = sum(
        concept.get("status") == "active"
        and sum(product.get("concept_id") == concept.get("id") for product in products) >= 2
        for concept in project.get("product_concepts", [])
    )
    return {
        "window": {"start": start, "end": end},
        "keywords": keyword_rows,
        "keyword_types": type_rows,
        "discovery_sources": discovery_sources,
        "unique_active_products": len(products),
        "confirmed_concept_groups": confirmed_concept_groups,
        "association_note": "同一卖家档案可关联多个关键词和类型，跨行数量不可相加；同款分组内仍有多个卖家档案，不能当作独立实物商品数。",
        "calibration": calibration,
        "review_prompts": review_prompts,
    }
