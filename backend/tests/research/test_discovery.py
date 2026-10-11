from __future__ import annotations

import json

import pytest
from pydantic import BaseModel

from rabbit_hole.discovery import (
    Keyword,
    KeywordGenerationError,
    KeywordType,
    NicheCandidate,
    generate_niche_candidates,
    generate_seed_batch,
    keyword_priority,
    normalize_keyword,
)


class FakeGenerator:
    async def generate(
        self, *, schema: type[BaseModel], system_instruction: str, untrusted_data: str
    ) -> BaseModel:
        if schema is NicheCandidate:
            return schema(
                name=untrusted_data,
                ai_rationale="generated rationale",
                priority="high",
            )
        if "query" in schema.model_fields:
            return schema(query=untrusted_data)
        raise AssertionError(schema)


def test_normalization_merges_case_and_simple_plural() -> None:
    assert normalize_keyword(" Dog Owners ") == normalize_keyword("dog owner")
    assert normalize_keyword("Kitchen, organizers!") == normalize_keyword(
        "kitchen organizers"
    )


@pytest.mark.asyncio
async def test_seed_batch_respects_six_buckets() -> None:
    batch = await generate_seed_batch(
        FakeGenerator(), niche="dog cleaning", per_type=10
    )
    assert len(batch) == 60
    assert {item.kind for item in batch} == set(KeywordType)
    assert all(item.status == "待审核" for item in batch)
    assert all(item.source_niche == "dog cleaning" for item in batch)


@pytest.mark.asyncio
async def test_generated_niches_require_human_selection() -> None:
    niches = await generate_niche_candidates(FakeGenerator(), market="US", count=12)
    assert len(niches) == 12
    assert all(item.status == "待研究" for item in niches)
    assert all(item.priority in {"high", "medium", "low"} for item in niches)
    assert all(item.enabled is False for item in niches)


@pytest.mark.asyncio
async def test_seed_batch_refills_duplicate_suggestions_to_keep_each_bucket_in_budget() -> (
    None
):
    class DuplicateGenerator(FakeGenerator):
        def __init__(self) -> None:
            self.calls = 0

        async def generate(
            self,
            *,
            schema: type[BaseModel],
            system_instruction: str,
            untrusted_data: str,
        ) -> BaseModel:
            if schema is Keyword:
                self.calls += 1
                if self.calls % 11 == 1:
                    return schema(query=" Dog Owners ", kind=KeywordType.CATEGORY)
                return schema(
                    query=f"dog owner {self.calls}", kind=KeywordType.CATEGORY
                )
            return await super().generate(
                schema=schema,
                system_instruction=system_instruction,
                untrusted_data=untrusted_data,
            )

    batch = await generate_seed_batch(
        DuplicateGenerator(), niche="dog cleaning", per_type=10
    )
    assert len(batch) == 60
    assert {item.kind for item in batch} == set(KeywordType)
    assert all(sum(item.kind == kind for item in batch) == 10 for kind in KeywordType)


@pytest.mark.asyncio
async def test_seed_batch_raises_after_finite_duplicate_exhaustion() -> None:
    class ExhaustedGenerator(FakeGenerator):
        async def generate(
            self,
            *,
            schema: type[BaseModel],
            system_instruction: str,
            untrusted_data: str,
        ) -> BaseModel:
            if "query" in schema.model_fields:
                return schema(query=" Dog Owners ")
            return await super().generate(
                schema=schema,
                system_instruction=system_instruction,
                untrusted_data=untrusted_data,
            )

    with pytest.raises(KeywordGenerationError, match="category"):
        await generate_seed_batch(
            ExhaustedGenerator(), niche="dog cleaning", per_type=10
        )


@pytest.mark.asyncio
async def test_generator_cannot_inject_niche_record_id_and_trusted_id_is_preserved() -> (
    None
):
    class MaliciousGenerator(FakeGenerator):
        async def generate(
            self,
            *,
            schema: type[BaseModel],
            system_instruction: str,
            untrusted_data: str,
        ) -> BaseModel:
            if "query" in schema.model_fields:
                return schema(
                    query=untrusted_data,
                    source_niche_record_id="rec_attacker",
                )
            return await super().generate(
                schema=schema,
                system_instruction=system_instruction,
                untrusted_data=untrusted_data,
            )

    with pytest.raises(ValueError, match="source_niche_record_id"):
        await generate_seed_batch(
            MaliciousGenerator(),
            niche="dog cleaning",
            per_type=10,
            source_niche_record_id="rec_trusted",
        )


@pytest.mark.asyncio
async def test_seed_batch_stores_only_explicit_trusted_niche_record_id() -> None:
    batch = await generate_seed_batch(
        FakeGenerator(),
        niche="dog cleaning",
        per_type=10,
        source_niche_record_id="rec_trusted",
    )
    assert len(batch) == 60
    assert {item.source_niche_record_id for item in batch} == {"rec_trusted"}


def test_feishu_adapters_use_stable_keys_and_do_not_emit_unmapped_fields() -> None:
    from rabbit_hole.integrations.feishu import FIELD_MAPPERS

    keyword = Keyword(
        query="Dog Owners",
        kind=KeywordType.AUDIENCE,
        source_niche="dog cleaning",
        source_niche_record_id="rec_niche_1",
    )
    keyword_fields = keyword.to_feishu_fields()
    assert keyword_fields == {
        FIELD_MAPPERS["关键词库"]["search_text"]: "Dog Owners",
        FIELD_MAPPERS["关键词库"]["normalized"]: "dog owner",
        FIELD_MAPPERS["关键词库"]["locale"]: "en",
        FIELD_MAPPERS["关键词库"]["keyword_type"]: "人群",
        FIELD_MAPPERS["关键词库"]["source_niche"]: ["rec_niche_1"],
    }
    assert set(keyword_fields) <= set(FIELD_MAPPERS["关键词库"].values())


def test_keyword_feishu_adapter_requires_resolved_niche_record_id() -> None:
    keyword = Keyword(
        query="Dog Owners", kind=KeywordType.AUDIENCE, source_niche="dog cleaning"
    )
    with pytest.raises(ValueError, match="source_niche_record_id"):
        keyword.to_feishu_fields()


def test_niche_feishu_adapter_maps_name_to_stable_niche_key() -> None:
    from rabbit_hole.integrations.feishu import FIELD_MAPPERS

    niche = NicheCandidate(name="dog cleaning")
    niche_fields = niche.to_feishu_fields()
    card = json.loads(niche_fields.pop(FIELD_MAPPERS["细分领域池"]["research_card"]))
    assert card["research_required"] and card["trends"]["conclusion"] == "unknown"
    assert niche_fields == {
        FIELD_MAPPERS["细分领域池"]["niche"]: "dog cleaning",
        FIELD_MAPPERS["细分领域池"]["market"]: "US",
        FIELD_MAPPERS["细分领域池"]["priority"]: "中",
        FIELD_MAPPERS["细分领域池"]["recommendation"]: "",
    }


def test_keyword_priority_uses_neutral_test_pool_and_marks_small_samples() -> None:
    result = keyword_priority(
        scans=3,
        related_ads=2,
        coarse_passes=1,
        candidates=1,
        test_pool=None,
    )
    assert result.sample_too_small is True
    assert result.score == pytest.approx(
        0.3 * (2 / 3) + 0.3 * (1 / 2) + 0.2 * 1 + 0.2 * 0.5
    )


def test_keyword_priority_reports_weighted_rates_after_five_scans() -> None:
    result = keyword_priority(
        scans=10, related_ads=5, coarse_passes=4, candidates=2, test_pool=1
    )
    assert result.sample_too_small is False
    assert result.related_ad_rate == pytest.approx(0.5)
    assert result.coarse_pass_rate == pytest.approx(0.8)
    assert result.candidate_rate == pytest.approx(0.5)
    assert result.test_pool_rate == pytest.approx(0.5)
    assert result.score == pytest.approx(0.3 * 0.5 + 0.3 * 0.8 + 0.2 * 0.5 + 0.2 * 0.5)


def test_curated_taxonomy_contains_seven_editable_us_categories() -> None:
    from rabbit_hole.discovery import US_SEED_CATEGORIES

    assert {item["key"] for item in US_SEED_CATEGORIES} == {
        "pet",
        "home_organization",
        "kitchen",
        "car_accessories",
        "outdoor",
        "office",
        "hobbies",
    }
