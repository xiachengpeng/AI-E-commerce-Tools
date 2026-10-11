"""Bounded import of weekly Google Trends exports with explicit provenance."""

from __future__ import annotations

import csv
import io
import math
from datetime import UTC, date, datetime
from typing import Any

from rabbit_hole.domain.markets import MARKETS, region_labels
from rabbit_hole.trends import TrendPoint, TrendSeries, classify_trend_window


def parse_trends_csv(data: dict[str, Any]) -> dict[str, Any]:
    query = str(data.get("query", "")).strip()
    window = data.get("window")
    market = data.get("market")
    if not query or not isinstance(market, str) or market not in MARKETS or window not in {"12m", "5y"}:
        raise ValueError("请确认查询词、项目目标市场和12个月/5年时间窗")
    raw = data.get("csv")
    if not isinstance(raw, str) or len(raw) > 300_000:
        raise ValueError("CSV为空或过大")
    rows = list(csv.reader(io.StringIO(raw.lstrip("\ufeff"))))
    header = next(
        (
            i
            for i, row in enumerate(rows)
            if len(row) == 2 and row[0].strip().lower() in {"week", "周", "週"}
        ),
        None,
    )
    if header is None:
        raise ValueError("请导入单个搜索词的周度CSV，表头第一列应为Week或周")
    label = rows[header][1].casefold().replace(" ", "")
    expected_query = query.casefold().replace(" ", "")
    if label not in {
        f"{expected_query}:{region}"
        for region in (f"({label})" for label in region_labels(market))
    }:
        raise ValueError("CSV表头的搜索词或地区与输入不一致，请选择与项目目标市场一致的数据")
    points: list[TrendPoint] = []
    for row in rows[header + 1 :]:
        if not row or not any(row):
            continue
        if len(row) != 2:
            raise ValueError("CSV必须仅包含日期与一个搜索词的热度")
        try:
            week = date.fromisoformat(row[0].strip())
            value = float(row[1])
        except ValueError:
            raise ValueError(
                "日期或热度格式不正确；不自动猜测缺失值或小于1的数值"
            ) from None
        if (
            not math.isfinite(value)
            or not 0 <= value <= 100
            or week > datetime.now(UTC).date()
        ):
            raise ValueError("热度应为0–100的有限数值，日期不能在未来")
        if points and (week - points[-1].week).days != 7:
            raise ValueError(
                "数据必须是按周连续递增的序列，不能缺周、重复或混用日/月数据"
            )
        points.append(TrendPoint(week=week, value=value))
    minimum, maximum = (50, 54) if window == "12m" else (250, 265)
    if not minimum <= len(points) <= maximum:
        raise ValueError(
            f"当前时间窗需要{minimum}–{maximum}个连续周数据，实际{len(points)}个"
        )
    if (datetime.now(UTC).date() - points[-1].week).days > 21:
        raise ValueError("数据末期超过21天，请重新导出当前时间窗")
    series = TrendSeries(query=query, geo=market, window=window, points=tuple(points))
    classification = classify_trend_window(series)
    return {
        "product_id": data.get("product_id"),
        "channel": "trends",
        "window": window,
        "query": query,
        "market": market,
        "source_url": data.get("source_url"),
        "observed_at": data.get("observed_at"),
        "confirmed": data.get("confirmed") is True,
        "conclusion": classification.label.value,
        "notes": "从人工提交的Google Trends周度CSV计算；来源真实性由提交者确认。",
        "data": {
            "origin": "manual_csv",
            "points": series.model_dump(mode="json")["points"],
            "classification": classification.model_dump(mode="json"),
        },
    }
