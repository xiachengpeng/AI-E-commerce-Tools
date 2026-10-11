"""Google Trends source boundary with replaceable API and Playwright strategies."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field

from rabbit_hole.domain.legacy import Clock, SystemClock
from rabbit_hole.integrations.collectors.base import CollectorError, CollectorResult
from rabbit_hole.trends import (
    TREND_WINDOW_CLASSIFIER_VERSION,
    TrendClassification,
    TrendLabel,
    TrendSeries,
    TrendThresholds,
    classify_trend,
)


class GoogleTrendsStrategy(Protocol):
    async def fetch_weekly_series(
        self, query: str, geo: str, window: str
    ) -> TrendSeries: ...


FetchSeries = Callable[[str, str, str], TrendSeries | Awaitable[TrendSeries]]


class TrendsPageError(RuntimeError):
    """Closed, non-sensitive failure codes for the production page boundary."""

    def __init__(self, code: str) -> None:
        if code not in {
            "schema_drift",
            "selector_drift",
            "access_restricted",
            "timeout",
            "source_error",
        }:
            code = "source_error"
        self.code = code
        self.retriable = code in {"timeout", "source_error"}
        super().__init__(code)


class GoogleTrendsApiStrategy:
    """HTTP strategy; enabling it does not alter the deterministic classifier."""

    def __init__(
        self,
        fetcher: FetchSeries | None = None,
        *,
        client: httpx.AsyncClient | None = None,
        endpoint: str | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._client = client
        self._endpoint = endpoint

    async def fetch_weekly_series(
        self, query: str, geo: str, window: str
    ) -> TrendSeries:
        if self._fetcher is not None:
            result = self._fetcher(query, geo, window)
            return await result if inspect.isawaitable(result) else result
        if self._client is None or self._endpoint is None:
            raise RuntimeError("API strategy needs a fetcher or client and endpoint")
        response = await self._client.get(
            self._endpoint, params={"query": query, "geo": geo, "window": window}
        )
        response.raise_for_status()
        return TrendSeries.model_validate(response.json())


class GoogleTrendsPlaywrightStrategy:
    """UI strategy boundary. Page parsing is supplied by the caller/fake in CI."""

    def __init__(self, fetcher: FetchSeries | None = None) -> None:
        self._fetcher = fetcher

    async def fetch_weekly_series(
        self, query: str, geo: str, window: str
    ) -> TrendSeries:
        if self._fetcher is None:
            raise RuntimeError("Playwright strategy requires an injected page parser")
        result = self._fetcher(query, geo, window)
        return await result if inspect.isawaitable(result) else result


GoogleTrendsHTTPStrategy = GoogleTrendsApiStrategy
GoogleTrendsPlaywrightUI = GoogleTrendsPlaywrightStrategy


class GoogleTrendsEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    query: str
    geo: str
    actual_queries: tuple[str, ...]
    collected_at: datetime
    series_12m: dict[str, TrendSeries] = Field(default_factory=dict)
    series_5y: dict[str, TrendSeries] = Field(default_factory=dict)
    results: dict[str, TrendClassification] = Field(default_factory=dict)
    label: TrendLabel
    threshold_explanation: str
    errors: tuple[CollectorError, ...] = ()
    classifier_version: str = TREND_WINDOW_CLASSIFIER_VERSION


class GoogleTrendsCollector:
    def __init__(
        self,
        strategy: GoogleTrendsStrategy,
        clock: Clock | None = None,
        *,
        thresholds: TrendThresholds | None = None,
    ) -> None:
        self._strategy = strategy
        self._clock = clock or SystemClock()
        self._thresholds = thresholds or TrendThresholds()

    async def collect(
        self,
        query: str,
        geo: str = "US",
        windows: Sequence[str] = ("12m", "5y"),
        synonyms: Sequence[str] = (),
    ) -> CollectorResult[GoogleTrendsEvidence]:
        generic = query.strip()
        if not generic:
            raise ValueError("query must not be empty")
        requested = tuple(dict.fromkeys(window.strip() for window in windows))
        if "12m" not in requested or "5y" not in requested:
            raise ValueError("Google Trends collection requires 12m and 5y windows")
        normalized = {" ".join(generic.split()).casefold(): " ".join(generic.split())}
        for item in synonyms:
            text = " ".join(item.split())
            if text:
                normalized.setdefault(text.casefold(), text)
        actual_queries = tuple(normalized.values())[:3]
        short: dict[str, TrendSeries] = {}
        long: dict[str, TrendSeries] = {}
        results: dict[str, TrendClassification] = {}
        errors: list[CollectorError] = []
        for actual_query in actual_queries:
            try:
                short_series = await self._strategy.fetch_weekly_series(
                    actual_query, geo, "12m"
                )
                long_series = await self._strategy.fetch_weekly_series(
                    actual_query, geo, "5y"
                )
                if short_series.window != "12m":
                    raise ValueError("12m strategy response has an incorrect window")
                if long_series.window != "5y" or len(long_series.points) < 260:
                    raise ValueError(
                        "5y strategy response must contain at least 260 weekly points"
                    )
                short[actual_query] = short_series
                long[actual_query] = long_series
                results[actual_query] = classify_trend(
                    short_series, long_series, thresholds=self._thresholds
                )
            except Exception as exc:  # noqa: BLE001 - source failures become typed evidence
                errors.append(
                    CollectorError(
                        code=exc.code
                        if isinstance(exc, TrendsPageError)
                        else "source_error",
                        detail="Google Trends collection did not return validated weekly observations",
                        retriable=exc.retriable
                        if isinstance(exc, TrendsPageError)
                        else True,
                        source="google-trends",
                    )
                )
        labels = {item.label for item in results.values()}
        if errors or len(results) != len(actual_queries):
            label = TrendLabel.INSUFFICIENT_DATA
            explanation = "insufficient-data: one or more Google Trends queries failed"
        elif len(labels) != 1:
            label = TrendLabel.INSUFFICIENT_DATA
            explanation = (
                "insufficient-data: conflicting labels across approved queries"
            )
        else:
            label = next(iter(labels))
            explanation = (
                "all approved queries agree: "
                + next(iter(results.values())).threshold_explanation
            )
        evidence = GoogleTrendsEvidence(
            query=generic,
            geo=geo,
            actual_queries=actual_queries,
            collected_at=self._clock.now().astimezone(UTC),
            series_12m=short,
            series_5y=long,
            results=results,
            label=label,
            threshold_explanation=explanation,
            errors=tuple(errors),
        )
        return CollectorResult.success(evidence)


# Friendly aliases for callers selecting a source strategy by configuration.
GoogleTrendsAPI = GoogleTrendsApiStrategy
GoogleTrendsUI = GoogleTrendsPlaywrightStrategy
