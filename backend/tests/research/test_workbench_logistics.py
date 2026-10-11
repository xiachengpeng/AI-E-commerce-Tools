"""Volumetric-weight arithmetic must never invent a carrier rule."""

import pytest

from rabbit_hole.domain.logistics import logistics_weights


def test_known_dimensions_and_profile_produce_chargeable_weight() -> None:
    result = logistics_weights(0.8, (30, 20, 10), 6000)

    assert result == {
        "actual_weight_kg": 0.8,
        "volumetric_weight_kg": 1.0,
        "chargeable_weight_kg": 1.0,
    }


@pytest.mark.parametrize(
    ("dimensions", "divisor"),
    [((30, 20, 10), None), ((30, None, 10), 6000)],
)
def test_missing_rule_or_dimension_remains_unknown(dimensions, divisor) -> None:
    result = logistics_weights(0.8, dimensions, divisor)

    assert result["actual_weight_kg"] == 0.8
    assert result["volumetric_weight_kg"] is None
    assert result["chargeable_weight_kg"] is None


@pytest.mark.parametrize(
    ("actual", "dimensions", "divisor"),
    [
        (0, (30, 20, 10), 6000),
        (0.8, (0, 20, 10), 6000),
        (0.8, (30, 20, 10), 0),
    ],
)
def test_nonpositive_logistics_inputs_are_rejected(actual, dimensions, divisor) -> None:
    with pytest.raises(ValueError):
        logistics_weights(actual, dimensions, divisor)
