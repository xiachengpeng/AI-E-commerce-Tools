"""Shared typed contracts for collectors."""

from __future__ import annotations

from typing import TypeVar

from pydantic import BaseModel, ConfigDict, Field


class CollectorError(BaseModel):
    model_config = ConfigDict(frozen=True)

    code: str
    detail: str
    retriable: bool = True
    source: str | None = None


T = TypeVar("T")


class CollectorResult[T](BaseModel):
    model_config = ConfigDict(frozen=True)

    value: T | None = None
    error: CollectorError | None = None
    evidence: dict[str, str] = Field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.error is None and self.value is not None

    @classmethod
    def success(
        cls, value: T, *, evidence: dict[str, str] | None = None
    ) -> CollectorResult[T]:
        return cls(value=value, evidence=evidence or {})

    @classmethod
    def failure(cls, error: CollectorError) -> CollectorResult[T]:
        return cls(error=error)
