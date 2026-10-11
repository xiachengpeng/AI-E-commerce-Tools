"""Carrier-specific package weight calculations without assumed rules."""

from __future__ import annotations

from math import isfinite


def _positive(value: float | None, name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a positive number")
    number = float(value)
    if not isfinite(number) or number <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return number


def logistics_weights(
    actual_weight_kg: float | None,
    dimensions_cm: tuple[float | None, float | None, float | None],
    divisor_cm3_per_kg: float | None,
) -> dict[str, float | None]:
    """Derive chargeable weight only when all carrier inputs are known."""

    if len(dimensions_cm) != 3:
        raise ValueError("dimensions_cm must contain length, width and height")
    actual = _positive(actual_weight_kg, "actual_weight_kg")
    dimensions = tuple(
        _positive(value, name)
        for value, name in zip(
            dimensions_cm, ("length_cm", "width_cm", "height_cm"), strict=True
        )
    )
    divisor = _positive(divisor_cm3_per_kg, "divisor_cm3_per_kg")
    length, width, height = dimensions
    volumetric = (
        length * width * height / divisor
        if divisor is not None
        and length is not None
        and width is not None
        and height is not None
        else None
    )
    return {
        "actual_weight_kg": actual,
        "volumetric_weight_kg": volumetric,
        "chargeable_weight_kg": (
            max(actual, volumetric)
            if actual is not None and volumetric is not None
            else None
        ),
    }
