"""Deterministic, evidence-preserving Google Trends classification."""

from __future__ import annotations

from datetime import date
from enum import StrEnum
from statistics import mean, median
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TrendLabel(StrEnum):
    INSUFFICIENT_DATA = "insufficient-data"
    SEASONAL = "seasonal"
    PEAKED = "peaked"
    RISING = "rising"
    DECLINING = "declining"
    STABLE_HIGH = "stable-high"


TREND_WINDOW_CLASSIFIER_VERSION: Literal["trend-window-v1"] = "trend-window-v1"


class TrendPoint(BaseModel):
    model_config = ConfigDict(frozen=True)

    week: date
    value: float = Field(ge=0)


class TrendSeries(BaseModel):
    """A weekly Google Trends series, retaining its query and market context."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    query: str = ""
    geo: str = "US"
    window: str = "12m"
    points: tuple[TrendPoint, ...] = ()
    # ``values`` and ``weeks`` make the model convenient for API adapters and
    # preserve compatibility with the compact shape used by some fixtures.
    values: tuple[float, ...] | None = None
    weeks: tuple[date, ...] | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_points(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        raw_points = value.get("points")
        if raw_points is None and value.get("values") is not None:
            raw_values = value["values"]
            raw_weeks = value.get("weeks")
            if raw_weeks is None:
                raw_weeks = [date(2000, 1, 3)]
                raw_weeks.extend(
                    raw_weeks[-1].fromordinal(raw_weeks[-1].toordinal() + 7)
                    for _ in range(len(raw_values) - 1)
                )
            value = dict(value)
            value["points"] = [
                {"week": week, "value": item}
                for week, item in zip(raw_weeks, raw_values, strict=True)
            ]
        elif raw_points is not None:
            value = dict(value)
            value["points"] = [
                {"week": item[0], "value": item[1]}
                if isinstance(item, (list, tuple))
                else item
                for item in raw_points
            ]
        return value

    @model_validator(mode="after")
    def normalize_series(self) -> TrendSeries:
        if len(self.points) < 1:
            raise ValueError("trend series must contain at least one weekly point")
        if any(
            right.week <= left.week for left, right in zip(self.points, self.points[1:])
        ):
            raise ValueError("trend points must be sorted by week")
        return self


class TrendFeatures(BaseModel):
    """Numerical evidence used by the classifier (never hidden from callers)."""

    model_config = ConfigDict(frozen=True)

    point_count: int = Field(ge=0)
    nonzero_count: int = Field(ge=0)
    coverage: float = Field(ge=0, le=1)
    current_mean: float = Field(ge=0)
    previous_mean: float = Field(ge=0)
    change_ratio: float | None = None
    rolling_13_current: float = Field(ge=0)
    rolling_13_previous: float = Field(ge=0)
    seasonal_peak_mean: float = Field(ge=0)
    seasonal_trough_mean: float = Field(ge=0)
    seasonal_strength: float = Field(ge=0)
    peak_mean: float = Field(ge=0)
    peak_index: int | None = None
    latest_mean: float = Field(ge=0)
    five_year_yoy: float | None = None
    yoy_by_year: tuple[float, ...] = ()

    @property
    def nonzero_coverage(self) -> float:
        return self.coverage

    @property
    def recent_mean(self) -> float:
        return self.current_mean

    @property
    def previous_comparison_mean(self) -> float:
        return self.previous_mean

    @property
    def yoy_growth(self) -> float | None:
        return self.five_year_yoy


class TrendClassification(BaseModel):
    """A label plus the complete feature and threshold evidence for that label."""

    model_config = ConfigDict(frozen=True)

    label: TrendLabel
    features: TrendFeatures
    threshold_explanation: str
    thresholds: dict[str, str] = Field(default_factory=dict)

    @property
    def explanation(self) -> str:
        return self.threshold_explanation


class PersistedTrendClassification(BaseModel):
    model_config = ConfigDict(frozen=True)

    classifier_version: Literal["trend-window-v1"] = TREND_WINDOW_CLASSIFIER_VERSION
    label: TrendLabel
    features: TrendFeatures
    threshold_explanation: str
    thresholds: dict[str, str] = Field(default_factory=dict)


def _window_means(values: list[float], width: int) -> list[float]:
    if len(values) < width:
        return []
    return [
        mean(values[index : index + width]) for index in range(len(values) - width + 1)
    ]


def _features(series: TrendSeries, comparison: TrendSeries | None) -> TrendFeatures:
    values = [point.value for point in series.points]
    count = len(values)
    nonzero = sum(value > 0 for value in values)
    current = mean(values[-13:]) if values else 0.0
    previous = mean(values[-26:-13]) if count >= 26 else 0.0
    change = None if previous == 0 else (current - previous) / previous
    windows = _window_means(values, 13)
    peak = max(windows, default=0.0)
    trough = min(windows, default=0.0)
    latest = current
    strength = 0.0 if trough == 0 else peak / trough
    peak_index = windows.index(peak) if windows else None

    yoy: list[float] = []
    if comparison is not None:
        comparison_values = [point.value for point in comparison.points]
        current_year = (
            mean(comparison_values[-13:]) if len(comparison_values) >= 13 else 0.0
        )
        # Compare the current 13-week period with periods one through five
        # years earlier.  The current period in the 5-year response is a
        # baseline, not a year-over-year observation, so it is never emitted.
        for years_ago in range(1, 6):
            end = len(comparison_values) - 52 * years_ago
            start = end - 13
            if start < 0:
                break
            prior = mean(comparison_values[start:end])
            if prior > 0:
                yoy.append((current_year - prior) / prior)
    return TrendFeatures(
        point_count=count,
        nonzero_count=nonzero,
        coverage=nonzero / count if count else 0.0,
        current_mean=current,
        previous_mean=previous,
        change_ratio=change,
        rolling_13_current=current,
        rolling_13_previous=previous,
        seasonal_peak_mean=peak,
        seasonal_trough_mean=trough,
        seasonal_strength=strength,
        peak_mean=peak,
        peak_index=peak_index,
        latest_mean=latest,
        five_year_yoy=mean(yoy) if yoy else None,
        yoy_by_year=tuple(yoy),
    )


class TrendThresholds(BaseModel):
    coverage: float = Field(default=0.5, ge=0, le=1)
    rising: float = Field(default=0.15, ge=0)
    declining: float = Field(default=0.20, ge=0)
    stable_median_ratio: float = Field(default=0.70, ge=0)
    peak_ratio: float = Field(default=0.60, ge=0, le=1)
    seasonal_ratio: float = Field(default=1.5, ge=1)
    seasonal_years: int = Field(default=3, ge=3, le=5)
    seasonal_tolerance_weeks: int = Field(default=4, ge=0)


def _seasonal_long(series: TrendSeries | None, thresholds: TrendThresholds) -> bool:
    if series is None or len(series.points) < 156:
        return False
    values = [point.value for point in series.points][-260:]
    peaks: list[int] = []
    for start in range(0, len(values) - 51, 52):
        year = values[start : start + 52]
        windows = _window_means(year, 8)
        baseline = median(year)
        if baseline > 0 and max(windows) >= thresholds.seasonal_ratio * baseline:
            peaks.append(windows.index(max(windows)))
    return any(
        sum(0 <= other - peak <= thresholds.seasonal_tolerance_weeks for other in peaks)
        >= thresholds.seasonal_years
        for peak in peaks
    )


def classify_trend(
    series: TrendSeries,
    comparison: TrendSeries | None = None,
    *,
    long_series: TrendSeries | None = None,
    thresholds: TrendThresholds | None = None,
) -> TrendClassification:
    """Classify a series using fixed precedence and return auditable evidence."""

    comparison = (
        comparison or long_series or (series if series.window == "5y" else None)
    )
    rules = thresholds or TrendThresholds()
    features = _features(series, comparison)
    values = [point.value for point in series.points]
    long_values = (
        [point.value for point in comparison.points] if comparison is not None else []
    )
    annual_ok = len(long_values) >= 104 and mean(long_values[-52:]) >= mean(
        long_values[:52]
    )
    recent = values[-52:]
    peak_week = recent.index(max(recent))
    # The peak-containing, contiguous 13-week block belongs to this request.
    peak_start = min((peak_week // 13) * 13, max(0, len(recent) - 13))
    peak_mean = mean(recent[peak_start : peak_start + 13])
    if len(values) < 52 or features.coverage < rules.coverage:
        label = TrendLabel.INSUFFICIENT_DATA
    elif _seasonal_long(comparison, rules):
        label = TrendLabel.SEASONAL
    elif (
        peak_week < len(recent) - 13
        and features.current_mean < rules.peak_ratio * peak_mean
    ):
        label = TrendLabel.PEAKED
    elif (
        features.change_ratio is not None
        and features.change_ratio >= rules.rising - 1e-12
        and annual_ok
    ):
        label = TrendLabel.RISING
    elif (
        features.change_ratio is not None
        and features.change_ratio <= -rules.declining + 1e-12
    ):
        label = TrendLabel.DECLINING
    elif (
        features.current_mean >= rules.stable_median_ratio * median(values)
        and features.current_mean > 0
    ):
        label = TrendLabel.STABLE_HIGH
    else:
        label = TrendLabel.INSUFFICIENT_DATA
    return TrendClassification(
        label=label,
        features=features,
        thresholds={key: str(value) for key, value in rules.model_dump().items()},
        threshold_explanation=f"{label}: coverage={features.coverage}; current={features.current_mean}; previous={features.previous_mean}; change={features.change_ratio}; long_window_non_declining={annual_ok}; series_median={median(values)}; peak_13_mean={peak_mean}",
    )


def classify_trend_window(
    series: TrendSeries,
    comparison: TrendSeries | None = None,
    *,
    long_series: TrendSeries | None = None,
    thresholds: TrendThresholds | None = None,
) -> PersistedTrendClassification:
    """Return one auditable classification contract for exactly one window."""
    classification = classify_trend(
        series,
        comparison,
        long_series=long_series,
        thresholds=thresholds,
    )
    return PersistedTrendClassification(
        classifier_version=TREND_WINDOW_CLASSIFIER_VERSION,
        **classification.model_dump(),
    )
