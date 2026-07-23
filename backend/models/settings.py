from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class AIProviderWrite(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    protocol: Literal["gemini", "vertex", "openai_compatible"]
    base_url: str | None = None
    api_key: str | None = None
    vertex_project_id: str | None = None
    vertex_location: str | None = None
    vertex_key_path: str | None = None
    text_model: str | None = None
    image_model: str | None = None
    supports_text: bool = True
    supports_image: bool = False
    timeout_seconds: int = Field(default=60, ge=1, le=600)
    max_retries: int = Field(default=2, ge=0, le=10)
    enabled: bool = True


class AIProviderRead(BaseModel):
    id: int
    name: str
    protocol: str
    base_url: str | None
    has_api_key: bool
    api_key_masked: str | None
    has_vertex_credentials: bool
    text_model: str | None
    image_model: str | None
    supports_text: bool
    supports_image: bool
    timeout_seconds: int
    max_retries: int
    enabled: bool
    last_test_status: str | None
    last_test_message: str | None
    last_tested_at: datetime | None
    config_version: int


class AIProviderList(BaseModel):
    items: list[AIProviderRead]


class CapabilityBindingWrite(BaseModel):
    provider_config_id: int


class CapabilityBindingRead(BaseModel):
    capability: Literal["text", "image"]
    provider_config_id: int
    updated_at: datetime | None


class CapabilityBindingList(BaseModel):
    items: list[CapabilityBindingRead]


class ProviderConnectionTest(BaseModel):
    provider_id: int | None = None
    draft: AIProviderWrite | None = None
    capability: Literal["text", "image"]

    @model_validator(mode="after")
    def require_exactly_one_provider_source(self):
        if (self.provider_id is None) == (self.draft is None):
            raise ValueError("provider_id 和 draft 必须且只能提供一个")
        return self


class ProviderConnectionTestResult(BaseModel):
    status: Literal["success", "error"]
    capability: Literal["text", "image"]
    duration_ms: int
    message: str


class FrontendLogEvent(BaseModel):
    level: str = "info"
    message: str
    capability: str | None = None
    provider: str | None = None
    model: str | None = None
    duration_ms: int | str | None = None
    retry: int | str | None = None
