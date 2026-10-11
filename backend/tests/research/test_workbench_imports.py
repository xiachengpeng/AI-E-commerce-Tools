from datetime import UTC, datetime, timedelta

import pytest


def test_trends_import_does_not_accept_substring_query():
    from rabbit_hole.application.imports import parse_trends_csv

    start = datetime.now(UTC).date() - timedelta(weeks=52)
    rows = "\n".join(f"{start + timedelta(weeks=i)},70" for i in range(52))
    with pytest.raises(ValueError, match="搜索词"):
        parse_trends_csv(
            {
                "csv": "Week,pill organizer: (US)\n" + rows,
                "query": "organizer",
                "market": "US",
                "window": "12m",
            }
        )


def test_trends_import_rejects_short_or_mismatched_data():
    from rabbit_hole.application.imports import parse_trends_csv

    with pytest.raises(ValueError):
        parse_trends_csv(
            {
                "csv": "Week,other: (US)\n2026-01-01,50",
                "query": "organizer",
                "market": "US",
                "window": "12m",
            }
        )


def test_trends_import_preserves_series_and_context():
    from rabbit_hole.application.imports import parse_trends_csv
    from rabbit_hole.trends import TrendSeries, classify_trend_window

    start = datetime.now(UTC).date() - timedelta(weeks=52)
    rows = "\n".join(f"{start + timedelta(weeks=i)},70" for i in range(52))
    result = parse_trends_csv(
        {
            "csv": "Week,organizer: (US)\n" + rows,
            "query": "organizer",
            "market": "US",
            "window": "12m",
            "product_id": "p",
            "source_url": "https://trends.google.com/trends/explore",
            "observed_at": "2026-09-13T01:00:00Z",
            "confirmed": True,
        }
    )
    assert result["channel"] == "trends"
    assert len(result["data"]["points"]) == 52
    assert result["data"]["origin"] == "manual_csv"
    assert result["conclusion"] in {"stable-high", "insufficient-data"}
    series = TrendSeries(
        query="organizer",
        geo="US",
        window="12m",
        points=result["data"]["points"],
    )
    assert result["data"]["classification"] == classify_trend_window(series).model_dump(
        mode="json"
    )
