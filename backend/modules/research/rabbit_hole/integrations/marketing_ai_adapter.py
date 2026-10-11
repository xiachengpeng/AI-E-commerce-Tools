"""Opt-in typed callable boundary; native research AI remains the default.

No HTTP credentials, provider configuration, hidden fallback, or retry lives here.
The caller supplies an authenticated, budget-controlled generator explicitly.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class MarketingHypotheses(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hypotheses: list[str] = Field(min_length=1, max_length=6)


async def generate_hypotheses(
    generator: Callable[..., Awaitable[Any]], *, title: str, market: str
) -> MarketingHypotheses:
    if market not in {"US", "GB", "CA", "AU", "DE", "FR", "JP"}:
        raise ValueError("unsupported market")
    if not title.strip() or len(title) > 200:
        raise ValueError("invalid title")
    value = await generator(
        MarketingHypotheses,
        system_instruction="提出待核实的选品研究假设；不得确认商品事实或替代证据。",
        untrusted_data={"title": title, "market": market},
    )
    return MarketingHypotheses.model_validate(value)
