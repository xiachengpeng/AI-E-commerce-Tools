"""Catch assumed carrier rules, fabricated product sales, and invalid input."""
import pytest


def test_carrier_weight_uses_explicit_divisor():
    from modules.research_math.logistics import logistics_weights
    assert logistics_weights(1, (30, 20, 10), 5000) == {
        'actual_weight_kg': 1.0, 'volumetric_weight_kg': 1.2, 'chargeable_weight_kg': 1.2,
    }


@pytest.mark.parametrize('actual,dimensions,divisor', [
    (1, (30, 20, 10), None), (None, (30, 20, 10), 5000), (1, (30, None, 10), 5000),
])
def test_missing_carrier_input_does_not_assume_chargeable_weight(actual, dimensions, divisor):
    from modules.research_math.logistics import logistics_weights
    assert logistics_weights(actual, dimensions, divisor)['chargeable_weight_kg'] is None


@pytest.mark.parametrize('value', [True, -1, 0, float('inf'), float('nan')])
def test_invalid_weight_rejected(value):
    from modules.research_math.logistics import logistics_weights
    with pytest.raises((ValueError, TypeError)):
        logistics_weights(value, (30, 20, 10), 5000)


@pytest.mark.parametrize('scope', ['domain', 'store', 'landing_page'])
def test_non_product_traffic_never_becomes_product_sales(scope):
    from modules.research_math.estimates import scenario_rows
    result = scenario_rows(10000, 40, 1, 2, 3, scope)
    assert result['base'] == {'monthly_orders': 200.0, 'monthly_revenue': 8000.0}
    assert result['product_monthly_orders'] is None
    assert result['product_monthly_revenue'] is None


def test_product_scope_has_three_explicit_scenarios():
    from modules.research_math.estimates import scenario_rows
    result = scenario_rows(10000, 40, 1, 2, 3, 'product')
    assert result['product_monthly_orders'] == {'low': 100.0, 'base': 200.0, 'high': 300.0}


@pytest.mark.parametrize('values', [
    (100, 40, 3, 2, 1, 'product'), (100, 40, 1, 2, 101, 'product'),
    (100, 40, 1, 2, 3, 'unknown'), (True, 40, 1, 2, 3, 'product'),
])
def test_invalid_scenarios_rejected(values):
    from modules.research_math.estimates import scenario_rows
    with pytest.raises((ValueError, TypeError)):
        scenario_rows(*values)


def test_market_language_is_independent_of_chinese_interface():
    from modules.research_math.markets import MARKETS, region_labels
    assert MARKETS['GB'].language == 'English'
    assert MARKETS['JP'].language == 'Japanese'
    assert MARKETS['DE'].language == 'German'
    assert 'unitedkingdom' in region_labels('GB')


def test_calculated_weight_overflow_is_rejected():
    from modules.research_math.logistics import logistics_weights
    with pytest.raises(ValueError):
        logistics_weights(1, (1e308, 1e308, 1e308), 5000)


def test_calculated_revenue_overflow_is_rejected():
    from modules.research_math.estimates import scenario_rows
    with pytest.raises(ValueError):
        scenario_rows(1e308, 1e308, 1, 2, 3, 'product')
