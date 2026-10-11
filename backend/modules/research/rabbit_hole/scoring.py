"""Deterministic, order-level economics and product evaluation rules."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, ClassVar

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from rabbit_hole.config import MarketSettings
from rabbit_hole.domain.legacy import EvidenceTrust
from rabbit_hole.input_urls import canonical_supplier_quote_source

ZERO = Decimal(0)
HUNDRED = Decimal(100)
MONEY_QUANTUM = Decimal("0.01")
PERCENT_QUANTUM = Decimal("0.1")
NON_NEGATIVE_TRENDS = {"rising", "stable-high", "seasonal"}
REQUIRED_EVIDENCE_FIELDS: tuple[str, ...] = (
    "active_days",
    "verified_creatives",
    "trend_12m",
    "trend_5y",
    "logistics_difficulty",
    "compliance_risk",
    "ip_risk",
    "creative_formats",
    "creative_scenarios",
    "creative_hooks",
    "ugc_or_demo",
    "advertiser_count",
    "search_truncated",
    "query_coverage_verified",
    "brand_concentration",
    "differentiation",
    "certification_required",
    "unit_price",
    "expected_aov",
    "bundle_quantity",
    "goods_cost",
    "shipping",
    "packaging",
    "tax_and_duty",
    "acquisition_cost",
    "packed_weight_kg",
    "supplier_quote",
)
CONDITIONAL_EVIDENCE_FIELDS = ("certification_verified",)
OPTIONAL_SCORING_FIELDS = {
    "advertiser_count",
    "search_truncated",
    "query_coverage_verified",
    "brand_concentration",
    "differentiation",
}
REQUIRED_EVIDENCE_FIELDS = tuple(
    field for field in REQUIRED_EVIDENCE_FIELDS if field not in OPTIONAL_SCORING_FIELDS
)
AUDITED_EVIDENCE_FIELDS = REQUIRED_EVIDENCE_FIELDS + CONDITIONAL_EVIDENCE_FIELDS


def _decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"invalid decimal value: {value!r}") from exc


def _lower(value: str | None) -> str | None:
    return value.strip().lower() if isinstance(value, str) else value


class FrozenModel(BaseModel):
    model_config = ConfigDict(
        frozen=True, populate_by_name=True, hide_input_in_errors=True
    )


class OrderEconomics(FrozenModel):
    """Costs and prices for one expected customer order, not one unit."""

    unit_price: Decimal = Field(ge=ZERO)
    bundle_quantity: int = Field(ge=1)
    expected_aov: Decimal = Field(gt=ZERO)
    goods_cost: Decimal | None = Field(default=None, ge=ZERO)
    shipping: Decimal | None = Field(default=None, ge=ZERO)
    packaging: Decimal | None = Field(default=None, ge=ZERO)
    tax_and_duty: Decimal | None = Field(default=None, ge=ZERO)
    acquisition_cost: Decimal | None = Field(default=None, ge=ZERO)
    packed_weight_kg: Decimal | None = Field(default=None, ge=ZERO)
    supplier_quote_unit_cost: Decimal | None = Field(default=None, ge=ZERO)
    supplier_quote_bundle_cost: Decimal | None = Field(default=None, ge=ZERO)
    supplier_quote_confirmed: bool | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "supplier_quote_confirmed", "supplier_quote_verified"
        ),
    )
    supplier_quote_valid: bool | None = None
    supplier_quote_collected_at: datetime | None = None
    supplier_quote_trust: EvidenceTrust | None = None
    supplier_quote_source: str | None = None
    bundle_evidence_trust: EvidenceTrust | None = None
    bundle_justification: str | None = None
    cost_trust: dict[str, EvidenceTrust] = Field(default_factory=dict)
    order_trust: dict[str, EvidenceTrust] = Field(default_factory=dict)

    _decimal_fields: ClassVar[tuple[str, ...]] = (
        "unit_price",
        "expected_aov",
        "goods_cost",
        "shipping",
        "packaging",
        "tax_and_duty",
        "acquisition_cost",
        "packed_weight_kg",
        "supplier_quote_unit_cost",
        "supplier_quote_bundle_cost",
    )

    @field_validator(*_decimal_fields, mode="before")
    @classmethod
    def convert_decimals(cls, value: Any) -> Any:
        return None if value is None else _decimal(value)

    @field_validator("supplier_quote_source", mode="before")
    @classmethod
    def validate_supplier_quote_source(cls, value: object) -> str | None:
        """Accept only a bounded, directly revisitable supplier quote URL."""

        return canonical_supplier_quote_source(value)

    @model_validator(mode="after")
    def validate_quote_consistency(self) -> OrderEconomics:
        if (
            self.supplier_quote_bundle_cost is not None
            and self.goods_cost is not None
            and self.goods_cost != self.supplier_quote_bundle_cost
        ):
            raise ValueError("goods_cost is inconsistent with supplier quote")
        if self.supplier_quote_unit_cost is not None and self.goods_cost is not None:
            expected = self.supplier_quote_unit_cost * self.bundle_quantity
            if self.goods_cost != expected:
                raise ValueError("goods_cost is inconsistent with supplier quote")
        return self


class EvidenceSnapshot(FrozenModel):
    """Normalized evidence used by coarse screening and the five dimensions."""

    active_days: int | None = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices("active_days", "meta_active_days"),
    )
    verified_creatives: int | None = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices("verified_creatives", "meta_creatives"),
    )
    trend_12m: str | None = Field(
        default=None, validation_alias=AliasChoices("trend_12m", "trend_12_month")
    )
    trend_5y: str | None = Field(
        default=None, validation_alias=AliasChoices("trend_5y", "trend_5_year")
    )
    logistics_difficulty: str | None = None
    compliance_risk: str | None = None
    ip_risk: str | None = None
    creative_formats: tuple[str, ...] | None = None
    creative_scenarios: tuple[str, ...] | None = None
    creative_hooks: tuple[str, ...] | None = None
    ugc_or_demo: bool | None = None
    advertiser_count: int | None = Field(default=None, ge=0)
    search_truncated: bool | None = None
    query_coverage_verified: bool | None = None
    brand_concentration: str | None = None
    differentiation: str | None = None
    certification_required: bool | None = None
    certification_verified: bool | None = None
    supplier_quote_trust: EvidenceTrust | None = None
    trust: dict[str, EvidenceTrust] = Field(default_factory=dict)

    _lower_fields: ClassVar[tuple[str, ...]] = (
        "trend_12m",
        "trend_5y",
        "logistics_difficulty",
        "compliance_risk",
        "ip_risk",
        "brand_concentration",
        "differentiation",
    )

    @field_validator(*_lower_fields, mode="before")
    @classmethod
    def normalize_labels(cls, value: Any, info: Any) -> Any:
        value = _lower(value)
        if value is None:
            return None
        allowed = (
            {
                "rising",
                "stable-high",
                "seasonal",
                "declining",
                "peaked",
                "insufficient-data",
            }
            if info.field_name.startswith("trend_")
            else {"low", "medium", "high", "unknown"}
        )
        if info.field_name == "logistics_difficulty":
            allowed |= {"oversized", "fragile", "infeasible"}
        if value not in allowed:
            raise ValueError("unsupported normalized evidence label")
        return value

    @field_validator(
        "creative_formats", "creative_scenarios", "creative_hooks", mode="before"
    )
    @classmethod
    def normalize_lists(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, str):
            value = value.split("|")
        return tuple(str(item).strip().lower() for item in value if str(item).strip())


class EvaluationInput(FrozenModel):
    product_name: str | None = None
    market: MarketSettings
    order: OrderEconomics
    meta: EvidenceSnapshot


class MarginResult(FrozenModel):
    expected_aov: Decimal
    payment_fee: Decimal
    loss_reserve: Decimal
    contribution_profit: Decimal
    margin_percent: Decimal

    @property
    def payment_fee_display(self) -> Decimal:
        return self.payment_fee.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)

    @property
    def loss_reserve_display(self) -> Decimal:
        return self.loss_reserve.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)

    @property
    def margin_percent_display(self) -> Decimal:
        return self.margin_percent.quantize(PERCENT_QUANTUM, rounding=ROUND_HALF_UP)


class EvaluationResult(FrozenModel):
    status: str
    suggestion: str | None = None
    margin: MarginResult | None = None
    hard_gate_failures: tuple[str, ...] = ()
    scores: dict[str, int] = Field(default_factory=dict)
    total: int | None = None
    reasons: tuple[str, ...] = ()
    missing_fields: tuple[str, ...] = ()
    dimension_explanations: dict[str, str] = Field(default_factory=dict)
    gate_explanations: dict[str, str] = Field(default_factory=dict)

    @classmethod
    def incomplete(cls, fields: list[str]) -> EvaluationResult:
        return cls(
            status="待补充证据",
            missing_fields=tuple(fields),
            reasons=("关键数据不完整",),
        )

    @classmethod
    def observe(cls, reasons: list[str]) -> EvaluationResult:
        return cls(status="观察池", suggestion="观察池", reasons=tuple(reasons))

    @classmethod
    def review(
        cls,
        margin: MarginResult,
        failures: list[str],
        scores: dict[str, int],
        suggestion: str,
    ) -> EvaluationResult:
        return cls(
            status="待人工复核",
            suggestion=suggestion,
            margin=margin,
            hard_gate_failures=tuple(failures),
            scores=scores,
            total=sum(scores.values()),
        )


@dataclass(frozen=True, slots=True)
class CoarseScreen:
    passed: bool
    reasons: list[str]


def _rate(value: Any) -> Decimal:
    """Convert a percentage expressed as e.g. 2.9 to a ratio."""
    return _decimal(value) / HUNDRED


def calculate_margin(order: OrderEconomics, market: MarketSettings) -> MarginResult:
    required = (
        "goods_cost",
        "shipping",
        "packaging",
        "tax_and_duty",
        "acquisition_cost",
    )
    missing = [name for name in required if getattr(order, name) is None]
    if missing:
        raise ValueError(f"missing order costs: {', '.join(missing)}")
    payment_percent = getattr(market, "payment_percent", None)
    payment_fixed = getattr(market, "payment_fixed", None)
    reserve_percent = getattr(market, "loss_reserve_percent", None)
    if payment_percent is None or payment_fixed is None or reserve_percent is None:
        raise ValueError("payment and reserve rates are required")

    expected_aov = _decimal(order.expected_aov)
    payment_fee = expected_aov * _rate(payment_percent) + _decimal(payment_fixed)
    loss_reserve = expected_aov * _rate(reserve_percent)
    goods_cost = _decimal(order.goods_cost)
    shipping = _decimal(order.shipping)
    packaging = _decimal(order.packaging)
    tax_and_duty = _decimal(order.tax_and_duty)
    acquisition_cost = _decimal(order.acquisition_cost)
    total_cost = (
        goods_cost
        + shipping
        + packaging
        + tax_and_duty
        + acquisition_cost
        + payment_fee
        + loss_reserve
    )
    contribution_profit = expected_aov - total_cost
    margin_percent = contribution_profit / expected_aov * HUNDRED
    return MarginResult(
        expected_aov=expected_aov,
        payment_fee=payment_fee,
        loss_reserve=loss_reserve,
        contribution_profit=contribution_profit,
        margin_percent=margin_percent,
    )


def _trust_missing(evidence: EvidenceSnapshot, field: str) -> bool:
    return evidence.trust.get(field) is EvidenceTrust.UNKNOWN


def _trust_not_verified(evidence: EvidenceSnapshot, field: str) -> bool:
    return evidence.trust.get(field) is not EvidenceTrust.VERIFIED


def _supplier_quote_is_verified(data: EvaluationInput) -> bool:
    trusts = tuple(
        trust
        for trust in (
            data.order.supplier_quote_trust,
            data.order.order_trust.get("supplier_quote"),
            data.meta.supplier_quote_trust,
            data.meta.trust.get("supplier_quote"),
        )
        if trust is not None
    )
    return bool(trusts) and all(trust is EvidenceTrust.VERIFIED for trust in trusts)


def _supplier_quote_requires_auditable_source(data: EvaluationInput) -> bool:
    """A verified or human-confirmed quote must be directly revisitable."""

    order = data.order
    return (
        order.supplier_quote_confirmed is True
        or order.supplier_quote_valid is True
        or _supplier_quote_is_verified(data)
    )


def required_missing_fields(
    data: EvaluationInput, *, now: datetime | None = None
) -> list[str]:
    missing: list[str] = []
    if not data.product_name or not data.product_name.strip():
        missing.append("product_name")
    for field in (
        "unit_price",
        "expected_aov",
        "bundle_quantity",
        "goods_cost",
        "shipping",
        "packaging",
        "tax_and_duty",
        "acquisition_cost",
        "packed_weight_kg",
    ):
        if getattr(data.order, field) is None:
            missing.append(field)
    for field in (
        "goods_cost",
        "shipping",
        "packaging",
        "tax_and_duty",
        "acquisition_cost",
        "packed_weight_kg",
    ):
        if data.order.cost_trust.get(field) is not EvidenceTrust.VERIFIED:
            missing.append(f"{field}_evidence")
    for field in ("unit_price", "expected_aov", "bundle_quantity"):
        trust = data.order.order_trust.get(field)
        if trust is not EvidenceTrust.VERIFIED:
            missing.append(f"{field}_evidence")
    if (
        data.order.supplier_quote_unit_cost is None
        and data.order.supplier_quote_bundle_cost is None
    ):
        missing.append("supplier_quote")
    for field in (
        "active_days",
        "verified_creatives",
    ):
        if getattr(data.meta, field) is None or _trust_not_verified(data.meta, field):
            missing.append(field)
    for field in (
        "trend_12m",
        "trend_5y",
        "logistics_difficulty",
        "compliance_risk",
        "ip_risk",
        "creative_formats",
        "creative_scenarios",
        "creative_hooks",
        "ugc_or_demo",
        "advertiser_count",
        "search_truncated",
        "query_coverage_verified",
        "brand_concentration",
        "differentiation",
        "certification_required",
    ):
        if field in OPTIONAL_SCORING_FIELDS:
            continue
        if getattr(data.meta, field) is None or _trust_not_verified(data.meta, field):
            missing.append(field)
    if not _supplier_quote_is_verified(data):
        missing.append("supplier_quote")
    quote_at = data.order.supplier_quote_collected_at
    if (
        data.order.supplier_quote_valid is not True
        or data.order.supplier_quote_confirmed is not True
        or quote_at is None
        or quote_at.tzinfo is None
        or not timedelta(0)
        <= (now or datetime.now(UTC)) - quote_at
        <= timedelta(days=14)
    ):
        missing.append("supplier_quote")
    if (
        data.order.bundle_quantity > 1 or data.order.unit_price < data.market.min_aov
    ) and (
        data.order.bundle_evidence_trust is not EvidenceTrust.VERIFIED
        or not (data.order.bundle_justification or "").strip()
    ):
        missing.append("bundle_evidence")
    for field in (
        "trend_12m",
        "trend_5y",
        "logistics_difficulty",
        "compliance_risk",
        "ip_risk",
    ):
        if getattr(data.meta, field) in {"unknown", "insufficient-data"}:
            missing.append(field)
    if (
        _supplier_quote_requires_auditable_source(data)
        and not data.order.supplier_quote_source
    ):
        missing.append("supplier_quote_source")
    if data.meta.certification_required is True and (
        data.meta.certification_verified is None
        or data.meta.trust.get("certification_verified") is not EvidenceTrust.VERIFIED
    ):
        missing.append("certification_verified")
    for field in ("payment_percent", "payment_fixed", "loss_reserve_percent"):
        if getattr(data.market, field, None) is None:
            missing.append(field)
    return missing


def meta_coarse_screen(meta: EvidenceSnapshot) -> CoarseScreen:
    reasons: list[str] = []
    if meta.active_days is None or meta.active_days < 30:
        reasons.append("Meta 可观察活跃时长不足 30 天")
    if meta.verified_creatives is None or meta.verified_creatives < 3:
        reasons.append("当前活跃且确认不同的创意少于 3 个")
    if _trust_not_verified(meta, "active_days") or _trust_not_verified(
        meta, "verified_creatives"
    ):
        reasons.append("Meta 粗筛所需活跃时长与创意证据必须为 verified")
    return CoarseScreen(not reasons, reasons)


def hard_gate_failures(data: EvaluationInput, margin: MarginResult) -> list[str]:
    order, meta = data.order, data.meta
    failures: list[str] = []
    minimum = _decimal(data.market.min_aov)
    maximum = _decimal(data.market.max_aov)
    if margin.margin_percent < Decimal(60):
        failures.append(f"贡献毛利率 {margin.margin_percent:.1f}% < 60%")
    expected_aov = _decimal(order.expected_aov)
    unit_price = _decimal(order.unit_price)
    weight = (
        None if order.packed_weight_kg is None else _decimal(order.packed_weight_kg)
    )
    if not minimum <= expected_aov <= maximum:
        failures.append(f"预计客单价 ${expected_aov:.2f} 不在 ${minimum}–${maximum}")
    if unit_price < minimum and order.bundle_quantity < 2:
        failures.append("单品售价低于市场最低客单价且没有可信 Bundle")
    if weight is None or weight <= ZERO or weight > Decimal(2):
        failures.append(f"重量 {weight}kg 不符合 0–2kg")
    if meta.logistics_difficulty in {"high", "oversized", "fragile", "infeasible"}:
        failures.append(f"物流难度为 {meta.logistics_difficulty}")
    if meta.compliance_risk == "high":
        failures.append("合规风险为 high")
    if meta.ip_risk == "high":
        failures.append("侵权风险为 high")
    if meta.trend_12m == "peaked":
        failures.append(f"12个月趋势为 {meta.trend_12m}")
    if meta.trend_5y == "peaked":
        failures.append(f"5年趋势为 {meta.trend_5y}")
    if meta.ugc_or_demo is False or not meta.creative_formats:
        failures.append("缺少合理的视频创意空间")
    for field, label in (
        ("logistics_difficulty", "物流"),
        ("compliance_risk", "合规"),
        ("ip_risk", "侵权"),
        ("trend_12m", "12个月趋势"),
        ("trend_5y", "5年趋势"),
        ("ugc_or_demo", "视频创意"),
    ):
        if meta.trust.get(field) is EvidenceTrust.INFERRED:
            failures.append(f"{label}证据可信等级为 inferred，需人工确认")
    return failures


def score_dimensions(data: EvaluationInput, margin: MarginResult) -> dict[str, int]:
    order, meta = data.order, data.meta
    demand = 0
    if meta.active_days is not None:
        if meta.active_days >= 365:
            demand += 3
        elif meta.active_days >= 90:
            demand += 2
        elif meta.active_days >= 30:
            demand += 1
    if meta.trend_12m in NON_NEGATIVE_TRENDS and meta.trend_5y in NON_NEGATIVE_TRENDS:
        if "rising" in {meta.trend_12m, meta.trend_5y}:
            demand += 2
        else:
            demand += 1

    formats = len(meta.creative_formats or ())
    creative = 2 if formats >= 3 else 1 if formats >= 2 else 0
    creative += int(len(meta.creative_scenarios or ()) >= 3)
    creative += int(len(meta.creative_hooks or ()) >= 3)
    creative += int(meta.ugc_or_demo is True)

    weight = (
        None if order.packed_weight_kg is None else _decimal(order.packed_weight_kg)
    )
    profit = (
        2
        if margin.margin_percent >= Decimal(70)
        else int(margin.margin_percent >= Decimal(60))
    )
    profit += int(weight is not None and weight <= Decimal(1))
    profit += int(meta.logistics_difficulty == "low")
    supplier_ok = (
        order.supplier_quote_unit_cost is not None
        or order.supplier_quote_bundle_cost is not None
    )
    supplier_ok = supplier_ok and order.supplier_quote_valid is not False
    supplier_ok = supplier_ok and order.supplier_quote_confirmed is not False
    supplier_ok = supplier_ok and _supplier_quote_is_verified(data)
    supplier_ok = supplier_ok and bool(order.supplier_quote_source)
    profit += int(supplier_ok)

    competition = 0
    if (
        meta.advertiser_count is not None
        and meta.search_truncated is False
        and meta.query_coverage_verified is True
        and all(
            meta.trust.get(field) is EvidenceTrust.VERIFIED
            for field in (
                "advertiser_count",
                "search_truncated",
                "query_coverage_verified",
            )
        )
    ):
        if 2 <= meta.advertiser_count <= 10:
            competition += 2
        elif 11 <= meta.advertiser_count <= 30:
            competition += 1
    if meta.trust.get("brand_concentration") in {
        EvidenceTrust.VERIFIED,
        EvidenceTrust.INFERRED,
    }:
        competition += {"low": 2, "medium": 1}.get(meta.brand_concentration or "", 0)
    if meta.trust.get("differentiation") in {
        EvidenceTrust.VERIFIED,
        EvidenceTrust.INFERRED,
    }:
        competition += int(meta.differentiation in {"medium", "high"})

    compliance = {"low": 2, "medium": 1}.get(meta.compliance_risk or "", 0)
    compliance += {"low": 2, "medium": 1}.get(meta.ip_risk or "", 0)
    compliance += int(
        meta.certification_required is False or meta.certification_verified is True
    )
    return {
        "需求与趋势": min(demand, 5),
        "素材空间": min(creative, 5),
        "利润与物流": min(profit, 5),
        "竞争强度": min(competition, 5),
        "合规风险": min(compliance, 5),
    }


def evaluate(data: EvaluationInput, *, now: datetime | None = None) -> EvaluationResult:
    missing = required_missing_fields(data, now=now)
    if missing:
        return EvaluationResult.incomplete(missing)
    coarse = meta_coarse_screen(data.meta)
    if not coarse.passed:
        return EvaluationResult.observe(coarse.reasons)
    margin = calculate_margin(data.order, data.market)
    failures = hard_gate_failures(data, margin)
    if "declining" in {data.meta.trend_12m, data.meta.trend_5y}:
        return EvaluationResult(
            status="待人工复核",
            suggestion="淘汰池" if failures else None,
            margin=margin,
            hard_gate_failures=tuple(failures),
            total=None,
            reasons=("趋势为 declining，但现有规则未定义最终通过或淘汰边界。",),
            missing_fields=("trend_declining_review",),
        )
    scores = score_dimensions(data, margin)
    total = sum(scores.values())
    suggestion = (
        "淘汰池"
        if failures
        else "测试池"
        if total >= 18
        else "备选池"
        if total >= 15
        else "淘汰池"
    )
    meta, order = data.meta, data.order
    explanations = {
        "需求与趋势": f"active_days={meta.active_days}; trends={meta.trend_12m}/{meta.trend_5y}; 30/90/365 day brackets + nonnegative trend bonus; points={scores['需求与趋势']}",
        "素材空间": f"formats={meta.creative_formats}; scenarios={meta.creative_scenarios}; hooks={meta.creative_hooks}; ugc_or_demo={meta.ugc_or_demo}; points={scores['素材空间']}",
        "利润与物流": f"margin={margin.margin_percent}; weight={order.packed_weight_kg}; logistics={meta.logistics_difficulty}; confirmed_current_quote={order.supplier_quote_source}; points={scores['利润与物流']}",
        "竞争强度": f"advertisers={meta.advertiser_count}; coverage={meta.query_coverage_verified}; truncated={meta.search_truncated}; concentration={meta.brand_concentration}; differentiation={meta.differentiation}; unavailable coverage earns zero advertiser points; points={scores['竞争强度']}",
        "合规风险": f"compliance={meta.compliance_risk}; ip={meta.ip_risk}; certification_required={meta.certification_required}; certification_verified={meta.certification_verified}; points={scores['合规风险']}",
    }
    gates = {
        "margin": f"{margin.margin_percent} >= 60%",
        "aov": f"{order.expected_aov} within {data.market.min_aov}–{data.market.max_aov}",
        "weight": f"{order.packed_weight_kg} within (0,2] kg",
        "logistics": str(meta.logistics_difficulty),
        "compliance": str(meta.compliance_risk),
        "ip": str(meta.ip_risk),
        "trends": f"{meta.trend_12m}/{meta.trend_5y}",
        "video": str(meta.ugc_or_demo),
        "failures": "; ".join(failures) or "none",
    }
    return EvaluationResult.review(margin, failures, scores, suggestion).model_copy(
        update={"dimension_explanations": explanations, "gate_explanations": gates}
    )
