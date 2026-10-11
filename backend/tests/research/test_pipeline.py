from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select

from rabbit_hole.config import MarketSettings
from rabbit_hole.discovery import NicheCandidate
from rabbit_hole.domain.legacy import Job, JobKind, JobPayload, JobStatus
from rabbit_hole.integrations.collectors.base import CollectorError, CollectorResult
from rabbit_hole.integrations.collectors.google import GoogleTrendsEvidence
from rabbit_hole.integrations.collectors.landing import FunnelEvidence, LandingSnapshot
from rabbit_hole.integrations.collectors.meta import (
    MetaAd,
    MetaQuery,
    QueryCoverage,
    SearchBatchResult,
)
from rabbit_hole.integrations.feishu import (
    RecordVersion,
    TriggerPoller,
    TriggerRecord,
    WriteConflict,
    protected_input_hash,
)
from rabbit_hole.persistence.database import job_checkpoints, runtime_jobs
from rabbit_hole.persistence.legacy_jobs import StaleLeaseError
from rabbit_hole.pipeline import (
    CHECKPOINT_STAGES,
    FeishuMutation,
    Pipeline,
    PipelineResult,
    RetryablePipelineError,
)
from rabbit_hole.trends import TrendLabel
from rabbit_hole.worker import Worker

NOW = datetime(2026, 9, 4, 4, 0, tzinfo=UTC)


class FrozenClock:
    def now(self) -> datetime:
        return NOW


class FakeCheckpoints:
    def __init__(self) -> None:
        self.values: dict[tuple[UUID, str], dict[str, Any]] = {}

    async def checkpoint(
        self,
        job_id: UUID,
        stage: str,
        data: dict[str, Any],
        *,
        worker: str,
        lease_token: UUID | None,
    ) -> None:
        assert worker == "worker-1"
        assert lease_token == UUID(int=2)
        self.values[(job_id, stage)] = data

    async def get_checkpoint(self, job_id: UUID, stage: str) -> dict[str, Any] | None:
        return self.values.get((job_id, stage))


class FakeFeishu:
    def __init__(self, source: RecordVersion) -> None:
        self.source = source
        self.mutations: dict[str, FeishuMutation] = {}
        self.generated: dict[str, RecordVersion] = {}
        self.ids: dict[str, str] = {}

    async def get_record(self, table: str, record_id: str) -> RecordVersion:
        if record_id in self.generated:
            return self.generated[record_id]
        assert record_id == self.source.record_id
        return self.source

    async def apply(self, mutation: FeishuMutation) -> str:
        existing = self.mutations.get(mutation.operation_key)
        if existing is not None:
            assert existing.model_dump() == mutation.model_dump()
            return self.ids[mutation.operation_key]
        if (
            mutation.action == "update"
            and mutation.record_id == self.source.record_id
            and mutation.expected_version != self.source.version
        ):
            raise WriteConflict("record changed before atomic write")
        self.mutations[mutation.operation_key] = mutation
        record_id = mutation.record_id or f"generated-{len(self.mutations)}"
        self.ids[mutation.operation_key] = record_id
        from rabbit_hole.integrations.feishu import FIELD_MAPPERS

        fields = dict(mutation.fields)
        fields[FIELD_MAPPERS[mutation.table]["status"]] = mutation.state
        if record_id != self.source.record_id:
            previous = self.generated.get(record_id)
            self.generated[record_id] = RecordVersion(
                record_id,
                f"v{len(self.mutations)}",
                {**(previous.fields if previous else {}), **fields},
            )
        return record_id


class FakeMeta:
    def __init__(self, result: CollectorResult[SearchBatchResult]) -> None:
        self.result = result
        self.calls = 0
        self.call_kwargs: list[dict[str, Any]] = []

    async def collect(
        self, query: MetaQuery, **kwargs: Any
    ) -> CollectorResult[SearchBatchResult]:
        self.calls += 1
        self.call_kwargs.append(dict(kwargs))
        assert query.market == "US"
        return self.result


class FakeLanding:
    def __init__(self, result: CollectorResult[LandingSnapshot]) -> None:
        self.result = result
        self.calls = 0

    async def collect(self, url: str) -> CollectorResult[LandingSnapshot]:
        self.calls += 1
        assert url.startswith("https://")
        return self.result


class FakeTrends:
    def __init__(self, result: CollectorResult[GoogleTrendsEvidence]) -> None:
        self.result = result
        self.calls = 0

    async def collect(
        self, query: str, **_: Any
    ) -> CollectorResult[GoogleTrendsEvidence]:
        self.calls += 1
        assert query
        return self.result


class FakeExtractor:
    def __init__(self, result: Mapping[str, Any] | None = None) -> None:
        self.result = result or {
            "generic_product_name": {
                "value": "AI suggestion only",
                "trust": "inferred",
            }
        }
        self.calls = 0

    async def extract(self, source: Any) -> Mapping[str, Any]:
        self.calls += 1
        assert source.landing is not None or source.meta_ads
        return self.result


class FakeStorage:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def put(self, **kwargs: Any) -> object:
        self.calls.append(kwargs)

        class Stored:
            object_id = f"evidence/{kwargs['record_id']}/{len(self.calls)}"

        return Stored()


class FakeNicheGenerator:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, **_: Any) -> NicheCandidate:
        self.calls += 1
        return NicheCandidate(
            name=f"niche-{self.calls}",
            ai_rationale="research suggestion",
            status="已启用",
            enabled=True,
            human_state="批准",
        )


def job(kind: JobKind, data: dict[str, Any], *, version: str = "v1") -> Job:
    payload = JobPayload(
        kind=kind,
        record_id="source-1",
        input_version=version,
        protected_input_hash=protected_input_hash(data),
        data=data,
    )
    return Job(
        id=UUID(int=1),
        idempotency_key="job-key",
        payload=payload,
        status=JobStatus.RUNNING,
        attempt=0,
        available_at=NOW,
        lease_until=NOW + timedelta(minutes=5),
        leased_by="worker-1",
        lease_token=UUID(int=2),
        failure_code=None,
        failure_detail=None,
        created_at=NOW,
        updated_at=NOW,
    )


def ad(ad_id: str, perceptual_hash: str) -> MetaAd:
    return MetaAd(
        ad_id=ad_id,
        advertiser="Acme",
        start_date=NOW.date() - timedelta(days=40),
        is_active=True,
        observable_active_days=40,
        primary_text=f"copy {ad_id}",
        hook=f"hook {ad_id}",
        landing_url="https://shop.example/products/portable-blender",
        final_landing_url="https://shop.example/products/portable-blender",
        landing_page_type="product",
        product_fingerprint="portable-blender",
        media_hash=f"media-{ad_id}",
        perceptual_hash=perceptual_hash,
        media_accessible=True,
        relevance_verified=True,
        query='"portable blender"',
    )


def meta_success() -> CollectorResult[SearchBatchResult]:
    ads = (ad("1", "0" * 16), ad("2", "f" * 16), ad("3", "5" * 16))
    query = MetaQuery(query="portable blender")
    return CollectorResult.success(
        SearchBatchResult(
            query=query,
            actual_queries=query.actual_queries,
            ads=ads,
            coverage=(
                QueryCoverage(
                    actual_query='"portable blender"',
                    displayed_filters={
                        "market": "US",
                        "status": "active",
                        "media_type": "video",
                        "search_mode": "exact_phrase",
                        "query": '"portable blender"',
                    },
                    result_count=3,
                    scroll_count=1,
                    stop_reason="page_end",
                    truncated=False,
                    relevance_verified=True,
                    screenshot_evidence_ids=("evidence/meta/screenshot",),
                ),
            ),
            collected_at=NOW,
            truncated=False,
            competition_verified=True,
        ),
        evidence={"screenshot": "evidence/meta/screenshot"},
    )


def meta_below_creative_threshold() -> CollectorResult[SearchBatchResult]:
    query = MetaQuery(query="portable blender")
    ads = (ad("1", "0" * 16), ad("2", "f" * 16))
    return CollectorResult.success(
        SearchBatchResult(
            query=query,
            actual_queries=query.actual_queries,
            ads=ads,
            coverage=(
                QueryCoverage(
                    actual_query='"portable blender"',
                    displayed_filters={
                        "market": "US",
                        "status": "active",
                        "media_type": "video",
                        "search_mode": "exact_phrase",
                        "query": '"portable blender"',
                    },
                    result_count=2,
                    scroll_count=1,
                    stop_reason="page_end",
                    truncated=False,
                    relevance_verified=True,
                ),
            ),
            collected_at=NOW,
            truncated=False,
            competition_verified=True,
        )
    )


def landing_success() -> CollectorResult[LandingSnapshot]:
    return CollectorResult.success(
        LandingSnapshot(
            title="Portable Blender",
            price="$79",
            body_text="Blend anywhere. Buy now. FAQ and returns.",
            images=("https://cdn.example/blender.jpg",),
            final_url="https://shop.example/products/portable-blender",
            page_type="product",
            content_hash="a" * 64,
            funnel=FunnelEvidence(
                first_screen_hook="Blend anywhere",
                cta="Buy now",
                faq=True,
                shipping_quality_returns=True,
            ),
        ),
        evidence={"snapshot": "evidence/landing/snapshot"},
    )


def trends_success() -> CollectorResult[GoogleTrendsEvidence]:
    return CollectorResult.success(
        GoogleTrendsEvidence(
            query="portable blender",
            geo="US",
            actual_queries=("portable blender",),
            collected_at=NOW,
            label=TrendLabel.RISING,
            threshold_explanation="deterministic rising threshold",
        ),
        evidence={"snapshot": "evidence/trends/snapshot"},
    )


def complete_evaluation() -> dict[str, Any]:
    verified = "verified"
    return {
        "product_name": "Portable Blender",
        "market": {
            "code": "US",
            "currency": "USD",
            "min_aov": 50,
            "max_aov": 100,
            "payment_percent": 2.9,
            "payment_fixed": 0.3,
            "loss_reserve_percent": 2,
        },
        "order": {
            "unit_price": 79,
            "bundle_quantity": 1,
            "expected_aov": 79,
            "goods_cost": 8,
            "shipping": 4,
            "packaging": 1,
            "tax_and_duty": 0,
            "acquisition_cost": 5,
            "packed_weight_kg": 0.7,
            "supplier_quote_unit_cost": 8,
            "supplier_quote_source": "https://supplier.example/quotes/portable-blender",
            "supplier_quote_confirmed": True,
            "supplier_quote_collected_at": NOW.isoformat(),
            "supplier_quote_valid": True,
            "supplier_quote_trust": verified,
            "cost_trust": {
                name: verified
                for name in (
                    "goods_cost",
                    "shipping",
                    "packaging",
                    "tax_and_duty",
                    "acquisition_cost",
                    "packed_weight_kg",
                )
            },
            "order_trust": {
                "unit_price": verified,
                "expected_aov": verified,
                "bundle_quantity": verified,
                "supplier_quote": verified,
            },
        },
        "meta": {
            "active_days": 40,
            "verified_creatives": 3,
            "trend_12m": "rising",
            "trend_5y": "rising",
            "logistics_difficulty": "low",
            "compliance_risk": "low",
            "ip_risk": "low",
            "creative_formats": ["video", "ugc", "demo"],
            "creative_scenarios": ["travel", "office", "gym"],
            "creative_hooks": ["portable", "fast", "easy"],
            "ugc_or_demo": True,
            "advertiser_count": 3,
            "search_truncated": False,
            "query_coverage_verified": True,
            "brand_concentration": "low",
            "differentiation": "high",
            "certification_required": False,
            "supplier_quote_trust": verified,
            "trust": {
                name: verified
                for name in (
                    "active_days",
                    "verified_creatives",
                    "trend_12m",
                    "trend_5y",
                    "logistics_difficulty",
                    "compliance_risk",
                    "ip_risk",
                    "creative_formats",
                    "creative_scenarios",
                    "creative_hooks",
                    "ugc_or_demo",
                    "advertiser_count",
                    "search_truncated",
                    "query_coverage_verified",
                    "brand_concentration",
                    "differentiation",
                    "certification_required",
                )
            },
        },
    }


def pipeline(
    *,
    data: dict[str, Any],
    feishu: FakeFeishu | None = None,
    meta: FakeMeta | None = None,
    landing: FakeLanding | None = None,
    trends: FakeTrends | None = None,
    extractor: FakeExtractor | None = None,
    niche_generator: FakeNicheGenerator | None = None,
    storage: FakeStorage | None = None,
) -> tuple[Pipeline, FakeCheckpoints, FakeFeishu]:
    checkpoints = FakeCheckpoints()
    source = RecordVersion("source-1", "v1", data)
    selected_feishu = feishu or FakeFeishu(source)
    service = Pipeline(
        jobs=checkpoints,
        feishu=selected_feishu,
        meta_collector=meta,
        landing_collector=landing,
        trends_collector=trends,
        extractor=extractor,
        discovery_generator=niche_generator,
        storage=storage,
        market=MarketSettings(
            code="US",
            currency="USD",
            min_aov=50,
            max_aov=100,
            payment_percent=2.9,
            payment_fixed=0.3,
            loss_reserve_percent=2,
        ),
        clock=FrozenClock(),
    )
    return service, checkpoints, selected_feishu


async def test_niche_initialization_creates_review_only_candidates() -> None:
    data = {"人工｜大类": "home organization", "人工｜状态": "待生成"}
    generator = FakeNicheGenerator()
    service, checkpoints, feishu = pipeline(data=data, niche_generator=generator)

    result = await service.run(job(JobKind.NICHE_DISCOVERY, data))

    assert result.status == "待研究"
    niches = [m for m in feishu.mutations.values() if m.table == "细分领域池"]
    generated = [m for m in niches if m.action == "create"]
    assert len(generated) == 12
    assert all(item.state == "待研究" for item in generated)
    assert all(item.fields.get("AUTO｜细分领域") for item in generated)
    assert all("已启用" not in item.model_dump_json() for item in generated)
    assert set(CHECKPOINT_STAGES) <= {stage for _, stage in checkpoints.values}


async def test_keyword_path_builds_batch_product_and_us_evaluation_idempotently() -> (
    None
):
    data = {
        "AUTO｜实际搜索词": "portable blender",
        "AUTO｜同义变体": "travel blender|personal blender",
        "人工｜状态": "待扫描",
    }
    meta = FakeMeta(meta_success())
    service, checkpoints, feishu = pipeline(data=data, meta=meta)
    queued = job(JobKind.KEYWORD_SCAN, data)

    first = await service.run(queued)
    mutation_count = len(feishu.mutations)
    second = await service.run(queued)

    assert first == second
    assert meta.calls == 1
    assert meta.call_kwargs == [
        {
            "job_id": queued.id,
            "record_id": "source-1",
            "worker": "worker-1",
            "lease_token": UUID(int=2),
            "attempt": 1,
            "manage_retries": False,
        }
    ]
    assert len(feishu.mutations) == mutation_count
    assert set(CHECKPOINT_STAGES) <= {stage for _, stage in checkpoints.values}
    assert any(
        item.table == "搜索批次" and item.state == "已完成"
        for item in feishu.mutations.values()
    )
    assert any(
        item.table == "产品主表" and item.fields["AUTO｜标准产品名称"]
        for item in feishu.mutations.values()
    )
    assert any(
        item.table == "市场评估表"
        and item.state == "待询价"
        and item.fields["AUTO｜产品市场唯一键"].endswith("|US")
        for item in feishu.mutations.values()
    )
    assert any(
        item.table == "关键词库" and item.state == "已启用"
        for item in feishu.mutations.values()
    )
    keyword_update = next(
        item
        for item in feishu.mutations.values()
        if item.table == "关键词库"
        and item.action == "update"
        and item.state == "已启用"
    )
    assert keyword_update.fields["AUTO｜扫描次数"] == 1
    assert keyword_update.fields["AUTO｜广告命中数"] == 3
    assert keyword_update.fields["AUTO｜相关广告数"] == 3
    assert keyword_update.fields["AUTO｜30天广告数"] == 3
    assert keyword_update.fields["AUTO｜三创意产品数"] == 1
    assert keyword_update.fields["AUTO｜值得深入数"] == 1


async def test_keyword_group_below_three_creatives_enters_observation_only() -> None:
    data = {
        "AUTO｜实际搜索词": "portable blender",
        "人工｜状态": "待扫描",
    }
    service, _, feishu = pipeline(
        data=data,
        meta=FakeMeta(meta_below_creative_threshold()),
    )

    await service.run(job(JobKind.KEYWORD_SCAN, data))

    market_records = [
        item for item in feishu.mutations.values() if item.table == "市场评估表"
    ]
    assert market_records
    assert all(item.state == "观察池" for item in market_records)
    assert all(item.state not in {"测试池", "淘汰池"} for item in market_records)


async def test_link_path_stops_at_human_review_and_keeps_suggestion_non_binding() -> (
    None
):
    data = {
        "link": "https://shop.example/products/portable-blender?utm_source=ad",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "evaluation": complete_evaluation(),
    }
    service, checkpoints, feishu = pipeline(
        data=data,
        meta=FakeMeta(meta_success()),
        landing=FakeLanding(landing_success()),
        trends=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
    )

    result = await service.run(job(JobKind.LINK_VALIDATION, data))

    assert result.status == "待人工复核"
    assert result.suggestion in {"测试池", "备选池", "淘汰池"}
    assert set(CHECKPOINT_STAGES) <= {stage for _, stage in checkpoints.values}
    final_update = [
        item
        for item in feishu.mutations.values()
        if item.table == "市场评估表" and item.action == "update"
    ][-1]
    assert final_update.state == "待人工复核"
    assert final_update.fields["AUTO｜当前建议"] == result.suggestion
    assert final_update.state not in {"测试池", "备选池", "淘汰池"}
    assert any(item.table == "评分记录" for item in feishu.mutations.values())
    evidence_records = [
        item for item in feishu.mutations.values() if item.table == "证据表"
    ]
    assert {item.fields["AUTO｜证据类型"] for item in evidence_records} == {
        "Meta",
        "落地页",
        "Trends",
        "供应商",
    }
    for evidence in evidence_records:
        assert evidence.fields["AUTO｜来源URL"]
        assert evidence.fields["AUTO｜原始值"]
        assert evidence.fields["AUTO｜标准化值"]
        assert evidence.fields["AUTO｜有效期"]
    supplier_evidence = next(
        item for item in evidence_records if item.fields["AUTO｜证据类型"] == "供应商"
    )
    assert supplier_evidence.fields["AUTO｜来源URL"] == (
        "https://supplier.example/quotes/portable-blender"
    )
    history = next(
        item for item in feishu.mutations.values() if item.table == "评分记录"
    )
    assert (
        "https://supplier.example/quotes/portable-blender"
        in history.fields["AUTO｜评分理由"]
    )


async def test_supplier_quote_url_is_canonical_before_history_and_evidence() -> None:
    raw_source = (
        "https://detail.1688.com/offer/123456789.html?token=ephemeral-token"
        "&X-Amz-Credential=temporary&X-Amz-Signature=signature#fragment-secret"
    )
    canonical_source = "https://detail.1688.com/offer/123456789.html"
    data = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "evaluation": complete_evaluation(),
    }
    data["evaluation"]["order"]["supplier_quote_source"] = raw_source
    service, _, feishu = pipeline(
        data=data,
        meta=FakeMeta(meta_success()),
        landing=FakeLanding(landing_success()),
        trends=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
    )

    result = await service.run(job(JobKind.LINK_VALIDATION, data))

    assert result.evidence["supplier_quote"]["source_url"] == canonical_source
    supplier_evidence = next(
        mutation
        for mutation in feishu.mutations.values()
        if mutation.table == "证据表" and mutation.fields["AUTO｜证据类型"] == "供应商"
    )
    assert supplier_evidence.fields["AUTO｜来源URL"] == canonical_source
    assert supplier_evidence.fields["AUTO｜原始值"] == canonical_source
    assert supplier_evidence.fields["AUTO｜标准化值"] == canonical_source
    history = next(
        mutation
        for mutation in feishu.mutations.values()
        if mutation.table == "评分记录"
    )
    assert canonical_source in history.fields["AUTO｜评分理由"]
    serialized_mutations = "\n".join(
        mutation.model_dump_json() for mutation in feishu.mutations.values()
    )
    assert "ephemeral-token" not in serialized_mutations
    assert "X-Amz-Credential" not in serialized_mutations
    assert "X-Amz-Signature" not in serialized_mutations
    assert "fragment-secret" not in serialized_mutations


async def test_feishu_supplier_source_stays_safe_through_persisted_workflow(
    job_repo, caplog
) -> None:
    """A real queue must not leak URL credentials before or after scoring."""
    source = "https://detail.1688.com/offer/123456789.html"
    raw_source = (
        source
        + "?token=workflow-token-secret&X-Amz-Credential=workflow-credential-secret"
        "&X-Amz-Signature=workflow-signature-secret#workflow-fragment-secret"
    )
    fields = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "人工｜供应商报价来源": raw_source,
        "evaluation": complete_evaluation(),
    }
    fields["evaluation"]["order"]["supplier_quote_source"] = raw_source

    class Source:
        async def list_trigger_records(self) -> list[TriggerRecord]:
            return [TriggerRecord("市场评估表", "source-1", "开始验证", "v1", fields)]

    caplog.set_level(logging.INFO, logger="sqlalchemy.engine")
    feishu = FakeFeishu(RecordVersion("source-1", "v1", fields))
    service = Pipeline(
        jobs=job_repo,
        feishu=feishu,
        meta_collector=FakeMeta(meta_success()),
        landing_collector=FakeLanding(landing_success()),
        trends_collector=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
        clock=FrozenClock(),
    )
    worker = Worker(
        jobs=job_repo,
        pipeline=service,
        poller=TriggerPoller(Source(), job_repo),
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
    )

    assert await worker.poll_once() == 1
    result = await worker.run_once()

    assert result.outcome == "succeeded"
    async with job_repo._connection() as connection:
        stored = (
            (
                await connection.execute(
                    select(runtime_jobs).where(runtime_jobs.c.id == result.job_id)
                )
            )
            .one()
            ._mapping
        )
        checkpoints = list(
            await connection.execute(
                select(job_checkpoints.c.stage, job_checkpoints.c.data).where(
                    job_checkpoints.c.job_id == result.job_id
                )
            )
        )
    assert stored["payload"]["data"]["人工｜供应商报价来源"] == source
    checkpoint_data = dict(checkpoints)
    assert set(CHECKPOINT_STAGES) <= checkpoint_data.keys()
    assert checkpoint_data["writeback"]["result"]["status"] == "待人工复核"
    assert (
        checkpoint_data["writeback"]["result"]["evidence"]["supplier_quote"][
            "source_url"
        ]
        == source
    )
    supplier_evidence = next(
        item
        for item in feishu.mutations.values()
        if item.table == "证据表" and item.fields["AUTO｜证据类型"] == "供应商"
    )
    assert supplier_evidence.fields["AUTO｜来源URL"] == source
    assert supplier_evidence.fields["AUTO｜原始值"] == source
    assert supplier_evidence.fields["AUTO｜标准化值"] == source
    serialized = (
        json.dumps(dict(stored), ensure_ascii=False, default=str)
        + json.dumps(checkpoint_data, ensure_ascii=False, default=str)
        + "\n".join(item.model_dump_json() for item in feishu.mutations.values())
        + caplog.text
    )
    for secret in (
        "workflow-token-secret",
        "workflow-credential-secret",
        "workflow-signature-secret",
        "workflow-fragment-secret",
        "X-Amz-Credential",
        "X-Amz-Signature",
    ):
        assert secret not in serialized


async def test_link_path_accepts_flat_feishu_order_fields() -> None:
    complete = complete_evaluation()
    data = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "AUTO｜标准产品名称": "Portable Blender",
        "人工｜单品售价": 79,
        "人工｜预计客单价": 79,
        "人工｜订单件数": 1,
        "人工｜订单货值": 8,
        "人工｜订单运费": 4,
        "人工｜订单包装": 1,
        "人工｜税费关税": 0,
        "人工｜预计广告成本": 5,
        "人工｜订单重量": 0.7,
        "人工｜供应商单件报价": 8,
        "人工｜供应商报价已确认": True,
        "人工｜供应商报价有效": True,
        "人工｜供应商报价采集时间": NOW.isoformat(),
        "人工｜供应商报价来源": "https://supplier.example/quotes/portable-blender",
        "meta": complete["meta"],
    }
    service, _, feishu = pipeline(
        data=data,
        meta=FakeMeta(meta_success()),
        landing=FakeLanding(landing_success()),
        trends=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
    )

    result = await service.run(job(JobKind.LINK_VALIDATION, data))

    assert result.status == "待人工复核"
    assert any(
        item.table == "市场评估表" and item.state == "待人工复核"
        for item in feishu.mutations.values()
    )


async def test_meta_failure_preserves_landing_and_becomes_supplement_not_rejection() -> (
    None
):
    data = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "evaluation": complete_evaluation(),
    }
    meta = FakeMeta(
        CollectorResult.failure(
            CollectorError(
                code="delayed_retry",
                detail="white_screen",
                source="meta-ad-library",
            )
        )
    )
    landing = FakeLanding(landing_success())
    extractor = FakeExtractor()
    service, checkpoints, feishu = pipeline(
        data=data,
        meta=meta,
        landing=landing,
        trends=FakeTrends(trends_success()),
        extractor=extractor,
    )

    result = await service.run(job(JobKind.LINK_VALIDATION, data))

    assert result.status == "待补充证据"
    assert result.status != "淘汰池"
    assert result.retryable is True
    assert result.failure_code == "delayed_retry"
    assert result.retry_kind is JobKind.META_SCAN
    assert landing.calls == 1
    assert extractor.calls == 1
    assert checkpoints.values[(UUID(int=1), "meta")]["status"] == "failed"
    landing_checkpoint = checkpoints.values[(UUID(int=1), "landing")]
    assert landing_checkpoint["status"] == "complete"
    assert landing_checkpoint["evidence"] == {"snapshot": "evidence/landing/snapshot"}
    assert any(
        item.table == "市场评估表" and item.state == "待补充证据"
        for item in feishu.mutations.values()
    )
    score_history = next(
        item for item in feishu.mutations.values() if item.table == "评分记录"
    )
    assert score_history.state == "待人工复核"
    assert score_history.fields["AUTO｜评分状态"] == "待人工复核"
    assert score_history.fields["AUTO｜系统建议"] == "待补充"


async def test_keyword_meta_retry_returns_fenced_queue_control_result() -> None:
    data = {
        "AUTO｜实际搜索词": "portable blender",
        "人工｜状态": "待扫描",
    }
    service, checkpoints, _ = pipeline(
        data=data,
        meta=FakeMeta(
            CollectorResult.failure(
                CollectorError(
                    code="delayed_retry",
                    detail="white_screen",
                    retriable=True,
                    source="meta-ad-library",
                )
            )
        ),
    )

    result = await service.run(job(JobKind.KEYWORD_SCAN, data))

    assert result.retryable is True
    assert result.needs_human is False
    assert result.failure_code == "delayed_retry"
    assert result.retry_kind is JobKind.META_SCAN
    assert checkpoints.values[(UUID(int=1), "writeback")]["status"] == "retryable"


async def test_successful_sources_are_archived_as_private_structured_evidence() -> None:
    data = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "evaluation": complete_evaluation(),
    }
    storage = FakeStorage()
    landing = landing_success().value
    assert landing is not None
    service, checkpoints, _ = pipeline(
        data=data,
        storage=storage,
        meta=FakeMeta(meta_success()),
        landing=FakeLanding(CollectorResult.success(landing)),
        trends=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
    )

    await service.run(job(JobKind.LINK_VALIDATION, data))

    assert {call["record_id"] for call in storage.calls} == {
        "source-1-meta",
        "source-1-landing",
        "source-1-trends",
    }
    assert checkpoints.values[(UUID(int=1), "landing")]["evidence"][
        "structured"
    ].startswith("evidence/source-1-landing/")
    assert all(call["content_type"] == "application/json" for call in storage.calls)


async def test_stale_record_preserves_evidence_and_score_but_marks_input_changed() -> (
    None
):
    data = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "evaluation": complete_evaluation(),
    }
    changed = RecordVersion("source-1", "v2", {**data, "人工｜预计客单价": 88})
    feishu = FakeFeishu(changed)
    service, checkpoints, _ = pipeline(
        data=data,
        feishu=feishu,
        meta=FakeMeta(meta_success()),
        landing=FakeLanding(landing_success()),
        trends=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
    )

    result = await service.run(job(JobKind.LINK_VALIDATION, data))

    assert result.status == "输入已变更"
    assert checkpoints.values[(UUID(int=1), "meta")]["status"] == "complete"
    assert checkpoints.values[(UUID(int=1), "evaluate")]["status"] == "complete"
    assert checkpoints.values[(UUID(int=1), "evaluate")]["value"]["total"] > 0
    assert any(item.table == "评分记录" for item in feishu.mutations.values())
    assert any(
        item.table == "市场评估表"
        and item.state == "输入已变更"
        and item.fields == {"AUTO｜运行状态": "输入已变更"}
        for item in feishu.mutations.values()
    )


async def test_stale_keyword_does_not_write_market_fields_into_keyword_table() -> None:
    data = {
        "AUTO｜实际搜索词": "portable blender",
        "人工｜状态": "待扫描",
    }
    changed = RecordVersion("source-1", "v2", data)
    feishu = FakeFeishu(changed)
    service, _, _ = pipeline(
        data=data,
        feishu=feishu,
        meta=FakeMeta(meta_success()),
    )

    result = await service.run(job(JobKind.KEYWORD_SCAN, data))

    assert result.status == "输入已变更"
    source_update = next(
        item
        for item in feishu.mutations.values()
        if item.table == "关键词库" and item.action == "update"
    )
    assert source_update.state == "输入已变更"
    assert source_update.fields == {}


async def test_protected_input_hash_mismatch_is_stale_even_at_same_version() -> None:
    data = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "人工｜预计客单价": 79,
        "evaluation": complete_evaluation(),
    }
    current = RecordVersion(
        "source-1",
        "v1",
        {**data, "人工｜预计客单价": 88},
    )
    service, _, _ = pipeline(
        data=data,
        feishu=FakeFeishu(current),
        meta=FakeMeta(meta_success()),
        landing=FakeLanding(landing_success()),
        trends=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
    )

    result = await service.run(job(JobKind.LINK_VALIDATION, data))

    assert result.status == "输入已变更"
    assert result.score is not None


async def test_ai_only_risk_claims_cannot_make_evaluation_complete() -> None:
    evaluation = complete_evaluation()
    evaluation["meta"]["compliance_risk"] = None
    evaluation["meta"]["trust"]["compliance_risk"] = "unknown"
    data = {
        "link": "https://shop.example/products/portable-blender",
        "query": "portable blender",
        "人工｜状态": "开始验证",
        "evaluation": evaluation,
    }
    extractor = FakeExtractor(
        {
            "compliance_warnings": {
                "value": [],
                "trust": "verified",
                "provenance": "human",
            }
        }
    )
    service, _, _ = pipeline(
        data=data,
        meta=FakeMeta(meta_success()),
        landing=FakeLanding(landing_success()),
        trends=FakeTrends(trends_success()),
        extractor=extractor,
    )

    result = await service.run(job(JobKind.LINK_VALIDATION, data))

    assert result.status == "待补充证据"
    assert "compliance_risk" in result.missing_fields


class WorkerJobs(FakeCheckpoints):
    def __init__(self, leased: Job) -> None:
        super().__init__()
        self.leased = leased
        self._offered = False
        self.completed = False
        self.retries: list[tuple[str, int]] = []
        self.renewals = 0
        self.human_failures: list[str] = []

    async def lease_next(self, worker: str, *, lease_for: timedelta) -> Job | None:
        del worker, lease_for
        if self._offered:
            return None
        self._offered = True
        return self.leased

    async def renew(self, *_: Any, **__: Any) -> Job:
        self.renewals += 1
        assert self.leased is not None
        return self.leased

    async def complete(self, *_: Any, **__: Any) -> Job:
        assert self.values[(UUID(int=1), "writeback")]
        self.completed = True
        assert self.leased is not None
        return self.leased

    async def retry(
        self, _job_id: UUID, *, failure: str, attempt: int, **_: Any
    ) -> Job:
        assert self.values[(UUID(int=1), "worker_failure")]["code"] == failure
        self.retries.append((failure, attempt))
        assert self.leased is not None
        return self.leased

    async def needs_human(self, *_: Any, **__: Any) -> Job:
        failure = __.get("failure")
        if isinstance(failure, str):
            self.human_failures.append(failure)
        assert self.leased is not None
        return self.leased


class SuccessfulPipeline:
    def __init__(self, jobs: WorkerJobs) -> None:
        self.jobs = jobs

    async def run(self, queued: Job) -> PipelineResult:
        await self.jobs.checkpoint(
            queued.id,
            "writeback",
            {"status": "complete"},
            worker=queued.leased_by or "",
            lease_token=queued.lease_token,
        )
        return PipelineResult(status="待询价", checkpoint_stage="writeback")


class RetryPipeline:
    async def run(self, _queued: Job) -> PipelineResult:
        raise RetryablePipelineError("landing_timeout", "collector timed out")


class RetryableResultPipeline:
    async def run(self, _queued: Job) -> PipelineResult:
        return PipelineResult(
            status="待延迟重试",
            retryable=True,
            failure_code="meta_timeout",
            retry_attempt=3,
            retry_kind=JobKind.META_SCAN,
        )


class MissingCheckpointPipeline:
    async def run(self, _queued: Job) -> PipelineResult:
        return PipelineResult(status="待询价", checkpoint_stage="writeback")


class RenewalPipeline:
    def __init__(self, jobs: WorkerJobs) -> None:
        self.jobs = jobs

    async def run(self, queued: Job) -> PipelineResult:
        while self.jobs.renewals == 0:
            await asyncio.sleep(0)
        await self.jobs.checkpoint(
            queued.id,
            "writeback",
            {"status": "complete"},
            worker=queued.leased_by or "",
            lease_token=queued.lease_token,
        )
        return PipelineResult(status="待询价", checkpoint_stage="writeback")


async def test_worker_acknowledges_only_after_durable_writeback_checkpoint() -> None:
    queued = job(JobKind.KEYWORD_SCAN, {"AUTO｜实际搜索词": "portable blender"})
    jobs = WorkerJobs(queued)
    result = await Worker(
        jobs=jobs,
        pipeline=SuccessfulPipeline(jobs),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
    ).run_once()

    assert result.outcome == "succeeded"
    assert jobs.completed is True


async def test_worker_checkpoints_typed_failure_before_retry() -> None:
    queued = job(JobKind.LINK_VALIDATION, {"link": "https://shop.example/p/1"})
    jobs = WorkerJobs(queued)

    result = await Worker(
        jobs=jobs,
        pipeline=RetryPipeline(),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
    ).run_once()

    assert result.outcome == "retry"
    assert jobs.retries == [("landing_timeout", 1)]


async def test_worker_retries_a_retryable_pipeline_result_with_meta_policy() -> None:
    queued = job(
        JobKind.KEYWORD_SCAN,
        {"AUTO｜实际搜索词": "portable blender", "人工｜状态": "待扫描"},
    )
    jobs = WorkerJobs(queued)

    result = await Worker(
        jobs=jobs,
        pipeline=RetryableResultPipeline(),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
    ).run_once()

    assert result.outcome == "retry"
    assert jobs.retries == [("meta_timeout", 3)]


class StaleFailureJobs(WorkerJobs):
    async def checkpoint(self, *_: Any, **__: Any) -> None:
        raise StaleLeaseError("lease replaced")


async def test_worker_swallow_stale_lease_while_recording_failure() -> None:
    queued = job(JobKind.LINK_VALIDATION, {"link": "https://shop.example/p/1"})
    jobs = StaleFailureJobs(queued)

    result = await Worker(
        jobs=jobs,
        pipeline=RetryPipeline(),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
    ).run_once()

    assert result.outcome == "lease_lost"
    assert result.failure_code == "stale_lease"


async def test_worker_renews_lease_during_browser_work() -> None:
    queued = job(JobKind.LINK_VALIDATION, {"link": "https://shop.example/p/1"})
    jobs = WorkerJobs(queued)

    async def yield_now(_seconds: float) -> None:
        await asyncio.sleep(0)

    result = await Worker(
        jobs=jobs,
        pipeline=RenewalPipeline(jobs),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
        renew_seconds=1,
        sleep=yield_now,
    ).run_once()

    assert result.outcome == "succeeded"
    assert jobs.renewals >= 1


async def test_worker_never_acknowledges_without_writeback_checkpoint() -> None:
    queued = job(JobKind.KEYWORD_SCAN, {"AUTO｜实际搜索词": "portable blender"})
    jobs = WorkerJobs(queued)

    result = await Worker(
        jobs=jobs,
        pipeline=MissingCheckpointPipeline(),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
    ).run_once()

    assert result.outcome == "needs_human"
    assert jobs.completed is False
    assert jobs.human_failures == ["missing_writeback_checkpoint"]


def test_worker_consumer_count_is_bounded_by_browser_concurrency() -> None:
    queued = job(JobKind.KEYWORD_SCAN, {"AUTO｜实际搜索词": "portable blender"})
    jobs = WorkerJobs(queued)

    one = Worker(
        jobs=jobs,
        pipeline=MissingCheckpointPipeline(),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=1,
        poll_seconds=10,
    )
    two = Worker(
        jobs=jobs,
        pipeline=MissingCheckpointPipeline(),
        poller=None,
        worker_id="worker-1",
        browser_concurrency=50,
        poll_seconds=10,
    )

    assert one.consumer_count == 1
    assert two.consumer_count == 2
