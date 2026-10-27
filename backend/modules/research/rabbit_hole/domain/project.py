"""Pure rules for the persistent, evidence-backed business workbench."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from html import unescape
from ipaddress import ip_address
from math import isfinite
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from rabbit_hole.domain.ad_evidence import (
    GateResult,
    creative_evidence_id,
    merge_ad_observation,
    normalize_ad_observation,
)
from rabbit_hole.domain.estimates import TRAFFIC_SCOPES, scenario_rows
from rabbit_hole.domain.freshness import evidence_freshness
from rabbit_hole.domain.logistics import logistics_weights
from rabbit_hole.domain.markets import MARKETS
from rabbit_hole.domain.provenance import (
    resolve_source_passage,
    source_passages,
)
from rabbit_hole.domain.requirements import (
    REQUIREMENTS_VERSION,
    blocking_requirement_keys,
    requirement_catalog,
    requirement_statuses,
    requirement_summary,
)
from rabbit_hole.domain.rules import (
    DEFAULT_RULES,
    RuleConfigError,
    effective_evidence_requirement_levels,
    effective_rules,
    effective_rules_version,
    validate_evidence_requirement_patch,
    validate_rule_patch,
)
from rabbit_hole.domain.scoring import (
    SCORING_VERSION,
    dimension_rows,
    evidence_ids_for,
    final_gate_row,
)
from rabbit_hole.domain.supporting_research import evergreen_signal
from rabbit_hole.input_urls import canonical_research_url, product_identity_url
from rabbit_hole.keyword_phrases import CanonicalPhrase, canonical_phrase
from rabbit_hole.trends import (
    PersistedTrendClassification,
    TrendSeries,
    classify_trend_window,
)

KEYWORD_TYPES = {
    "category", "function", "audience", "pain", "scenario", "brand",
    "pain_scenario", "scenario_audience",
}
CHANNELS = {"meta", "trends", "pinterest", "tiktok", "amazon", "similarweb"}
TREND_CONCLUSIONS = {
    "rising",
    "stable-high",
    "seasonal",
    "declining",
    "peaked",
    "insufficient-data",
}
RISKS = {"low", "medium", "high"}
TRIAGE_STATES = {"pending", "retained", "observing", "rejected"}
MAX_TEXT, MAX_KEYWORDS, MAX_PRODUCTS, MAX_EVIDENCE, MAX_POINTS = (
    10_000,
    200,
    200,
    500,
    3_000,
)


class WorkbenchError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def _utc(value: datetime | None = None) -> datetime:
    value = value or datetime.now(UTC)
    if value.tzinfo is None or value.utcoffset() is None:
        raise WorkbenchError("invalid_datetime", "datetime must include a timezone")
    return value.astimezone(UTC)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _dt(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise WorkbenchError(
            "invalid_datetime", f"{field} must be an ISO datetime with timezone"
        )
    try:
        parsed = datetime.fromisoformat(value.strip())
    except (TypeError, ValueError) as exc:
        raise WorkbenchError(
            "invalid_datetime", f"{field} must be an ISO datetime with timezone"
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise WorkbenchError("invalid_datetime", f"{field} must include a timezone")
    return parsed.astimezone(UTC)


def _day(value: Any, field: str) -> date:
    if not isinstance(value, str):
        raise WorkbenchError("invalid_date", f"{field} must be an ISO date")
    try:
        return date.fromisoformat(value[:10])
    except ValueError as exc:
        raise WorkbenchError("invalid_date", f"{field} must be an ISO date") from exc


_SCRIPT = re.compile(r"(?is)<\s*(script|style)\b[^>]*>.*?<\s*/\s*\1\s*>")
_TAG = re.compile(r"(?s)<[^>]*>")
_SECRET = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+"
)


def _text(
    value: Any, field: str, *, required: bool = False, limit: int = MAX_TEXT
) -> str:
    if value is None:
        result = ""
    elif isinstance(value, (str, int, float, Decimal)):
        result = str(value)
    else:
        raise WorkbenchError("invalid_text", f"{field} must be text")
    result = unescape(_TAG.sub("", _SCRIPT.sub("", result))).strip()
    result = _SECRET.sub("[redacted]", result)
    if len(result) > limit:
        raise WorkbenchError("text_too_long", f"{field} exceeds {limit} characters")
    if required and not result:
        raise WorkbenchError("missing_field", f"{field} is required")
    return result


def _keyword_phrase(value: Any, field: str = "text") -> CanonicalPhrase:
    try:
        return canonical_phrase(value, limit=500)
    except ValueError as exc:
        raise WorkbenchError(
            "invalid_keyword", f"{field} must be a non-empty phrase"
        ) from exc


def _bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise WorkbenchError("invalid_boolean", f"{field} must be true or false")
    return value


def _num(
    value: Any, field: str, *, minimum: float = 0, positive: bool = False
) -> float:
    if isinstance(value, bool):
        raise WorkbenchError("invalid_number", f"{field} must be numeric")
    try:
        result = float(Decimal(str(value)))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise WorkbenchError("invalid_number", f"{field} must be numeric") from exc
    if not isfinite(result):
        raise WorkbenchError("invalid_number", f"{field} must be finite")
    if result < minimum or (positive and result <= minimum):
        raise WorkbenchError(
            "invalid_number",
            f"{field} must be positive"
            if positive
            else f"{field} must be at least {minimum:g}",
        )
    return result


def _int(value: Any, field: str, *, minimum: int = 0) -> int:
    result = _num(value, field, minimum=minimum)
    if not result.is_integer():
        raise WorkbenchError("invalid_number", f"{field} must be an integer")
    return int(result)


def _url(value: Any, field: str = "url", *, required: bool = True) -> str:
    result = _text(value, field, required=required, limit=2_000)
    if not result and not required:
        return ""
    try:
        parsed, port = urlsplit(result), urlsplit(result).port
    except ValueError as exc:
        raise WorkbenchError(
            "invalid_url", f"{field} must be a public http(s) URL"
        ) from exc
    host = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not host
        or parsed.username
        or parsed.password
    ):
        raise WorkbenchError(
            "invalid_url", f"{field} must be a public http(s) URL without credentials"
        )
    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise WorkbenchError(
            "invalid_url", f"{field} must not reference a local address"
        )
    try:
        address = ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise WorkbenchError(
            "invalid_url", f"{field} must not reference a private address"
        )
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    normalized = urlunsplit(
        (
            parsed.scheme.lower(),
            host if port is None else f"{host}:{port}",
            path,
            parsed.query,
            "",
        )
    )
    try:
        return canonical_research_url(normalized)
    except ValueError as exc:
        raise WorkbenchError(
            "invalid_url", f"{field} must be a public http(s) URL"
        ) from exc


def _product_identity(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return product_identity_url(value)
    except ValueError:
        return None


def _id() -> str:
    return str(uuid4())


def _find(items: list[dict[str, Any]], item_id: Any, kind: str) -> dict[str, Any]:
    found = next((item for item in items if item["id"] == item_id), None)
    if found is None:
        raise WorkbenchError("not_found", f"{kind} not found", 404)
    return found


STEP_LABELS = {
    "identification": "识别具体商品",
    "coarse": "广告粗筛",
    "expansion": "沿线索扩词",
    "channels": "多渠道验证",
    "funnel": "广告与落地页分析",
    "economics": "成本与风险核算",
    "score": "评分",
    "decision": "人工决策",
    "test": "测试准备与真实结果",
    "review": "复盘",
}


def _new_product(
    name: str, url: str, source_ids: list[str], now: datetime
) -> dict[str, Any]:
    return {
        "id": _id(),
        "name": name,
        "url": url,
        "identity_key": _product_identity(url),
        "identity_revision": 1,
        "identity_history": [],
        "concept_id": None,
        "source_keyword_ids": list(dict.fromkeys(source_ids)),
        "revision": 0,
        "evidence": [],
        "gates": {},
        "identification": {},
        "funnel": {},
        "creative_references": [],
        "funnel_investigations": [],
        "economics": {},
        "estimates": [],
        "scores": [],
        "decision": None,
        "test_plan": None,
        "test_runs": [],
        "test_results": [],
        "reviews": [],
        "candidate_sources": [],
        "triage": _default_triage(),
        "steps": [
            {
                "key": key,
                "label": label,
                "state": "pending",
                "reason": "Not started",
                "next_action": "Provide required evidence.",
            }
            for key, label in STEP_LABELS.items()
        ],
        "todos": [],
        "created_at": _iso(now),
        "updated_at": _iso(now),
    }


def new_project(
    title: str,
    direction: str,
    market: str = "US",
    *,
    now: datetime | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    current = _utc(now)
    market = _text(market, "market", required=True, limit=10).upper()
    if market not in MARKETS:
        raise WorkbenchError("unsupported_market", "Unsupported research market")
    return {
        "id": project_id or _id(),
        "title": _text(title, "title", required=True, limit=200),
        "direction": _text(direction, "direction", required=True, limit=1_000),
        "market": market,
        "version": 0,
        "created_at": _iso(current),
        "updated_at": _iso(current),
        "keywords": [],
        "products": [],
        "product_concepts": [],
        "events": [],
        "limits": {
            "scan_batch_limit": 20,
            "daily_scan_budget": 20,
            "scan_limit": 20,
            "max_depth": 3,
        },
        "rules": deepcopy(DEFAULT_RULES),
        "rules_version": 1,
        "rule_history": [],
        "logistics_profile": None,
        "logistics_profile_history": [],
        "summary": {},
        "todos": [],
        "focus_product_id": None,
    }


def current_test_run(product: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (
            run
            for run in reversed(product.get("test_runs", []))
            if run.get("status") == "active"
        ),
        None,
    )


def active_test_results(
    product: dict[str, Any], test_run_id: str | None = None
) -> list[dict[str, Any]]:
    if test_run_id is None:
        run = current_test_run(product)
        test_run_id = run.get("id") if run else None
    if not test_run_id:
        return []
    candidates = [
        result
        for result in product.get("test_results", [])
        if result.get("test_run_id") == test_run_id
    ]
    superseded_ids = {
        result.get("supersedes_id")
        for result in candidates
        if result.get("supersedes_id")
    }
    return [
        result
        for result in candidates
        if result.get("id") not in superseded_ids and result.get("state") != "void"
    ]


def _close_current_test_run(
    product: dict[str, Any], status: str, now: datetime
) -> None:
    run = current_test_run(product)
    if run:
        run.update(status=status, closed_at=_iso(now))


def _invalidate(product: dict[str, Any], now: datetime) -> None:
    product["revision"] += 1
    product["updated_at"] = _iso(now)
    if product.get("decision"):
        product["decision"]["stale"] = True
    if product.get("test_plan"):
        product["test_plan"]["stale"], product["test_plan"]["approved"] = True, False
    _close_current_test_run(product, "stale", now)


def _identity_revision(product: dict[str, Any]) -> int:
    value = product.get("identity_revision", 1)
    return value if isinstance(value, int) and value >= 1 else 1


def _current_identity_record(product: dict[str, Any], record: dict[str, Any]) -> bool:
    record_revision = record.get("identity_revision", 1)
    return isinstance(record_revision, int) and record_revision == _identity_revision(
        product
    )


def _latest(
    product: dict[str, Any], channel: str, window: str | None = None
) -> dict[str, Any] | None:
    matches = [
        item
        for item in product["evidence"]
        if item["channel"] == channel
        and (window is None or item.get("window") == window)
        and _current_identity_record(product, item)
    ]
    return matches[-1] if matches else None


def _missing(
    state: dict[str, Any], product: dict[str, Any], now: datetime
) -> list[str]:
    return blocking_requirement_keys(requirement_statuses(state, product, now))


def _set_step(
    product: dict[str, Any], key: str, state: str, reason: str, next_action: str
) -> None:
    next(item for item in product["steps"] if item["key"] == key).update(
        state=state, reason=reason, next_action=next_action
    )


def _refresh_identification(
    product: dict[str, Any],
    rules: dict[str, int | float],
    *,
    rule_version: int,
    evaluated_at: datetime,
) -> None:
    identity = product.get("identification", {})
    if not identity:
        return
    identity.setdefault("product_confirmed", bool(identity.get("relevance_confirmed")))
    observation = normalize_ad_observation(identity)
    identity.update(observation)
    identity["active_days"] = observation["ad_age_days"] or 0
    identity.setdefault("creatives", [])
    identity.setdefault("distinct_active_creatives", 0)
    passed = bool(
        identity.get("relevance_confirmed")
        and (identity.get("ad_age_days") or 0) >= rules["min_active_days"]
        and identity.get("currently_active") is True
        and identity.get("distinct_active_creatives", 0) >= rules["min_creatives"]
    )
    identity["passed"] = passed
    identity["reason_summary"] = (
        "粗筛证据已满足要求。"
        if passed
        else (
            "需同时确认相关性、首次投放距今至少"
            f"{rules['min_active_days']:g}天、当前仍在投放、至少"
            f"{rules['min_creatives']:g}个独立活跃创意。"
        )
    )
    evidence_ids = tuple(
        str(item["evidence_id"])
        for item in identity["creatives"]
        if item.get("distinct") and item.get("active") and item.get("evidence_id")
    )
    status: Literal["pass", "fail", "unknown", "not_applicable"]
    if not identity.get("relevance_confirmed"):
        status = "unknown"
        reason = "尚未确认广告与当前具体商品的相关性。"
    elif not identity.get("creatives_confirmed_at"):
        status = "unknown"
        reason = "尚未人工确认广告年龄与独立活跃素材证据。"
    elif passed:
        status = "pass"
        reason = (
            f"广告年龄至少 {rules['min_active_days']:g} 天，且已有至少 "
            f"{rules['min_creatives']:g} 个经人工确认的独立活跃素材；"
            "广告连续投放状态仍按独立证据字段记录，不由广告年龄推断。"
        )
    else:
        status = "fail"
        reason = (
            f"已确认证据未同时达到广告年龄 {rules['min_active_days']:g} 天、"
            f"当前仍在投放和 {rules['min_creatives']:g} 个独立活跃素材的粗筛要求。"
        )
    gates = product.setdefault("gates", {})
    prior_gate = gates.get("coarse_screen")
    evaluation_time = evaluated_at
    if not isinstance(prior_gate, dict):
        evidence_changed_at = (
            identity.get("creatives_confirmed_at")
            or identity.get("confirmed_at")
            or product.get("updated_at")
        )
        if evidence_changed_at:
            evaluation_time = _dt(evidence_changed_at, "gate.evaluated_at")
    candidate_gate = GateResult(
        key="coarse_screen",
        kind="stage_gate",
        status=status,
        reason=reason,
        rule_version=rule_version,
        evidence_ids=evidence_ids,
        evaluated_at=_iso(evaluation_time),
    ).public_view()
    stable_fields = (
        "key",
        "kind",
        "status",
        "reason",
        "rule_version",
        "evidence_ids",
    )
    if isinstance(prior_gate, dict) and all(
        prior_gate.get(key) == candidate_gate.get(key) for key in stable_fields
    ):
        candidate_gate["evaluated_at"] = prior_gate.get(
            "evaluated_at", candidate_gate["evaluated_at"]
        )
    gates["coarse_screen"] = candidate_gate


def _refresh_product(
    state: dict[str, Any],
    product: dict[str, Any],
    now: datetime,
    rules: dict[str, int | float],
    rule_version: int,
) -> None:
    from rabbit_hole.domain.verification import verification_current

    if (product.get("identification", {}).get("confirmation_method") == "ai"
        and not verification_current(state, product)):
        product["identification"].update(product_confirmed=False, relevance_confirmed=False)
    _refresh_identification(
        product, rules, rule_version=rule_version, evaluated_at=now
    )
    identity = product.get("identification", {})
    if identity.get("relevance_confirmed"):
        _set_step(
            product,
            "identification",
            "passed",
            "AI 已对照来源匹配商品与关键词；尚未经人工确认，粗筛需另行核对。"
            if identity.get("confirmation_method") == "ai"
            else "已人工核对具体商品与广告相关性。",
            "检查广告粗筛条件。",
        )
        _set_step(
            product,
            "coarse",
            "passed" if identity.get("passed") else "needs_input",
            f"首次投放距今至少{rules['min_active_days']:g}天、当前仍在投放，且至少"
            f"{rules['min_creatives']:g}个经核验的独立活跃创意。"
            if identity.get("passed")
            else "尚未同时满足广告年龄、当前投放状态与独立创意要求。",
            "继续收集渠道证据。"
            if identity.get("passed")
            else "补充广告年龄、当前投放状态及独立素材证据。",
        )
    elif identity:
        _set_step(
            product,
            "identification",
            "needs_input",
            identity["reason_summary"],
            "补充商品与广告的相关性依据。",
        )
        _set_step(
            product,
            "coarse",
            "needs_input",
            "尚未同时满足粗筛条件。",
            "补充活跃天数和独立创意证据。",
        )
    else:
        _set_step(
            product,
            "identification",
            "needs_input",
            "尚未确认广告对应哪个具体商品。",
            "核对商品链接并确认相关性。",
        )
        _set_step(
            product,
            "coarse",
            "blocked",
            "需要先识别具体商品。",
            "完成商品识别后检查粗筛。",
        )
    _set_step(
        product,
        "expansion",
        "pending",
        "尚未完成有来源的扩词审核。",
        "从产品原文提出新词并审核。",
    )
    missing = _missing(state, product, now)
    channel_missing = [
        value
        for value in missing
        if value
        in {
            "meta",
            "meta_competition",
            "trends_12m",
            "trends_5y",
            "trends_query_mismatch",
            "pinterest",
            "tiktok",
            "amazon",
            "similarweb",
        }
    ]
    _set_step(
        product,
        "channels",
        "passed" if not channel_missing else "needs_input",
        "各渠道已确认或注明豁免；豁免仍代表有限证据。"
        if not channel_missing
        else f"待补充：{', '.join(channel_missing)}",
        "补充缺失渠道，核对趋势词与直接流量占比。",
    )
    _set_step(
        product,
        "funnel",
        "needs_input" if "funnel" in missing else "passed",
        "缺少经确认的广告与页面要素。"
        if "funnel" in missing
        else "已记录并确认广告与页面要素。",
        "核对钩子、形式、场景、角度和行动号召。",
    )
    econ_missing = any(
        value in missing
        for value in (
            "economics",
            "confirmed_supplier_quote",
            "fresh_supplier_quote",
            "bundle_reason",
            "certification_verification",
        )
    )
    _set_step(
        product,
        "economics",
        "needs_input" if econ_missing else "passed",
        f"缺少完整成本或{rules['quote_valid_days']:g}天内有效报价。"
        if econ_missing
        else "已记录当前订单收入、成本和风险。",
        "补齐费用、报价依据和认证信息。" if econ_missing else "计算当前版本评分。",
    )
    score = product["scores"][-1] if product["scores"] else None
    if (
        score
        and score["revision"] == product["revision"]
        and not (missing and score["status"] == "complete")
    ):
        _set_step(
            product,
            "score",
            {"complete": "passed", "incomplete": "needs_input", "rejected": "failed"}[
                score["status"]
            ],
            score["recommendation"],
            "补齐缺项，或记录人工决定。",
        )
    else:
        _set_step(
            product,
            "score",
            "needs_input",
            "尚无有效评分，或证据已变化、过期。",
            "补充证据后重新评分。",
        )
    decision = product.get("decision")
    current_decision = bool(
        decision
        and not decision.get("stale")
        and not (decision["pool"] in {"test", "backup"} and missing)
    )
    _set_step(
        product,
        "decision",
        "passed" if current_decision else "needs_input",
        "已保存当前人工决定。" if current_decision else "需要作出或更新人工决定。",
        ("进行研究复盘，证据变化后再评估。" if decision["pool"] != "test"
         else "制定测试计划，核对预算与停止线。")
        if current_decision else "选择测试、备选、观察或淘汰并说明理由。",
    )
    run = current_test_run(product)
    plan = run.get("plan") if run else None
    if current_decision and decision and decision["pool"] != "test":
        _set_step(
            product,
            "test",
            "not_applicable",
            "当前未进入测试池，无需虚构测试结果。",
            "进行研究复盘，证据变化后再评估。",
        )
    elif current_decision and plan and plan.get("approved") and not plan.get("stale"):
        confirmed_results = any(
            result.get("confirmed") for result in active_test_results(product)
        )
        _set_step(
            product,
            "test",
            "passed" if confirmed_results else "needs_input",
            "已保存经确认的真实测试结果。"
            if confirmed_results
            else "计划已批准，尚缺经确认的真实测试结果。",
            "提交带来源的实际测试指标。",
        )
    else:
        _set_step(
            product,
            "test",
            "needs_input",
            "等待有效测试池决定和测试计划审批。",
            "确认预算、周期、成功线和停止线。",
        )
    _set_step(
        product,
        "review",
        "passed" if product["reviews"] else "pending",
        "已保存复盘记录。" if product["reviews"] else "尚未记录复盘。",
        "本轮复盘已保存；审核下一轮关键词，或补充证据后重新评估。"
        if product["reviews"] else "填写结论、经验及下一轮词池。",
    )


def _refresh(state: dict[str, Any], now: datetime) -> None:
    rules = effective_rules(state)
    rule_version = effective_rules_version(state)
    todos = []
    active_products = [
        product for product in state["products"] if not product.get("merged_into")
    ]
    for product in active_products:
        triage_state = _triage_state(product)
        _refresh_product(state, product, now, rules, rule_version)
        expanded = [
            w
            for w in state["keywords"]
            if w.get("product_id") == product["id"] and w.get("parent_id")
        ]
        if expanded:
            reviewed = all(w["approved"] for w in expanded)
            _set_step(
                product,
                "expansion",
                "passed" if reviewed else "needs_input",
                f"已生成 {len(expanded)} 个带来源的新词。",
                "继续搜索已审核词。" if reviewed else "审核新词后再搜索。",
            )
        # Keep the inbox focused on the next useful human action, while all
        # later forms remain accessible in the product record.
        stages = {step["key"]: step["state"] for step in product["steps"]}
        if stages["identification"] != "passed":
            actionable = {"identification"}
        elif stages["coarse"] != "passed":
            actionable = {"coarse"}
        else:
            actionable = {
                key
                for key in ("channels", "funnel", "economics")
                if stages[key] != "passed"
            }
            if not actionable:
                actionable = {
                    next(
                        (
                            key
                            for key in ("score", "decision", "test", "review")
                            if stages[key] not in {"passed", "not_applicable"}
                        ),
                        "review",
                    )
                }
        if (
            product.get("decision")
            and not product["decision"].get("stale")
            and product["decision"]["pool"] in {"observe", "reject"}
        ):
            actionable = {"review"} if not product["reviews"] else set()
        product["todos"] = [
            {
                "product_id": product["id"],
                "step": step["key"],
                "label": step["label"],
                "reason": step["reason"],
            }
            for step in product["steps"]
            if step["key"] in actionable
            and step["state"] in {"needs_input", "blocked", "pending"}
            and triage_state not in {"observing", "rejected"}
        ]
        todos.extend(product["todos"])
    state["todos"] = todos
    _refresh_guidance(state, active_products)
    state["summary"] = {
        "projects": 1,
        "keywords": len(state["keywords"]),
        "products": len(active_products),
        "qualified": sum(
            bool(item.get("identification", {}).get("passed"))
            for item in active_products
        ),
        "todos": len(todos),
        "pending_triage": len(state["queues"]["triage"]),
        "retained": len(state["queues"]["retained"]),
        "observing": len(state["queues"]["observing"]),
        "rejected": len(state["queues"]["rejected"]),
    }


def _triage_state(product: dict[str, Any]) -> str:
    triage = product.get("triage")
    state = triage.get("state") if isinstance(triage, dict) else None
    return state if state in TRIAGE_STATES else "pending"


def _default_triage() -> dict[str, Any]:
    return {
        "state": "pending",
        "reason": "",
        "decided_at": None,
        "operator": None,
        "history": [],
    }


def _exact_source_ads(
    state: dict[str, Any], product: dict[str, Any]
) -> list[dict[str, Any]]:
    keywords = {item.get("id"): item for item in state.get("keywords", [])}
    ads: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for source in product.get("candidate_sources", [])[:200]:
        if not isinstance(source, dict):
            continue
        keyword_id, ad_id = source.get("keyword_id"), source.get("ad_id")
        if not isinstance(keyword_id, str) or not isinstance(ad_id, str):
            continue
        key = (keyword_id, ad_id)
        if key in seen:
            continue
        keyword = keywords.get(keyword_id)
        ad = next(
            (
                item
                for item in (keyword or {}).get("ads", [])
                if isinstance(item, dict) and item.get("id") == ad_id
            ),
            None,
        )
        if ad is not None:
            ads.append(ad)
            seen.add(key)
    return ads


def _queue_row(
    state: dict[str, Any], product: dict[str, Any], *, action_label: str
) -> dict[str, Any]:
    todo = (product.get("todos") or [None])[0]
    step = todo.get("step") if isinstance(todo, dict) else "review"
    reason = (
        todo.get("reason")
        if isinstance(todo, dict)
        else str((product.get("triage") or {}).get("reason") or "等待后续处理。")
    )
    source_ids = product.get("source_keyword_ids") or []
    source = next(
        (item for item in state["keywords"] if item.get("id") in source_ids), None
    )
    exact_ads = _exact_source_ads(state, product)
    active_since = sorted(
        str(item.get("start_date"))
        for item in exact_ads
        if item.get("start_date")
    )
    return {
        "product_id": product["id"],
        "name": product["name"],
        "source_keyword": source.get("text", "") if source else "",
        "step": step,
        "reason": reason,
        "action_label": action_label,
        "source_ad_count": len(exact_ads),
        "source_advertiser": str(exact_ads[0].get("advertiser") or "")
        if exact_ads
        else "",
        "source_active_since": active_since[0] if active_since else "",
        "landing_observed": bool(product.get("landing_snapshot")),
    }


def _refresh_guidance(
    state: dict[str, Any], active_products: list[dict[str, Any]]
) -> None:
    queues: dict[str, list[dict[str, Any]]] = {
        "triage": [],
        "retained": [],
        "blocked": [],
        "observing": [],
        "rejected": [],
        "decision": [],
    }
    ordered = sorted(
        active_products,
        key=lambda item: (str(item.get("created_at", "")), str(item.get("id", ""))),
    )
    by_id = {product["id"]: product for product in ordered}
    for product in ordered:
        triage_state = _triage_state(product)
        if triage_state == "pending":
            queues["triage"].append(
                _queue_row(state, product, action_label="筛选这条线索")
            )
        elif triage_state == "observing":
            queues["observing"].append(
                _queue_row(state, product, action_label="查看观察记录")
            )
        elif triage_state == "rejected":
            queues["rejected"].append(
                _queue_row(state, product, action_label="恢复线索")
            )
        else:
            row = _queue_row(state, product, action_label="继续深挖")
            if row["step"] in {"decision", "test", "review"}:
                queues["decision"].append(row)
            elif any(
                step.get("key") == row["step"] and step.get("state") == "blocked"
                for step in product.get("steps", [])
            ):
                queues["blocked"].append(row)
            else:
                queues["retained"].append(row)
    pending_products = sorted(
        (product for product in ordered if _triage_state(product) == "pending"),
        key=lambda product: (
            0 if _exact_source_ads(state, product) else 1,
            0 if product.get("landing_snapshot") else 1,
            str(product.get("created_at", "")),
            str(product.get("id", "")),
        ),
    )
    pending_rank = {
        product["id"]: index for index, product in enumerate(pending_products)
    }
    queues["triage"].sort(key=lambda row: pending_rank.get(row["product_id"], 10**9))
    state["queues"] = queues

    focus_id = state.get("focus_product_id")
    focus = by_id.get(focus_id) if isinstance(focus_id, str) else None
    if focus is None or _triage_state(focus) != "retained":
        state["focus_product_id"] = None
        focus = None
    retained = [product for product in ordered if _triage_state(product) == "retained"]
    pending = pending_products
    selected = focus or (retained[0] if retained else None)
    if selected is not None:
        todo = (selected.get("todos") or [None])[0]
        state["guidance"] = {
            "kind": "deep_dive",
            "title": f"继续深挖 {selected['name']}",
            "reason": (
                todo.get("reason")
                if isinstance(todo, dict)
                else "查看当前结论并继续下一步。"
            ),
            "project_id": state["id"],
            "product_id": selected["id"],
            "step": todo.get("step", "review") if isinstance(todo, dict) else "review",
        }
    elif pending:
        selected = pending[0]
        todo = (selected.get("todos") or [None])[0]
        state["guidance"] = {
            "kind": "triage",
            "title": "继续筛选下一条线索",
            "reason": f"还有 {len(pending)} 条广告线索尚未判断。",
            "project_id": state["id"],
            "product_id": selected["id"],
            "step": todo.get("step", "identification")
            if isinstance(todo, dict)
            else "identification",
        }
    else:
        state["guidance"] = {
            "kind": "complete",
            "title": "查看选品结论与复盘",
            "reason": "当前没有需要立即处理的线索。",
            "project_id": state["id"],
            "product_id": None,
            "step": None,
        }


def _decorate_identity_view(product: dict[str, Any]) -> None:
    if not product.get("identity_key"):
        product["identity_key"] = _product_identity(product.get("url"))
    product.setdefault("identity_revision", _identity_revision(product))
    product.setdefault("identity_history", [])
    product.setdefault("merge_history", [])
    product.setdefault("triage", _default_triage())
    product.setdefault("creative_references", [])
    product.setdefault("funnel_investigations", [])
    for key in ("creative_references", "funnel_investigations"):
        for record in product[key]:
            record["stale_identity"] = not _current_identity_record(product, record)
    if isinstance(product.get("identification"), dict):
        observation = normalize_ad_observation(product["identification"])
        product["identification"].update(observation)
        product["identification"]["active_days"] = (
            observation["ad_age_days"] or 0
        )
    for key in ("evidence", "automatic_trends"):
        for record in product.get(key, []):
            record["stale_identity"] = not _current_identity_record(product, record)
            if key == "automatic_trends":
                record["legacy_classifier"] = not bool(
                    (record.get("classification") or {}).get("classifier_version")
                    if isinstance(record.get("classification"), dict)
                    else False
                )
    for key in ("funnel", "economics", "landing_snapshot"):
        record = product.get(key)
        if isinstance(record, dict) and record:
            record["stale_identity"] = not _current_identity_record(product, record)
    for key in ("funnel_history", "quote_history", "landing_history"):
        for record in product.get(key, []):
            record["stale_identity"] = not _current_identity_record(product, record)
    product.setdefault("test_runs", [])
    run_ids = {run.get("id") for run in product["test_runs"]}
    superseded_ids = {
        result.get("supersedes_id")
        for result in product.get("test_results", [])
        if result.get("supersedes_id")
    }
    for result in product.get("test_results", []):
        result["legacy"] = (
            not result.get("test_run_id") or result.get("test_run_id") not in run_ids
        )
        result.setdefault("state", "confirmed" if result.get("confirmed") else "draft")
        result["superseded"] = result.get("id") in superseded_ids
        result["active"] = bool(
            not result["legacy"]
            and not result["superseded"]
            and result["state"] != "void"
        )


def project_view(
    state: dict[str, Any], *, now: datetime | None = None
) -> dict[str, Any]:
    current = _utc(now)
    view = deepcopy(state)
    view.setdefault("collection_modes", {"meta": "ui", "trends": "ui"})
    view.setdefault("collection_modes_version", 0)
    view.setdefault("logistics_profile", None)
    view.setdefault("logistics_profile_history", [])
    view["rules"] = effective_rules(state)
    view["rules_version"] = effective_rules_version(state)
    view["rule_history"] = deepcopy(state.get("rule_history", []))
    view["limits"] = {
        "scan_batch_limit": view["rules"]["scan_batch_limit"],
        "daily_scan_budget": view["rules"]["daily_scan_budget"],
        # Temporary compatibility alias for clients from before the budget split.
        "scan_limit": view["rules"]["scan_batch_limit"],
        "max_depth": view["rules"]["max_depth"],
    }
    for product in view["products"]:
        _decorate_identity_view(product)
        product["evergreen_signal"] = evergreen_signal(product)
        product.setdefault("estimates", [])
        for record in product.get("evidence", []):
            freshness = evidence_freshness(
                record.get("observed_at"),
                record.get("review_due_at"),
                record.get("valid_until"),
                current,
            )
            record["freshness_status"] = freshness["status"]
            record["freshness_reason"] = freshness["reason"]
            if record.get("channel") == "similarweb":
                record.setdefault("traffic_scope", "unknown")
        economics = product.get("economics")
        if isinstance(economics, dict) and economics:
            stale = bool(economics.get("stale_identity"))
            profile = view.get("logistics_profile")
            divisor = (
                profile.get("volumetric_divisor_cm3_per_kg")
                if isinstance(profile, dict) and profile.get("confirmed")
                else None
            )
            weights = logistics_weights(
                economics.get("actual_weight_kg", economics.get("weight_kg")),
                (
                    economics.get("package_length_cm"),
                    economics.get("package_width_cm"),
                    economics.get("package_height_cm"),
                ),
                divisor,
            )
            economics.update(weights)
            economics["logistics_stale"] = stale
            if stale:
                economics["volumetric_weight_kg"] = None
                economics["chargeable_weight_kg"] = None
            quote_date = economics.get("quote_date")
            try:
                quote_at = _dt(quote_date, "quote_date") if quote_date else None
            except WorkbenchError:
                quote_at = None
            quote_until = (
                _iso(quote_at + timedelta(days=view["rules"]["quote_valid_days"]))
                if quote_at is not None
                else None
            )
            economics["quote_freshness"] = evidence_freshness(
                quote_date if quote_at is not None else None,
                None,
                quote_until,
                current,
            )
        product["expansion_sources"] = [
            passage.public_view() for passage in source_passages(view, product["id"])
        ]
    view["merged_products"] = [
        product for product in view["products"] if product.get("merged_into")
    ]
    view["products"] = [
        product for product in view["products"] if not product.get("merged_into")
    ]
    view["product_concepts"] = deepcopy(state.get("product_concepts", []))
    for concept in view["product_concepts"]:
        concept["offer_ids"] = [
            item["id"]
            for item in view["products"]
            if item.get("concept_id") == concept["id"]
        ]
    for keyword in view["keywords"]:
        try:
            normalized = canonical_phrase(keyword.get("text"), limit=500)
        except (TypeError, ValueError):
            keyword["needs_normalization"] = True
            keyword["normalization_suggestion"] = None
        else:
            keyword["needs_normalization"] = keyword.get("text") != normalized.quoted
            keyword["normalization_suggestion"] = (
                normalized.quoted if keyword["needs_normalization"] else None
            )
        if not keyword.get("parent_id"):
            continue
        keyword["legacy_source"] = not bool(keyword.get("source_id"))
        passage = resolve_source_passage(
            view,
            str(keyword.get("product_id", "")),
            str(keyword.get("source_id", "")),
            str(keyword.get("source_kind", "")),
        )
        keyword["stale_source"] = bool(
            keyword.get("source_id")
            and (
                passage is None
                or passage.content_hash != keyword.get("source_content_hash")
                or keyword.get("source_quote") not in passage.text
            )
        )
    _refresh(view, current)
    for product in view["products"]:
        current_traffic = _latest(product, "similarweb") or {}
        current_aov = (product.get("economics") or {}).get("aov")
        evidence_by_id = {
            item.get("id"): item for item in product.get("evidence", [])
        }
        for estimate in product.get("estimates", []):
            bound_traffic = evidence_by_id.get(estimate.get("traffic_evidence_id"))
            estimate["stale"] = bool(
                estimate.get("identity_revision") != _identity_revision(product)
                or estimate.get("aov_snapshot") != current_aov
                or estimate.get("traffic_evidence_id") != current_traffic.get("id")
                or (
                    bound_traffic is not None
                    and bound_traffic.get("freshness_status") == "expired"
                )
            )
    view["evidence_requirements_version"] = REQUIREMENTS_VERSION
    view["evidence_requirement_catalog"] = [
        item.public_view() for item in requirement_catalog(view)
    ]
    project_requirement_summary = {
        "required_gaps": 0,
        "recommended_gaps": 0,
        "unknown": 0,
        "stale": 0,
        "not_applicable": 0,
    }
    for product in view["products"]:
        statuses = requirement_statuses(view, product, current)
        summary = requirement_summary(statuses)
        product["requirement_statuses"] = statuses
        product["requirement_summary"] = summary
        for key in project_requirement_summary:
            project_requirement_summary[key] += summary[key]
    view["requirement_summary"] = project_requirement_summary
    view["events"] = deepcopy(view.get("events", []))[-100:]
    return view


def apply_command(
    state: dict[str, Any],
    action: str,
    payload: dict[str, Any],
    actor: str = "local_user",
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WorkbenchError("invalid_payload", "payload must be an object")
    if action != "merge_products" and payload.get("product_id"):
        candidate = next(
            (
                item
                for item in state.get("products", [])
                if item.get("id") == payload.get("product_id")
            ),
            None,
        )
        if candidate and candidate.get("merged_into"):
            raise WorkbenchError(
                "product_merged",
                f"该档案已合并到 {candidate['merged_into']}，请在目标档案继续。",
                409,
            )
    handler: Callable[[dict[str, Any], dict[str, Any], str, datetime], None] | None
    if action == 'confirm_marketing_fact':
        from rabbit_hole.domain.marketing import confirm_marketing_fact
        handler = confirm_marketing_fact
    else:
        handler = _HANDLERS.get(action)
    if handler is None:
        raise WorkbenchError("unknown_action", f"Unknown command: {action}")
    current = _utc(now)
    handler(
        state, payload, "automation" if actor == "automation" else "local_user", current
    )
    state["updated_at"] = _iso(current)
    _refresh(state, current)
    return state


def _require_human_product_decision(actor: str) -> None:
    if actor != "local_user":
        raise WorkbenchError("human_confirmation_required", "商品关联、拆分和合并必须人工确认")


def _merge_products(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _require_human_product_decision(actor)
    target_id = _text(p.get("target_product_id"), "target_product_id", required=True)
    source_id = _text(p.get("source_product_id"), "source_product_id", required=True)
    reason = _text(p.get("reason"), "reason", required=True, limit=2_000)
    if target_id == source_id:
        raise WorkbenchError(
            "invalid_merge", "target and source must be different products"
        )
    target = _find(state["products"], target_id, "target product")
    source = _find(state["products"], source_id, "source product")
    if target.get("merged_into") or source.get("merged_into"):
        raise WorkbenchError("invalid_merge", "a merged product cannot be merged again")
    if target.get("concept_id") or source.get("concept_id"):
        raise WorkbenchError(
            "invalid_merge", "先将卖家商品移出同款分组，再合并重复档案"
        )
    target_identity = target.get("identity_key") or product_identity_url(target["url"])
    source_identity = source.get("identity_key") or product_identity_url(source["url"])
    if target_identity != source_identity:
        raise WorkbenchError("invalid_merge", "products must have the same identity")

    target["source_keyword_ids"] = list(
        dict.fromkeys(
            target.get("source_keyword_ids", []) + source.get("source_keyword_ids", [])
        )
    )
    candidates = target.setdefault("candidate_sources", [])
    seen_candidates = {
        (item.get("keyword_id"), item.get("ad_id")) for item in candidates
    }
    for item in source.get("candidate_sources", []):
        key = (item.get("keyword_id"), item.get("ad_id"))
        if key not in seen_candidates:
            candidates.append(deepcopy(item))
            seen_candidates.add(key)

    # Move only evidence tied to the current identity and preserve its origin.
    for collection in ("evidence", "automatic_trends"):
        destination = target.setdefault(collection, [])
        existing = {
            (
                item.get("channel") or item.get("query"),
                item.get("window"),
                item.get("observed_at"),
                item.get("source_url"),
            )
            for item in destination
        }
        for record in source.get(collection, []):
            if not _current_identity_record(source, record):
                continue
            evidence_key = (
                record.get("channel") or record.get("query"),
                record.get("window"),
                record.get("observed_at"),
                record.get("source_url"),
            )
            if evidence_key in existing:
                continue
            moved = deepcopy(record)
            moved["origin_product_id"] = source["id"]
            moved["origin_identity_revision"] = _identity_revision(source)
            moved["identity_revision"] = _identity_revision(target)
            destination.append(moved)
            existing.add(evidence_key)

    source_snapshot = source.get("landing_snapshot")
    if (
        isinstance(source_snapshot, dict)
        and source_snapshot
        and _current_identity_record(source, source_snapshot)
    ):
        moved_snapshot = deepcopy(source_snapshot)
        moved_snapshot["origin_product_id"] = source["id"]
        moved_snapshot["origin_identity_revision"] = _identity_revision(source)
        moved_snapshot["identity_revision"] = _identity_revision(target)
        if target.get("landing_snapshot"):
            target.setdefault("landing_history", []).append(moved_snapshot)
        else:
            target["landing_snapshot"] = moved_snapshot

    for keyword in state["keywords"]:
        if keyword.get("product_id") != source["id"]:
            continue
        keyword["origin_product_id"] = source["id"]
        keyword["product_id"] = target["id"]
        if (
            not keyword.get("source_id")
            or keyword.get("source_product_id") != source["id"]
        ):
            continue
        quote = keyword.get("source_quote")
        equivalent = next(
            (
                passage
                for passage in source_passages(state, target["id"])
                if passage.source_kind == keyword.get("source_kind")
                and passage.content_hash == keyword.get("source_content_hash")
                and passage.keyword_id == keyword.get("source_keyword_id")
                and passage.ad_id == keyword.get("source_ad_id")
                and isinstance(quote, str)
                and quote in passage.text
            ),
            None,
        )
        if equivalent is None:
            keyword["stale_source"] = True
            keyword["approved"] = False
            keyword["status"] = "pending_review"
            continue
        keyword.update(
            source_id=equivalent.source_id,
            source_kind=equivalent.source_kind,
            source_product_id=equivalent.product_id,
            source_identity_revision=equivalent.identity_revision,
            source_keyword_id=equivalent.keyword_id,
            source_ad_id=equivalent.ad_id,
            source_content_hash=equivalent.content_hash,
            stale_source=False,
        )

    source["merged_into"] = target["id"]
    source["merged_at"] = _iso(now)
    source["merge_reason"] = reason
    source["merged_by"] = actor
    if state.get("focus_product_id") == source["id"]:
        state["focus_product_id"] = None
    target.setdefault("merge_history", []).append(
        {
            "source_product_id": source["id"],
            "source_name": source.get("name"),
            "source_url": source.get("url"),
            "merged_at": _iso(now),
            "reason": reason,
            "operator": actor,
            "source_keyword_count": len(source.get("source_keyword_ids", [])),
            "candidate_source_count": len(source.get("candidate_sources", [])),
            "evidence_count": len(source.get("evidence", []))
            + len(source.get("automatic_trends", [])),
        }
    )
    _invalidate(target, now)


def _active_concept(state: dict[str, Any], concept_id: Any) -> dict[str, Any]:
    concept = _find(state.get("product_concepts", []), concept_id, "product concept")
    if concept.get("status") != "active":
        raise WorkbenchError("invalid_concept", "商品概念分组已结束")
    return concept


def _concept_offers(state: dict[str, Any], concept_id: str) -> list[dict[str, Any]]:
    return [
        item
        for item in state["products"]
        if item.get("concept_id") == concept_id and not item.get("merged_into")
    ]


def _dissolve_small_concept(
    state: dict[str, Any], concept: dict[str, Any], actor: str, now: datetime
) -> None:
    remaining = _concept_offers(state, concept["id"])
    if len(remaining) >= 2:
        return
    for item in remaining:
        item["concept_id"] = None
    concept["status"] = "dissolved"
    concept["updated_at"] = _iso(now)
    concept["history"].append(
        {"action": "dissolved", "at": _iso(now), "operator": actor}
    )


def _link_product_offers(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _require_human_product_decision(actor)
    first = _find(state["products"], p.get("first_product_id"), "first product")
    second = _find(state["products"], p.get("second_product_id"), "second product")
    reason = _text(p.get("reason"), "reason", required=True, limit=2_000)
    if first["id"] == second["id"] or first.get("merged_into") or second.get("merged_into"):
        raise WorkbenchError("invalid_concept_link", "请选择两个不同的活动卖家商品")
    first_identity = first.get("identity_key") or _product_identity(first.get("url"))
    second_identity = second.get("identity_key") or _product_identity(second.get("url"))
    if first_identity == second_identity:
        raise WorkbenchError("invalid_concept_link", "相同商品链接请使用重复档案合并")
    first_concept, second_concept = first.get("concept_id"), second.get("concept_id")
    if first_concept and second_concept:
        raise WorkbenchError("invalid_concept_link", "两个商品已有分组，不能重复关联")
    concept_id = first_concept or second_concept
    if concept_id:
        concept = _active_concept(state, concept_id)
        added = [second if first_concept else first]
    else:
        name = _text(p.get("name"), "name", required=True, limit=500)
        concept = {
            "id": _id(),
            "name": name,
            "status": "active",
            "created_at": _iso(now),
            "updated_at": _iso(now),
            "history": [],
        }
        state.setdefault("product_concepts", []).append(concept)
        added = [first, second]
    for item in added:
        item["concept_id"] = concept["id"]
    concept["history"].append(
        {
            "id": _id(),
            "action": "linked",
            "added_offer_ids": [item["id"] for item in added],
            "reason": reason,
            "at": _iso(now),
            "operator": actor,
        }
    )
    concept["updated_at"] = _iso(now)


def _split_product_offer(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _require_human_product_decision(actor)
    item = _find(state["products"], p.get("product_id"), "product")
    reason = _text(p.get("reason"), "reason", required=True, limit=2_000)
    concept = _active_concept(state, item.get("concept_id"))
    item["concept_id"] = None
    concept["history"].append(
        {
            "action": "split",
            "offer_id": item["id"],
            "reason": reason,
            "at": _iso(now),
            "operator": actor,
        }
    )
    concept["updated_at"] = _iso(now)
    _dissolve_small_concept(state, concept, actor, now)


def _undo_offer_link(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _require_human_product_decision(actor)
    concept = _active_concept(state, p.get("concept_id"))
    history = concept["history"]
    undone_ids = {
        item.get("link_id") for item in history if item.get("action") == "undo_link"
    }
    link = next(
        (
            item
            for item in reversed(history)
            if item.get("action") == "linked" and item.get("id") not in undone_ids
        ),
        None,
    )
    if link is None or any(
        item.get("action") not in {"linked", "undo_link"}
        for item in history[history.index(link) + 1 :]
    ):
        raise WorkbenchError("invalid_concept_undo", "关联后分组已变更，请逐个移出卖家商品")
    added_ids = set(link["added_offer_ids"])
    if any(
        item.get("concept_id") != concept["id"]
        for item in state["products"]
        if item["id"] in added_ids
    ):
        raise WorkbenchError("invalid_concept_undo", "关联商品已变化，不能直接撤销")
    for item in state["products"]:
        if item["id"] in added_ids:
            item["concept_id"] = None
    history.append(
        {"action": "undo_link", "link_id": link["id"], "at": _iso(now), "operator": actor}
    )
    concept["updated_at"] = _iso(now)
    _dissolve_small_concept(state, concept, actor, now)


def _triage_product(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    disposition = _text(p.get("disposition"), "disposition", required=True, limit=30)
    if disposition not in TRIAGE_STATES - {"pending"}:
        raise WorkbenchError(
            "invalid_disposition",
            "disposition must be retained, observing, or rejected",
        )
    reason = _text(p.get("reason"), "reason", required=True, limit=2_000)
    previous = _triage_state(product)
    if previous == disposition:
        raise WorkbenchError(
            "invalid_triage_transition",
            f"product is already {disposition}",
        )
    triage = product.setdefault("triage", _default_triage())
    triage.setdefault("history", []).append(
        {
            "from": previous,
            "to": disposition,
            "reason": reason,
            "operator": actor,
            "at": _iso(now),
        }
    )
    triage.update(
        state=disposition,
        reason=reason,
        decided_at=_iso(now),
        operator=actor,
    )
    if disposition in {"observing", "rejected"} and state.get(
        "focus_product_id"
    ) == product.get("id"):
        state["focus_product_id"] = None
    product["updated_at"] = _iso(now)


def _restore_product(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    previous = _triage_state(product)
    if previous not in {"observing", "rejected"}:
        raise WorkbenchError(
            "invalid_triage_transition",
            "only observing or rejected products can be restored",
        )
    reason = _text(p.get("reason"), "reason", required=True, limit=2_000)
    triage = product.setdefault("triage", _default_triage())
    triage.setdefault("history", []).append(
        {
            "from": previous,
            "to": "pending",
            "reason": reason,
            "operator": actor,
            "at": _iso(now),
        }
    )
    triage.update(
        state="pending",
        reason=reason,
        decided_at=_iso(now),
        operator=actor,
    )
    product["updated_at"] = _iso(now)


def _undo_triage_product(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    triage = product.setdefault("triage", _default_triage())
    history = triage.setdefault("history", [])
    current = _triage_state(product)
    latest = history[-1] if history else None
    if (
        not isinstance(latest, dict)
        or latest.get("to") != current
        or latest.get("from") not in TRIAGE_STATES
        or latest.get("undo_of_at")
    ):
        raise WorkbenchError(
            "no_reversible_triage_decision",
            "这条线索没有可撤销的最近筛选判断。",
        )
    restored = str(latest["from"])
    history.append(
        {
            "from": current,
            "to": restored,
            "reason": "撤销刚才判断",
            "operator": actor,
            "at": _iso(now),
            "undo_of_at": latest.get("at"),
        }
    )
    triage.update(
        state=restored,
        reason=f"已撤销：{latest.get('reason') or '最近筛选判断'}",
        decided_at=_iso(now),
        operator=actor,
    )
    if restored == "retained":
        state["focus_product_id"] = product["id"]
    elif state.get("focus_product_id") == product.get("id"):
        state["focus_product_id"] = None
    product["updated_at"] = _iso(now)


def _focus_product(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    if _triage_state(product) != "retained":
        raise WorkbenchError(
            "invalid_focus",
            "focus product must be retained for deep research",
        )
    state["focus_product_id"] = product["id"]


def _configure_collection(state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime) -> None:
    if set(p) != {"meta", "trends"} or any(v not in {"api", "ui"} for v in p.values()):
        raise WorkbenchError("invalid_mode", "请选择 Meta 和 Trends 的 API / UI 模式")
    state["collection_modes"] = dict(p)
    state["collection_modes_version"] = state.get("collection_modes_version", 0) + 1


def _configure_rules(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    reason = _text(p.get("reason"), "reason", required=True)
    try:
        configured = validate_rule_patch(effective_rules(state), p.get("rules"))
        evidence_levels = validate_evidence_requirement_patch(
            effective_evidence_requirement_levels(state),
            p.get("evidence_requirement_levels", {}),
        )
    except RuleConfigError as exc:
        raise WorkbenchError(exc.code, exc.message) from exc
    rules_changed = configured != effective_rules(state)
    evidence_levels_changed = (
        evidence_levels != effective_evidence_requirement_levels(state)
    )
    if not rules_changed and not evidence_levels_changed:
        return
    version = effective_rules_version(state) + 1
    state["rules"] = configured
    state["evidence_requirement_levels"] = evidence_levels
    state["rules_version"] = version
    state["limits"] = {
        "scan_batch_limit": configured["scan_batch_limit"],
        "daily_scan_budget": configured["daily_scan_budget"],
        "scan_limit": configured["scan_batch_limit"],
        "max_depth": configured["max_depth"],
    }
    history_item = {
        "version": version,
        "rules": deepcopy(configured),
        "reason": reason,
        "operator": actor,
        "configured_at": _iso(now),
    }
    if evidence_levels_changed:
        history_item["evidence_requirement_levels"] = deepcopy(evidence_levels)
    state.setdefault("rule_history", []).append(history_item)
    for product in state["products"]:
        if product.get("merged_into"):
            continue
        _invalidate(product, now)
        _refresh_identification(
            product, configured, rule_version=version, evaluated_at=now
        )


def _set_logistics_profile(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    observed = _dt(p.get("observed_at"), "observed_at")
    if observed > now + timedelta(minutes=5):
        raise WorkbenchError("future_evidence", "observed_at cannot be in the future")
    if _bool(p.get("confirmed"), "confirmed") is not True:
        raise WorkbenchError(
            "unconfirmed_logistics_profile", "Confirm the carrier rule source first"
        )
    divisor = (
        _num(
            p["volumetric_divisor_cm3_per_kg"],
            "volumetric_divisor_cm3_per_kg",
            positive=True,
        )
        if p.get("volumetric_divisor_cm3_per_kg") is not None
        else None
    )
    carrier = _text(p.get("carrier"), "carrier", required=True, limit=200)
    service = _text(p.get("service"), "service", required=True, limit=200)
    source_url = _url(p.get("source_url"), "source_url", required=True)
    old = state.get("logistics_profile")
    version = (old.get("version", 0) + 1) if isinstance(old, dict) else 1
    if isinstance(old, dict):
        state.setdefault("logistics_profile_history", []).append(deepcopy(old))
    state["logistics_profile"] = {
        "version": version,
        "carrier": carrier,
        "service": service,
        "source_url": source_url,
        "observed_at": _iso(observed),
        "volumetric_divisor_cm3_per_kg": divisor,
        "confirmed": True,
        "operator": actor,
        "recorded_at": _iso(now),
    }


def _add_keyword(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    if len(state["keywords"]) >= MAX_KEYWORDS:
        raise WorkbenchError("limit_reached", "Project keyword limit reached")
    kind = _text(p.get("type"), "type", required=True, limit=30)
    if kind not in KEYWORD_TYPES:
        raise WorkbenchError("invalid_keyword_type", "Unsupported keyword type")
    text = _keyword_phrase(
        _text(p.get("text"), "text", required=True, limit=500)
    ).quoted
    parent_id, product_id = p.get("parent_id"), p.get("product_id")
    quote = _text(p.get("source_quote"), "source_quote", limit=2_000)
    source_id = _text(p.get("source_id"), "source_id", limit=1_000)
    source_kind = _text(p.get("source_kind"), "source_kind", limit=30)
    depth = 0
    passage = None
    if any((parent_id, product_id, quote, source_id, source_kind)):
        if not all((parent_id, product_id, quote, source_id, source_kind)):
            raise WorkbenchError(
                "invalid_expansion",
                "Expansion requires parent, product, source, and source quote",
            )
        parent, product = (
            _find(state["keywords"], parent_id, "parent keyword"),
            _find(state["products"], product_id, "product"),
        )
        if not product.get("identification", {}).get("relevance_confirmed"):
            raise WorkbenchError(
                "invalid_expansion", "Expansion requires confirmed product relevance"
            )
        depth = parent["depth"] + 1
        rules = effective_rules(state)
        if depth > rules["max_depth"]:
            raise WorkbenchError(
                "limit_reached", "Keyword expansion depth limit reached"
            )
        if (
            len(
                [
                    item
                    for item in state["keywords"]
                    if item.get("parent_id") == parent_id
                    and item.get("product_id") == product_id
                ]
            )
            >= rules["expansion_limit"]
        ):
            raise WorkbenchError(
                "limit_reached",
                "Maximum proposals per parent/product reached",
            )
        passage = resolve_source_passage(state, product["id"], source_id, source_kind)
        if passage is None or quote not in passage.text:
            raise WorkbenchError(
                "invalid_expansion_source",
                "Expansion source is unavailable for the current product identity",
            )
    if any(
        item["text"].casefold() == text.casefold()
        and item.get("parent_id") == parent_id
        and item.get("product_id") == product_id
        for item in state["keywords"]
    ):
        return
    item = {
        "id": _id(),
        "text": text,
        "type": kind,
        "meaning": _text(p.get("meaning"), "meaning", limit=1_000),
        "approved": False,
        "parent_id": parent_id,
        "parents": [parent_id] if parent_id else [],
        "product_id": product_id,
        "depth": depth,
        "status": "pending_review",
        "ads": [],
        "message": "",
        "source_quote": quote or None,
        "operator": actor,
        "created_at": _iso(now),
        "updated_at": _iso(now),
    }
    if passage is not None:
        item.update(
            source_id=passage.source_id,
            source_kind=passage.source_kind,
            source_product_id=passage.product_id,
            source_identity_revision=passage.identity_revision,
            source_keyword_id=passage.keyword_id,
            source_ad_id=passage.ad_id,
            source_content_hash=passage.content_hash,
        )
    state["keywords"].append(item)


def _expansion_source_is_current(
    state: dict[str, Any], keyword: dict[str, Any]
) -> bool:
    if not keyword.get("parent_id"):
        return True
    passage = resolve_source_passage(
        state,
        str(keyword.get("product_id", "")),
        str(keyword.get("source_id", "")),
        str(keyword.get("source_kind", "")),
    )
    quote = keyword.get("source_quote")
    return bool(
        passage is not None
        and isinstance(quote, str)
        and quote in passage.text
        and keyword.get("source_content_hash") == passage.content_hash
    )


def _approve_keyword(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    keyword = _find(state["keywords"], p.get("keyword_id"), "keyword")
    if keyword["status"] == "archived":
        raise WorkbenchError("keyword_locked", "该词已归档；需要继续时请添加新词。")
    approved = _bool(p.get("approved"), "approved")
    if approved and keyword.get("text") != _keyword_phrase(keyword.get("text")).quoted:
        raise WorkbenchError(
            "keyword_needs_normalization",
            "关键词引号格式需要先修改并规范化，再审核通过。",
        )
    if (
        approved
        and keyword.get("parent_id")
        and not _expansion_source_is_current(state, keyword)
    ):
        raise WorkbenchError(
            "invalid_expansion_source",
            "Expansion source must be selected again before approval",
        )
    keyword["approved"] = approved
    if keyword["status"] not in {"complete", "blocked"}:
        restored = keyword.get("restored_from_status")
        keyword["status"] = (
            restored
            if approved and restored in {"complete", "blocked"}
            else "ready"
            if approved
            else "pending_review"
        )
    keyword.setdefault("lifecycle_history", []).append(
        {
            "action": "approve" if approved else "unapprove",
            "operator": actor,
            "at": _iso(now),
        }
    )
    if approved:
        keyword.pop("restored_from_status", None)
    keyword.update(operator=actor, updated_at=_iso(now))


def _edit_keyword(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    word = _find(state["keywords"], p.get("keyword_id"), "keyword")
    if word["status"] not in {"pending_review", "ready"} or word.get("scan_counted"):
        raise WorkbenchError(
            "keyword_locked", "已执行或归档的词不能改写；请添加新词保留来源历史。"
        )
    text = _keyword_phrase(
        _text(p.get("text"), "text", required=True, limit=500)
    ).quoted
    kind = _text(p.get("type"), "type", required=True)
    if kind not in KEYWORD_TYPES:
        raise WorkbenchError("invalid_keyword_type", "请选择有效的关键词类型。")
    if any(
        w["id"] != word["id"]
        and w["text"].casefold() == text.casefold()
        and w.get("parent_id") == word.get("parent_id")
        for w in state["keywords"]
    ):
        raise WorkbenchError("duplicate_keyword", "相同路径中已存在这个词。")
    passage = None
    if word.get("parent_id"):
        product_id = str(word.get("product_id", ""))
        source_id = _text(p.get("source_id"), "source_id", required=True, limit=1_000)
        source_kind = _text(
            p.get("source_kind"), "source_kind", required=True, limit=30
        )
        quote = _text(p.get("source_quote"), "source_quote", required=True, limit=2_000)
        passage = resolve_source_passage(state, product_id, source_id, source_kind)
        if passage is None or quote not in passage.text:
            raise WorkbenchError(
                "invalid_expansion_source",
                "Expansion source is unavailable for the current product identity",
            )
    word.setdefault("history", []).append(
        {
            key: deepcopy(word[key])
            for key in (
                "text",
                "type",
                "meaning",
                "source_id",
                "source_kind",
                "source_quote",
                "source_product_id",
                "source_identity_revision",
                "source_keyword_id",
                "source_ad_id",
                "source_content_hash",
                "updated_at",
            )
            if key in word
        }
    )
    word.update(
        text=text,
        type=kind,
        meaning=_text(p.get("meaning"), "meaning", limit=1000),
        approved=False,
        status="pending_review",
        operator=actor,
        updated_at=_iso(now),
    )
    if passage is not None:
        word.update(
            source_id=passage.source_id,
            source_kind=passage.source_kind,
            source_quote=quote,
            source_product_id=passage.product_id,
            source_identity_revision=passage.identity_revision,
            source_keyword_id=passage.keyword_id,
            source_ad_id=passage.ad_id,
            source_content_hash=passage.content_hash,
        )


def _archive_keyword(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    word = _find(state["keywords"], p.get("keyword_id"), "keyword")
    if word["status"] in {"queued", "running"}:
        raise WorkbenchError("keyword_locked", "该词正在执行，结束后可归档。")
    if word["status"] == "archived":
        return
    word["archived_from_status"] = word.get("restored_from_status", word["status"])
    word["archived_from_approved"] = word["approved"]
    word.setdefault("lifecycle_history", []).append(
        {
            "action": "archive",
            "operator": actor,
            "at": _iso(now),
            "from_status": word["status"],
        }
    )
    word.update(approved=False, status="archived", operator=actor, updated_at=_iso(now))


def _restore_keyword(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    word = _find(state["keywords"], p.get("keyword_id"), "keyword")
    if word["status"] != "archived":
        raise WorkbenchError("keyword_locked", "只有已归档的关键词可以恢复。")
    if any(
        other["id"] != word["id"]
        and other["status"] != "archived"
        and other["text"].casefold() == word["text"].casefold()
        and other.get("parent_id") == word.get("parent_id")
        and other.get("product_id") == word.get("product_id")
        for other in state["keywords"]
    ):
        raise WorkbenchError(
            "duplicate_keyword", "相同路径中已有此关键词，未合并或改写历史。"
        )
    word["restored_from_status"] = word.get("archived_from_status", "ready")
    word.setdefault("lifecycle_history", []).append(
        {"action": "restore", "operator": actor, "at": _iso(now)}
    )
    word.update(
        approved=False,
        status="pending_review",
        operator=actor,
        updated_at=_iso(now),
        message="已保留原搜索与证据，需重新审核后继续。",
    )


def _add_product(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    name, url = (
        _text(p.get("name"), "name", required=True, limit=500),
        _url(p.get("url")),
    )
    source_ids = p.get("source_keyword_ids") or []
    if not isinstance(source_ids, list):
        raise WorkbenchError("invalid_payload", "source_keyword_ids must be a list")
    source_ids = [
        _find(state["keywords"], item, "keyword")["id"] for item in source_ids
    ]
    identity = _product_identity(url)
    existing = next(
        (
            item
            for item in state["products"]
            if not item.get("merged_into")
            and (
                _product_identity(item.get("identity_key"))
                or _product_identity(item.get("url"))
            )
            == identity
        ),
        None,
    )
    if existing:
        existing["source_keyword_ids"] = list(
            dict.fromkeys(existing["source_keyword_ids"] + source_ids)
        )
        return
    if len(state["products"]) >= MAX_PRODUCTS:
        raise WorkbenchError("limit_reached", "Project product limit reached")
    state["products"].append(_new_product(name, url, source_ids, now))


def _normalize_creatives(
    value: Any,
    *,
    actor: str,
    confirmed_at: datetime,
    identity_revision: int,
) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(value, list):
        raise WorkbenchError("invalid_payload", "creatives must be a list")
    normalized = []
    for item in value[:200]:
        if not isinstance(item, dict):
            continue
        creative_id = _text(
            item.get("id"), "creative.id", required=True, limit=500
        )
        source_url = _url(item.get("source_url"), "creative.source_url")
        normalized.append(
            {
                "id": creative_id,
                "source_url": source_url,
                "distinct": _bool(item.get("distinct"), "creative.distinct"),
                "active": _bool(item.get("active"), "creative.active"),
                "confirmed_by": actor,
                "confirmed_at": _iso(confirmed_at),
                "evidence": {
                    "creative_id": creative_id,
                    "source_url": source_url,
                },
                "evidence_id": creative_evidence_id(
                    identity_revision, creative_id, source_url
                ),
            }
        )
    evidenced: set[tuple[str, str]] = {
        (str(item["id"]), str(item["source_url"]))
        for item in normalized
        if item["distinct"] and item["active"]
    }
    remaining = set(evidenced)
    distinct = 0
    while remaining:
        distinct += 1
        frontier = [remaining.pop()]
        component_ids: set[str] = set()
        component_urls: set[str] = set()
        while frontier:
            creative_id, source_url = frontier.pop()
            component_ids.add(creative_id)
            component_urls.add(source_url)
            linked = {
                pair
                for pair in remaining
                if pair[0] in component_ids or pair[1] in component_urls
            }
            remaining.difference_update(linked)
            frontier.extend(linked)
    return normalized, distinct


def _update_product_identity(
    state: dict[str, Any],
    product: dict[str, Any],
    p: dict[str, Any],
    actor: str,
    now: datetime,
) -> None:
    name, url = (
        _text(p.get("name"), "name", required=True, limit=500),
        _url(p.get("url")),
    )
    relevance = _bool(p.get("relevance_confirmed"), "relevance_confirmed")
    relevance_result = p.get("relevance_result", "matched" if relevance else "unverified")
    if not isinstance(relevance_result, str) or relevance_result not in {"matched", "mismatch", "unverified"} or relevance != (relevance_result == "matched"):
        raise WorkbenchError("invalid_payload", "核对结果与相关性确认不一致，请重新选择")
    reason = _text(p.get("reason"), "reason", required=True)
    old_identity_key = product.get("identity_key") or product_identity_url(
        product["url"]
    )
    new_identity_key = product_identity_url(url)
    if new_identity_key != old_identity_key:
        if product.get("concept_id"):
            _split_product_offer(
                state,
                {"product_id": product["id"], "reason": "商品链接身份已更换，需重新核对同款关系"},
                actor,
                now,
            )
        old_identity_revision = _identity_revision(product)
        if product.get("identification"):
            product.setdefault("identification_history", []).append(
                {
                    **deepcopy(product["identification"]),
                    "closed_at": _iso(now),
                }
            )
        product.setdefault("identity_history", []).append(
            {
                "identity_key": old_identity_key,
                "identity_revision": old_identity_revision,
                "name": product["name"],
                "url": product["url"],
                "closed_at": _iso(now),
            }
        )
        product["identity_revision"] = old_identity_revision + 1
        identification: dict[str, Any] = {}
    else:
        product.setdefault("identity_revision", _identity_revision(product))
        product.setdefault("identity_history", [])
        identification = deepcopy(product.get("identification") or {})
    product["identity_key"] = new_identity_key
    product.update(name=name, url=url)
    identification.update(
        {
            "product_confirmed": relevance,
            "relevance_confirmed": relevance,
            "relevance_result": relevance_result,
            "reason": reason,
            "operator": actor,
            "confirmed_at": _iso(now),
            "identity_revision": _identity_revision(product),
        }
    )
    if "ad_age_days" not in identification and "active_days" not in identification:
        identification["ad_age_days"] = None
    identification.setdefault("active_days", 0)
    identification.setdefault("creatives", [])
    identification.setdefault("distinct_active_creatives", 0)
    identification["passed"] = False
    identification["confirmation_method"] = "manual" if actor != "automation" else "automatic"
    product["identification"] = identification


def _update_creative_confirmation(
    state: dict[str, Any],
    product: dict[str, Any],
    p: dict[str, Any],
    actor: str,
    now: datetime,
    *,
    require_confirmed_identity: bool = True,
) -> None:
    identity = product.get("identification") or {}
    if require_confirmed_identity and not identity.get("relevance_confirmed"):
        raise WorkbenchError(
            "identification_required",
            "Confirm the current product identity before creative evidence",
        )
    requested_revision = _int(
        p.get("identity_revision"), "identity_revision", minimum=1
    )
    current_revision = _identity_revision(product)
    if (
        requested_revision != current_revision
        or identity.get("identity_revision", current_revision) != current_revision
    ):
        raise WorkbenchError(
            "stale_identity", "identity_revision does not match the current product"
        )
    age_value = p.get("ad_age_days", p.get("active_days"))
    ad_age_days = _int(age_value, "ad_age_days")
    if ad_age_days > 10_000:
        raise WorkbenchError("invalid_number", "ad_age_days must not exceed 10000")
    normalized, distinct = _normalize_creatives(
        p.get("creatives"),
        actor=actor,
        confirmed_at=now,
        identity_revision=current_revision,
    )
    observation = merge_ad_observation(
        identity,
        {
            "started_at": p.get("started_at"),
            "ad_age_days": ad_age_days,
            "currently_active": p.get(
                "currently_active", any(item["active"] for item in normalized)
            ),
            "observed_at": p.get("observed_at", _iso(now)),
            "continuity_status": p.get("continuity_status", "unknown"),
        },
    )
    identity.update(
        {
            **observation,
            "active_days": ad_age_days,
            "creatives": normalized,
            "distinct_active_creatives": distinct,
            "creative_operator": actor,
            "creatives_confirmed_at": _iso(now),
            "identity_revision": current_revision,
        }
    )
    _refresh_identification(
        product,
        effective_rules(state),
        rule_version=effective_rules_version(state),
        evaluated_at=now,
    )


def _confirm_product(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    _update_product_identity(state, product, p, actor, now)
    _refresh_identification(
        product,
        effective_rules(state),
        rule_version=effective_rules_version(state),
        evaluated_at=now,
    )
    _invalidate(product, now)


def _verification_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _automation(actor)
    from rabbit_hole.domain.verification import normalize_assessment

    items = p.get("assessments")
    if not isinstance(items, list) or not 1 <= len(items) <= 20:
        raise WorkbenchError("invalid_payload", "核对结果必须为1至20条")
    for item in items:
        if not isinstance(item, dict):
            raise WorkbenchError("invalid_payload", "核对结果格式无效")
        product = _find(state["products"], item.get("product_id"), "product")
        if product.get("merged_into"):
            continue
        identity = product.get("identification") or {}
        if identity.get("confirmed_at") and identity.get("confirmation_method") != "ai":
            continue
        result = normalize_assessment(state, product, item)
        if product.get("verification"):
            product.setdefault("verification_history", []).append(deepcopy(product["verification"]))
        product["verification"] = {**result, "checked_at": _iso(now), "method": "ai"}
        if result["status"] == "matched":
            _confirm_product(state, {
                "product_id": product["id"], "name": result["name"], "url": product["url"],
                "relevance_confirmed": True, "reason": result["reason"],
            }, actor, now)
            product["identification"]["confirmation_method"] = "ai"
        elif identity.get("confirmation_method") == "ai":
            identity.update(product_confirmed=False, relevance_confirmed=False)


def _confirm_creatives(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    _update_creative_confirmation(state, product, p, actor, now)
    _invalidate(product, now)


def _identify(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    _update_product_identity(state, product, p, actor, now)
    _update_creative_confirmation(
        state,
        product,
        {**p, "identity_revision": _identity_revision(product)},
        actor,
        now,
        require_confirmed_identity=False,
    )
    _invalidate(product, now)


def _bounded(value: Any, depth: int = 0, *, max_depth: int = 5) -> Any:
    if depth > max_depth:
        raise WorkbenchError("limit_reached", "Evidence nesting is too deep")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return _text(value, "data")
    if isinstance(value, (int, float, Decimal)):
        return _num(value, "data", minimum=-float("inf"))
    if isinstance(value, list):
        if len(value) > MAX_POINTS:
            raise WorkbenchError("limit_reached", "Evidence data exceeds 3000 points")
        return [_bounded(item, depth + 1, max_depth=max_depth) for item in value]
    if isinstance(value, dict):
        if len(value) > 100:
            raise WorkbenchError("limit_reached", "Evidence object is too large")
        return {
            _text(key, "data key", required=True, limit=100): _bounded(item, depth + 1, max_depth=max_depth)
            for key, item in value.items()
        }
    raise WorkbenchError(
        "invalid_payload", "Evidence data contains an unsupported value"
    )


def _evidence(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    if len(product["evidence"]) >= MAX_EVIDENCE:
        raise WorkbenchError("limit_reached", "Product evidence history limit reached")
    channel = _text(p.get("channel"), "channel", required=True, limit=30)
    if channel not in CHANNELS:
        raise WorkbenchError("invalid_channel", "Unsupported evidence channel")
    observed = _dt(p.get("observed_at"), "observed_at")
    if observed > now + timedelta(minutes=5):
        raise WorkbenchError(
            "future_evidence",
            "observed_at cannot be more than five minutes in the future",
        )
    waiver, reason = (
        _bool(p.get("not_applicable", False), "not_applicable"),
        _text(p.get("reason"), "reason"),
    )
    if waiver and channel in {"meta", "trends"}:
        raise WorkbenchError("invalid_waiver", "Meta and Trends cannot be waived")
    if waiver and not reason:
        raise WorkbenchError("missing_field", "A waiver reason is required")
    conclusion = _text(
        p.get("conclusion"), "conclusion", required=not waiver, limit=1_000
    )
    item: dict[str, Any] = {
        "id": _id(),
        "channel": channel,
        "source_url": _url(p.get("source_url"), "source_url", required=not waiver),
        "observed_at": _iso(observed),
        "query": _text(p.get("query"), "query", limit=500) or None,
        "conclusion": conclusion,
        "notes": _text(p.get("notes"), "notes"),
        "confirmed": _bool(p.get("confirmed"), "confirmed"),
        "not_applicable": waiver,
        "reason": reason or None,
        "limited": waiver,
        "provenance": "manual",
        "operator": actor,
        "recorded_at": _iso(now),
        "identity_revision": _identity_revision(product),
    }
    review_due = (
        _dt(p["review_due_at"], "review_due_at")
        if p.get("review_due_at")
        else None
    )
    valid_until = (
        _dt(p["valid_until"], "valid_until") if p.get("valid_until") else None
    )
    if review_due is not None or valid_until is not None:
        if item["confirmed"] is not True:
            raise WorkbenchError(
                "unconfirmed_deadline", "Evidence deadlines require confirmation"
            )
        if any(
            deadline is not None and deadline < observed
            for deadline in (review_due, valid_until)
        ) or (review_due is not None and valid_until is not None and review_due > valid_until):
            raise WorkbenchError(
                "invalid_deadline", "Evidence deadlines must follow observation order"
            )
    item["review_due_at"] = _iso(review_due) if review_due else None
    item["valid_until"] = _iso(valid_until) if valid_until else None
    if channel == "trends":
        window = _text(p.get("window"), "window", required=True, limit=10)
        if window not in {"12m", "5y"} or conclusion not in TREND_CONCLUSIONS:
            raise WorkbenchError(
                "invalid_trends_evidence", "Invalid Trends window or conclusion"
            )
        if (
            not item["query"]
            or _text(p.get("market"), "market", required=True, limit=10).upper() != state["market"]
        ):
            raise WorkbenchError(
                "invalid_trends_evidence",
                "Trends evidence must match the project query, window, and market",
            )
        item.update(window=window, market=state["market"])
    if channel == "similarweb":
        item["direct_share"] = (
            _num(p["direct_share"], "direct_share")
            if p.get("direct_share") is not None
            else None
        )
        if item["direct_share"] is not None and item["direct_share"] > 100:
            raise WorkbenchError(
                "invalid_number", "direct_share must be between 0 and 100"
            )
        item["monthly_visits"] = (
            _num(p["monthly_visits"], "monthly_visits")
            if p.get("monthly_visits") is not None
            else None
        )
        if item["monthly_visits"] is not None:
            scope = _text(p.get("traffic_scope"), "traffic_scope", required=True)
            if scope not in TRAFFIC_SCOPES - {"unknown"}:
                raise WorkbenchError(
                    "invalid_traffic_scope", "Choose a known traffic scope"
                )
            traffic_url = _url(p.get("traffic_url"), "traffic_url", required=True)
            if scope == "product" and _product_identity(traffic_url) != product.get(
                "identity_key"
            ):
                raise WorkbenchError(
                    "traffic_product_mismatch",
                    "Product traffic URL must match the current product identity",
                )
            item.update(
                traffic_scope=scope,
                traffic_url=traffic_url,
                traffic_period=_text(
                    p.get("traffic_period"), "traffic_period", required=True, limit=100
                ),
            )
        else:
            item.update(traffic_scope="unknown", traffic_url=None, traffic_period=None)
    if channel == "meta":
        item["advertiser_count"] = (
            _int(p["advertiser_count"], "advertiser_count")
            if p.get("advertiser_count") is not None
            else None
        )
        for key in ("brand_concentration", "differentiation"):
            value = _text(p.get(key), key, limit=20) or None
            if value is not None and value not in RISKS:
                raise WorkbenchError(
                    "invalid_evidence", f"{key} must be low, medium, or high"
                )
            item[key] = value
    if "data" in p:
        item["data"] = _bounded(p["data"])
    product["evidence"].append(item)
    _invalidate(product, now)


def _funnel(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    facts: dict[str, Any] = {
        key: _text(p.get(key), key)
        for key in ("hook", "cta", "trust", "faq", "bundle", "notes")
    }
    for key in ("creative_formats", "scenarios", "angles"):
        if not isinstance(p.get(key), list):
            raise WorkbenchError("invalid_payload", f"{key} must be a list")
        facts[key] = [
            _text(value, key, required=True, limit=500) for value in p[key][:100]
        ]
    facts.update(
        source_url=_url(p.get("source_url"), "source_url"),
        confirmed=_bool(p.get("confirmed"), "confirmed"),
        operator=actor,
        recorded_at=_iso(now),
        identity_revision=_identity_revision(product),
    )
    if product.get("funnel"):
        product.setdefault("funnel_history", []).append(deepcopy(product["funnel"]))
    product["funnel"] = facts
    _invalidate(product, now)


def _add_creative_reference(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    if actor != "local_user":
        raise WorkbenchError("human_confirmation_required", "创意参考须由用户实际观察后记录")
    product = _find(state["products"], p.get("product_id"), "product")
    records = product.setdefault("creative_references", [])
    if len(records) >= 200:
        raise WorkbenchError("limit_reached", "创意参考记录已达上限")
    observed = _dt(p.get("observed_at"), "observed_at")
    if observed > now + timedelta(minutes=5):
        raise WorkbenchError("future_evidence", "observed_at cannot be in the future")
    record = {
        "id": _id(), "product_id": product["id"],
        "identity_revision": _identity_revision(product),
        "source_ad_id": _text(p.get("source_ad_id"), "source_ad_id", required=True, limit=200),
        "source_url": _url(p.get("source_url"), "source_url"),
        "observed_at": _iso(observed),
        "format": _text(p.get("format"), "format", required=True, limit=200),
        "hook": _text(p.get("hook"), "hook", required=True, limit=500),
        "pattern_note": _text(p.get("pattern_note"), "pattern_note", required=True, limit=1000),
        "provenance": "manual", "operator": actor, "recorded_at": _iso(now),
    }
    for field in ("category", "audience", "pain_point", "scene", "angle", "cta", "notes"):
        record[field] = _text(p.get(field), field, limit=1000)
    record["duration_seconds"] = (
        _int(p["duration_seconds"], "duration_seconds")
        if p.get("duration_seconds") not in (None, "") else None
    )
    records.append(record)
    product["updated_at"] = _iso(now)


_FUNNEL_METHODS = {
    "email_marketing": "actual_subscription",
    "abandoned_cart": "actual_abandonment",
    "analytics": "account_analytics",
    "retargeting": "actual_retargeting_test",
}
_FUNNEL_STATUSES = {
    "unknown", "not_checked", "observed", "confirmed", "not_found", "not_applicable"
}


def _record_funnel_investigation(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    if actor != "local_user":
        raise WorkbenchError("human_confirmation_required", "漏斗调查须由用户实际核对后记录")
    product = _find(state["products"], p.get("product_id"), "product")
    records = product.setdefault("funnel_investigations", [])
    if len(records) >= 200:
        raise WorkbenchError("limit_reached", "漏斗调查记录已达上限")
    area = _text(p.get("area"), "area", required=True, limit=40)
    status = _text(p.get("status"), "status", required=True, limit=30)
    if area not in _FUNNEL_METHODS or status not in _FUNNEL_STATUSES:
        raise WorkbenchError("invalid_investigation", "无效的调查领域或状态")
    method = _text(p.get("method"), "method", limit=100)
    if status in {"confirmed", "not_found"} and method != _FUNNEL_METHODS[area]:
        raise WorkbenchError("invalid_investigation", "确认结论必须来自该领域的实际流程测试")
    if status == "observed" and not method:
        raise WorkbenchError("missing_field", "method is required")
    if status == "not_applicable" and not _text(p.get("reason"), "reason"):
        raise WorkbenchError("missing_field", "reason is required")
    evidence_required = status in {"observed", "confirmed", "not_found"}
    observed = _dt(p.get("observed_at"), "observed_at") if evidence_required else None
    if observed and observed > now + timedelta(minutes=5):
        raise WorkbenchError("future_evidence", "observed_at cannot be in the future")
    records.append({
        "id": _id(), "product_id": product["id"],
        "identity_revision": _identity_revision(product),
        "area": area, "status": status, "method": method or None,
        "source_url": _url(p.get("source_url"), "source_url", required=evidence_required),
        "observed_at": _iso(observed) if observed else None,
        "notes": _text(p.get("notes"), "notes", limit=2000),
        "reason": _text(p.get("reason"), "reason", limit=1000),
        "provenance": "manual", "operator": actor, "recorded_at": _iso(now),
    })
    product["updated_at"] = _iso(now)


def _economics(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    result: dict[str, Any] = {}
    for key in (
        "unit_price",
        "aov",
        "goods_cost",
        "shipping",
        "packaging",
        "tax",
        "ad_cost",
        "payment_percent",
        "payment_fixed",
        "reserve_percent",
        "weight_kg",
    ):
        result[key] = _num(p[key], key) if p.get(key) is not None else None
    actual_value = p.get("actual_weight_kg", p.get("weight_kg"))
    actual = (
        _num(actual_value, "actual_weight_kg", positive=True)
        if actual_value is not None
        else None
    )
    if p.get("weight_kg") is not None and result["weight_kg"] != actual:
        raise WorkbenchError(
            "conflicting_weight", "weight_kg and actual_weight_kg must match"
        )
    result["weight_kg"] = actual
    result["actual_weight_kg"] = actual
    for key in ("package_length_cm", "package_width_cm", "package_height_cm"):
        result[key] = (
            _num(p[key], key, positive=True) if p.get(key) is not None else None
        )
    for key in ("fragile", "battery", "liquid", "powder", "magnetic", "oversized"):
        result[key] = _bool(p[key], key) if p.get(key) is not None else None
    result["quantity"] = (
        _int(p["quantity"], "quantity", minimum=1)
        if p.get("quantity") is not None
        else None
    )
    for key in ("payment_percent", "reserve_percent"):
        if result[key] is not None and result[key] > 100:
            raise WorkbenchError("invalid_number", f"{key} must be between 0 and 100")
    for key in ("logistics_risk", "compliance_risk", "ip_risk"):
        value = _text(p.get(key), key, limit=20) or None
        if value is not None and value not in RISKS:
            raise WorkbenchError("invalid_risk", f"{key} must be low, medium, or high")
        result[key] = value
    result.update(
        quote_source=_url(p.get("quote_source"), "quote_source", required=False),
        quote_date=_iso(_dt(p["quote_date"], "quote_date"))
        if p.get("quote_date")
        else None,
        quote_confirmed=_bool(p.get("quote_confirmed"), "quote_confirmed")
        if "quote_confirmed" in p
        else None,
        bundle_reason=_text(p.get("bundle_reason"), "bundle_reason") or None,
        certification_required=_bool(
            p.get("certification_required"), "certification_required"
        )
        if "certification_required" in p
        else None,
        certification_verified=_bool(
            p.get("certification_verified"), "certification_verified"
        )
        if "certification_verified" in p
        else None,
        operator=actor,
        recorded_at=_iso(now),
        revision=product["revision"] + 1,
        identity_revision=_identity_revision(product),
    )
    if product.get("economics"):
        product.setdefault("quote_history", []).append(deepcopy(product["economics"]))
    product["economics"] = result
    _invalidate(product, now)


def _add_sales_estimate(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    evidence_id = _text(
        p.get("traffic_evidence_id"), "traffic_evidence_id", required=True
    )
    traffic = next(
        (
            item
            for item in product.get("evidence", [])
            if item.get("id") == evidence_id
            and item.get("channel") == "similarweb"
            and _current_identity_record(product, item)
        ),
        None,
    )
    if traffic is None or not traffic.get("confirmed"):
        raise WorkbenchError(
            "invalid_traffic_evidence", "Select confirmed current traffic evidence"
        )
    if evidence_freshness(
        traffic.get("observed_at"),
        traffic.get("review_due_at"),
        traffic.get("valid_until"),
        now,
    )["status"] == "expired":
        raise WorkbenchError(
            "expired_traffic_evidence", "Traffic evidence has expired; recheck the source"
        )
    economics = product.get("economics") or {}
    if not _current_identity_record(product, economics) or economics.get("aov") is None:
        raise WorkbenchError("missing_aov", "Current product AOV is required")
    cvr_source = _text(p.get("cvr_source"), "cvr_source", required=True, limit=2_000)
    cvrs = [
        _num(p.get(key), key)
        for key in ("cvr_low", "cvr_base", "cvr_high")
    ]
    try:
        scenarios = scenario_rows(
            traffic["monthly_visits"],
            economics["aov"],
            cvrs[0],
            cvrs[1],
            cvrs[2],
            traffic.get("traffic_scope", "unknown"),
        )
    except (TypeError, ValueError) as exc:
        raise WorkbenchError("invalid_estimate", str(exc)) from exc
    product.setdefault("estimates", []).append(
        {
            "id": _id(),
            "kind": "estimate",
            "traffic_evidence_id": evidence_id,
            "traffic_scope": scenarios["scope"],
            "traffic_period": traffic.get("traffic_period"),
            "monthly_visits_snapshot": traffic["monthly_visits"],
            "aov_snapshot": economics["aov"],
            "cvr_low": cvrs[0],
            "cvr_base": cvrs[1],
            "cvr_high": cvrs[2],
            "cvr_source": cvr_source,
            "scenarios": scenarios,
            "identity_revision": _identity_revision(product),
            "operator": actor,
            "created_at": _iso(now),
        }
    )


def _margin(e: dict[str, Any]) -> float:
    fees = (
        e["aov"] * e["payment_percent"] / 100
        + e["payment_fixed"]
        + e["aov"] * e["reserve_percent"] / 100
    )
    costs = (
        sum(e[key] for key in ("goods_cost", "shipping", "packaging", "tax", "ad_cost"))
        + fees
    )
    return float(round((e["aov"] - costs) / e["aov"] * 100, 2)) if e["aov"] else 0.0


def _final_score_gates(
    product: dict[str, Any],
    economics: dict[str, Any],
    margin: float,
    rules: dict[str, int | float],
    requirements: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    economics_ids = evidence_ids_for(requirements, "economics")
    trend_ids = evidence_ids_for(requirements, "trends_12m", "trends_5y")
    similarweb_ids = evidence_ids_for(requirements, "similarweb")
    trends = [
        (_latest(product, "trends", window) or {}).get("conclusion")
        for window in ("12m", "5y")
    ]
    risk_values = [
        economics[key] for key in ("logistics_risk", "compliance_risk", "ip_risk")
    ]
    similarweb = _latest(product, "similarweb") or {}
    similarweb_requirement = next(
        item for item in requirements if item.get("key") == "similarweb"
    )
    if similarweb_requirement.get("status") == "not_applicable":
        similarweb_status: Literal["pass", "fail", "unknown", "not_applicable"] = (
            "not_applicable"
        )
        similarweb_reason = str(similarweb_requirement.get("status_reason") or "不适用")
    elif similarweb.get("direct_share") is None:
        similarweb_status = "unknown"
        similarweb_reason = "没有可靠 Similarweb 直接流量占比，不能默认视为通过。"
    elif similarweb["direct_share"] > rules["max_direct_share_percent"]:
        similarweb_status = "fail"
        similarweb_reason = (
            f"直接流量占比 {similarweb['direct_share']:g}% 高于 "
            f"{rules['max_direct_share_percent']:g}% 上限。"
        )
    else:
        similarweb_status = "pass"
        similarweb_reason = (
            f"直接流量占比 {similarweb['direct_share']:g}% 未高于 "
            f"{rules['max_direct_share_percent']:g}% 上限。"
        )
    return [
        final_gate_row(
            key="contribution_margin",
            status="pass" if margin >= rules["min_margin_percent"] else "fail",
            rule_id="gate.contribution_margin",
            evidence_ids=economics_ids,
            reason=(
                f"贡献毛利率 {margin:g}%；项目下限 "
                f"{rules['min_margin_percent']:g}%。"
            ),
        ),
        final_gate_row(
            key="aov",
            status=(
                "pass"
                if rules["min_aov"] <= economics["aov"] <= rules["max_aov"]
                else "fail"
            ),
            rule_id="gate.aov_range",
            evidence_ids=economics_ids,
            reason=(
                f"AOV {economics['aov']:g}；项目范围 "
                f"{rules['min_aov']:g}–{rules['max_aov']:g}。"
            ),
        ),
        final_gate_row(
            key="packed_weight",
            status=(
                "pass"
                if economics["weight_kg"] <= rules["max_weight_kg"]
                else "fail"
            ),
            rule_id="gate.packed_weight",
            evidence_ids=economics_ids,
            reason=(
                f"包装重量 {economics['weight_kg']:g}kg；项目上限 "
                f"{rules['max_weight_kg']:g}kg。"
            ),
        ),
        final_gate_row(
            key="risk",
            status="fail" if "high" in risk_values else "pass",
            rule_id="gate.logistics_compliance_ip_risk",
            evidence_ids=economics_ids,
            reason=f"物流/合规/IP 风险为 {'/'.join(risk_values)}。",
        ),
        final_gate_row(
            key="peaked_trend",
            status="fail" if "peaked" in trends else "pass",
            rule_id="gate.peaked_trend",
            evidence_ids=trend_ids,
            reason=f"12m/5y 趋势为 {trends[0]}/{trends[1]}。",
        ),
        final_gate_row(
            key="similarweb_direct_share",
            status=similarweb_status,
            rule_id="gate.similarweb_direct_share",
            evidence_ids=similarweb_ids,
            reason=similarweb_reason,
        ),
    ]


def _evaluate(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    rules = effective_rules(state)
    rule_version = effective_rules_version(state)
    requirements = requirement_statuses(state, product, now)
    missing = blocking_requirement_keys(requirements)
    score: dict[str, Any] = {
        "id": _id(),
        "revision": product["revision"],
        "created_at": _iso(now),
        "status": "incomplete",
        "missing": missing,
        "total": None,
        "dimensions": [],
        "margin": None,
        "recommendation": "",
        "rule_version": rule_version,
        "score_version": SCORING_VERSION,
        "rules": deepcopy(rules),
        "final_gates": [],
        "operator": actor,
        "identity_revision": _identity_revision(product),
    }
    if missing:
        score["recommendation"] = f"证据不足，暂不能评分。待补充：{', '.join(missing)}"
        product["scores"].append(score)
        return
    margin, e = _margin(product["economics"]), product["economics"]
    score["final_gates"] = _final_score_gates(
        product, e, margin, rules, requirements
    )
    failures = []
    if margin < rules["min_margin_percent"]:
        failures.append("contribution_margin_below_minimum")
    if not rules["min_aov"] <= e["aov"] <= rules["max_aov"]:
        failures.append("aov_outside_configured_range")
    if e["weight_kg"] > rules["max_weight_kg"]:
        failures.append("weight_above_maximum")
    if any(
        e[key] == "high" for key in ("logistics_risk", "compliance_risk", "ip_risk")
    ):
        failures.append("high_risk")
    if any(
        (_latest(product, "trends", w) or {}).get("conclusion") == "peaked"
        for w in ("12m", "5y")
    ):
        failures.append("peaked_trend")
    similarweb = _latest(product, "similarweb") or {}
    if (
        similarweb.get("direct_share") is not None
        and similarweb["direct_share"] > rules["max_direct_share_percent"]
    ):
        failures.append("similarweb_direct_share_above_maximum")
    if failures:
        score.update(
            status="rejected",
            missing=[],
            margin=margin,
            hard_failures=failures,
            recommendation=f"未通过硬门槛：{', '.join(failures)}",
        )
        product["scores"].append(score)
        return
    if any(
        (_latest(product, "trends", window) or {}).get("conclusion") == "declining"
        for window in ("12m", "5y")
    ):
        score.update(
            status="incomplete",
            missing=["trend_declining_review"],
            margin=margin,
            recommendation=(
                "趋势为 declining，但当前规则没有定义最终通过或淘汰边界；"
                "请人工复核趋势背景后再决定。"
            ),
            manual_review_required=True,
            trend_status="unknown",
        )
        product["scores"].append(score)
        return
    trends = [
        (_latest(product, "trends", w) or {})["conclusion"] for w in ("12m", "5y")
    ]
    funnel, meta = product["funnel"], _latest(product, "meta") or {}
    values: list[dict[str, Any]] = [
        {
            "key": "demand_trend",
            "score": 5 if "rising" in trends else 4,
            "reason": "需求趋势按现有 0–5 评分规则计算。",
            "inputs": {"trends": trends},
            "calculation": "任一窗口 rising 计 5 分，否则在已支持的非负趋势中计 4 分。",
        },
        {
            "key": "creative_space",
            "score": min(
                5,
                2
                + min(1, len(funnel["creative_formats"]) // 2)
                + min(1, len(funnel["scenarios"]) // 2)
                + min(1, len(funnel["angles"]) // 2),
            ),
            "reason": "素材空间按现有 0–5 评分规则计算。",
            "inputs": {
                "formats": len(funnel["creative_formats"]),
                "scenarios": len(funnel["scenarios"]),
                "angles": len(funnel["angles"]),
            },
            "calculation": "基础 2 分；形式、场景、角度各达到 2 项分别加 1 分；最高 5 分。",
        },
        {
            "key": "profit_logistics",
            "score": 5 if margin >= 65 and e["weight_kg"] <= 1.5 else 4,
            "reason": "利润与物流按现有 0–5 评分规则计算。",
            "inputs": {"margin": margin, "weight_kg": e["weight_kg"]},
            "calculation": "贡献毛利率至少 65% 且重量不高于 1.5kg 计 5 分，否则计 4 分。",
        },
        {
            "key": "competition",
            "score": 5
            if meta["brand_concentration"] == "low"
            and meta["differentiation"] == "high"
            else 4
            if meta["brand_concentration"] != "high"
            else 2,
            "reason": "竞争强度按现有 0–5 评分规则计算。",
            "inputs": {
                "advertiser_count": meta["advertiser_count"],
                "brand_concentration": meta["brand_concentration"],
                "differentiation": meta["differentiation"],
            },
            "calculation": "低品牌集中且高差异化计 5 分；非高集中计 4 分；高集中计 2 分。",
        },
        {
            "key": "compliance_risk",
            "score": 5
            if all(
                e[key] == "low"
                for key in ("logistics_risk", "compliance_risk", "ip_risk")
            )
            else 3,
            "reason": "合规风险按现有 0–5 评分规则计算。",
            "inputs": {
                "risks": [
                    e[key] for key in ("logistics_risk", "compliance_risk", "ip_risk")
                ]
            },
            "calculation": "物流、合规、IP 风险全部为 low 计 5 分，否则计 3 分。",
        },
    ]
    dimensions = dimension_rows(values, requirements, calculated_at=_iso(now))
    total = sum(int(item["score"]) for item in values)
    score.update(
        status="complete",
        missing=[],
        total=total,
        dimensions=dimensions,
        margin=margin,
        recommendation="建议进入测试候选"
        if total >= rules["test_score"]
        else "建议进入备选"
        if total >= rules["backup_score"]
        else "建议淘汰",
    )
    product["scores"].append(score)


def _current_score(product: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (
            score
            for score in reversed(product["scores"])
            if score["revision"] == product["revision"]
        ),
        None,
    )


def _decide(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    pool, reason = (
        _text(p.get("pool"), "pool", required=True, limit=20),
        _text(p.get("reason"), "reason", required=True),
    )
    if pool not in {"test", "backup", "observe", "reject"}:
        raise WorkbenchError("invalid_pool", "Unsupported decision pool")
    score = _current_score(product)
    rules = effective_rules(state)
    threshold = rules["test_score"] if pool == "test" else rules["backup_score"]
    if pool in {"test", "backup"} and (
        not score
        or score["status"] != "complete"
        or score["total"] is None
        or score["total"] < threshold
        or score.get("hard_failures")
        or _missing(state, product, now)
    ):
        raise WorkbenchError(
            "decision_blocked",
            f"{pool} requires a current complete score of at least {threshold}",
        )
    if product.get("decision"):
        product.setdefault("decision_history", []).append(deepcopy(product["decision"]))
    _close_current_test_run(product, "stale", now)
    if product.get("test_plan"):
        product["test_plan"]["stale"], product["test_plan"]["approved"] = True, False
    product["decision"] = {
        "id": _id(),
        "pool": pool,
        "reason": reason,
        "score_id": score["id"] if score else None,
        "score_revision": score["revision"] if score else None,
        "stale": False,
        "operator": actor,
        "created_at": _iso(now),
    }


def _test_plan(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    decision = product.get("decision")
    if (
        not decision
        or decision.get("stale")
        or decision["pool"] != "test"
        or _missing(state, product, now)
    ):
        raise WorkbenchError("test_blocked", "A current test-pool decision is required")
    plan: dict[str, Any] = {
        key: _num(p.get(key), key, positive=True)
        for key in ("budget", "success_cpa", "stop_loss")
    }
    plan["days"] = _int(p.get("days"), "days", minimum=1)
    if not _bool(p.get("approved"), "approved"):
        raise WorkbenchError(
            "approval_required", "Test plan requires explicit human approval"
        )
    plan.update(
        notes=_text(p.get("notes"), "notes"),
        approved=True,
        stale=False,
        revision=product["revision"],
        operator=actor,
        created_at=_iso(now),
    )
    plan["checklist"] = [
        f"确认产品定位与受众：{product['name']}",
        f"围绕已观察钩子创作原创素材：{product.get('funnel', {}).get('hook', '待确认')}",
        "人工投放前检查商品页、预算、目标CPA和停止线。",
        "记录带来源的真实指标；工作台不会代你购买广告。",
    ]
    funnel, economics = product["funnel"], product["economics"]
    plan["preparation"] = {
        "execution_status": "未投放，需人工执行",
        "positioning": product["name"],
        "scenarios": funnel["scenarios"],
        "angles": funnel["angles"],
        "script": [
            f"0–3秒：用原创画面呈现问题，测试钩子：{funnel['hook']}",
            "3–10秒：拍摄真实使用过程与前后差异；不作未经证实的效果承诺。",
            "10–20秒：解释产品机制和适用场景，补充真实尺寸、规格或使用限制。",
            f"结尾：测试行动号召“{funnel['cta']}”，与实际售价和页面承诺保持一致。",
        ],
        "shot_list": [
            "原创问题场景",
            "真实开箱与细节",
            "连续使用演示",
            "尺寸与组合件数",
            "授权明确的证言（若有）",
        ],
        "page_checklist": [
            "首屏产品定位与CTA",
            "真实规格与使用限制",
            "物流及退货承诺",
            "真实可信评价",
            "移动端下单与支付测试",
        ],
        "price_hypothesis": {
            key: economics[key]
            for key in ("unit_price", "quantity", "aov", "bundle_reason")
        },
        "rights": "竞品素材仅用于研究；拍摄原创或取得明确授权，不直接复制。",
        "unknown": "邮件、弃购挽回与再营销效果尚无证据，不作推断。",
    }
    _close_current_test_run(product, "superseded", now)
    run_id = _id()
    plan["test_run_id"] = run_id
    product.setdefault("test_runs", []).append(
        {
            "id": run_id,
            "product_revision": product["revision"],
            "decision_id": decision["id"],
            "plan": deepcopy(plan),
            "status": "active",
            "created_at": _iso(now),
            "closed_at": None,
        }
    )
    product["test_plan"] = deepcopy(plan)


def _require_test_run(product: dict[str, Any]) -> dict[str, Any]:
    run = current_test_run(product)
    plan = run.get("plan") if run else None
    decision = product.get("decision") or {}
    if (
        not plan
        or not plan.get("approved")
        or plan.get("stale")
        or plan.get("revision") != product["revision"]
        or decision.get("stale")
        or decision.get("pool") != "test"
    ):
        raise WorkbenchError("test_blocked", "A current approved test plan is required")
    assert run is not None
    return run


def _validated_test_result(
    product: dict[str, Any],
    p: dict[str, Any],
    now: datetime,
    run: dict[str, Any],
    *,
    ignore_result_id: str | None = None,
) -> dict[str, Any]:
    start, end = (
        _day(p.get("period_start"), "period_start"),
        _day(p.get("period_end"), "period_end"),
    )
    if end < start:
        raise WorkbenchError(
            "invalid_period", "period_end must be on or after period_start"
        )
    if end > now.date():
        raise WorkbenchError("future_result", "Test period cannot be in the future")
    values = {
        key: _num(p.get(key), key)
        for key in (
            "spend",
            "impressions",
            "clicks",
            "add_to_carts",
            "checkouts",
            "orders",
            "revenue",
            "refunds",
        )
    }
    if (
        not values["orders"]
        <= values["checkouts"]
        <= values["add_to_carts"]
        <= values["clicks"]
        <= values["impressions"]
    ):
        raise WorkbenchError(
            "invalid_funnel",
            "orders <= checkouts <= add_to_carts <= clicks <= impressions is required",
        )
    if values["refunds"] > values["orders"]:
        raise WorkbenchError("invalid_refunds", "refunds cannot exceed orders")
    source = _url(p.get("source_url"), "source_url")
    for prior in active_test_results(product, run["id"]):
        if prior.get("id") == ignore_result_id:
            continue
        old_start, old_end = (
            _day(prior["period_start"], "period_start"),
            _day(prior["period_end"], "period_end"),
        )
        if prior["source_url"] == source and old_start == start and old_end == end:
            raise WorkbenchError("duplicate_result", "duplicate source and test period")
        if start <= old_end and old_start <= end:
            raise WorkbenchError("overlapping_result", "test periods cannot overlap")

    def ratio(a: float, b: float) -> float | None:
        return round(a / b * 100, 4) if b else None

    metrics = {
        "ctr": ratio(values["clicks"], values["impressions"]),
        "cpc": round(values["spend"] / values["clicks"], 4)
        if values["clicks"]
        else None,
        "cvr": ratio(values["orders"], values["clicks"]),
        "cpa": round(values["spend"] / values["orders"], 4)
        if values["orders"]
        else None,
        "aov": round(values["revenue"] / values["orders"], 4)
        if values["orders"]
        else None,
    }
    return {
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        **values,
        "source_url": source,
        "metrics": metrics,
    }


def _current_result(
    product: dict[str, Any], result_id: Any, run: dict[str, Any]
) -> dict[str, Any]:
    result = _find(product["test_results"], result_id, "test result")
    if result.get("test_run_id") != run["id"] or result.get("id") not in {
        item.get("id") for item in active_test_results(product, run["id"])
    }:
        raise WorkbenchError(
            "result_not_current", "Test result is historical or already superseded"
        )
    return result


def _test_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    run = _require_test_run(product)
    confirmed = _bool(p.get("confirmed"), "confirmed")
    product["test_results"].append(
        {
            "id": _id(),
            "test_run_id": run["id"],
            "revision": 1,
            "supersedes_id": None,
            "state": "confirmed" if confirmed else "draft",
            "confirmed": confirmed,
            **_validated_test_result(product, p, now, run),
            "reason": None,
            "operator": actor,
            "recorded_at": _iso(now),
        }
    )


def _confirm_test_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    run = _require_test_run(product)
    prior = _current_result(product, p.get("result_id"), run)
    if prior.get("state") != "draft":
        raise WorkbenchError("invalid_result_state", "Only a draft can be confirmed")
    result = deepcopy(prior)
    result.update(
        id=_id(),
        revision=int(prior.get("revision", 1)) + 1,
        supersedes_id=prior["id"],
        state="confirmed",
        confirmed=True,
        reason="Draft confirmed",
        operator=actor,
        recorded_at=_iso(now),
    )
    product["test_results"].append(result)


def _revise_test_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    run = _require_test_run(product)
    prior = _current_result(product, p.get("result_id"), run)
    reason = _text(p.get("reason"), "reason", required=True)
    confirmed = _bool(p.get("confirmed"), "confirmed")
    product["test_results"].append(
        {
            "id": _id(),
            "test_run_id": run["id"],
            "revision": int(prior.get("revision", 1)) + 1,
            "supersedes_id": prior["id"],
            "state": "confirmed" if confirmed else "draft",
            "confirmed": confirmed,
            **_validated_test_result(
                product, p, now, run, ignore_result_id=prior["id"]
            ),
            "reason": reason,
            "operator": actor,
            "recorded_at": _iso(now),
        }
    )


def _void_test_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    run = _require_test_run(product)
    prior = _current_result(product, p.get("result_id"), run)
    reason = _text(p.get("reason"), "reason", required=True)
    result = deepcopy(prior)
    result.update(
        id=_id(),
        revision=int(prior.get("revision", 1)) + 1,
        supersedes_id=prior["id"],
        state="void",
        confirmed=False,
        reason=reason,
        operator=actor,
        recorded_at=_iso(now),
    )
    product["test_results"].append(result)


def _review(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    product = _find(state["products"], p.get("product_id"), "product")
    decision = product.get("decision")
    if not decision or decision.get("stale"):
        raise WorkbenchError(
            "review_blocked", "A current decision is required before review"
        )
    real_results = [
        item for item in active_test_results(product) if item.get("confirmed")
    ]
    if decision["pool"] == "test" and not real_results:
        raise WorkbenchError(
            "review_blocked", "A tested product requires a real confirmed test result"
        )
    product["reviews"].append(
        {
            "id": _id(),
            "kind": "test" if decision["pool"] == "test" else "research",
            "conclusion": _text(p.get("conclusion"), "conclusion", required=True),
            "lessons": _text(p.get("lessons"), "lessons", required=True),
            "operator": actor,
            "created_at": _iso(now),
        }
    )
    next_keywords = p.get("next_keywords") or []
    if not isinstance(next_keywords, list):
        raise WorkbenchError("invalid_payload", "next_keywords must be a list")
    for text in next_keywords[:20]:
        before_count = len(state["keywords"])
        _add_keyword(state, {"text": text, "type": "function"}, actor, now)
        if len(state["keywords"]) == before_count:
            continue
        keyword = state["keywords"][-1]
        keyword.update(
            product_id=product["id"],
            source_quote=f"Review {product['id']}: {_text(p.get('lessons'), 'lessons')}"[
                :2_000
            ],
        )


def _automation(actor: str) -> None:
    if actor != "automation":
        raise WorkbenchError(
            "forbidden_action", "This command is available only to automation", 403
        )


def _keyword_state(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _automation(actor)
    keyword, status = (
        _find(state["keywords"], p.get("keyword_id"), "keyword"),
        _text(p.get("status"), "status", required=True, limit=20),
    )
    if status not in {"queued", "running", "blocked"}:
        raise WorkbenchError(
            "invalid_status",
            "Automation keyword status must be queued, running, or blocked",
        )
    if status in {"queued", "running"} and not keyword["approved"]:
        raise WorkbenchError(
            "approval_required", "Keyword must be approved before collection"
        )
    if status in {"queued", "running"} and not _expansion_source_is_current(
        state, keyword
    ):
        raise WorkbenchError(
            "invalid_expansion_source",
            "Expansion source must be selected again before collection",
        )
    keyword.update(
        status=status,
        message=_text(p.get("message"), "message", limit=1_000),
        operator=actor,
        updated_at=_iso(now),
    )
    if p.get("observed_at"):
        observed = _dt(p["observed_at"], "observed_at")
        if observed > now + timedelta(minutes=5):
            raise WorkbenchError(
                "future_evidence", "observed_at cannot be in the future"
            )
        keyword["collection_observed_at"] = _iso(observed)
    if p.get("evidence_id"):
        keyword["collection_evidence_id"] = _text(
            p["evidence_id"], "evidence_id", limit=2_000
        )
    if isinstance(p.get("displayed_filters"), dict):
        keyword["collection_filters"] = _bounded(p["displayed_filters"])


def _ad(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise WorkbenchError("invalid_payload", "ad must be an object")
    from rabbit_hole.domain.ad_media import normalize_ad_media

    observation = normalize_ad_observation(item)
    media = normalize_ad_media(item.get("media"))
    return {
        "id": _text(item.get("id"), "ad.id", required=True, limit=500),
        "advertiser": _text(item.get("advertiser"), "advertiser", limit=500),
        "start_date": _text(item.get("start_date"), "start_date", limit=50),
        "landing_url": _url(item.get("landing_url"), "landing_url", required=False),
        "primary_text": _text(item.get("primary_text"), "primary_text"),
        **({"media": media} if media else {}),
        "active": _bool(item.get("active"), "active"),
        **observation,
    }


def _collection_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _automation(actor)
    keyword = _find(state["keywords"], p.get("keyword_id"), "keyword")
    if not keyword["approved"]:
        raise WorkbenchError(
            "approval_required", "Keyword must be approved before collection"
        )
    if not _expansion_source_is_current(state, keyword):
        raise WorkbenchError(
            "invalid_expansion_source",
            "Expansion source changed before collection completed",
        )
    status = _text(p.get("status"), "status", required=True, limit=20)
    if status not in {"complete", "blocked"}:
        raise WorkbenchError(
            "invalid_status", "Collection status must be complete or blocked"
        )
    ads = p.get("ads")
    if not isinstance(ads, list) or len(ads) > 1_000:
        raise WorkbenchError("invalid_payload", "ads must be a bounded list")
    provenance_fields = {
        "observed_at",
        "source_url",
        "evidence_id",
        "displayed_filters",
    }
    supplied_provenance = provenance_fields.intersection(p)
    last_collection = None
    if supplied_provenance:
        if supplied_provenance != provenance_fields:
            raise WorkbenchError(
                "invalid_payload", "collection provenance must be complete"
            )
        observed = _dt(p.get("observed_at"), "observed_at")
        if observed > now + timedelta(minutes=5):
            raise WorkbenchError(
                "future_evidence", "observed_at cannot be in the future"
            )
        evidence_id = _text(
            p.get("evidence_id"), "evidence_id", required=True, limit=2_000
        )
        if not evidence_id.startswith(f"evidence/{state['market']}/"):
            raise WorkbenchError(
                "invalid_payload", "evidence_id must identify evidence for the project market"
            )
        filters = p.get("displayed_filters")
        if not isinstance(filters, dict):
            raise WorkbenchError(
                "invalid_payload", "displayed_filters must be an object"
            )
        last_collection = {
            "observed_at": _iso(observed),
            "source_url": _url(p.get("source_url"), "source_url"),
            "evidence_id": evidence_id,
            "displayed_filters": _bounded(filters),
            "recorded_at": _iso(now),
        }
    normalized = [_ad(item) for item in ads]
    existing = {item["id"]: item for item in keyword["ads"]}
    for item in normalized:
        current = existing.get(item["id"])
        if current is None:
            keyword["ads"].append(item)
            existing[item["id"]] = item
            continue
        merged = merge_ad_observation(current, item)
        current.update(
            {
                key: value
                for key, value in item.items()
                if value is not None and key != "observation_history"
            }
        )
        current.update(merged)
    keyword.update(
        status=status,
        message=_text(p.get("message"), "message", limit=1_000),
        operator=actor,
        updated_at=_iso(now),
    )
    if status != "complete":
        return
    if last_collection is not None:
        keyword["last_collection"] = last_collection
    for ad in normalized:
        url = ad["landing_url"]
        identity = _product_identity(url)
        product = next(
            (
                item
                for item in state["products"]
                if identity
                and not item.get("merged_into")
                and (
                    _product_identity(item.get("identity_key"))
                    or _product_identity(item.get("url"))
                )
                == identity
            ),
            None,
        )
        if url and product is None and len(state["products"]) < MAX_PRODUCTS:
            product = _new_product(
                ad["advertiser"] or f"Unresolved ad {ad['id']}",
                url,
                [keyword["id"]],
                now,
            )
            state["products"].append(product)
        if product:
            if keyword["id"] not in product["source_keyword_ids"]:
                product["source_keyword_ids"].append(keyword["id"])
            if not any(
                item["ad_id"] == ad["id"] and item["keyword_id"] == keyword["id"]
                for item in product["candidate_sources"]
            ):
                product["candidate_sources"].append(
                    {
                        "keyword_id": keyword["id"],
                        "ad_id": ad["id"],
                        "advertiser": ad["advertiser"],
                        "landing_url": url,
                        "recorded_at": _iso(now),
                    }
                )


def _landing_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _automation(actor)
    product, observed = (
        _find(state["products"], p.get("product_id"), "product"),
        _dt(p.get("observed_at"), "observed_at"),
    )
    if observed > now + timedelta(minutes=5):
        raise WorkbenchError("future_evidence", "observed_at cannot be in the future")
    if not isinstance(p.get("snapshot"), dict):
        raise WorkbenchError("invalid_payload", "snapshot must be an object")
    status_codes: dict[str, int | None] = {}
    for field in ("http_status_code", "browser_status_code"):
        value = p["snapshot"].get(field)
        if value is not None and (type(value) is not int or not 100 <= value <= 599):
            raise WorkbenchError(
                "invalid_payload", f"{field} must be an HTTP status code"
            )
        status_codes[field] = value
    # JSON-LD is optional web metadata, often deeper than ordinary evidence.
    # Bound it separately so an oversized optional tree cannot discard the page.
    snapshot = _bounded({key: value for key, value in p["snapshot"].items() if key != "json_ld"})
    metadata = p["snapshot"].get("json_ld", [])
    if not isinstance(metadata, list):
        raise WorkbenchError("invalid_payload", "json_ld must be an array")
    try:
        encoded = json.dumps(metadata, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise WorkbenchError("invalid_payload", "json_ld must contain valid JSON") from None
    try:
        if len(encoded.encode("utf-8")) > 100_000:
            raise WorkbenchError("limit_reached", "Structured page data exceeds 100 KB")
        snapshot["json_ld"] = _bounded(metadata, max_depth=16)
        snapshot["json_ld_status"] = "complete"
        snapshot.pop("json_ld_warning", None)
    except WorkbenchError as exc:
        if exc.code not in {"limit_reached", "text_too_long"}:
            raise
        snapshot["json_ld"] = []
        snapshot["json_ld_status"] = "omitted_limit"
        snapshot["json_ld_warning"] = "部分结构化商品数据超过保存上限，已略过；标题、正文与价格仍保留，请人工核对。"

    for field in ("requested_url", "http_final_url", "browser_final_url", "final_url"):
        if field in snapshot and snapshot[field] is not None:
            snapshot[field] = _url(snapshot[field], field)
    for field, value in status_codes.items():
        if field in p["snapshot"]:
            snapshot[field] = value
    mode = snapshot.get("rendering_mode")
    if mode is not None and mode not in {"http", "browser", "firecrawl"}:
        raise WorkbenchError(
            "invalid_payload", "rendering_mode must be http, browser or firecrawl"
        )
    if product.get("landing_snapshot"):
        product.setdefault("landing_history", []).append(
            deepcopy(product["landing_snapshot"])
        )
    product["landing_snapshot"] = {
        **snapshot,
        "source_url": _url(p.get("source_url"), "source_url"),
        "observed_at": _iso(observed),
        "confirmed": False,
        "provenance": "automatic",
        "recorded_at": _iso(now),
        "identity_revision": _identity_revision(product),
    }
    _invalidate(product, now)


def _trends_result(
    state: dict[str, Any], p: dict[str, Any], actor: str, now: datetime
) -> None:
    _automation(actor)
    product, query = (
        _find(state["products"], p.get("product_id"), "product"),
        _text(p.get("query"), "query", required=True, limit=500),
    )
    entries = p.get("evidence") or []
    if not isinstance(entries, list) or len(entries) > 10:
        raise WorkbenchError(
            "invalid_payload", "automatic trends evidence must be bounded"
        )
    normalized = []
    for item in entries:
        observed = _dt(item.get("observed_at"), "observed_at")
        window, conclusion = (
            _text(item.get("window"), "window", required=True, limit=10),
            _text(item.get("conclusion"), "conclusion", required=True, limit=30),
        )
        if observed > now + timedelta(minutes=5):
            raise WorkbenchError(
                "future_evidence", "observed_at cannot be in the future"
            )
        if window not in {"12m", "5y"} or conclusion not in TREND_CONCLUSIONS:
            raise WorkbenchError(
                "invalid_trends_evidence", "invalid automatic Trends evidence"
            )
        if item.get("market", "US") != state["market"]:
            raise WorkbenchError("invalid_trends_evidence", "Trends market must match the project")
        try:
            classification = PersistedTrendClassification.model_validate(
                item.get("classification")
            )
            series = TrendSeries(
                query=query,
                geo=state["market"],
                window=window,
                points=item.get("points", []),
            )
            expected_classification = classify_trend_window(series)
        except ValueError as exc:
            raise WorkbenchError(
                "invalid_trends_evidence",
                "automatic Trends evidence requires a versioned classification",
            ) from exc
        if (
            classification.label.value != conclusion
            or classification != expected_classification
        ):
            raise WorkbenchError(
                "invalid_trends_evidence",
                "automatic Trends conclusion must match its classification",
            )
        normalized.append(
            {
                "id": _id(),
                "query": query,
                "market": state["market"],
                "window": window,
                "conclusion": conclusion,
                "classification": classification.model_dump(mode="json"),
                "points": _bounded(item.get("points", [])),
                "source_url": _url(item.get("source_url"), "source_url"),
                "observed_at": _iso(observed),
                "confirmed": False,
                "provenance": "automatic",
                "recorded_at": _iso(now),
                "identity_revision": _identity_revision(product),
            }
        )
    product.setdefault("automatic_trends", []).extend(normalized)
    if p.get("error"):
        product["automatic_trends_error"] = _text(p["error"], "error", limit=2_000)
    _invalidate(product, now)


_HANDLERS: dict[
    str, Callable[[dict[str, Any], dict[str, Any], str, datetime], None]
] = {
    "configure_rules": _configure_rules,
    "configure_collection": _configure_collection,
    "set_logistics_profile": _set_logistics_profile,
    "add_keyword": _add_keyword,
    "edit_keyword": _edit_keyword,
    "archive_keyword": _archive_keyword,
    "restore_keyword": _restore_keyword,
    "approve_keyword": _approve_keyword,
    "add_product": _add_product,
    "merge_products": _merge_products,
    "link_product_offers": _link_product_offers,
    "split_product_offer": _split_product_offer,
    "undo_offer_link": _undo_offer_link,
    "triage_product": _triage_product,
    "restore_product": _restore_product,
    "undo_triage_product": _undo_triage_product,
    "focus_product": _focus_product,
    "confirm_product": _confirm_product,
    "confirm_creatives": _confirm_creatives,
    "identify": _identify,
    "evidence": _evidence,
    "funnel": _funnel,
    "add_creative_reference": _add_creative_reference,
    "record_funnel_investigation": _record_funnel_investigation,
    "economics": _economics,
    "add_sales_estimate": _add_sales_estimate,
    "evaluate": _evaluate,
    "decide": _decide,
    "test_plan": _test_plan,
    "test_result": _test_result,
    "confirm_test_result": _confirm_test_result,
    "revise_test_result": _revise_test_result,
    "void_test_result": _void_test_result,
    "review": _review,
    "keyword_state": _keyword_state,
    "collection_result": _collection_result,
    "landing_result": _landing_result,
    "verification_result": _verification_result,
    "trends_result": _trends_result,
}
