"""Research operation contracts; bounds are explicit and never truncate evidence."""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ResearchOperation = Literal["direction", "keywords", "expand", "verify", "extract"]
INPUT_BYTES_LIMIT = 262144
OUTPUT_TOKENS = {
    "direction": 1500,
    "keywords": 5000,
    "expand": 5000,
    "verify": 7000,
    "extract": 5000,
}


class ResearchAIRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    operation: ResearchOperation
    schema: type[BaseModel]
    system_instruction: str
    untrusted_data: str | dict
    action_id: str | None
    attempt: int = Field(ge=0, strict=True)


class ResearchKeywords(BaseModel):
    # Original per-candidate validation/filtering remains in keyword_phrases.
    keywords: list[dict]


class ResearchAssessments(BaseModel):
    # Original identity/hash/quote gate normalizes each assessment after parsing.
    assessments: list[dict]


class ResearchDirection(BaseModel):
    direction: str = Field(min_length=1, max_length=1000)


class ExplicitMarket(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)
    code: Literal["US", "GB", "CA", "AU", "DE", "FR", "JP"]
    currency: str = Field(min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    min_aov: float = Field(gt=0)
    max_aov: float = Field(gt=0)
    payment_percent: float = Field(ge=0)
    payment_fixed: float = Field(ge=0)
    loss_reserve_percent: float = Field(ge=0)

    @model_validator(mode="after")
    def ordered_range(self):
        if self.max_aov < self.min_aov:
            raise ValueError("market AOV range is invalid")
        return self


class ExplicitAdmission(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)
    daily_candidates: int = Field(ge=1, strict=True)
    daily_keywords: int = Field(ge=1, strict=True)
    daily_scans: int = Field(ge=1, strict=True)
    daily_ai_calls: int = Field(ge=1, strict=True)
    daily_cost_usd: Decimal = Field(gt=0)
    estimated_call_cost_usd: Decimal = Field(gt=0)
    estimated_research_scan_cost_usd: Decimal = Field(gt=0)


class ExplicitTrendThresholds(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)
    coverage: float = Field(ge=0, le=1)
    rising: float = Field(ge=0)
    declining: float = Field(ge=0)
    stable_median_ratio: float = Field(ge=0)
    peak_ratio: float = Field(ge=0, le=1)
    seasonal_ratio: float = Field(ge=1)
    seasonal_years: int = Field(ge=3, le=5, strict=True)
    seasonal_tolerance_weeks: int = Field(ge=0, strict=True)


class ResearchBusinessSettings(BaseModel):
    """Required migrated/confirmed values, without environment or credentials.

    Round-trip with model_dump_json()/model_validate_json(). Local integration
    configuration may point business_settings_path at that private absolute JSON
    file; worker CLI uses --business-settings. Neither path creates defaults.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)
    market: ExplicitMarket
    admission: ExplicitAdmission
    trend_thresholds: ExplicitTrendThresholds
    browser_concurrency: int = Field(ge=1, le=2, strict=True)
    poll_seconds: int = Field(ge=10, strict=True)
    public_dns: Literal["system", "google"]
