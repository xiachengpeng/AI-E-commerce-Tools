from __future__ import annotations

import csv
import importlib.util
import json
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from rabbit_hole.config import MarketSettings
from rabbit_hole.domain.legacy import EvidenceTrust
from rabbit_hole.scoring import (
    REQUIRED_EVIDENCE_FIELDS,
    EvaluationInput,
    EvidenceSnapshot,
    OrderEconomics,
    calculate_margin,
    evaluate,
)

_CLI_SPEC = importlib.util.spec_from_file_location(
    "rabbit_hole_cli", Path(__file__).parents[1] / "automation" / "rabbit_hole.py"
)
assert _CLI_SPEC and _CLI_SPEC.loader
_CLI = importlib.util.module_from_spec(_CLI_SPEC)
sys.modules["rabbit_hole_cli"] = _CLI
_CLI_SPEC.loader.exec_module(_CLI)
_bool = _CLI._bool
_input = _CLI._input
_market = _CLI._market


@pytest.fixture
def us_market() -> MarketSettings:
    return MarketSettings(
        code="US",
        currency="USD",
        min_aov=50,
        max_aov=100,
        payment_percent=2.9,
        payment_fixed=0.30,
        loss_reserve_percent=3.0,
    )


@pytest.fixture
def complete_input(us_market: MarketSettings) -> EvaluationInput:
    return EvaluationInput(
        product_name="Portable pet paw cleaner",
        market=us_market,
        order=OrderEconomics(
            unit_price=39,
            bundle_quantity=2,
            expected_aov=69,
            goods_cost=10,
            shipping=6,
            packaging=1,
            tax_and_duty=0,
            acquisition_cost=5,
            packed_weight_kg=Decimal("0.8"),
            supplier_quote_unit_cost=5,
            supplier_quote_confirmed=True,
            supplier_quote_valid=True,
            supplier_quote_collected_at=datetime.now(UTC),
            bundle_evidence_trust=EvidenceTrust.VERIFIED,
            bundle_justification="Human verified two-pack offer",
            cost_trust={
                field: EvidenceTrust.VERIFIED
                for field in (
                    "goods_cost",
                    "shipping",
                    "packaging",
                    "tax_and_duty",
                    "acquisition_cost",
                    "packed_weight_kg",
                )
            },
            order_trust={
                field: EvidenceTrust.VERIFIED
                for field in ("unit_price", "expected_aov", "bundle_quantity")
            },
            supplier_quote_source="https://supplier.example/quotes/paw-cleaner",
        ),
        meta=EvidenceSnapshot(
            active_days=76,
            verified_creatives=3,
            trend_12m="rising",
            trend_5y="stable-high",
            logistics_difficulty="low",
            compliance_risk="low",
            ip_risk="low",
            creative_formats=("ugc", "demo", "before-after"),
            creative_scenarios=("home", "road-trip", "gift"),
            creative_hooks=("mud", "clean", "portable"),
            ugc_or_demo=True,
            advertiser_count=8,
            search_truncated=False,
            query_coverage_verified=True,
            brand_concentration="low",
            differentiation="high",
            certification_required=False,
            certification_verified=True,
            trust={
                "active_days": EvidenceTrust.VERIFIED,
                "verified_creatives": EvidenceTrust.VERIFIED,
                "trend_12m": EvidenceTrust.VERIFIED,
                "trend_5y": EvidenceTrust.VERIFIED,
                "logistics_difficulty": EvidenceTrust.VERIFIED,
                "compliance_risk": EvidenceTrust.VERIFIED,
                "ip_risk": EvidenceTrust.VERIFIED,
                "creative_formats": EvidenceTrust.VERIFIED,
                "creative_scenarios": EvidenceTrust.VERIFIED,
                "creative_hooks": EvidenceTrust.VERIFIED,
                "ugc_or_demo": EvidenceTrust.VERIFIED,
                "advertiser_count": EvidenceTrust.VERIFIED,
                "search_truncated": EvidenceTrust.VERIFIED,
                "query_coverage_verified": EvidenceTrust.VERIFIED,
                "brand_concentration": EvidenceTrust.VERIFIED,
                "differentiation": EvidenceTrust.VERIFIED,
                "supplier_quote": EvidenceTrust.VERIFIED,
                "certification_required": EvidenceTrust.VERIFIED,
                "certification_verified": EvidenceTrust.VERIFIED,
            },
        ),
    )


def test_missing_trust_and_unconfirmed_quote_cannot_score(complete_input):
    untrusted = complete_input.model_copy(
        update={"meta": complete_input.meta.model_copy(update={"trust": {}})}
    )
    assert "compliance_risk" in evaluate(untrusted).missing_fields
    assert (
        "supplier_quote"
        in evaluate(
            complete_input.model_copy(
                update={
                    "order": complete_input.order.model_copy(
                        update={"supplier_quote_confirmed": None}
                    )
                }
            )
        ).missing_fields
    )


def test_closed_risk_and_trend_values():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        EvidenceSnapshot(compliance_risk="safe-ish")
    with pytest.raises(ValidationError):
        EvidenceSnapshot(trend_12m="good")


def test_uncomputed_scores_are_missing(complete_input):
    assert (
        evaluate(complete_input.model_copy(update={"product_name": None})).total is None
    )


@pytest.mark.parametrize(
    "change,missing",
    [
        ({"supplier_quote_confirmed": False}, "supplier_quote"),
        ({"supplier_quote_valid": False}, "supplier_quote"),
        ({"supplier_quote_collected_at": "2000-01-01T00:00:00Z"}, "supplier_quote"),
        ({"bundle_evidence_trust": "inferred"}, "bundle_evidence"),
    ],
)
def test_quote_currency_confirmation_and_bundle_are_mandatory(
    complete_input, change, missing
):
    from datetime import UTC, datetime

    order = complete_input.order.model_dump()
    order.update(
        supplier_quote_confirmed=True,
        supplier_quote_valid=True,
        supplier_quote_collected_at=datetime.now(UTC),
        bundle_evidence_trust="verified",
        bundle_justification="Confirmed two-pack offer",
    )
    order.update(change)
    result = evaluate(
        complete_input.model_copy(
            update={"order": OrderEconomics.model_validate(order)}
        )
    )
    assert missing in result.missing_fields


def test_margin_uses_aov_and_every_order_cost(us_market: MarketSettings) -> None:
    order = OrderEconomics(
        unit_price=39.0,
        bundle_quantity=2,
        expected_aov=69.0,
        goods_cost=10.0,
        shipping=6.0,
        packaging=1.0,
        tax_and_duty=0.0,
        acquisition_cost=5.0,
        packed_weight_kg=0.8,
    )
    result = calculate_margin(order, us_market)
    assert result.payment_fee == Decimal("2.301")
    assert result.loss_reserve == Decimal("2.07")
    assert result.margin_percent == pytest.approx(
        Decimal("61.781159"), rel=Decimal("1e-5")
    )


def test_blank_cost_blocks_scoring_but_explicit_zero_is_valid(
    complete_input: EvaluationInput,
) -> None:
    missing_tax = complete_input.model_copy(
        update={"order": complete_input.order.model_copy(update={"tax_and_duty": None})}
    )
    result = evaluate(missing_tax)
    assert result.status == "待补充证据"
    assert "tax_and_duty" in result.missing_fields


@pytest.mark.parametrize(
    "aov,passes", [("49.99", False), ("50", True), ("100", True), ("100.01", False)]
)
def test_aov_gate_is_inclusive_at_us_boundaries(
    complete_input: EvaluationInput, aov: str, passes: bool
) -> None:
    data = complete_input.model_copy(
        update={"order": complete_input.order.model_copy(update={"expected_aov": aov})}
    )
    result = evaluate(data)
    assert any("客单价" in reason for reason in result.hard_gate_failures) is (
        not passes
    )


@pytest.mark.parametrize("weight,passes", [("1", True), ("2", True), ("2.01", False)])
def test_weight_gate_is_inclusive(
    complete_input: EvaluationInput, weight: str, passes: bool
) -> None:
    data = complete_input.model_copy(
        update={
            "order": complete_input.order.model_copy(
                update={"packed_weight_kg": weight}
            )
        }
    )
    result = evaluate(data)
    assert any("重量" in reason for reason in result.hard_gate_failures) is (not passes)


@pytest.mark.parametrize(
    "active_days,creatives,passes", [(29, 3, False), (30, 2, False), (30, 3, True)]
)
def test_meta_coarse_screen_requires_both_thresholds(
    complete_input: EvaluationInput, active_days: int, creatives: int, passes: bool
) -> None:
    data = complete_input.model_copy(
        update={
            "meta": complete_input.meta.model_copy(
                update={"active_days": active_days, "verified_creatives": creatives}
            )
        }
    )
    result = evaluate(data)
    assert result.status == ("待人工复核" if passes else "观察池")


@pytest.mark.parametrize("trend", ["declining", "peaked", "seasonal"])
def test_trend_boundaries_and_seasonality(
    complete_input: EvaluationInput, trend: str
) -> None:
    data = complete_input.model_copy(
        update={"meta": complete_input.meta.model_copy(update={"trend_12m": trend})}
    )
    result = evaluate(data)
    if trend == "seasonal":
        assert not any("趋势" in reason for reason in result.hard_gate_failures)
    elif trend == "declining":
        assert result.total is None
        assert result.hard_gate_failures == ()
        assert "trend_declining_review" in result.missing_fields
        assert result.status == "待人工复核"
    else:
        assert any("趋势" in reason for reason in result.hard_gate_failures)


@pytest.mark.parametrize("field", ["compliance_risk", "ip_risk"])
def test_high_risk_overrides_numeric_suggestion(
    complete_input: EvaluationInput, field: str
) -> None:
    data = complete_input.model_copy(
        update={"meta": complete_input.meta.model_copy(update={field: "high"})}
    )
    result = evaluate(data)
    assert result.status == "待人工复核", result.missing_fields
    assert result.suggestion == "淘汰池"
    assert result.total >= 18


def test_result_is_always_pending_human_review_after_scoring(
    complete_input: EvaluationInput,
) -> None:
    result = evaluate(complete_input)
    assert result.status == "待人工复核"
    assert result.suggestion in {"测试池", "备选池", "淘汰池"}
    assert all(0 <= score <= 5 for score in result.scores.values())
    assert 0 <= result.total <= 25


def test_order_rejects_invalid_values() -> None:
    with pytest.raises(ValueError):
        OrderEconomics(
            unit_price=1,
            bundle_quantity=0,
            expected_aov=0,
            goods_cost=-1,
            shipping=0,
            packaging=0,
            tax_and_duty=0,
            acquisition_cost=0,
            packed_weight_kg=1,
        )


def test_bundle_goods_cost_must_match_selected_quote() -> None:
    with pytest.raises(ValueError, match="supplier"):
        OrderEconomics(
            unit_price=39,
            bundle_quantity=2,
            expected_aov=69,
            goods_cost=11,
            shipping=6,
            packaging=1,
            tax_and_duty=0,
            acquisition_cost=5,
            packed_weight_kg=0.8,
            supplier_quote_unit_cost=5,
        )


def test_inferred_meta_coarse_evidence_blocks_scoring(
    complete_input: EvaluationInput,
) -> None:
    data = complete_input.model_copy(
        update={
            "meta": complete_input.meta.model_copy(
                update={
                    "active_days": 365,
                    "verified_creatives": 3,
                    "trust": {
                        **complete_input.meta.trust,
                        "active_days": EvidenceTrust.INFERRED,
                        "verified_creatives": EvidenceTrust.INFERRED,
                    },
                }
            )
        }
    )
    result = evaluate(data)
    assert result.status == "待补充证据"
    assert "active_days" in result.missing_fields
    assert "verified_creatives" in result.missing_fields


@pytest.mark.parametrize("value", ["", "unknown", "inferred"])
def test_csv_unknown_boolean_is_not_false(value: str) -> None:
    row = {"flag": value}
    assert _bool(row, "flag") is None


def test_csv_boolean_typo_is_rejected() -> None:
    with pytest.raises(ValueError, match="boolean"):
        _bool({"flag": "tru"}, "flag")


@pytest.mark.parametrize("value", ["y", "n", "是", "否"])
def test_csv_noncanonical_boolean_is_rejected(value: str) -> None:
    with pytest.raises(ValueError, match="boolean"):
        _bool({"flag": value}, "flag")


def test_csv_without_explicit_evidence_trust_does_not_pass_coarse(
    complete_input: EvaluationInput,
) -> None:
    row = {
        "name": "No audit trail",
        "target_market": "US",
        "unit_price": "60",
        "expected_aov": "69",
        "bundle_quantity": "1",
        "goods_cost": "10",
        "shipping": "6",
        "packaging": "1",
        "tax_and_duty": "0",
        "acquisition_cost": "5",
        "packed_weight_kg": "0.8",
        "supplier_quote_unit_cost": "10",
        "supplier_quote_confirmed": "yes",
        "supplier_quote_valid": "yes",
        "active_days": "365",
        "verified_creatives": "3",
        "trend_12m": "rising",
        "trend_5y": "stable-high",
        "logistics_difficulty": "low",
        "compliance_risk": "low",
        "ip_risk": "low",
        "creative_formats": "ugc|demo",
        "creative_scenarios": "home|gift|travel",
        "creative_hooks": "one|two|three",
        "ugc_or_demo": "yes",
        "certification_required": "no",
        "payment_percent": "99",
        "payment_fixed": "99",
        "loss_reserve_percent": "99",
    }
    config = {
        "default_market": "US",
        "markets": {
            "US": {
                "currency": "USD",
                "min_aov": 50,
                "max_aov": 100,
                "payment_percent": 2.9,
                "payment_fixed": 0.3,
                "loss_reserve_percent": 3,
            }
        },
    }
    result = evaluate(_input(row, config))
    assert result.status == "待补充证据"
    assert result.missing_fields


def test_market_uses_configured_rates_without_csv_override() -> None:
    config = {
        "default_market": "US",
        "markets": {
            "US": {
                "currency": "USD",
                "min_aov": 50,
                "max_aov": 100,
                "payment_percent": 9.9,
                "payment_fixed": 9.99,
                "loss_reserve_percent": 8.8,
            }
        },
    }
    market = _market({"target_market": "US"}, config)
    assert market.payment_percent == 9.9
    assert market.payment_fixed == 9.99
    assert market.loss_reserve_percent == 8.8
    result = calculate_margin(
        OrderEconomics(
            unit_price=69,
            bundle_quantity=1,
            expected_aov=69,
            goods_cost=10,
            shipping=6,
            packaging=1,
            tax_and_duty=0,
            acquisition_cost=5,
            packed_weight_kg=Decimal("0.8"),
        ),
        market,
    )
    assert result.payment_fee == Decimal("16.821")
    assert result.loss_reserve == Decimal("6.072")


@pytest.mark.parametrize(
    "margin_pct,passes_gate,profit_points",
    [("59.99", False, 0), ("60", True, 1), ("69.99", True, 1), ("70", True, 2)],
)
def test_margin_gate_and_profit_dimension_boundaries(
    complete_input: EvaluationInput,
    margin_pct: str,
    passes_gate: bool,
    profit_points: int,
) -> None:
    aov = Decimal(69)
    target_cost = aov * (Decimal(1) - Decimal(margin_pct) / Decimal(100))
    fees = aov * Decimal("0.029") + Decimal("0.30") + aov * Decimal("0.03")
    acquisition = target_cost - Decimal(10) - Decimal(6) - Decimal(1) - fees
    data = complete_input.model_copy(
        update={
            "order": complete_input.order.model_copy(
                update={"acquisition_cost": acquisition}
            )
        }
    )
    result = evaluate(data)
    assert any("贡献毛利率" in reason for reason in result.hard_gate_failures) is (
        not passes_gate
    )
    assert result.scores["利润与物流"] == profit_points + 3


def test_inferred_order_cost_blocks_margin_scoring(
    complete_input: EvaluationInput,
) -> None:
    data = complete_input.model_copy(
        update={
            "order": complete_input.order.model_copy(
                update={"cost_trust": {"shipping": EvidenceTrust.INFERRED}}
            )
        }
    )
    result = evaluate(data)
    assert result.status == "待补充证据"
    assert "shipping_evidence" in result.missing_fields


def test_example_csv_has_audit_pair_for_every_scoring_input() -> None:
    with open(
        Path(__file__).parents[1] / "automation" / "candidates.example.csv", newline=""
    ) as handle:
        header = set(next(csv.reader(handle)))
    missing = {
        column
        for field in REQUIRED_EVIDENCE_FIELDS
        for column in (f"{field}_source", f"{field}_trust")
        if column not in header
    }
    assert not missing


def test_csv_maps_evidence_trust_per_field_not_from_one_generic_source() -> None:
    row = {
        "name": "Mixed evidence",
        "target_market": "US",
        "unit_price": "60",
        "expected_aov": "69",
        "bundle_quantity": "1",
        "goods_cost": "10",
        "shipping": "6",
        "packaging": "1",
        "tax_and_duty": "0",
        "acquisition_cost": "5",
        "packed_weight_kg": "0.8",
        "supplier_quote_unit_cost": "10",
        "supplier_quote_confirmed": "yes",
        "supplier_quote_valid": "yes",
        "active_days": "365",
        "active_days_source": "meta snapshot",
        "active_days_trust": "verified",
        "verified_creatives": "3",
        "verified_creatives_source": "creative review",
        "verified_creatives_trust": "verified",
        "trend_12m": "rising",
        "trend_12m_source": "inferred trend note",
        "trend_12m_trust": "inferred",
        "trend_5y": "stable-high",
        "trend_5y_source": "trend report",
        "trend_5y_trust": "verified",
        "logistics_difficulty": "low",
        "logistics_difficulty_source": "shipping quote",
        "logistics_difficulty_trust": "verified",
        "compliance_risk": "low",
        "compliance_risk_source": "ai note",
        "compliance_risk_trust": "inferred",
        "ip_risk": "low",
        "ip_risk_source": "manual search",
        "ip_risk_trust": "verified",
        "creative_formats": "ugc|demo",
        "creative_formats_source": "landing page",
        "creative_formats_trust": "verified",
        "creative_scenarios": "home|gift|travel",
        "creative_scenarios_source": "landing page",
        "creative_scenarios_trust": "verified",
        "creative_hooks": "one|two|three",
        "creative_hooks_source": "landing page",
        "creative_hooks_trust": "verified",
        "ugc_or_demo": "yes",
        "ugc_or_demo_source": "manual review",
        "ugc_or_demo_trust": "verified",
        "certification_required": "no",
        "certification_required_source": "manual review",
        "certification_required_trust": "verified",
        "advertiser_count": "8",
        "advertiser_count_source": "meta ads",
        "advertiser_count_trust": "verified",
        "search_truncated": "no",
        "search_truncated_source": "meta ads",
        "search_truncated_trust": "verified",
        "query_coverage_verified": "yes",
        "query_coverage_verified_source": "meta ads",
        "query_coverage_verified_trust": "verified",
        "brand_concentration": "low",
        "brand_concentration_source": "manual review",
        "brand_concentration_trust": "verified",
        "differentiation": "high",
        "differentiation_source": "manual review",
        "differentiation_trust": "verified",
        "certification_verified": "yes",
        "certification_verified_source": "manual review",
        "certification_verified_trust": "verified",
        "supplier_quote_source": "https://supplier.example/quotes/mixed-evidence",
        "supplier_quote_trust": "verified",
    }
    for field in (
        "goods_cost",
        "shipping",
        "packaging",
        "tax_and_duty",
        "acquisition_cost",
        "packed_weight_kg",
    ):
        row[f"{field}_source"] = "order quote"
        row[f"{field}_trust"] = "verified"
    for field in ("unit_price", "expected_aov", "bundle_quantity"):
        row[f"{field}_source"] = "offer page"
        row[f"{field}_trust"] = "verified"
    config = {
        "default_market": "US",
        "markets": {
            "US": {
                "currency": "USD",
                "min_aov": 50,
                "max_aov": 100,
                "payment_percent": 2.9,
                "payment_fixed": 0.3,
                "loss_reserve_percent": 3,
            }
        },
    }
    data = _input(row, config)
    assert data.meta.trust["active_days"] is EvidenceTrust.VERIFIED
    assert data.meta.trust["trend_12m"] is EvidenceTrust.INFERRED
    assert data.meta.trust["compliance_risk"] is EvidenceTrust.INFERRED
    result = evaluate(data)
    assert result.status == "待补充证据"
    assert "trend_12m" in result.missing_fields
    assert "compliance_risk" in result.missing_fields


@pytest.mark.parametrize("trust", [EvidenceTrust.INFERRED, EvidenceTrust.UNKNOWN])
def test_supplier_quote_requires_verified_evidence(
    complete_input: EvaluationInput,
    trust: EvidenceTrust,
) -> None:
    data = complete_input.model_copy(
        update={
            "meta": complete_input.meta.model_copy(
                update={
                    "trust": {
                        **complete_input.meta.trust,
                        "supplier_quote": trust,
                    }
                }
            )
        }
    )

    result = evaluate(data)

    assert result.status == "待补充证据"
    assert "supplier_quote" in result.missing_fields


def test_supplier_quote_blocks_conflicting_legacy_trust(
    complete_input: EvaluationInput,
) -> None:
    data = complete_input.model_copy(
        update={
            "order": complete_input.order.model_copy(
                update={"order_trust": {"supplier_quote": EvidenceTrust.INFERRED}}
            )
        }
    )

    result = evaluate(data)

    assert result.status == "待补充证据"
    assert "supplier_quote" in result.missing_fields


def test_verified_or_human_confirmed_supplier_quote_requires_auditable_source(
    complete_input: EvaluationInput,
) -> None:
    no_source = complete_input.model_copy(
        update={
            "order": complete_input.order.model_copy(
                update={"supplier_quote_source": None}
            )
        }
    )

    result = evaluate(no_source)

    assert result.status == "待补充证据"
    assert "supplier_quote_source" in result.missing_fields

    human_confirmed = complete_input.model_copy(
        update={
            "order": complete_input.order.model_copy(
                update={
                    "supplier_quote_source": None,
                    "supplier_quote_confirmed": True,
                }
            ),
            "meta": complete_input.meta.model_copy(
                update={
                    "trust": {
                        **complete_input.meta.trust,
                        "supplier_quote": EvidenceTrust.UNKNOWN,
                    }
                }
            ),
        }
    )
    human_result = evaluate(human_confirmed)
    assert "supplier_quote_source" in human_result.missing_fields


@pytest.mark.parametrize(
    "source",
    [
        "unknown",
        "ftp://supplier.example/quote",
        "https://",
        "https://supplier.example/" + "q" * 2049,
    ],
)
def test_supplier_quote_source_is_a_bounded_auditable_http_url(source: str) -> None:
    with pytest.raises(ValueError, match="supplier_quote_source"):
        OrderEconomics(
            unit_price=39,
            bundle_quantity=2,
            expected_aov=69,
            supplier_quote_unit_cost=5,
            supplier_quote_source=source,
        )


def test_supplier_quote_source_survives_model_dump_and_csv_mapping(
    complete_input: EvaluationInput,
) -> None:
    source = "https://supplier.example/quotes/paw-cleaner"
    assert (
        complete_input.model_dump(mode="json")["order"]["supplier_quote_source"]
        == source
    )

    data = _input(
        {
            "name": "Supplier source mapping",
            "target_market": "US",
            "unit_price": "39",
            "bundle_quantity": "2",
            "expected_aov": "69",
            "supplier_quote_unit_cost": "5",
            "supplier_quote_source": source + "?token=ephemeral-token",
            "supplier_quote_trust": "verified",
        },
        {
            "default_market": "US",
            "markets": {
                "US": {
                    "currency": "USD",
                    "min_aov": 50,
                    "max_aov": 100,
                    "payment_percent": 2.9,
                    "payment_fixed": 0.3,
                    "loss_reserve_percent": 3,
                }
            },
        },
    )
    assert data.order.supplier_quote_source == source


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        (
            "https://supplier.example/quotes/paw-cleaner?token=ephemeral-token",
            "https://supplier.example/quotes/paw-cleaner",
        ),
        (
            "https://supplier.example/quotes/paw-cleaner?X-Amz-Credential=temporary&X-Amz-Signature=signature",
            "https://supplier.example/quotes/paw-cleaner",
        ),
        (
            "https://supplier.example/quotes/paw-cleaner?token=" + "x" * 3000,
            "https://supplier.example/quotes/paw-cleaner",
        ),
        (
            "https://supplier.example/quotes/paw-cleaner#fragment-secret",
            "https://supplier.example/quotes/paw-cleaner",
        ),
        (
            "https://detail.1688.com/offer/123456789.html?spm=a260k",
            "https://detail.1688.com/offer/123456789.html",
        ),
        (
            "https://www.aliexpress.com/item/1005001234567890.html",
            "https://www.aliexpress.com/item/1005001234567890.html",
        ),
    ],
)
def test_supplier_quote_source_is_canonicalized_before_model_dump(
    source: str, expected: str
) -> None:
    order = OrderEconomics(
        unit_price=39,
        bundle_quantity=1,
        expected_aov=69,
        supplier_quote_unit_cost=5,
        supplier_quote_source=source,
    )

    assert order.supplier_quote_source == expected
    dumped = order.model_dump(mode="json")
    assert dumped["supplier_quote_source"] == expected
    assert "?" not in dumped["supplier_quote_source"]
    assert "#" not in dumped["supplier_quote_source"]


def test_supplier_quote_source_rejects_userinfo_before_persistence() -> None:
    with pytest.raises(ValueError, match="supplier_quote_source"):
        OrderEconomics(
            unit_price=39,
            bundle_quantity=1,
            expected_aov=69,
            supplier_quote_unit_cost=5,
            supplier_quote_source="https://user:password@supplier.example/quote",
        )


@pytest.mark.parametrize("nested", [False, True], ids=["order", "evaluation"])
def test_supplier_source_validation_error_does_not_echo_credentials(
    complete_input: EvaluationInput, nested: bool
) -> None:
    source = "https://error-secret@shop.example/?token=more-error-secret"
    with pytest.raises(ValueError) as rejected:
        if nested:
            data = complete_input.model_dump(mode="json")
            data["order"]["supplier_quote_source"] = source
            EvaluationInput.model_validate(data)
        else:
            OrderEconomics(
                unit_price=39,
                bundle_quantity=1,
                expected_aov=69,
                supplier_quote_source=source,
            )
    assert "supplier_quote_source" in str(rejected.value)
    assert "error-secret" not in str(rejected.value)


def test_blank_supplier_source_stays_missing_evidence(
    complete_input: EvaluationInput,
) -> None:
    data = complete_input.model_dump(mode="json")
    data["order"]["supplier_quote_source"] = "  "

    result = evaluate(EvaluationInput.model_validate(data))

    assert result.status == "待补充证据"
    assert "supplier_quote_source" in result.missing_fields


def test_unrequired_certification_does_not_require_verification(
    complete_input: EvaluationInput,
) -> None:
    trust = dict(complete_input.meta.trust)
    trust.pop("certification_verified")
    data = complete_input.model_copy(
        update={
            "meta": complete_input.meta.model_copy(
                update={"certification_verified": None, "trust": trust}
            )
        }
    )

    result = evaluate(data)

    assert result.status == "待人工复核"
    assert "certification_verified" not in result.missing_fields


def test_csv_unrequired_certification_allows_blank_verification() -> None:
    csv_path = Path(__file__).parents[1] / "automation" / "candidates.example.csv"
    config_path = Path(__file__).parents[1] / "automation" / "config.json"
    with csv_path.open(newline="") as handle:
        row = next(csv.DictReader(handle))
    row.update(
        certification_required="no",
        certification_verified="",
        certification_verified_source="",
        certification_verified_trust="",
        supplier_quote_collected_at=datetime.now(UTC).isoformat(),
        bundle_evidence_trust="verified",
        bundle_evidence_source="human-confirmed offer",
        bundle_justification="Verified two-pack offer",
    )

    result = evaluate(_input(row, json.loads(config_path.read_text())))

    assert result.status == "待人工复核"
    assert "certification_verified" not in result.missing_fields


@pytest.mark.parametrize(
    ("verified", "trust"),
    [
        (None, EvidenceTrust.VERIFIED),
        (True, EvidenceTrust.INFERRED),
        (True, EvidenceTrust.UNKNOWN),
    ],
)
def test_required_certification_requires_value_and_verified_evidence(
    complete_input: EvaluationInput,
    verified: bool | None,
    trust: EvidenceTrust,
) -> None:
    data = complete_input.model_copy(
        update={
            "meta": complete_input.meta.model_copy(
                update={
                    "certification_required": True,
                    "certification_verified": verified,
                    "trust": {
                        **complete_input.meta.trust,
                        "certification_verified": trust,
                    },
                }
            )
        }
    )

    result = evaluate(data)

    assert result.status == "待补充证据"
    assert "certification_verified" in result.missing_fields


def test_unaudited_video_creative_fallback_cannot_pass_or_score(
    complete_input: EvaluationInput,
) -> None:
    trust = dict(complete_input.meta.trust)
    trust.pop("ugc_or_demo")
    data = complete_input.model_copy(
        update={
            "meta": complete_input.meta.model_copy(
                update={
                    "ugc_or_demo": None,
                    "video_creative_feasible": True,
                    "trust": trust,
                }
            )
        }
    )

    result = evaluate(data)

    assert result.status == "待补充证据"
    assert "ugc_or_demo" in result.missing_fields
    assert not result.scores
