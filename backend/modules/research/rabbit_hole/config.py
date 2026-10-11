from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict

from rabbit_hole.trends import TrendThresholds


class MarketSettings(BaseModel):
    code: str
    currency: str
    min_aov: float = Field(gt=0)
    max_aov: float = Field(gt=0)
    payment_percent: float = Field(ge=0)
    payment_fixed: float = Field(ge=0)
    loss_reserve_percent: float = Field(ge=0)


class AdmissionLimits(BaseModel):
    daily_candidates: int = Field(default=50, ge=1)
    daily_keywords: int = Field(default=20, ge=1)
    daily_scans: int = Field(default=50, ge=1)
    daily_ai_calls: int = Field(default=500, ge=1)
    daily_cost_usd: Decimal = Field(default=Decimal(10), gt=0)
    estimated_call_cost_usd: Decimal = Field(default=Decimal("0.01"), gt=0)
    estimated_research_scan_cost_usd: Decimal = Field(default=Decimal("0.01"), gt=0)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="RABBIT_HOLE_", env_nested_delimiter="__"
    )

    database_url: str
    storage_backend: Literal['s3', 'files'] = 's3'
    storage_path: str = '/app/data/evidence'
    feishu_app_id: str
    feishu_app_secret: str
    feishu_base_app_token: str
    s3_endpoint: HttpUrl
    s3_bucket: str
    s3_access_key: str
    s3_secret_key: str
    openai_api_key: str
    # Optional OpenAI-compatible relay endpoint. Empty means the SDK default.
    openai_base_url: str | None = None
    openai_model: str = ""
    market: MarketSettings
    admission: AdmissionLimits = Field(default_factory=AdmissionLimits)
    trend_thresholds: TrendThresholds = Field(default_factory=TrendThresholds)
    browser_concurrency: int = Field(default=2, ge=1, le=2)
    poll_seconds: int = Field(default=60, ge=10)
    public_dns: Literal["system", "google"] = "system"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


class OfflineRuntimeSettings(BaseModel):
    """Local lifecycle configuration with no provider credentials or env lookup."""
    model_config = {"frozen": True}
    database: Path
    evidence_root: Path
    browser_root: Path
    lock_root: Path
    evidence_bucket: str | None = None
    collector_version: str | None = None
    allow_external: Literal[False] = False
