"""Human-controlled niche discovery and keyword seed generation.

The objects in this module deliberately distinguish model suggestions from
observed evidence and human decisions.  Nothing here enables a niche or
creates a scan job; the resulting records are safe to display and review.
"""

from __future__ import annotations

import inspect
import json
import re
import unicodedata
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel, ConfigDict, Field, model_validator

T = TypeVar("T", bound=BaseModel)


class StructuredGenerator(Protocol):
    async def generate(
        self, *, schema: type[T], system_instruction: str, untrusted_data: str
    ) -> T: ...


class KeywordType(StrEnum):
    CATEGORY = "category"
    FUNCTION = "function"
    AUDIENCE = "audience"
    PAIN = "pain"
    SCENARIO_HOLIDAY = "scenario_holiday"
    BRAND_PRODUCT = "brand_product"

    @property
    def feishu_value(self) -> str:
        return {
            KeywordType.CATEGORY: "类目",
            KeywordType.FUNCTION: "功能",
            KeywordType.AUDIENCE: "人群",
            KeywordType.PAIN: "痛点",
            KeywordType.SCENARIO_HOLIDAY: "场景/节日",
            KeywordType.BRAND_PRODUCT: "品牌/产品",
        }[self]


class KeywordGenerationError(ValueError):
    """Raised when a finite refill budget cannot satisfy one keyword bucket."""

    def __init__(
        self, kind: KeywordType, requested: int, produced: int, attempts: int
    ) -> None:
        self.kind = kind
        self.requested = requested
        self.produced = produced
        self.attempts = attempts
        super().__init__(
            f"unable to generate {requested} unique {kind.value} keywords "
            f"after {attempts} attempts (produced {produced})"
        )


def niche_research_queries(card: dict[str, Any]) -> tuple[str, ...]:
    raw = card.get("representative_keywords")
    if not isinstance(raw, (list, tuple)) or not all(
        isinstance(item, str) for item in raw
    ):
        raise ValueError("research requires 5–10 representative queries")
    unique = {
        normalize_keyword(item): " ".join(item.split())
        for item in raw
        if normalize_keyword(item)
    }
    if not 5 <= len(unique) <= 10:
        raise ValueError("research requires 5–10 distinct representative queries")
    return tuple(unique.values())


class NicheCandidate(BaseModel):
    """A proposed niche, with AI output and evidence kept in separate fields."""

    name: str = ""
    category_key: str = ""
    category_label_zh: str = ""
    market: str = "US"
    priority: str = "medium"
    ai_rationale: str = ""
    trend_evidence: dict[str, Any] = Field(default_factory=dict)
    meta_advertiser_count: int | None = Field(default=None, ge=0)
    meta_creative_count: int | None = Field(default=None, ge=0)
    meta_evidence: dict[str, Any] = Field(default_factory=dict)
    logistics_warnings: tuple[str, ...] = ()
    compliance_warnings: tuple[str, ...] = ()
    supply_chain_evidence: dict[str, Any] = Field(default_factory=dict)
    human_state: str | None = None
    status: str = "待研究"
    enabled: bool = False
    representative_keywords: tuple[str, ...] = ()
    target_audience: str = "unknown"
    core_problem: str = "unknown"
    filming_scenarios: tuple[str, ...] = ()
    potential_price_band: str = "unknown"

    @model_validator(mode="before")
    @classmethod
    def accept_common_generator_names(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        result = dict(value)
        if not result.get("name"):
            result["name"] = result.get("niche") or result.get("niche_name") or ""
        if not result.get("ai_rationale") and result.get("rationale"):
            result["ai_rationale"] = result["rationale"]
        if "human_state" not in result:
            result["human_state"] = result.get("human_status") or result.get(
                "human_decision"
            )
        if "logistics_warnings" not in result and result.get(
            "logistics_compliance_warnings"
        ):
            result["logistics_warnings"] = result["logistics_compliance_warnings"]
        return result

    @property
    def observed_meta_advertiser_count(self) -> int | None:
        return self.meta_advertiser_count

    @property
    def observed_meta_creative_count(self) -> int | None:
        return self.meta_creative_count

    @property
    def niche(self) -> str:
        return self.name

    @property
    def logistics_compliance_warnings(self) -> tuple[str, ...]:
        return self.logistics_warnings + self.compliance_warnings

    def to_feishu_fields(self) -> dict[str, Any]:
        return _to_feishu_fields(
            "细分领域池",
            {
                "niche": self.name,
                "market": self.market,
                "priority": {"high": "高", "medium": "中", "low": "低"}.get(
                    self.priority, "中"
                ),
                "recommendation": self.ai_rationale,
                "research_card": json.dumps(
                    {
                        "generic_term": self.name,
                        "target_audience": self.target_audience,
                        "core_problem": self.core_problem,
                        "filming_scenarios": self.filming_scenarios,
                        "potential_price_band": self.potential_price_band,
                        "logistics_warnings": self.logistics_warnings,
                        "compliance_warnings": self.compliance_warnings,
                        "representative_keywords": self.representative_keywords,
                        "trends": {"conclusion": "unknown", "source": None},
                        "meta": {
                            "advertisers": None,
                            "creatives": None,
                            "source": None,
                        },
                        "supply_chain": "unknown",
                        "trust": "inferred",
                        "research_required": True,
                    },
                    ensure_ascii=False,
                ),
            },
        )


class Keyword(BaseModel):
    """One actual search query and its normalized duplicate-detection key."""

    query: str = ""
    normalized_keyword: str = ""
    kind: KeywordType = KeywordType.CATEGORY
    source_niche: str = ""
    source_niche_record_id: str | None = None
    market: str = "US"
    language: str = "en"
    status: str = "待审核"
    enabled: bool = False
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def accept_query_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        result = dict(value)
        if not result.get("query"):
            result["query"] = (
                result.get("keyword")
                or result.get("actual_query")
                or result.get("text")
                or ""
            )
        if "kind" not in result and "keyword_type" in result:
            result["kind"] = result["keyword_type"]
        return result

    @model_validator(mode="after")
    def normalize_fields(self) -> Keyword:
        self.market = self.market.strip().upper()
        self.language = self.language.strip().lower()
        self.normalized_keyword = normalize_keyword(self.query)
        return self

    @property
    def actual_query(self) -> str:
        return self.query

    @property
    def keyword(self) -> str:
        return self.query

    @property
    def source(self) -> str:
        return self.source_niche

    def to_feishu_fields(
        self, *, source_niche_record_id: str | None = None
    ) -> dict[str, Any]:
        resolved_record_id = source_niche_record_id or self.source_niche_record_id
        if not resolved_record_id or not resolved_record_id.strip():
            raise ValueError(
                "source_niche_record_id is required for the Feishu link field"
            )
        return _to_feishu_fields(
            "关键词库",
            {
                "search_text": self.query,
                "normalized": self.normalized_keyword,
                "locale": self.language,
                "keyword_type": self.kind.feishu_value,
                # Feishu LinkToRecord CellValue is a list of target record IDs;
                # a display name is not a valid substitute.
                "source_niche": [resolved_record_id.strip()],
            },
        )


class KeywordPriority(BaseModel):
    """Auditable 90-day funnel rates and their display-only weighted score."""

    scans: int
    related_ads: int
    coarse_passes: int
    candidates: int
    test_pool: int | None
    related_ad_rate: float
    coarse_pass_rate: float
    candidate_rate: float
    test_pool_rate: float
    score: float = Field(ge=0, le=1)
    sample_too_small: bool

    @property
    def weighted_score(self) -> float:
        return self.score


_WORD_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)


def _singularize(word: str) -> str:
    """Apply intentionally conservative English plural normalization."""

    if len(word) <= 3:
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith(("sses", "shes", "ches", "xes", "zes")):
        return word[:-2]
    if word.endswith("s") and not word.endswith(("ss", "us", "is")):
        return word[:-1]
    return word


def normalize_keyword(keyword: str) -> str:
    """Normalize case, punctuation, whitespace, and simple English plurals."""

    normalized = unicodedata.normalize("NFKC", keyword).casefold()
    words = _WORD_RE.findall(normalized)
    return " ".join(_singularize(word) for word in words)


_DATA_PATH = Path(__file__).with_name("data") / "us_seed_categories.json"
US_SEED_CATEGORIES: list[dict[str, Any]] = json.loads(
    _DATA_PATH.read_text(encoding="utf-8")
)

_NICHE_INSTRUCTION = (
    "Suggest one US niche from the supplied editable taxonomy. Return structured data only. "
    "AI rationale is a suggestion, not evidence; leave evidence and human fields untouched."
)
_KEYWORD_INSTRUCTION = (
    "Suggest one concise English search query for the supplied niche and keyword type. "
    "Return structured data only and never claim that a query is evidence."
)


class _KeywordSuggestion(BaseModel):
    """The deliberately narrow, untrusted LLM response contract."""

    model_config = ConfigDict(extra="forbid")

    query: str


def _to_feishu_fields(table: str, values: dict[str, Any]) -> dict[str, Any]:
    """Translate stable field keys to Feishu display names after validation."""

    # Import lazily so discovery's data models remain usable without making
    # Feishu the generation dependency.  FIELD_MAPPERS is the Task 5 contract.
    from rabbit_hole.integrations.feishu import FIELD_MAPPERS

    mapper = FIELD_MAPPERS.get(table)
    if mapper is None:
        raise ValueError(f"unknown Feishu table: {table}")
    unknown = set(values) - set(mapper)
    if unknown:
        raise ValueError(
            f"unknown stable Feishu field keys for {table}: {sorted(unknown)}"
        )
    return {mapper[key]: value for key, value in values.items()}


async def _generate[T: BaseModel](
    generator: StructuredGenerator,
    *,
    schema: type[T],
    system_instruction: str,
    untrusted_data: str,
) -> T:
    # Task 9's production implementation is async.  Accepting a synchronous
    # test double as well keeps this boundary easy to exercise without making
    # the protocol less precise.
    response: Any = generator.generate(
        schema=schema,
        system_instruction=system_instruction,
        untrusted_data=untrusted_data,
    )
    if inspect.isawaitable(response):
        response = await response
    if isinstance(response, schema):
        return response
    if isinstance(response, BaseModel):
        return schema.model_validate(response.model_dump())
    return schema.model_validate(response)


async def generate_niche_candidates(
    generator: StructuredGenerator,
    *,
    market: str = "US",
    count: int = 12,
    category_key: str | None = None,
) -> list[NicheCandidate]:
    """Generate review-only niche suggestions from the editable US taxonomy."""

    if count < 1:
        raise ValueError("count must be positive")
    normalized_market = market.strip().upper()
    result: list[NicheCandidate] = []
    categories = [
        item
        for item in US_SEED_CATEGORIES
        if category_key is None or category_key in {item["key"], item["label_zh"]}
    ]
    if not categories:
        raise ValueError("unknown selected category")
    for index in range(count):
        category = categories[index % len(categories)]
        data = json.dumps(
            {"market": normalized_market, "category": category},
            ensure_ascii=False,
            sort_keys=True,
        )
        suggestion = await _generate(
            generator,
            schema=NicheCandidate,
            system_instruction=_NICHE_INSTRUCTION,
            untrusted_data=data,
        )
        priority = (
            suggestion.priority
            if suggestion.priority in {"high", "medium", "low"}
            else "medium"
        )
        result.append(
            suggestion.model_copy(
                update={
                    "market": normalized_market,
                    "category_key": category["key"],
                    "category_label_zh": category["label_zh"],
                    "priority": priority,
                    "status": "待研究",
                    "enabled": False,
                    "human_state": None,
                    "representative_keywords": tuple(category["canonical_terms"]),
                    "trend_evidence": {},
                    "meta_evidence": {},
                    "meta_advertiser_count": None,
                    "meta_creative_count": None,
                    "supply_chain_evidence": {},
                }
            )
        )
    return result


def _keyword_from_response(
    suggestion: _KeywordSuggestion,
    *,
    kind: KeywordType,
    niche: str,
    market: str,
    language: str,
    source_niche_record_id: str | None,
) -> Keyword:
    return Keyword(
        query=suggestion.query,
        kind=kind,
        source_niche=niche,
        source_niche_record_id=source_niche_record_id,
        market=market,
        language=language,
        status="待审核",
        enabled=False,
    )


async def generate_seed_batch(
    generator: StructuredGenerator,
    *,
    niche: str | NicheCandidate,
    per_type: int = 10,
    market: str = "US",
    language: str = "en",
    existing_keywords: tuple[Keyword, ...] = (),
    max_attempts_per_type: int | None = None,
    source_niche_record_id: str | None = None,
) -> list[Keyword]:
    """Generate six keyword buckets, removing duplicate market/language keys."""

    if not 10 <= per_type <= 20:
        raise ValueError("per_type must be between 10 and 20")
    attempts_limit = max_attempts_per_type or per_type * 3
    if attempts_limit < per_type:
        raise ValueError("max_attempts_per_type must be at least per_type")
    if isinstance(niche, NicheCandidate):
        if not niche.enabled:
            raise ValueError(
                "a niche must be explicitly enabled before seed generation"
            )
        niche_name = niche.name
    else:
        niche_name = niche
    normalized_market = market.strip().upper()
    normalized_language = language.strip().lower()
    result: list[Keyword] = []
    seen = {
        (
            item.market.strip().upper(),
            item.language.strip().lower(),
            item.normalized_keyword,
        )
        for item in existing_keywords
        if item.normalized_keyword
    }
    for kind in KeywordType:
        bucket_count = 0
        attempts = 0
        while bucket_count < per_type and attempts < attempts_limit:
            attempts += 1
            index = attempts - 1
            context = json.dumps(
                {"niche": niche_name, "kind": kind.value, "index": index + 1},
                ensure_ascii=False,
                sort_keys=True,
            )
            suggestion = await _generate(
                generator,
                schema=_KeywordSuggestion,
                system_instruction=_KEYWORD_INSTRUCTION,
                untrusted_data=context,
            )
            item = _keyword_from_response(
                suggestion,
                kind=kind,
                niche=niche_name,
                market=normalized_market,
                language=normalized_language,
                source_niche_record_id=source_niche_record_id,
            )
            key = (normalized_market, normalized_language, item.normalized_keyword)
            if item.normalized_keyword and key not in seen:
                seen.add(key)
                result.append(item)
                bucket_count += 1
        if bucket_count < per_type:
            raise KeywordGenerationError(kind, per_type, bucket_count, attempts)
    return result


def _rate(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return min(1.0, max(0.0, numerator / denominator))


def keyword_priority(
    *,
    scans: int,
    related_ads: int,
    coarse_passes: int,
    candidates: int,
    test_pool: int | None = None,
) -> KeywordPriority:
    """Calculate the display-only 90-day keyword priority score.

    Each rate uses its immediately preceding funnel stage as denominator:
    searches → related ads → coarse passes → candidates → test pool.
    """

    values = (scans, related_ads, coarse_passes, candidates)
    if any(value < 0 for value in values) or (test_pool is not None and test_pool < 0):
        raise ValueError("keyword metrics cannot be negative")
    related_rate = _rate(related_ads, scans)
    coarse_rate = _rate(coarse_passes, related_ads)
    candidate_rate = _rate(candidates, coarse_passes)
    test_rate = 0.5 if test_pool is None else _rate(test_pool, candidates)
    score = (
        0.3 * related_rate + 0.3 * coarse_rate + 0.2 * candidate_rate + 0.2 * test_rate
    )
    return KeywordPriority(
        scans=scans,
        related_ads=related_ads,
        coarse_passes=coarse_passes,
        candidates=candidates,
        test_pool=test_pool,
        related_ad_rate=related_rate,
        coarse_pass_rate=coarse_rate,
        candidate_rate=candidate_rate,
        test_pool_rate=test_rate,
        score=score,
        sample_too_small=scans < 5,
    )


__all__ = [
    "US_SEED_CATEGORIES",
    "Keyword",
    "KeywordGenerationError",
    "KeywordPriority",
    "KeywordType",
    "NicheCandidate",
    "StructuredGenerator",
    "generate_niche_candidates",
    "generate_seed_batch",
    "keyword_priority",
    "normalize_keyword",
]
