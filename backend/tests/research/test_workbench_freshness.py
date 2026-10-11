"""Only explicit deadlines or the existing quote rule establish freshness."""

from datetime import UTC, datetime

import pytest

from rabbit_hole.domain.freshness import evidence_freshness

NOW = datetime(2026, 9, 29, 4, 0, tzinfo=UTC)
OBSERVED = "2026-09-01T00:00:00Z"


@pytest.mark.parametrize(
    ("review_due", "valid_until", "status"),
    [
        ("2026-10-01T00:00:00Z", "2026-10-15T00:00:00Z", "fresh"),
        ("2026-09-20T00:00:00Z", "2026-10-15T00:00:00Z", "stale"),
        ("2026-09-20T00:00:00Z", "2026-09-28T00:00:00Z", "expired"),
        (None, None, "unknown"),
    ],
)
def test_freshness_uses_explicit_deadlines_only(review_due, valid_until, status):
    result = evidence_freshness(OBSERVED, review_due, valid_until, NOW)

    assert result["status"] == status
    assert result["observed_at"] == OBSERVED
    assert result["valid_until"] == valid_until
    assert result["reason"]


def test_missing_observation_cannot_be_called_fresh() -> None:
    result = evidence_freshness(None, None, "2026-10-15T00:00:00Z", NOW)
    assert result["status"] == "unknown"


@pytest.mark.parametrize(
    ("observed", "review_due", "valid_until"),
    [
        ("not-a-date", None, None),
        (OBSERVED, "2026-10-20T00:00:00Z", "2026-10-15T00:00:00Z"),
        (OBSERVED, None, "2026-08-30T00:00:00Z"),
    ],
)
def test_invalid_deadline_sequence_is_rejected(observed, review_due, valid_until):
    with pytest.raises(ValueError):
        evidence_freshness(observed, review_due, valid_until, NOW)
