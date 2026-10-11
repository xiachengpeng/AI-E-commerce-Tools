import json
from datetime import timedelta

import httpx
import pytest
from e2e.test_phase1 import FixtureBase

from rabbit_hole.discovery import NicheCandidate, generate_niche_candidates
from rabbit_hole.integrations.feishu import FeishuClient, TriggerPoller
from rabbit_hole.pipeline import Pipeline, TerminalPipelineError
from rabbit_hole.runtime.legacy import FeishuWorkflowAdapter


class Generator:
    calls = 0

    async def generate(self, *, schema, untrusted_data, **kwargs):
        self.calls += 1
        data = json.loads(untrusted_data)
        if schema is NicheCandidate:
            return schema(name="pet travel", ai_rationale="research", **data)
        return schema(query=f"{data['kind']} product term {data['index']}")


async def test_selected_taxonomy_drives_niche_candidates():
    niches = await generate_niche_candidates(Generator(), count=2, category_key="pet")
    assert {niche.category_key for niche in niches} == {"pet"}
    assert all(niche.status == "待研究" and not niche.enabled for niche in niches)
    assert all(
        "representative_keywords" in niche.to_feishu_fields()["AUTO｜研究证据卡"]
        for niche in niches
    )


@pytest.mark.parametrize("generated_without_collection", [False, True])
async def test_approved_niche_generates_review_only_keywords_once(
    db_transaction, job_repo, clock, generated_without_collection
):
    base = FixtureBase()
    card = {
        "generic_term": "pet travel",
        "target_audience": "dog owners",
        "core_problem": "travel cleanup",
        "filming_scenarios": ["car", "park"],
        "potential_price_band": "50-100",
        "logistics_warnings": [],
        "compliance_warnings": [],
        "trends": {"conclusion": "stable-high", "source": "human-evidence-1"},
        "meta": {
            "representative_keywords": [
                "dog travel",
                "dog bowl",
                "pet cleanup",
                "dog seat",
                "pet bag",
            ],
            "source": "human-evidence-2",
            "advertisers": 3,
            "creatives": 5,
        },
        "supply_chain": "unknown",
    }
    base.seed(
        "细分领域池",
        "source",
        {
            "人工｜状态": ["已启用"],
            "AUTO｜细分领域": "pet travel",
            "人工｜生成种子词": True,
            "人工｜研究证据已确认": True,
            "人工｜研究证据卡": json.dumps(card),
            **(
                {"AUTO｜领域唯一键": "US|pet|pet travel"}
                if generated_without_collection
                else {}
            ),
        },
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("a", "s", "b", http_client=http)
        poller = TriggerPoller(client, job_repo)
        assert await poller.poll_once() == 1
        job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        adapter = FeishuWorkflowAdapter(client, db_transaction, verify_delays=())
        generator = Generator()
        service = Pipeline(
            jobs=job_repo, feishu=adapter, discovery_generator=generator, clock=clock
        )
        if generated_without_collection:
            with pytest.raises(TerminalPipelineError, match="System research"):
                await service.run(job)
            assert not base.table_rows("关键词库")
            return
        result = await service.run(job)
        assert result.status == "已启用"
        assert await poller.poll_once() == 0
        await Pipeline(
            jobs=job_repo, feishu=adapter, discovery_generator=generator, clock=clock
        ).run(job)
    keywords = base.table_rows("关键词库")
    assert len(keywords) == 60
    assert all(item["fields"]["人工｜状态"] == ["待审核"] for item in keywords)
    assert generator.calls == 60


async def test_generated_niche_research_is_automatically_consumed(
    db_transaction, job_repo, clock
):
    from test_meta_collector import (
        FakeEvidenceStore,
        FakePageFactory,
        FakePageState,
        ad,
    )
    from test_pipeline import FakeStorage

    from rabbit_hole.integrations.collectors.google import GoogleTrendsCollector
    from rabbit_hole.integrations.collectors.meta import MetaCollector
    from rabbit_hole.trends import TrendSeries

    base = FixtureBase()
    base.seed(
        "细分领域池", "source", {"人工｜状态": ["待生成"], "人工｜选择大类": "pet"}
    )
    queries = ["dog care", "cat care", "pet grooming", "pet enrichment", "pet travel"]
    pages = FakePageState(
        {f'"{query}"': [[ad(f"{index}")]] for index, query in enumerate(queries)}
    )
    meta = MetaCollector(
        FakePageFactory(pages),
        evidence_store=FakeEvidenceStore(),
        job_repository=job_repo,
        clock=clock,
    )

    class Trends:
        async def fetch_weekly_series(self, query, geo, window):
            return TrendSeries(
                query=query,
                geo=geo,
                window=window,
                values=[20] * (260 if window == "5y" else 52),
            )

    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("a", "s", "b", http_client=http)
        adapter = FeishuWorkflowAdapter(client, db_transaction, verify_delays=())
        poller = TriggerPoller(client, job_repo)
        service = Pipeline(
            jobs=job_repo,
            feishu=adapter,
            discovery_generator=Generator(),
            clock=clock,
            niche_count=1,
            meta_collector=meta,
            trends_collector=GoogleTrendsCollector(Trends(), clock),
            storage=FakeStorage(),
        )
        assert await poller.poll_once() == 1
        generated_job = await job_repo.lease_next(
            "test", lease_for=timedelta(minutes=5)
        )
        await service.run(generated_job)
        await job_repo.complete(
            generated_job.id, worker="test", lease_token=generated_job.lease_token
        )
        assert await poller.poll_once() == 1
        research_job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        result = await service.run(research_job)
        assert result.status == "待人工选择"
        await service.run(research_job)
        assert await poller.poll_once() == 0
    candidate = next(
        row["fields"] for row in base.table_rows("细分领域池") if row["id"] != "source"
    )
    card = json.loads(candidate["AUTO｜研究证据卡"])
    assert candidate["人工｜状态"] == ["待人工选择"]
    assert card["trends"]["conclusion"] == "stable-high"
    assert len(card["meta"]["observations"]) == 5
    assert {item["query"] for item in card["meta"]["observations"]} == set(queries)
    assert all(
        item["status"] == "complete" and item["source"]
        for item in card["meta"]["observations"]
    )
    assert card["priority_reasons"]
    assert card["supply_chain"] == "unknown"
    assert not base.table_rows("关键词库")
    assert card["meta"]["observed_ad_ids"] == ["0", "1", "2", "3", "4"]
    # A confirmed system-produced card must suffice; do not require copying it
    # into an unrelated human JSON cell or bypass the approval gate.
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("a", "s", "b", http_client=http)
        candidate_row = next(
            row for row in base.table_rows("细分领域池") if row["id"] != "source"
        )
        base.seed(
            "细分领域池",
            candidate_row["id"],
            {**candidate, "人工｜状态": ["已启用"], "人工｜生成种子词": True},
        )
        poller = TriggerPoller(client, job_repo)
        assert await poller.poll_once() == 0
        base.seed(
            "细分领域池",
            candidate_row["id"],
            {
                **candidate,
                "人工｜状态": ["已启用"],
                "人工｜生成种子词": True,
                "人工｜研究证据已确认": True,
            },
        )
        assert await poller.poll_once() == 1
        seed_job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
        service = Pipeline(
            jobs=job_repo,
            feishu=FeishuWorkflowAdapter(client, db_transaction, verify_delays=()),
            discovery_generator=Generator(),
            clock=clock,
        )
        assert (await service.run(seed_job)).status == "已启用"
        await service.run(seed_job)
        assert await poller.poll_once() == 0
    keywords = base.table_rows("关键词库")
    assert len(keywords) == 60
    assert all(row["fields"]["人工｜状态"] == ["待审核"] for row in keywords)


async def test_research_worker_resumes_without_readmitting_or_sharing_retry_budget(
    db_transaction, job_repo, clock
):
    from collections import deque

    from sqlalchemy import select
    from test_meta_collector import FakeEvidenceStore, FakeMetaPage, FakePageState, ad
    from test_pipeline import FakeStorage

    from rabbit_hole.integrations.collectors.meta import (
        MetaCollector,
        MetaPageHealthError,
    )
    from rabbit_hole.persistence.database import daily_usage
    from rabbit_hole.worker import Worker

    queries = ["dog care", "cat care", "pet grooming", "pet enrichment", "pet travel"]
    state = FakePageState(
        {f'"{query}"': [[ad(str(index))]] for index, query in enumerate(queries)}
    )
    errors = {
        '"dog care"': deque(["page_crash"] * 4),
        '"cat care"': deque(["page_crash"]),
    }

    class Page(FakeMetaPage):
        async def read_batch(self, *, query):
            if errors.get(query):
                raise MetaPageHealthError(errors[query].popleft())
            return await super().read_batch(query=query)

    class Pages:
        async def create(self):
            return Page(state)

        async def new_context(self):
            return Page(state)

    base = FixtureBase()
    base.seed(
        "细分领域池",
        "source",
        {
            "人工｜状态": ["待研究"],
            "AUTO｜细分领域": "pet travel",
            "AUTO｜研究证据卡": json.dumps(
                {"generic_term": "pet travel", "representative_keywords": queries}
            ),
        },
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("a", "s", "b", http_client=http)
        poller = TriggerPoller(client, job_repo)
        pipeline = Pipeline(
            jobs=job_repo,
            feishu=FeishuWorkflowAdapter(client, db_transaction, verify_delays=()),
            meta_collector=MetaCollector(
                Pages(),
                evidence_store=FakeEvidenceStore(),
                job_repository=job_repo,
                clock=clock,
            ),
            storage=FakeStorage(),
            clock=clock,
        )
        worker = Worker(
            jobs=job_repo,
            pipeline=pipeline,
            poller=poller,
            worker_id="test",
            browser_concurrency=1,
            poll_seconds=60,
        )
        assert await worker.poll_once() == 1
        first = await worker.run_once()
        assert first.outcome == "retry"
        pending = json.loads(base.rows["source"]["fields"]["AUTO｜研究证据卡"])
        assert pending["meta"]["advertisers"] is None
        assert [item["status"] for item in pending["meta"]["observations"]] == [
            "failed",
            "pending",
            "pending",
            "pending",
            "pending",
        ]
        assert await worker.poll_once() == 0
        clock.advance(timedelta(minutes=16))
        # Missing Trends remains a visible human task even when all Meta queries succeed.
        assert (await worker.run_once()).outcome == "needs_human"
    card = json.loads(base.rows["source"]["fields"]["AUTO｜研究证据卡"])
    assert base.rows["source"]["fields"]["人工｜状态"] == ["待人工选择"]
    assert card["trends"]["conclusion"] == "unknown"
    assert card["meta"]["observed_ad_ids"] == ["0", "1", "2", "3", "4"]
    assert all(item["status"] == "complete" for item in card["meta"]["observations"])
    usage = (await db_transaction.execute(select(daily_usage))).mappings().one()
    assert usage["scans"] == 5
    assert float(usage["estimated_cost_usd"]) == 0.05
