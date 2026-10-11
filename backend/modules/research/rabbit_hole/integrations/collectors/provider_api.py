"""Strict parsers for third-party observations; no automatic evidence approval."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from rabbit_hole.domain.ad_copy import snapshot_ad_copy
from rabbit_hole.domain.ad_media import normalize_ad_media
from rabbit_hole.input_urls import canonical_research_url
from rabbit_hole.trends import TrendSeries


class ProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def parse_meta_items(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        raise ProviderError("schema_drift", "接口广告列表格式变化")
    ads: dict[str, dict[str, Any]] = {}
    for row in items:
        if not isinstance(row, dict):
            raise ProviderError("schema_drift", "接口广告记录格式变化")
        if row.get("errorCode") == "ADS_NOT_FOUND":
            if len(items) != 1:
                raise ProviderError("schema_drift", "空结果与广告记录冲突")
            return []
        if row.get("error") or row.get("errorCode"):
            raise ProviderError("source_error", "提供方返回错误记录，未作为广告保存")
        snap = row.get("snapshot") or {}
        ad_id = row.get("ad_archive_id")
        if not isinstance(ad_id, str) or not ad_id or row.get("is_active") is not True:
            raise ProviderError("schema_drift", "广告缺少字符串ID或活跃状态不符合请求")
        media = [*snap.get("videos", []), *snap.get("cards", [])]
        video = next((v.get("video_hd_url") or v.get("video_sd_url") for v in media if v.get("video_hd_url") or v.get("video_sd_url")), None)
        if not video:
            raise ProviderError("filter_mismatch", "返回广告未包含可识别视频，筛选需要核对")
        start = row.get("start_date")
        started_date = datetime.fromtimestamp(start, UTC).date() if isinstance(start, (int, float)) else None
        started = started_date.isoformat() if started_date else None
        images = snap.get("images")
        images = images if isinstance(images, list) else []
        previews = normalize_ad_media([
            {"kind": "video" if item.get("video_hd_url") or item.get("video_sd_url") else "image",
             "url": item.get("video_hd_url") or item.get("video_sd_url") or item.get("original_image_url") or item.get("resized_image_url"),
             "preview_url": item.get("video_preview_image_url")}
            for item in [*media, *images] if isinstance(item, dict)
        ])
        ads[ad_id] = {
            "id": ad_id, "advertiser": row.get("page_name") or snap.get("page_name") or "未记录",
            "start_date": started,
            "landing_url": canonical_research_url(str(snap["link_url"])) if snap.get("link_url") else None,
            "primary_text": snapshot_ad_copy(snap),
            **({"media": previews} if previews else {}),
            "active": True,
            "started_at": started, "currently_active": True, "continuity_status": "unknown",
            "observed_at": None, "ad_age_days": max(0, (datetime.now(UTC).date() - started_date).days) if started_date else None,
        }
    if not items:
        raise ProviderError("unverified_empty", "提供方返回空列表，但未明确确认无广告")
    return list(ads.values())[:100]


def parse_serpapi_series(data: dict[str, Any], query: str, window: str, *, market: str = "US") -> TrendSeries:
    params = data.get("search_parameters", {})
    expected = "today 12-m" if window == "12m" else "today 5-y"
    if data.get("error") or data.get("search_metadata", {}).get("status") != "Success":
        raise ProviderError("source_error", "SerpApi 未返回成功的趋势结果")
    if params.get("q") != query or params.get("geo") != market or params.get("date") != expected:
        raise ProviderError("filter_mismatch", "趋势查询词、地区或窗口与请求不一致")
    rows = list(data.get("interest_over_time", {}).get("timeline_data", []))
    while rows and rows[-1].get("partial_data"):
        rows.pop()
    if len(rows) < (48 if window == "12m" else 260):
        raise ProviderError("insufficient_data", "完整周数据不足，无法进行趋势分类")
    points = []
    last = None
    for row in rows:
        try:
            timestamp = int(row["timestamp"])
            values = row["values"]
            value = values[0]["extracted_value"]
            if row.get("partial_data") or len(values) != 1 or values[0].get("query") != query or isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 100 or str(values[0].get("value", "")).startswith("<"):
                raise ValueError()
            if last is not None and timestamp - last != 604800:
                raise ValueError()
            points.append({"week": datetime.fromtimestamp(timestamp, UTC).date(), "value": value})
            last = timestamp
        except (KeyError, TypeError, ValueError, IndexError, OverflowError):
            raise ProviderError("schema_drift", "趋势数据非连续完整周序列或数值无效") from None
    return TrendSeries.model_validate({"query": query, "geo": market, "window": window, "points": points})
