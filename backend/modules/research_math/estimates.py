"""Traffic-scope-safe sales scenarios, never realized sales."""

from __future__ import annotations

from math import isfinite
from typing import Any

TRAFFIC_SCOPES = frozenset({"domain", "store", "product", "landing_page", "unknown"})


def _number(value: float, name: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result) or result < 0 or (positive and result == 0):
        raise ValueError(f"{name} must be finite and nonnegative")
    return result


def scenario_rows(
    monthly_visits: float,
    aov: float,
    cvr_low: float,
    cvr_base: float,
    cvr_high: float,
    traffic_scope: str,
) -> dict[str, Any]:
    """Calculate low/base/high at the source scope, not an inferred product share."""

    visits = _number(monthly_visits, "monthly_visits")
    order_value = _number(aov, "aov", positive=True)
    low = _number(cvr_low, "cvr_low")
    base = _number(cvr_base, "cvr_base")
    high = _number(cvr_high, "cvr_high")
    if not 0 <= low <= base <= high <= 100:
        raise ValueError("CVR scenarios must be ordered percentages between 0 and 100")
    if traffic_scope not in TRAFFIC_SCOPES - {"unknown"}:
        raise ValueError("traffic_scope must identify a known source scope")
    rows = {
        key: {
            "monthly_orders": round(visits * cvr / 100, 2),
            "monthly_revenue": round(visits * cvr / 100 * order_value, 2),
        }
        for key, cvr in (("low", low), ("base", base), ("high", high))
    }
    if any(not isfinite(value) for row in rows.values() for value in row.values()):
        raise ValueError('calculated scenario exceeds the numeric range')
    return {
        "scope": traffic_scope,
        **rows,
        "product_monthly_orders": (
            {key: row["monthly_orders"] for key, row in rows.items()}
            if traffic_scope == "product"
            else None
        ),
        "product_monthly_revenue": (
            {key: row["monthly_revenue"] for key, row in rows.items()}
            if traffic_scope == "product"
            else None
        ),
    }
