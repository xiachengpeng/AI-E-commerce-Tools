from dataclasses import replace
from datetime import timedelta

import httpx
import pytest
from e2e.test_phase1 import FixtureBase
from test_pipeline import (
    FakeExtractor,
    FakeLanding,
    FakeMeta,
    FakeStorage,
    FakeTrends,
    landing_success,
    meta_success,
    trends_success,
)

from rabbit_hole.config import MarketSettings
from rabbit_hole.domain.legacy import JobKind, JobPayload
from rabbit_hole.integrations.collectors.base import CollectorError, CollectorResult
from rabbit_hole.integrations.feishu import FeishuClient, protected_input_hash
from rabbit_hole.pipeline import Pipeline
from rabbit_hole.runtime.legacy import FeishuWorkflowAdapter


def declared_link_inputs(clock):
    return {
        "人工｜状态": ["开始验证"],
        "人工｜广告或落地页链接": "https://shop.example/products/portable-blender",
        "人工｜产品名称": "Portable Blender",
        "人工｜通用产品词": "portable blender",
        "人工｜市场": ["US"],
        "人工｜订单件数": 1,
        "人工｜单品售价": 79,
        "人工｜预计客单价": 79,
        "人工｜订单货值": 8,
        "人工｜订单运费": 4,
        "人工｜订单包装": 1,
        "人工｜税费关税": 0,
        "人工｜预计广告成本": 5,
        "人工｜订单重量": 0.7,
        "人工｜供应商单件报价": 8,
        "人工｜供应商报价已确认": True,
        "人工｜供应商报价有效": True,
        "人工｜供应商报价可信度": ["verified"],
        "人工｜供应商报价来源": "https://supplier.example/quote",
        "人工｜供应商报价采集时间": clock.now().isoformat(),
        "人工｜物流风险": ["低"],
        "人工｜合规风险": ["低"],
        "人工｜侵权风险": ["低"],
        "人工｜创意形式": "video|ugc|demo",
        "人工｜使用场景": "office|study|gift",
        "人工｜创意角度": "portable|fast|easy",
        "人工｜可持续演示": True,
        "人工｜需要认证": False,
        "人工｜品牌集中度": ["低"],
        "人工｜产品差异化": ["高"],
        "人工｜证据已确认": True,
    }


def pipeline(repo, adapter, clock, meta=None):
    return Pipeline(
        jobs=repo,
        feishu=adapter,
        clock=clock,
        meta_collector=meta or FakeMeta(meta_success()),
        landing_collector=FakeLanding(landing_success()),
        trends_collector=FakeTrends(trends_success()),
        extractor=FakeExtractor(),
        storage=FakeStorage(),
        market=MarketSettings(
            code="US",
            currency="USD",
            min_aov=50,
            max_aov=100,
            payment_percent=2.9,
            payment_fixed=0.3,
            loss_reserve_percent=2,
        ),
    )


async def enqueue(repo, adapter, table, kind):
    record = await adapter.get_record(table, "source")
    queued = await repo.enqueue(
        JobPayload(
            kind=kind,
            record_id="source",
            input_version=record.version,
            protected_input_hash=protected_input_hash(record.fields),
            data=dict(record.fields),
        )
    )
    job = await repo.lease_next("test", lease_for=timedelta(minutes=5))
    assert job.id == queued.id
    return job


async def test_declared_base_link_input_reaches_review(db_transaction, job_repo, clock):
    base = FixtureBase()
    base.seed("市场评估表", "source", declared_link_inputs(clock))
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.status == "待人工复核", result
    assert result.score["total"] > 0
    import json

    history = base.table_rows("评分记录")[0]["fields"]
    audit = json.loads(history["AUTO｜输入证据快照"])
    assert set(audit["value"]["dimension_explanations"]) == {
        "需求与趋势",
        "素材空间",
        "利润与物流",
        "竞争强度",
        "合规风险",
    }
    assert audit["value"]["gate_explanations"]


@pytest.mark.parametrize("after_ack", range(1, 13))
async def test_immutable_intents_resume_advanced_clock(
    db_transaction, job_repo, clock, after_ack
):
    base = FixtureBase()
    base.seed(
        "关键词库",
        "source",
        {"人工｜状态": ["待扫描"], "AUTO｜实际搜索词": "portable blender"},
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "关键词库", JobKind.KEYWORD_SCAN)

        class Interrupt:
            count = 0

            async def get_record(self, *args):
                return await adapter.get_record(*args)

            async def apply(self, mutation):
                result = await adapter.apply(mutation)
                self.count += 1
                if self.count == after_ack:
                    raise RuntimeError("process terminated after ack")
                return result

        with pytest.raises(RuntimeError, match="terminated"):
            await pipeline(job_repo, Interrupt(), clock).run(job)
        clock.advance(timedelta(minutes=16))
        job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.status == "已启用"
    assert len(base.table_rows("搜索批次")) == 1


async def test_keyword_delayed_batch_is_completed_in_same_row(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    base.seed(
        "关键词库",
        "source",
        {"人工｜状态": ["待扫描"], "AUTO｜实际搜索词": "portable blender"},
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "关键词库", JobKind.KEYWORD_SCAN)
        failed = FakeMeta(
            CollectorResult.failure(
                CollectorError(code="delayed_retry", detail="page unavailable")
            )
        )
        assert (await pipeline(job_repo, adapter, clock, failed).run(job)).retryable
        clock.advance(timedelta(minutes=16))
        job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        assert (
            await pipeline(job_repo, adapter, clock).run(replace(job, attempt=3))
        ).status == "已启用"
    rows = base.table_rows("搜索批次")
    assert len(rows) == 1
    assert rows[0]["fields"]["AUTO｜状态"] == ["已完成"]


async def test_delayed_link_recomputes_and_recognizes_own_state(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    base.seed("市场评估表", "source", declared_link_inputs(clock))
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        failed = FakeMeta(
            CollectorResult.failure(
                CollectorError(code="delayed_retry", detail="page unavailable")
            )
        )
        assert (await pipeline(job_repo, adapter, clock, failed).run(job)).retryable
        clock.advance(timedelta(minutes=16))
        job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        result = await pipeline(job_repo, adapter, clock).run(replace(job, attempt=3))
    assert result.status == "待人工复核", result
    assert result.score["total"] > 0


async def test_target_product_never_uses_unrelated_search_group(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data["人工｜广告或落地页链接"] = "https://shop.example/products/target-a"
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.status == "待识别具体产品"
    assert result.score is None or result.score["total"] is None


async def test_score_history_has_full_snapshot_and_incomplete_clears_current(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data.pop("人工｜订单货值")
    data.update({"AUTO｜贡献毛利率": 90, "AUTO｜总分": 25, "AUTO｜需求趋势分": 5})
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        await pipeline(job_repo, adapter, clock).run(job)
    fields = base.rows["source"]["fields"]
    assert fields.get("AUTO｜贡献毛利率") is None
    assert fields.get("AUTO｜总分") is None
    assert fields.get("AUTO｜需求趋势分") is None
    history = base.table_rows("评分记录")[0]["fields"]
    import json

    snapshot = json.loads(history["AUTO｜输入证据快照"])
    assert snapshot["input"]["product_name"] == "Portable Blender"
    assert "sources" in snapshot


async def test_linked_product_is_loaded_and_version_fenced(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data.pop("人工｜广告或落地页链接")
    data.pop("人工｜产品名称")
    data["AUTO｜产品"] = ["product"]
    base.seed(
        "产品主表",
        "product",
        {
            "人工｜商品链接": "https://shop.example/products/portable-blender?token=linked-secret",
            "AUTO｜标准产品名称": "Portable Blender",
            "AUTO｜产品指纹": "portable-blender",
            "AUTO｜状态": ["待补充"],
        },
    )
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.status == "待人工复核"
    checkpoint = await job_repo.get_checkpoint(job.id, "linked_product")
    assert checkpoint["record_id"] == "product"
    assert checkpoint["version"]
    assert "linked-secret" not in str(checkpoint)


@pytest.mark.parametrize("state", ["队列中", "采集中", "待评分", "待人工复核"])
async def test_link_restart_after_each_acknowledged_state_edge(
    db_transaction, job_repo, clock, state
):
    base = FixtureBase()
    base.seed("市场评估表", "source", declared_link_inputs(clock))
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)

        class Interrupt:
            async def get_record(self, *args):
                return await adapter.get_record(*args)

            async def apply(self, mutation):
                result = await adapter.apply(mutation)
                if mutation.table == "市场评估表" and mutation.state == state:
                    raise RuntimeError("state ack interruption")
                return result

        with pytest.raises(RuntimeError, match="state ack"):
            await pipeline(job_repo, Interrupt(), clock).run(job)
        clock.advance(timedelta(minutes=16))
        job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.status == "待人工复核"


async def test_meta_link_late_success_invalidates_failed_landing(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data["人工｜广告或落地页链接"] = "https://www.facebook.com/ads/library/?id=1"
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        failed = FakeMeta(
            CollectorResult.failure(
                CollectorError(code="delayed_retry", detail="page unavailable")
            )
        )
        await pipeline(job_repo, adapter, clock, failed).run(job)
        clock.advance(timedelta(minutes=16))
        job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        result = await pipeline(job_repo, adapter, clock).run(replace(job, attempt=3))
    assert result.status == "待人工复核"


async def test_new_source_snapshot_does_not_reuse_old_evidence_alias(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    base.seed("市场评估表", "source", declared_link_inputs(clock))
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        service = pipeline(job_repo, adapter, clock)
        first = await service._write_source_evidence(
            job, {"evidence": {"page": "immutable-old"}}, source_type="Meta"
        )
        second = await service._write_source_evidence(
            job, {"evidence": {"page": "immutable-new"}}, source_type="Meta"
        )
    assert first != second
    assert {row["fields"]["AUTO｜快照对象ID"] for row in base.table_rows("证据表")} == {
        "immutable-old",
        "immutable-new",
    }


async def test_confirmed_quote_without_validity_never_scores(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data.pop("人工｜供应商报价有效")
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.score is None or result.score["total"] is None


async def test_quote_audit_preserves_actual_collection_time(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    collected = clock.now() - timedelta(days=3)
    data["人工｜供应商报价采集时间"] = collected.isoformat()
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        await pipeline(job_repo, adapter, clock).run(job)
    quote = next(
        row["fields"]
        for row in base.table_rows("证据表")
        if row["fields"]["AUTO｜证据类型"] == ["供应商"]
    )
    assert quote["AUTO｜采集时间"] == collected.isoformat()
    assert quote["AUTO｜有效期"] == (collected + timedelta(days=14)).isoformat()


async def test_equal_scores_with_new_input_snapshot_create_new_history(
    db_transaction, job_repo, clock
):
    from rabbit_hole.scoring import EvaluationResult

    base = FixtureBase()
    base.seed("市场评估表", "source", declared_link_inputs(clock))
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        service = pipeline(job_repo, adapter, clock)
        score = EvaluationResult(status="待补充证据")
        for source in ("old", "new"):
            await job_repo.checkpoint(
                job.id,
                "evaluate",
                {"sources": {"meta": source}},
                worker="test",
                lease_token=job.lease_token,
            )
            await service._write_score_history(job, score, supplier_quote_source=None)
    assert len(base.table_rows("评分记录")) == 2
    assert {row["fields"]["AUTO｜规则版本"] for row in base.table_rows("评分记录")} == {
        "phase1-v2"
    }


@pytest.mark.parametrize(
    "unresolved", ["missing_meta_query", "ambiguous_linked_product"]
)
async def test_unresolved_input_stops_at_product_identification(
    db_transaction, job_repo, clock, unresolved
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data.pop("人工｜产品名称")
    data.pop("人工｜通用产品词")
    if unresolved == "missing_meta_query":
        data["人工｜广告或落地页链接"] = "https://www.facebook.com/ads/library/?id=123"
    else:
        data.pop("人工｜广告或落地页链接")
        data["AUTO｜产品"] = ["one", "two"]
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.status == "待识别具体产品"
    assert base.rows["source"]["fields"]["人工｜状态"] == ["待识别具体产品"]
    assert not base.table_rows("搜索批次")


async def test_declared_human_synonyms_reach_meta_search(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data["人工｜已审核同义词"] = "portable blender|travel blender|personal blender"
    base.seed("市场评估表", "source", data)

    class Capture(FakeMeta):
        actual_queries = ()

        async def collect(self, query, **kwargs):
            self.actual_queries = query.actual_queries
            return await super().collect(query, **kwargs)

    collector = Capture(meta_success())
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        await pipeline(job_repo, adapter, clock, collector).run(job)
    assert collector.actual_queries == (
        '"portable blender"',
        '"travel blender"',
        '"personal blender"',
    )


async def test_linked_auto_landing_fallback_ignores_empty_human_link(
    db_transaction, job_repo, clock
):
    base = FixtureBase()
    data = declared_link_inputs(clock)
    data["人工｜广告或落地页链接"] = None
    data["AUTO｜产品"] = ["product"]
    base.seed(
        "产品主表",
        "product",
        {
            "人工｜商品链接": None,
            "AUTO｜落地页链接": "https://shop.example/products/portable-blender",
            "AUTO｜标准产品名称": "Portable Blender",
            "AUTO｜状态": ["待补充"],
        },
    )
    base.seed("市场评估表", "source", data)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        adapter = FeishuWorkflowAdapter(
            FeishuClient("a", "s", "b", http_client=http),
            db_transaction,
            verify_delays=(),
        )
        job = await enqueue(job_repo, adapter, "市场评估表", JobKind.LINK_VALIDATION)
        result = await pipeline(job_repo, adapter, clock).run(job)
    assert result.status == "待人工复核"
