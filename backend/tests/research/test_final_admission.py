from datetime import timedelta

import pytest
from sqlalchemy import select

from rabbit_hole.domain.legacy import JobKind, JobPayload
from rabbit_hole.persistence.legacy_jobs import JobRepository


async def test_niche_research_reserves_every_observation_and_estimated_cost(
    db_transaction, job_repo
):
    import json

    from rabbit_hole.persistence.database import daily_usage

    card = {
        "representative_keywords": [
            "dog care",
            "cat care",
            "pet grooming",
            "pet enrichment",
            "pet travel",
        ]
    }
    admitted = await job_repo.enqueue(
        JobPayload(
            kind=JobKind.NICHE_RESEARCH,
            record_id="niche",
            input_version="1",
            data={"AUTO｜研究证据卡": json.dumps(card)},
        )
    )
    row = (await db_transaction.execute(select(daily_usage))).mappings().one()
    assert row["scans"] == 5
    assert row["estimated_ai_calls"] == 0
    assert float(row["estimated_cost_usd"]) == 0.05
    assert admitted.payload.estimated_cost_usd == 0.05


@pytest.mark.parametrize(
    "limits",
    [
        {"daily_scans": 1},
        {"daily_keywords": 1},
        {"daily_candidates": 1},
        {"daily_cost_usd": 0.01},
        {"daily_ai_calls": 1},
    ],
)
async def test_daily_admission_is_durable_and_admitted_work_finishes(
    db_transaction, clock, limits
):
    from rabbit_hole.config import AdmissionLimits
    from rabbit_hole.persistence.database import daily_usage
    from rabbit_hole.persistence.legacy_jobs import AdmissionLimitReached

    quota = AdmissionLimits(**limits)
    repo = JobRepository(db_transaction, clock, admission=quota)
    kind = (
        JobKind.LINK_VALIDATION
        if "daily_candidates" in limits
        else JobKind.KEYWORD_SCAN
    )
    first = JobPayload(kind=kind, record_id="one", input_version="1")
    admitted = await repo.enqueue(first)
    assert admitted.payload.estimated_cost_usd == 0.01
    restarted = JobRepository(db_transaction, clock, admission=quota)
    assert (await restarted.enqueue(first)).id == admitted.id
    with pytest.raises(AdmissionLimitReached):
        await restarted.enqueue(
            JobPayload(kind=kind, record_id="two", input_version="1")
        )
    job = await restarted.lease_next("test", lease_for=timedelta(minutes=5))
    await restarted.complete(job.id, worker="test", lease_token=job.lease_token)
    usage = (await db_transaction.execute(select(daily_usage))).mappings().one()
    assert float(usage["estimated_cost_usd"]) == 0.01
    assert usage["estimated_ai_calls"] == 1
    clock.advance(timedelta(days=1))
    assert await restarted.enqueue(
        JobPayload(kind=kind, record_id="two", input_version="1")
    )


async def test_discovered_candidate_cap_blocks_only_new_admission(
    db_transaction, clock
):
    from rabbit_hole.config import AdmissionLimits
    from rabbit_hole.monitoring import Telemetry
    from rabbit_hole.persistence.legacy_jobs import AdmissionLimitReached

    await Telemetry(db_transaction, clock).record(
        "candidate:one", source="candidate", success=True
    )
    repo = JobRepository(
        db_transaction, clock, admission=AdmissionLimits(daily_candidates=1)
    )
    with pytest.raises(AdmissionLimitReached):
        await repo.enqueue(
            JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="new", input_version="1")
        )


async def test_direct_admission_sanitizes_all_link_aliases(job_repo):
    from rabbit_hole.input_urls import LINK_ALIASES

    data = {
        alias: "https://shop.example/p?token=secret&size=m"
        for alias in LINK_ALIASES | {"AUTO｜落地页链接"}
    }
    job = await job_repo.enqueue(
        JobPayload(
            kind=JobKind.LINK_VALIDATION,
            record_id="source",
            input_version="1",
            data=data,
        )
    )
    assert set(job.payload.data.values()) == {"https://shop.example/p?size=m"}


async def test_poller_continues_other_work_when_scan_quota_exhausted(
    db_transaction, clock
):
    from rabbit_hole.config import AdmissionLimits
    from rabbit_hole.integrations.feishu import TriggerPoller, TriggerRecord
    from rabbit_hole.persistence.database import runtime_jobs

    repo = JobRepository(
        db_transaction, clock, admission=AdmissionLimits(daily_scans=1)
    )
    await repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="old", input_version="1")
    )

    class Source:
        async def list_trigger_records(self):
            return [
                TriggerRecord("关键词库", "refused", "待扫描", "1", {}),
                TriggerRecord("细分领域池", "niche", "待生成", "1", {}),
            ]

    assert await TriggerPoller(Source(), repo).poll_once() == 1
    records = (
        (await db_transaction.execute(select(runtime_jobs.c.payload))).scalars().all()
    )
    assert {row["record_id"] for row in records} == {"old", "niche"}


async def test_concurrent_admission_charges_once_and_refuses_competitor(
    db_engine, clock
):
    import asyncio
    from uuid import uuid4

    from sqlalchemy import delete

    from rabbit_hole.config import AdmissionLimits
    from rabbit_hole.persistence.database import daily_usage, runtime_jobs
    from rabbit_hole.persistence.legacy_jobs import AdmissionLimitReached

    prefix = uuid4().hex
    repo = JobRepository(db_engine, clock, admission=AdmissionLimits(daily_scans=1))
    payloads = [
        JobPayload(
            kind=JobKind.KEYWORD_SCAN, record_id=f"{prefix}-{index}", input_version="1"
        )
        for index in range(2)
    ]
    results = await asyncio.gather(
        *(repo.enqueue(item) for item in payloads), return_exceptions=True
    )
    try:
        assert sum(isinstance(result, AdmissionLimitReached) for result in results) == 1
        async with db_engine.connect() as connection:
            row = (await connection.execute(select(daily_usage))).mappings().one()
        assert row["scans"] == 1
        assert float(row["estimated_cost_usd"]) == 0.01
    finally:
        async with db_engine.begin() as connection:
            for result in results:
                if not isinstance(result, BaseException):
                    await connection.execute(
                        delete(runtime_jobs).where(runtime_jobs.c.id == result.id)
                    )
