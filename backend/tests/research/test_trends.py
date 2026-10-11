from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pytest

from rabbit_hole.integrations.collectors.base import CollectorError
from rabbit_hole.integrations.collectors.google import (
    GoogleTrendsCollector,
    GoogleTrendsEvidence,
    GoogleTrendsStrategy,
)
from rabbit_hole.trends import (
    TrendLabel,
    TrendSeries,
    classify_trend,
    classify_trend_window,
)

FIXTURES = Path(__file__).parent / "fixtures" / "trends"


def test_window_classifier_has_explicit_version() -> None:
    result = classify_trend_window(TrendSeries(values=[70] * 52, window="12m"))
    assert result.classifier_version == "trend-window-v1"
    assert result.label is TrendLabel.STABLE_HIGH


def load_trend(name: str) -> TrendSeries:
    return TrendSeries.model_validate(json.loads((FIXTURES / name).read_text()))


@pytest.mark.parametrize(
    ("fixture", "expected"),
    [
        ("rising.json", TrendLabel.RISING),
        ("peaked.json", TrendLabel.PEAKED),
        ("seasonal.json", TrendLabel.SEASONAL),
        ("sparse.json", TrendLabel.INSUFFICIENT_DATA),
    ],
)
def test_classification_fixtures(fixture: str, expected: TrendLabel) -> None:
    comparison = (
        load_trend("yoy_5y.json")
        if fixture == "rising.json"
        else TrendSeries(values=([100] * 8 + [20] * 44) * 5, window="5y")
        if fixture == "seasonal.json"
        else None
    )
    result = classify_trend(load_trend(fixture), comparison)
    assert result.label is expected
    assert result.features.coverage > 0
    assert result.threshold_explanation


def test_zero_previous_comparison_is_insufficient() -> None:
    series = TrendSeries(
        query="zero previous",
        geo="US",
        window="12m",
        points=[
            {
                "week": date(2026, 1, 5) + timedelta(weeks=week),
                "value": 20 if week < 13 else 0,
            }
            for week in range(52)
        ],
    )
    result = classify_trend(series)
    assert result.label is TrendLabel.INSUFFICIENT_DATA
    assert result.features.previous_mean == 0
    assert "previous" in result.threshold_explanation.lower()


def test_declining_and_stable_high_thresholds() -> None:
    declining = classify_trend(load_trend("declining.json"))
    assert (
        declining.label is TrendLabel.PEAKED
    )  # Peak rule precedes decline under §7.4.
    stable = TrendSeries(
        query="stable",
        points=[
            {"week": date(2025, 1, 6) + timedelta(weeks=week), "value": 70}
            for week in range(52)
        ],
    )
    assert classify_trend(stable).label is TrendLabel.STABLE_HIGH


def test_five_year_fixture_has_real_window_and_excludes_current_baseline() -> None:
    long_series = load_trend("yoy_5y.json")
    assert long_series.window == "5y"
    assert len(long_series.points) == 260
    short = TrendSeries(
        query="yoy",
        window="12m",
        points=[
            {
                "week": date(2025, 1, 6) + timedelta(weeks=week),
                "value": 20 if week < 39 else 40,
            }
            for week in range(52)
        ],
    )
    result = classify_trend(short, long_series)
    assert len(result.features.yoy_by_year) == 4
    assert all(value == pytest.approx(1.0) for value in result.features.yoy_by_year)


def test_interior_seasonal_peak_repeats_at_yearly_offsets() -> None:
    short = load_trend("seasonal_interior_12m.json")
    long_series = load_trend("seasonal_interior_5y.json")
    assert len(long_series.points) == 260
    result = classify_trend(short, long_series)
    assert result.label is TrendLabel.SEASONAL
    assert result.features.peak_mean > result.features.current_mean


def test_change_and_stable_high_boundaries_are_inclusive() -> None:
    def series(previous: int, current: int) -> TrendSeries:
        return TrendSeries(
            query="boundary",
            points=[
                {
                    "week": date(2025, 1, 6) + timedelta(weeks=week),
                    "value": previous if week < 39 else current,
                }
                for week in range(52)
            ],
        )

    assert (
        classify_trend(
            series(100, 115), long_series=TrendSeries(values=[20] * 260, window="5y")
        ).label
        is TrendLabel.RISING
    )
    assert classify_trend(series(50, 40)).label is TrendLabel.DECLINING
    stable = load_trend("stable_high_5y.json")
    assert len(stable.points) == 260
    assert classify_trend(stable).label is TrendLabel.STABLE_HIGH


class FakeStrategy:
    def __init__(self, series: dict[tuple[str, str], TrendSeries]) -> None:
        self.series = series
        self.calls: list[tuple[str, str, str]] = []

    async def fetch_weekly_series(
        self, query: str, geo: str, window: str
    ) -> TrendSeries:
        self.calls.append((query, geo, window))
        return self.series[(query, window)]


@pytest.mark.asyncio
async def test_collector_queries_generic_term_and_at_most_two_synonyms() -> None:
    source = FakeStrategy(
        {
            ("water bottle", "12m"): load_trend("rising.json"),
            ("water bottle", "5y"): load_trend("yoy_5y.json"),
            ("hydration bottle", "12m"): load_trend("rising.json"),
            ("hydration bottle", "5y"): load_trend("yoy_5y.json"),
            ("sports bottle", "12m"): load_trend("rising.json"),
            ("sports bottle", "5y"): load_trend("yoy_5y.json"),
        }
    )
    result = await GoogleTrendsCollector(source).collect(
        "water bottle",
        "US",
        ("12m", "5y"),
        synonyms=("hydration bottle", "sports bottle", "ignored"),
    )
    assert result.ok
    assert result.value is not None
    evidence = result.value
    assert isinstance(evidence, GoogleTrendsEvidence)
    assert evidence.actual_queries == (
        "water bottle",
        "hydration bottle",
        "sports bottle",
    )
    assert len(source.calls) == 6
    assert all(len(item.points) == 260 for item in evidence.series_5y.values())
    assert all(item.window == "5y" for item in evidence.series_5y.values())
    assert evidence.label is TrendLabel.RISING
    assert all(item.features.coverage > 0 for item in evidence.results.values())


@pytest.mark.asyncio
async def test_collector_conflicting_synonym_labels_are_insufficient() -> None:
    source = FakeStrategy(
        {
            ("generic", "12m"): load_trend("rising.json"),
            ("generic", "5y"): load_trend("yoy_5y.json"),
            ("synonym", "12m"): load_trend("declining.json"),
            ("synonym", "5y"): load_trend("yoy_5y.json"),
        }
    )
    result = await GoogleTrendsCollector(source).collect(
        "generic",
        "US",
        ("12m", "5y"),
        synonyms=("synonym",),
    )
    assert result.value is not None
    evidence = result.value
    assert evidence.label is TrendLabel.INSUFFICIENT_DATA
    assert "conflict" in evidence.threshold_explanation.lower()


def test_api_and_playwright_strategies_share_fetch_contract() -> None:
    assert hasattr(GoogleTrendsStrategy, "fetch_weekly_series")
    assert CollectorError(code="timeout", detail="timed out").retriable is True
