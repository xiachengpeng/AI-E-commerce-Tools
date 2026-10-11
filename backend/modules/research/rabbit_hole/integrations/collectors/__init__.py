"""Collector contracts and source-specific adapters."""

from rabbit_hole.integrations.collectors.base import CollectorError, CollectorResult
from rabbit_hole.integrations.collectors.google import (
    GoogleTrendsApiStrategy,
    GoogleTrendsCollector,
    GoogleTrendsPlaywrightStrategy,
)

__all__ = [
    "CollectorError",
    "CollectorResult",
    "GoogleTrendsApiStrategy",
    "GoogleTrendsCollector",
    "GoogleTrendsPlaywrightStrategy",
]
