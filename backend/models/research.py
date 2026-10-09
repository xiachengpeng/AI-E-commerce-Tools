"""Versioned research DTOs: no raw project state or provider settings."""
from typing import Literal
from uuid import UUID
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictFloat, model_validator


class ResearchModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class SourceRef(ResearchModel):
    system: Literal['rabbit_hole']
    project_id: UUID
    product_id: UUID
    identity_revision: int = Field(ge=1, strict=True)
    source_version: int = Field(ge=0, strict=True)


class FactDTO(ResearchModel):
    key: Literal['product_name', 'category', 'material', 'dimensions', 'features', 'warranty']
    value: str | None = Field(max_length=2000)
    state: Literal['confirmed', 'inferred', 'unknown', 'stale']
    confirmation_method: str | None
    confirmed_at: AwareDatetime | None
    evidence_refs: list[str] = Field(max_length=20)


class ProductSnapshot(ResearchModel):
    contract_version: Literal[1]
    source_ref: SourceRef
    market: Literal['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP']
    name: str = Field(max_length=500)
    url: str | None
    facts: list[FactDTO] = Field(max_length=20)
    steps: list[dict] = Field(max_length=20)
    decision: str | None
    merged: bool = False


class ProjectSummary(ResearchModel):
    id: UUID
    title: str = Field(max_length=200)
    market: str
    source_version: int = Field(ge=0, strict=True)
    updated_at: AwareDatetime


class ProjectPage(ResearchModel):
    contract_version: Literal[1]
    projects: list[ProjectSummary] = Field(max_length=50)
    next_cursor: UUID | None


class ProjectSnapshot(ProjectSummary):
    contract_version: Literal[1]
    direction: str = Field(max_length=1000)
    products: list[ProductSnapshot] = Field(max_length=200)
    keyword_count: int = Field(ge=0)

    @model_validator(mode='after')
    def validate_product_references(self):
        for product in self.products:
            if (product.source_ref.project_id != self.id or product.market != self.market
                    or product.source_ref.source_version != self.source_version):
                raise ValueError('研究商品引用必须属于当前项目、国家和版本')
        return self


class LogisticsRequest(ResearchModel):
    actual_weight_kg: StrictFloat | None = None
    dimensions_cm: tuple[StrictFloat | None, StrictFloat | None, StrictFloat | None]
    divisor_cm3_per_kg: StrictFloat | None = None


class ScenarioRequest(ResearchModel):
    monthly_visits: StrictFloat
    aov: StrictFloat
    cvr_low: StrictFloat
    cvr_base: StrictFloat
    cvr_high: StrictFloat
    traffic_scope: Literal['domain', 'store', 'product', 'landing_page']


class PreviewRequest(ResearchModel):
    expected_source_version: int = Field(ge=0, strict=True)
    expected_identity_revision: int = Field(ge=1, strict=True)
    expected_market: str
    existing: dict[str, str] = Field(default_factory=dict)


class ConfirmFactRequest(ResearchModel):
    command_id: UUID
    expected_version: int = Field(ge=0, strict=True)
    identity_revision: int = Field(ge=1, strict=True)
    market: Literal['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP']
    key: Literal['product_name', 'category', 'material', 'dimensions', 'features', 'warranty']
    value: str = Field(min_length=1, max_length=2000)
    source_url: str = Field(min_length=1, max_length=2048)
    own_product: Literal[True]


class ConfirmationStatus(ResearchModel):
    contract_version: Literal[1]
    project_id: UUID
    command_id: UUID
    state: Literal['committed', 'not_observed']


class ResearchReport(ResearchModel):
    contract_version: Literal[1]
    project_id: UUID
    source_version: int = Field(ge=0, strict=True)
    market: str
    title: str = Field(max_length=200)
    product_count: int = Field(ge=0, le=200)
    keyword_count: int = Field(ge=0)
    confirmed_fact_count: int = Field(ge=0)
    truncated: bool
