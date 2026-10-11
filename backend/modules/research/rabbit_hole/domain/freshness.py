"""Freshness interpretation of explicit evidence deadlines."""

from __future__ import annotations

from datetime import datetime


def _date(value: str | None, name: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an ISO datetime")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a timezone")
    return parsed


def evidence_freshness(
    observed_at: str | None,
    review_due_at: str | None,
    valid_until: str | None,
    now: datetime,
) -> dict[str, str | None]:
    """Classify evidence without assigning an unstated expiry period."""

    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must include a timezone")
    observed = _date(observed_at, "observed_at")
    review_due = _date(review_due_at, "review_due_at")
    valid = _date(valid_until, "valid_until")
    if observed is not None and any(
        deadline is not None and deadline < observed
        for deadline in (review_due, valid)
    ):
        raise ValueError("deadlines must not precede observation")
    if review_due is not None and valid is not None and review_due > valid:
        raise ValueError("review_due_at must not exceed valid_until")
    if observed is None:
        status, reason = "unknown", "缺少观察时间，不能判断证据时效。"
    elif valid is not None and now > valid:
        status, reason = "expired", "已超过明确的有效期限。"
    elif review_due is not None and now > review_due:
        status, reason = "stale", "已到明确的复核日期，需重新核对。"
    elif review_due is not None or valid is not None:
        status, reason = "fresh", "仍在明确的复核或有效期限内。"
    else:
        status, reason = "unknown", "没有明确的复核或有效期限，不自动推断为新鲜。"
    return {
        "status": status,
        "reason": reason,
        "observed_at": observed_at,
        "review_due_at": review_due_at,
        "valid_until": valid_until,
    }
