"""Production pipeline/outbox counting at the external HTTP boundary."""

from datetime import timedelta

import httpx
import pytest
from e2e.test_phase1 import FixtureBase
from sqlalchemy import select
from test_pipeline import FakeMeta, FakeStorage, meta_success

from rabbit_hole.domain.legacy import JobKind, JobPayload
from rabbit_hole.integrations.feishu import FeishuClient, protected_input_hash
from rabbit_hole.monitoring import Telemetry, runtime_events
from rabbit_hole.persistence.database import feishu_outbox
from rabbit_hole.pipeline import FeishuMutation, Pipeline, RetryablePipelineError
from rabbit_hole.runtime.legacy import FeishuWorkflowAdapter


@pytest.mark.parametrize("interruption", [None, "lost_create", "after_candidate"])
async def test_pipeline_counts_new_candidate_once_after_durable_acknowledgement(
    db_transaction, job_repo, clock, interruption
):
    # Missing acknowledgement telemetry leaves this at zero; counting attempts
    # instead would count a lost response, outbox replay or checkpoint resume twice.
    base = FixtureBase()
    base.seed(
        "关键词库",
        "keyword-source",
        {"AUTO｜实际搜索词": "portable blender", "人工｜状态": ["待扫描"]},
    )
    pending_interruption = interruption

    def transport(request):
        nonlocal pending_interruption
        path = request.url.path
        creating_product = path.endswith(
            f"/tables/{base.table_ids['产品主表']}/records/batch_create"
        )
        creating_market = path.endswith(
            f"/tables/{base.table_ids['市场评估表']}/records/batch_create"
        )
        response = base(request)
        if pending_interruption == "after_candidate" and creating_market:
            pending_interruption = None
            raise httpx.ReadTimeout(
                "interrupted after candidate acknowledgement", request=request
            )
        if pending_interruption == "lost_create" and creating_product:
            pending_interruption = None
            raise httpx.ReadTimeout(
                "candidate created but response lost", request=request
            )
        return response

    telemetry = Telemetry(db_transaction)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
        client = FeishuClient(
            "fixture-app", "fixture-secret", "fixture-base", http_client=http
        )
        adapter = FeishuWorkflowAdapter(client, db_transaction, verify_delays=())
        source = await adapter.get_record("关键词库", "keyword-source")
        queued = await job_repo.enqueue(
            JobPayload(
                kind=JobKind.KEYWORD_SCAN,
                record_id=source.record_id,
                input_version=source.version,
                protected_input_hash=protected_input_hash(source.fields),
                data=dict(source.fields),
            )
        )
        job = await job_repo.lease_next(
            "candidate-test", lease_for=timedelta(minutes=5)
        )
        assert job is not None and job.id == queued.id

        def make_pipeline():
            return Pipeline(
                jobs=job_repo,
                feishu=adapter,
                meta_collector=FakeMeta(meta_success()),
                storage=FakeStorage(),
                clock=clock,
            )

        pipeline = make_pipeline()
        assert (await telemetry.snapshot()).daily_candidates == 0
        if interruption:
            with pytest.raises(RetryablePipelineError):
                await pipeline.run(job)
            assert len(base.table_rows("产品主表")) == 1
            expected = 0 if interruption == "lost_create" else 1
            assert (await telemetry.snapshot()).daily_candidates == expected
            assert await job_repo.get_checkpoint(job.id, "meta") is not None
            assert await job_repo.get_checkpoint(job.id, "writeback") is None
            # Maintenance reconciles a lost result without rerunning the pipeline.
            await adapter.reconcile_pending()
            assert (await telemetry.snapshot()).daily_candidates == 1
            adapter = FeishuWorkflowAdapter(client, db_transaction, verify_delays=())
            pipeline = make_pipeline()

        result = await pipeline.run(job)
        assert result.status == "已启用"
        assert (await telemetry.snapshot()).daily_candidates == 1
        outbox = (await db_transaction.execute(select(feishu_outbox))).mappings().all()
        product = next(
            row for row in outbox if row["payload"]["mutation"]["table"] == "产品主表"
        )
        assert product["status"] == "succeeded"
        request = FeishuMutation.model_validate(product["payload"]["mutation"])
        assert await adapter.apply(request) == product["record_id"]
        # A second job's create-if-absent must not count an existing candidate.
        assert (
            await adapter.apply(
                request.model_copy(update={"operation_key": "another-job:product:0"})
            )
            == product["record_id"]
        )
        await job_repo.complete(
            job.id, worker="candidate-test", lease_token=job.lease_token
        )
        assert (await pipeline.run(job)).model_dump() == result.model_dump()
        assert (await telemetry.snapshot()).daily_candidates == 1

    events = (
        (
            await db_transaction.execute(
                select(runtime_events).where(runtime_events.c.source == "candidate")
            )
        )
        .mappings()
        .all()
    )
    assert len(events) == 1 and events[0]["success"] and events[0]["count"] == 1
    assert len(base.table_rows("产品主表")) == 1
    assert base.table_rows("产品主表")[0]["fields"]["AUTO｜状态"] == ["待补充"]
    assert base.table_rows("市场评估表")[0]["fields"]["人工｜状态"] == ["待询价"]
