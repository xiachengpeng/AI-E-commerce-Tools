"""Versioned evidence requirements for workbench scoring readiness."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from rabbit_hole.domain.freshness import evidence_freshness
from rabbit_hole.domain.rules import (
    effective_evidence_requirement_levels,
    validate_evidence_requirement_patch,
)

__all__ = [
    "REQUIREMENTS_VERSION",
    "EvidenceRequirement",
    "blocking_requirement_keys",
    "requirement_catalog",
    "requirement_statuses",
    "requirement_summary",
    "validate_evidence_requirement_patch",
]

REQUIREMENTS_VERSION = "workbench-evidence-v1"
RequirementLevel = Literal[
    "required",
    "recommended",
    "optional",
    "conditional_required",
    "not_applicable",
]
RequirementStatus = Literal["pass", "fail", "unknown", "not_applicable"]


@dataclass(frozen=True, slots=True)
class EvidenceRequirement:
    key: str
    label: str
    level: RequirementLevel
    applies: bool
    reason: str

    def public_view(self) -> dict[str, Any]:
        return asdict(self)


_BASE_REQUIREMENTS: tuple[tuple[str, str, RequirementLevel, str], ...] = (
    ("coarse_screen", "广告粗筛", "required", "进入深度研究前必须有可审计的粗筛证据。"),
    ("meta", "Meta 竞争证据", "required", "SOP 将 Meta 广告证据作为核心验证来源。"),
    ("trends_12m", "Google Trends 近 12 个月", "required", "需求趋势需要短周期证据。"),
    ("trends_5y", "Google Trends 近 5 年", "required", "需求趋势需要长周期证据。"),
    ("trends_query_match", "趋势查询一致性", "required", "两个趋势窗口必须使用同一查询词。"),
    ("funnel", "广告与落地页漏斗", "required", "评分前必须确认广告和页面要素。"),
    ("economics", "经济模型与风险", "required", "评分前必须确认完整成本、报价和风险。"),
    (
        "certification_verification",
        "适用认证核验",
        "conditional_required",
        "只有产品被明确标记为需要认证时才适用。",
    ),
)
_CHANNEL_LABELS = {
    "pinterest": "Pinterest 辅助证据",
    "tiktok": "TikTok 辅助证据",
    "amazon": "Amazon 辅助证据",
    "similarweb": "Similarweb 流量证据",
}
_BLOCKING_LEVELS = frozenset({"required", "conditional_required"})


def requirement_catalog(
    project: dict[str, Any], product: dict[str, Any] | None = None
) -> list[EvidenceRequirement]:
    economics = product.get("economics", {}) if product else {}
    certification_required = economics.get("certification_required") is True
    catalog = [
        EvidenceRequirement(
            key=key,
            label=label,
            level=level,
            applies=(key != "certification_verification" or certification_required),
            reason=reason,
        )
        for key, label, level, reason in _BASE_REQUIREMENTS
    ]
    for key, level in effective_evidence_requirement_levels(project).items():
        catalog.append(
            EvidenceRequirement(
                key=key,
                label=_CHANNEL_LABELS[key],
                level=level,  # type: ignore[arg-type]
                applies=True,
                reason=(
                    "该项目规则已明确提升为评分必需证据。"
                    if level == "required"
                    else "SOP 将其作为多渠道验证来源，但未规定为绝对评分前置项。"
                ),
            )
        )
    return catalog


def _identity_revision(product: dict[str, Any]) -> int:
    value = product.get("identity_revision", 1)
    return value if type(value) is int and value >= 1 else 1


def _current(record: dict[str, Any], product: dict[str, Any]) -> bool:
    revision = record.get("identity_revision", 1)
    return type(revision) is int and revision == _identity_revision(product)


def _latest(
    product: dict[str, Any], channel: str, window: str | None = None
) -> tuple[dict[str, Any] | None, bool]:
    all_matches = [
        item
        for item in product.get("evidence", [])
        if item.get("channel") == channel
        and (window is None or item.get("window") == window)
    ]
    current = [item for item in all_matches if _current(item, product)]
    return (current[-1] if current else None, bool(all_matches and not current))


def _record_evidence_id(kind: str, record: dict[str, Any]) -> str | None:
    if record.get("id"):
        return str(record["id"])
    changed_at = record.get("recorded_at") or record.get("confirmed_at")
    if not changed_at:
        return None
    return f"{kind}:{record.get('identity_revision', 1)}:{changed_at}"


def _parsed_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(UTC)


def _explicit_freshness(record: dict[str, Any] | None, now: datetime) -> str:
    if record is None:
        return "unknown"
    try:
        return str(
            evidence_freshness(
                record.get("observed_at"),
                record.get("review_due_at"),
                record.get("valid_until"),
                now,
            )["status"]
        )
    except ValueError:
        return "unknown"


def _status_row(
    requirement: EvidenceRequirement,
    status: RequirementStatus,
    reason: str,
    *,
    evidence_ids: list[str] | None = None,
    stale: bool = False,
    blocking_key: str | None = None,
) -> dict[str, Any]:
    blocks = bool(
        requirement.applies
        and requirement.level in _BLOCKING_LEVELS
        and status not in {"pass", "not_applicable"}
    )
    return {
        **requirement.public_view(),
        "status": status,
        "status_reason": reason,
        "blocks_scoring": blocks,
        "evidence_ids": evidence_ids or [],
        "stale": stale,
        "blocking_key": blocking_key or requirement.key,
    }


def _channel_status(
    requirement: EvidenceRequirement, product: dict[str, Any], now: datetime
) -> dict[str, Any]:
    record, stale = _latest(product, requirement.key)
    if record is None:
        return _status_row(
            requirement,
            "unknown",
            "当前商品身份下尚无该渠道证据。",
            stale=stale,
        )
    evidence_id = _record_evidence_id(requirement.key, record)
    evidence_ids = [evidence_id] if evidence_id else []
    freshness = _explicit_freshness(record, now)
    if freshness == "expired":
        return _status_row(
            requirement,
            "unknown",
            "该渠道证据已超过明确有效期限，需要重新核对。",
            evidence_ids=evidence_ids,
            stale=True,
        )
    if record.get("not_applicable") is True and record.get("reason"):
        return _status_row(
            requirement,
            "not_applicable",
            str(record["reason"]),
            evidence_ids=evidence_ids,
        )
    if not record.get("confirmed"):
        return _status_row(
            requirement,
            "unknown",
            "已有记录尚未人工确认。",
            evidence_ids=evidence_ids,
        )
    if requirement.key == "similarweb" and record.get("direct_share") is None:
        return _status_row(
            requirement,
            "unknown",
            "Similarweb 记录缺少可靠的直接流量占比。",
            evidence_ids=evidence_ids,
        )
    return _status_row(
        requirement,
        "pass",
        "已有当前身份下的人工确认记录。",
        evidence_ids=evidence_ids,
        stale=freshness == "stale",
    )


def _economics_status(
    requirement: EvidenceRequirement,
    product: dict[str, Any],
    now: datetime,
    quote_valid_days: int,
) -> dict[str, Any]:
    economics = product.get("economics", {})
    if not isinstance(economics, dict) or not economics or not _current(economics, product):
        return _status_row(requirement, "unknown", "当前商品身份下尚无经济模型证据。")
    evidence_id = _record_evidence_id("economics", economics)
    evidence_ids = [evidence_id] if evidence_id else []
    required = (
        "unit_price",
        "quantity",
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
        "quote_source",
        "quote_date",
        "quote_confirmed",
        "logistics_risk",
        "compliance_risk",
        "ip_risk",
    )
    if any(economics.get(key) is None or economics.get(key) == "" for key in required):
        return _status_row(
            requirement,
            "unknown",
            "成本、报价或风险字段不完整。",
            evidence_ids=evidence_ids,
            blocking_key="economics",
        )
    if economics.get("quote_confirmed") is not True:
        return _status_row(
            requirement,
            "unknown",
            "供应商报价尚未人工确认。",
            evidence_ids=evidence_ids,
            blocking_key="confirmed_supplier_quote",
        )
    quote_at = _parsed_datetime(economics.get("quote_date"))
    if (
        quote_at is None
        or quote_at > now + timedelta(minutes=5)
        or now - quote_at > timedelta(days=quote_valid_days)
    ):
        return _status_row(
            requirement,
            "unknown",
            "供应商报价不在项目规则规定的有效期内。",
            evidence_ids=evidence_ids,
            blocking_key="fresh_supplier_quote",
        )
    if economics.get("quantity", 1) > 1 and not economics.get("bundle_reason"):
        return _status_row(
            requirement,
            "unknown",
            "多件组合缺少业务理由。",
            evidence_ids=evidence_ids,
            blocking_key="bundle_reason",
        )
    return _status_row(
        requirement, "pass", "成本、报价和基础风险字段已确认。", evidence_ids=evidence_ids
    )


def requirement_statuses(
    project: dict[str, Any], product: dict[str, Any], now: datetime
) -> list[dict[str, Any]]:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must include a timezone")
    now = now.astimezone(UTC)
    raw_rules = project.get("rules")
    rules: dict[str, Any] = raw_rules if isinstance(raw_rules, dict) else {}
    quote_valid_days = rules.get("quote_valid_days", 14)
    if type(quote_valid_days) is not int or quote_valid_days <= 0:
        quote_valid_days = 14
    catalog = requirement_catalog(project, product)
    by_key = {item.key: item for item in catalog}
    rows: list[dict[str, Any]] = []

    coarse = by_key["coarse_screen"]
    gate = (product.get("gates") or {}).get("coarse_screen") or {}
    raw_coarse_status = gate.get("status")
    coarse_status: RequirementStatus
    if raw_coarse_status in {"pass", "fail", "unknown", "not_applicable"}:
        coarse_status = raw_coarse_status
    else:
        coarse_status = (
            "pass"
            if product.get("identification", {}).get("passed")
            else "unknown"
        )
    rows.append(
        _status_row(
            coarse,
            coarse_status,
            str(gate.get("reason") or "粗筛证据尚未完整确认。"),
            evidence_ids=[str(value) for value in gate.get("evidence_ids", [])],
        )
    )

    meta_requirement = by_key["meta"]
    meta, meta_stale = _latest(product, "meta")
    if not meta or not meta.get("confirmed"):
        rows.append(
            _status_row(
                meta_requirement,
                "unknown",
                "当前商品身份下缺少人工确认的 Meta 竞争证据。",
                stale=meta_stale,
                blocking_key="meta",
            )
        )
    else:
        meta_id = _record_evidence_id("meta", meta)
        meta_freshness = _explicit_freshness(meta, now)
        if meta_freshness == "expired":
            rows.append(
                _status_row(
                    meta_requirement,
                    "unknown",
                    "Meta 证据已超过明确有效期限，需要重新核对。",
                    evidence_ids=[meta_id] if meta_id else [],
                    stale=True,
                )
            )
        elif any(
            meta.get(key) is None
            for key in ("advertiser_count", "brand_concentration", "differentiation")
        ):
            rows.append(
                _status_row(
                    meta_requirement,
                    "unknown",
                    "Meta 记录缺少竞争度或差异化字段。",
                    evidence_ids=[meta_id] if meta_id else [],
                    blocking_key="meta_competition",
                )
            )
        else:
            rows.append(
                _status_row(
                    meta_requirement,
                    "pass",
                    "Meta 竞争证据已人工确认。",
                    evidence_ids=[meta_id] if meta_id else [],
                    stale=meta_freshness == "stale",
                )
            )

    trend_records: dict[str, dict[str, Any] | None] = {}
    for window in ("12m", "5y"):
        requirement = by_key[f"trends_{window}"]
        record, stale = _latest(product, "trends", window)
        freshness = _explicit_freshness(record, now)
        trend_records[window] = None if freshness == "expired" else record
        evidence_id = _record_evidence_id(f"trends_{window}", record or {})
        if (
            record is None
            or freshness == "expired"
            or not record.get("confirmed")
            or record.get("conclusion") == "insufficient-data"
        ):
            rows.append(
                _status_row(
                    requirement,
                    "unknown",
                    f"{window} 趋势证据缺失、未确认或数据不足。",
                    evidence_ids=[evidence_id] if evidence_id else [],
                    stale=stale or freshness in {"stale", "expired"},
                )
            )
        else:
            rows.append(
                _status_row(
                    requirement,
                    "pass",
                    f"{window} 趋势证据已人工确认。",
                    evidence_ids=[evidence_id] if evidence_id else [],
                    stale=freshness == "stale",
                )
            )
    query_requirement = by_key["trends_query_match"]
    trend_queries = {
        str(record.get("query", "")).strip().casefold()
        for record in trend_records.values()
        if record is not None and record.get("query")
    }
    if len(trend_records) < 2 or any(record is None for record in trend_records.values()):
        rows.append(
            _status_row(
                query_requirement,
                "unknown",
                "两个趋势窗口尚未完整，暂不能核对查询一致性。",
            )
        )
    elif len(trend_queries) == 1:
        rows.append(
            _status_row(query_requirement, "pass", "两个趋势窗口使用同一查询词。")
        )
    else:
        rows.append(
            _status_row(
                query_requirement,
                "fail",
                "两个趋势窗口使用了不同查询词。",
                blocking_key="trends_query_mismatch",
            )
        )

    for key in _CHANNEL_LABELS:
        rows.append(_channel_status(by_key[key], product, now))

    funnel_requirement = by_key["funnel"]
    funnel = product.get("funnel", {})
    funnel_fields = ("hook", "creative_formats", "scenarios", "angles", "cta", "source_url")
    funnel_id = _record_evidence_id("funnel", funnel) if isinstance(funnel, dict) else None
    if (
        not isinstance(funnel, dict)
        or not funnel
        or not _current(funnel, product)
        or not funnel.get("confirmed")
        or not all(funnel.get(key) for key in funnel_fields)
    ):
        rows.append(
            _status_row(funnel_requirement, "unknown", "漏斗要素尚未完整人工确认。")
        )
    else:
        rows.append(
            _status_row(
                funnel_requirement,
                "pass",
                "广告与落地页漏斗要素已确认。",
                evidence_ids=[funnel_id] if funnel_id else [],
            )
        )

    rows.append(
        _economics_status(
            by_key["economics"], product, now, int(quote_valid_days)
        )
    )
    certification = by_key["certification_verification"]
    economics = product.get("economics", {})
    economics_id = (
        _record_evidence_id("economics", economics)
        if isinstance(economics, dict)
        else None
    )
    if economics.get("certification_required") is True:
        rows.append(
            _status_row(
                certification,
                "pass" if economics.get("certification_verified") is True else "unknown",
                "所需认证已核验。"
                if economics.get("certification_verified") is True
                else "已确认需要认证，但尚无已核验的认证证据。",
                evidence_ids=[economics_id] if economics_id else [],
            )
        )
    elif economics.get("certification_required") is False:
        rows.append(
            _status_row(
                certification,
                "not_applicable",
                "经济模型已明确确认该商品不要求额外认证。",
                evidence_ids=[economics_id] if economics_id else [],
            )
        )
    else:
        rows.append(
            _status_row(
                certification,
                "unknown",
                "是否需要认证尚未确认。",
                evidence_ids=[economics_id] if economics_id else [],
            )
        )
    return rows


def requirement_summary(statuses: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "required_gaps": sum(bool(item.get("blocks_scoring")) for item in statuses),
        "recommended_gaps": sum(
            item.get("level") == "recommended"
            and item.get("status") in {"fail", "unknown"}
            for item in statuses
        ),
        "unknown": sum(item.get("status") == "unknown" for item in statuses),
        "stale": sum(bool(item.get("stale")) for item in statuses),
        "not_applicable": sum(
            item.get("status") == "not_applicable" for item in statuses
        ),
    }


def blocking_requirement_keys(statuses: list[dict[str, Any]]) -> list[str]:
    return list(
        dict.fromkeys(
            str(item.get("blocking_key") or item["key"])
            for item in statuses
            if item.get("blocks_scoring")
        )
    )
