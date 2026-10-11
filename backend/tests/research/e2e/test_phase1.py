"""Opt-in, fixture-backed acceptance of the Phase 1 workflow boundary.

This test does not contact a customer Base or a source site. It exercises the
real queue, Pipeline, durable Feishu adapter and versioned MinIO evidence
store against disposable local services. Meta, landing and Trends observations
are deterministic fixtures because live credentials/selectors are operational
inputs, not a test substitute.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import boto3
import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from rabbit_hole.config import MarketSettings
from rabbit_hole.discovery import NicheCandidate
from rabbit_hole.domain.legacy import Job, JobKind, JobPayload
from rabbit_hole.integrations.collectors.google import GoogleTrendsCollector
from rabbit_hole.integrations.collectors.landing import LandingCollector
from rabbit_hole.integrations.collectors.meta import (
    MetaAd,
    MetaCollector,
    MetaPageHealthError,
)
from rabbit_hole.integrations.feishu import (
    BaseSchema,
    FeishuClient,
    protected_input_hash,
)
from rabbit_hole.persistence.database import job_checkpoints, runtime_jobs
from rabbit_hole.persistence.evidence_store import EvidenceStore
from rabbit_hole.persistence.legacy_jobs import JobRepository
from rabbit_hole.pipeline import Pipeline
from rabbit_hole.runtime.legacy import FeishuWorkflowAdapter
from rabbit_hole.security import SafeUrlClient
from rabbit_hole.trends import TrendSeries

pytestmark = pytest.mark.e2e

FIXTURES = Path(__file__).parents[1] / "fixtures"
FINAL_POOLS = frozenset({"测试池", "备选池", "淘汰池"})


@pytest.fixture(autouse=True)
def require_local_acceptance_services() -> None:
    if os.getenv("RABBIT_HOLE_RUN_E2E") != "1":
        pytest.skip("set RABBIT_HOLE_RUN_E2E=1 for local Phase 1 acceptance")
    if os.getenv("RABBIT_HOLE_TEST_FILES") == "1":
        return
    required = (
        "RABBIT_HOLE_TEST_MINIO_ENDPOINT",
        "RABBIT_HOLE_TEST_MINIO_ACCESS_KEY",
        "RABBIT_HOLE_TEST_MINIO_SECRET_KEY",
    )
    if any(not os.getenv(name) for name in required):
        pytest.skip("local versioned MinIO credentials are required for E2E")


@pytest.fixture
def minio_store(tmp_path) -> Iterator[tuple[Any, str, EvidenceStore]]:
    """Create and fully remove one versioned, task-owned acceptance bucket."""

    if os.getenv("RABBIT_HOLE_TEST_FILES") == "1":
        from rabbit_hole.persistence.local_objects import LocalObjectClient
        client = LocalObjectClient(tmp_path / "evidence")
        yield client, "private", EvidenceStore(client,bucket="private",collector_version="phase1-e2e-v1")
        return
    client = boto3.client(
        "s3",
        endpoint_url=os.environ["RABBIT_HOLE_TEST_MINIO_ENDPOINT"],
        aws_access_key_id=os.environ["RABBIT_HOLE_TEST_MINIO_ACCESS_KEY"],
        aws_secret_access_key=os.environ["RABBIT_HOLE_TEST_MINIO_SECRET_KEY"],
        region_name="us-east-1",
    )
    bucket = f"rabbit-hole-task11-{uuid4().hex}"
    client.create_bucket(Bucket=bucket)
    client.put_bucket_versioning(
        Bucket=bucket, VersioningConfiguration={"Status": "Enabled"}
    )
    assert client.get_bucket_versioning(Bucket=bucket)["Status"] == "Enabled"
    store = EvidenceStore(client, bucket=bucket, collector_version="phase1-e2e-v1")
    try:
        yield client, bucket, store
    finally:
        while True:
            listed = client.list_object_versions(Bucket=bucket)
            versions = [
                {"Key": item["Key"], "VersionId": item["VersionId"]}
                for section in ("Versions", "DeleteMarkers")
                for item in listed.get(section, [])
            ]
            if not versions:
                break
            client.delete_objects(Bucket=bucket, Delete={"Objects": versions})
        client.delete_bucket(Bucket=bucket)


class FixtureBase:
    """A strict in-memory Base v3 HTTP boundary, not a workflow substitute."""

    def __init__(self) -> None:
        self.table_ids = {
            table.name: f"tbl{index:02d}"
            for index, table in enumerate(BaseSchema.default().tables, start=1)
        }
        self._names = {value: key for key, value in self.table_ids.items()}
        self.rows: dict[str, dict[str, Any]] = {}
        self.writes: list[tuple[str, str, dict[str, Any]]] = []
        self._next_record = 1

    def seed(self, table: str, record_id: str, fields: dict[str, Any]) -> None:
        self.validate_fields(table, fields)
        self.rows[record_id] = {
            "id": record_id,
            "fields": deepcopy(fields),
            "table": table,
        }

    @staticmethod
    def validate_fields(table: str, fields: dict[str, Any]) -> None:
        declared = {
            field.display_name
            for item in BaseSchema.default().tables
            if item.name == table
            for field in item.fields
        }
        assert not set(fields) - declared, (
            f"undeclared Base fields: {set(fields) - declared}"
        )

    def table_rows(self, table: str) -> list[dict[str, Any]]:
        return [deepcopy(row) for row in self.rows.values() if row["table"] == table]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        data = json.loads(request.content) if request.content else {}
        if path.endswith("/tenant_access_token/internal"):
            return httpx.Response(
                200,
                json={"code": 0, "tenant_access_token": "fixture", "expire": 7200},
            )
        if path.endswith("/tables"):
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": [
                            {"name": name, "id": table_id}
                            for name, table_id in self.table_ids.items()
                        ],
                        "has_more": False,
                    },
                },
            )
        table = self._table_for_path(path)
        if path.endswith("/views"):
            from rabbit_hole.integrations.feishu import ALL_VIEWS

            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": [
                            {"id": f"view-{index}", "name": view.name}
                            for index, view in enumerate(ALL_VIEWS)
                            if view.table == table
                        ],
                        "has_more": False,
                    },
                },
            )
        if path.endswith("/records/batch_get"):
            records = [
                self._wire_row(self.rows[record_id])
                for record_id in data["record_id_list"]
                if record_id in self.rows and self.rows[record_id]["table"] == table
            ]
            return httpx.Response(200, json={"code": 0, "data": {"records": records}})
        if path.endswith("/records") and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "records": [
                            self._wire_row(row) for row in self.table_rows(table)
                        ],
                        "has_more": False,
                    },
                },
            )
        if path.endswith("/records/batch_create"):
            self.writes.append(("create", table, deepcopy(data)))
            record_id = f"rec{self._next_record:04d}"
            self._next_record += 1
            self.seed(table, record_id, dict(data["create_records"][0]))
            return httpx.Response(
                200, json={"code": 0, "data": {"record_id_list": [record_id]}}
            )
        if path.endswith("/records/batch_update"):
            self.writes.append(("update", table, deepcopy(data)))
            for record_id, fields in data["update_records"].items():
                self.validate_fields(table, fields)
                assert record_id in self.rows
                assert self.rows[record_id]["table"] == table
                self.rows[record_id]["fields"].update(deepcopy(fields))
            return httpx.Response(200, json={"code": 0, "data": {}})
        raise AssertionError((request.method, path, data))

    def _table_for_path(self, path: str) -> str:
        table_id = path.split("/tables/", maxsplit=1)[1].split("/", maxsplit=1)[0]
        return self._names[table_id]

    @staticmethod
    def _wire_row(row: dict[str, Any]) -> dict[str, Any]:
        return {"id": row["id"], "fields": deepcopy(row["fields"])}


class FixtureMetaPage:
    source_url = "https://www.facebook.com/ads/library/"

    def __init__(self, state: FixtureMetaState) -> None:
        self._state = state
        self._filters: dict[str, str] = {}

    async def apply_filter(self, name: str, value: str) -> None:
        self._filters[name] = value

    async def displayed_filters(self) -> dict[str, str]:
        return dict(self._filters)

    async def health_check(self) -> None:
        if self._state.white_screen:
            self._state.white_screen = False
            raise MetaPageHealthError("white_screen")

    async def read_batch(self, *, query: str) -> tuple[MetaAd, ...]:
        assert query == '"glow lamp"'
        return self._state.ads

    async def scroll(self) -> None:
        raise AssertionError("fixture page is already at the end")

    async def at_end(self) -> bool:
        return True

    async def no_results_confirmed(self) -> bool:
        return False

    async def screenshot(self) -> bytes:
        return b"phase1-meta-fixture-screenshot"

    async def refresh(self) -> None:
        self._state.refreshes += 1

    async def reopen(self) -> None:
        raise AssertionError("white screen should recover at refresh")

    async def restore_checkpoint(self, checkpoint: dict[str, Any]) -> None:
        assert checkpoint


class FixtureMetaState:
    def __init__(self, ads: tuple[MetaAd, ...], *, white_screen: bool) -> None:
        self.ads = ads
        self.white_screen = white_screen
        self.refreshes = 0


class FixtureMetaFactory:
    def __init__(self, state: FixtureMetaState) -> None:
        self._state = state

    async def create(self) -> FixtureMetaPage:
        return FixtureMetaPage(self._state)

    async def new_context(self) -> FixtureMetaPage:
        return FixtureMetaPage(self._state)


class FixtureTrendsStrategy:
    def __init__(self) -> None:
        self._short = TrendSeries.model_validate_json(
            (FIXTURES / "trends" / "rising.json").read_text()
        )
        self._long = TrendSeries.model_validate_json(
            (FIXTURES / "trends" / "yoy_5y.json").read_text()
        )

    async def fetch_weekly_series(
        self, query: str, geo: str, window: str
    ) -> TrendSeries:
        source = self._short if window == "12m" else self._long
        return source.model_copy(update={"query": query, "geo": geo, "window": window})


class FixtureExtractor:
    async def extract(self, source: Any) -> dict[str, dict[str, str]]:
        assert source.landing is not None
        return {"generic_product_name": {"value": "Glow Lamp", "trust": "inferred"}}


class FixtureNicheGenerator:
    async def generate(self, **_: Any) -> NicheCandidate:
        return NicheCandidate(
            name="Desk Lighting",
            category_key="home",
            ai_rationale="fixture proposal for human research",
            status="已启用",
            enabled=True,
            human_state="批准",
        )


def _ad(ad_id: str, fingerprint: str, *, advertiser: str) -> MetaAd:
    perceptual_hashes = {
        "pass-1": "0" * 16,
        "pass-2": "f" * 16,
        "pass-3": "5" * 16,
        "observe-1": "a" * 16,
        "observe-2": "3" * 16,
    }
    return MetaAd(
        ad_id=ad_id,
        advertiser=advertiser,
        start_date=datetime(2026, 7, 1, tzinfo=UTC).date(),
        is_active=True,
        observable_active_days=40,
        primary_text=f"Glow lamp proof {ad_id}",
        hook=f"hook {ad_id}",
        landing_url="https://shop.example/products/glow-lamp",
        final_landing_url="https://shop.example/products/glow-lamp",
        landing_page_type="product",
        product_fingerprint=fingerprint,
        media_hash=f"media-{ad_id}",
        perceptual_hash=perceptual_hashes[ad_id],
        media_accessible=True,
        relevance_verified=True,
        query='"glow lamp"',
    )


def _evaluation() -> dict[str, Any]:
    verified = "verified"
    return {
        "product_name": "Glow Lamp",
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
            "supplier_quote_source": "https://supplier.example/quotes/glow-lamp",
            "supplier_quote_confirmed": True,
            "supplier_quote_valid": True,
            "supplier_quote_trust": verified,
            "cost_trust": {
                key: verified
                for key in (
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
            "creative_scenarios": ["office", "study", "gift"],
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
                key: verified
                for key in (
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


async def _run_job(
    jobs: JobRepository, pipeline: Pipeline, payload: JobPayload
) -> tuple[Job, Any]:
    queued = await jobs.enqueue(payload)
    leased = await jobs.lease_next("phase1-e2e", lease_for=timedelta(minutes=5))
    assert leased is not None and leased.id == queued.id
    result = await pipeline.run(leased)
    await jobs.complete(leased.id, worker="phase1-e2e", lease_token=leased.lease_token)
    return leased, result


async def _payload_from_base(
    adapter: FeishuWorkflowAdapter,
    *,
    kind: JobKind,
    table: str,
    record_id: str,
    stale_version: bool = False,
) -> JobPayload:
    source = await adapter.get_record(table, record_id)
    return JobPayload(
        kind=kind,
        record_id=record_id,
        input_version="stale-fixture-v1" if stale_version else source.version,
        protected_input_hash=protected_input_hash(source.fields),
        market="US",
        data=source.fields,
    )


async def test_phase1_real_pipeline_preserves_evidence_and_human_gate(
    db_transaction: AsyncConnection,
    job_repo: JobRepository,
    clock: Any,
    minio_store: tuple[Any, str, EvidenceStore],
) -> None:
    """Exercise automation-owned paths against local real services."""

    object_client, bucket, storage = minio_store
    base = FixtureBase()
    assert len(base.table_ids) == 9
    base.seed(
        "细分领域池",
        "niche-source",
        {"人工｜选择大类": "家居收纳", "人工｜状态": ["待生成"]},
    )
    base.seed(
        "关键词库",
        "keyword-source",
        {"AUTO｜实际搜索词": "glow lamp", "人工｜状态": ["待扫描"]},
    )
    link_fields = {
        "人工｜广告或落地页链接": "https://shop.example/products/glow-lamp",
        "人工｜通用产品词": "glow lamp",
        "人工｜产品名称": "Glow Lamp",
        "人工｜状态": ["开始验证"],
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
    base.seed("市场评估表", "link-source", link_fields)
    base.seed("市场评估表", "stale-source", deepcopy(link_fields))
    base.seed(
        "供应商报价",
        "human-quote",
        {
            "AUTO｜商品链接": "https://supplier.example/quotes/glow-lamp",
            "AUTO｜状态": ["待人工选择"],
            "人工｜是否采用": False,
        },
    )
    ads = (
        _ad("pass-1", "glow-lamp", advertiser="Acme"),
        _ad("pass-2", "glow-lamp", advertiser="Acme"),
        _ad("pass-3", "glow-lamp", advertiser="Acme"),
        _ad("observe-1", "desk-cable-organizer", advertiser="DeskCo"),
        _ad("observe-2", "desk-cable-organizer", advertiser="DeskCo"),
    )
    meta_state = FixtureMetaState(ads, white_screen=True)
    meta = MetaCollector(
        FixtureMetaFactory(meta_state),
        evidence_store=storage,
        job_repository=job_repo,
        clock=clock,
    )
    landing = LandingCollector(
        SafeUrlClient(
            resolver=lambda _host, _port: ["93.184.216.34"],
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    200, content=(FIXTURES / "landing" / "product.html").read_bytes()
                )
            ),
        )
    )
    market = MarketSettings(
        code="US",
        currency="USD",
        min_aov=50,
        max_aov=100,
        payment_percent=2.9,
        payment_fixed=0.3,
        loss_reserve_percent=2,
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient(
            "fixture-app", "fixture-secret", "fixture-base", http_client=http
        )
        adapter = FeishuWorkflowAdapter(client, db_transaction, verify_delays=())
        pipeline = Pipeline(
            jobs=job_repo,
            feishu=adapter,
            meta_collector=meta,
            landing_collector=landing,
            trends_collector=GoogleTrendsCollector(FixtureTrendsStrategy(), clock),
            extractor=FixtureExtractor(),
            discovery_generator=FixtureNicheGenerator(),
            storage=storage,
            market=market,
            clock=clock,
            niche_count=1,
        )

        niche_payload = await _payload_from_base(
            adapter,
            kind=JobKind.NICHE_DISCOVERY,
            table="细分领域池",
            record_id="niche-source",
        )
        _, niche = await _run_job(job_repo, pipeline, niche_payload)
        assert niche.status == "待研究"

        keyword_payload = await _payload_from_base(
            adapter,
            kind=JobKind.KEYWORD_SCAN,
            table="关键词库",
            record_id="keyword-source",
        )
        first = await job_repo.enqueue(keyword_payload)
        duplicate = await job_repo.enqueue(keyword_payload)
        assert first.id == duplicate.id
        keyword_job = await job_repo.lease_next(
            "phase1-e2e", lease_for=timedelta(minutes=5)
        )
        assert keyword_job is not None and keyword_job.id == first.id
        keyword = await pipeline.run(keyword_job)
        assert (await pipeline.run(keyword_job)).model_dump() == keyword.model_dump()
        await job_repo.complete(
            keyword_job.id, worker="phase1-e2e", lease_token=keyword_job.lease_token
        )
        assert keyword.status == "已启用"
        assert meta_state.refreshes == 1
        # The keyword scan deliberately proves both the passing and observation
        # groups. Link validation then follows the selected passing product.
        meta_state.ads = ads[:3]

        link_payload = await _payload_from_base(
            adapter,
            kind=JobKind.LINK_VALIDATION,
            table="市场评估表",
            record_id="link-source",
        )
        link_job, link = await _run_job(job_repo, pipeline, link_payload)
        assert link.status == "待人工复核"
        assert link.score is not None

        stale_payload = await _payload_from_base(
            adapter,
            kind=JobKind.LINK_VALIDATION,
            table="市场评估表",
            record_id="stale-source",
            stale_version=True,
        )
        _, stale = await _run_job(job_repo, pipeline, stale_payload)
        assert stale.status == "输入已变更"

    assert {name for name in base.table_ids} == {
        "细分领域池",
        "关键词库",
        "搜索批次",
        "产品主表",
        "市场评估表",
        "广告与素材",
        "证据表",
        "供应商报价",
        "评分记录",
    }
    assert len(base.table_rows("广告与素材")) == 5
    states = [
        row["fields"].get("人工｜状态", row["fields"].get("AUTO｜状态"))
        for row in base.table_rows("市场评估表")
    ]
    assert ["待询价"] in states
    assert ["观察池"] in states
    assert base.rows["human-quote"]["fields"] == {
        "AUTO｜商品链接": "https://supplier.example/quotes/glow-lamp",
        "AUTO｜状态": ["待人工选择"],
        "人工｜是否采用": False,
    }
    assert not any(table == "供应商报价" for _, table, _ in base.writes)

    score_rows = base.table_rows("评分记录")
    assert len(score_rows) == 2  # complete link plus stale-input audit history
    assert (
        sum(
            row["fields"].get("AUTO｜评分ID", "").startswith(f"{link_job.id}:")
            for row in score_rows
        )
        == 1
    )
    assert all(row["fields"]["AUTO｜评分状态"] == ["待人工复核"] for row in score_rows)
    assert not any(
        action == "update" and table == "评分记录" for action, table, _ in base.writes
    )

    evidence_rows = base.table_rows("证据表")
    snapshot_ids = [
        row["fields"].get("AUTO｜快照对象ID")
        for row in evidence_rows
        if row["fields"].get("AUTO｜快照对象ID")
    ]
    assert snapshot_ids
    assert all(
        isinstance(object_id, str) and object_id.startswith("evidence/US/")
        for object_id in snapshot_ids
    )
    assert all(
        "http" not in object_id and bucket not in object_id
        for object_id in snapshot_ids
    )
    for object_id in snapshot_ids:
        object_client.head_object(Bucket=bucket, Key=object_id)

    meta_checkpoint = (
        await db_transaction.execute(
            select(job_checkpoints.c.data).where(
                job_checkpoints.c.job_id == keyword_job.id,
                job_checkpoints.c.stage == "meta_collect",
            )
        )
    ).scalar_one()
    assert meta_checkpoint["screenshot_evidence_id"].startswith("evidence/US/")
    assert (
        await db_transaction.execute(
            select(runtime_jobs.c.status).where(runtime_jobs.c.id == keyword_job.id)
        )
    ).scalar_one() == "succeeded"

    def values(value: Any) -> list[str]:
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            return [item for entry in value for item in values(entry)]
        if isinstance(value, dict):
            return [item for entry in value.values() for item in values(entry)]
        return []

    status_fields = {
        table.name: table.field_map["status"].display_name
        for table in BaseSchema.default().tables
        if "status" in table.field_map
    }
    assert not any(
        pool in values(row["fields"].get(status_fields.get(row["table"], "")))
        for row in base.rows.values()
        for pool in FINAL_POOLS
    )
