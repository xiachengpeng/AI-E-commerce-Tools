"""Sales scenarios must keep their traffic scope and uncertainty."""

import pytest

from rabbit_hole.domain.estimates import scenario_rows


def test_domain_traffic_never_becomes_product_revenue() -> None:
    result = scenario_rows(100_000, 75, 1, 2, 3, "domain")

    assert result["scope"] == "domain"
    assert result["low"] == {"monthly_orders": 1000, "monthly_revenue": 75_000}
    assert result["base"] == {"monthly_orders": 2000, "monthly_revenue": 150_000}
    assert result["high"] == {"monthly_orders": 3000, "monthly_revenue": 225_000}
    assert result["product_monthly_orders"] is None
    assert result["product_monthly_revenue"] is None


def test_product_scope_can_show_product_scenarios() -> None:
    result = scenario_rows(1000, 60, 1, 2, 3, "product")
    assert result["product_monthly_orders"] == {"low": 10, "base": 20, "high": 30}
    assert result["product_monthly_revenue"] == {
        "low": 600,
        "base": 1200,
        "high": 1800,
    }


@pytest.mark.parametrize(
    ("visits", "low", "base", "high", "scope"),
    [
        (100, 3, 2, 4, "product"),
        (100, -1, 2, 4, "product"),
        (100, 1, 2, 101, "product"),
        (-1, 1, 2, 4, "product"),
        (100, 1, 2, 4, "unknown"),
    ],
)
def test_invalid_scenario_inputs_are_rejected(visits, low, base, high, scope):
    with pytest.raises(ValueError):
        scenario_rows(visits, 75, low, base, high, scope)
