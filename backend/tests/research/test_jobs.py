from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

from rabbit_hole.domain.legacy import JobKind, JobPayload, JobStatus
from rabbit_hole.persistence.database import runtime_jobs
from rabbit_hole.persistence.legacy_jobs import ActiveLeaseError, StaleLeaseError


def test_explicit_postgres_url_is_preferred(monkeypatch):
    """Removing the explicit URL branch would force a local run through Docker."""
    from conftest import postgres_connection_url

    explicit_url = "postgresql+psycopg://xiachengpeng@127.0.0.1:55432/rabbit_hole_test"
    monkeypatch.setenv("RABBIT_HOLE_TEST_POSTGRES_URL", explicit_url)

    assert postgres_connection_url() == explicit_url


async def test_enqueue_is_idempotent(job_repo):
    """Changing duplicate handling would create two jobs for one input version."""
    payload = JobPayload(
        kind=JobKind.KEYWORD_SCAN, record_id="rec_1", input_version="v1"
    )

    first = await job_repo.enqueue(payload)
    second = await job_repo.enqueue(payload)

    assert first.id == second.id


async def test_enqueue_receipt_distinguishes_new_and_existing(job_repo):
    """Poll admission must distinguish a new row from an idempotent replay."""
    from rabbit_hole.persistence.legacy_jobs import EnqueueReceipt

    payload = JobPayload(
        kind=JobKind.NICHE_RESEARCH, record_id="receipt", input_version="v1"
    )

    first = await job_repo.enqueue_with_receipt(payload)
    second = await job_repo.enqueue_with_receipt(payload)

    assert isinstance(first, EnqueueReceipt)
    assert first.created is True
    assert second.created is False
    assert first.job.id == second.job.id


async def test_enqueue_receipt_uses_protected_snapshot_across_auto_revisions(
    job_repo,
):
    """Automation writes must resume the same job without masking human input."""
    original = JobPayload(
        kind=JobKind.NICHE_RESEARCH,
        record_id="source",
        input_version="base-revision-one",
        protected_input_hash="a" * 64,
        data={"AUTO｜研究证据卡": "before"},
    )
    auto_updated = original.model_copy(
        update={
            "input_version": "base-revision-two",
            "data": {"AUTO｜研究证据卡": "after"},
        }
    )

    first = await job_repo.enqueue_with_receipt(original)
    second = await job_repo.enqueue_with_receipt(auto_updated)

    assert first.created is True
    assert second.created is False
    assert first.job.id == second.job.id


async def test_retry_uses_approved_schedule(job_repo, clock):
    """Changing Meta's fourth failure delay would violate its recovery policy."""
    job = await job_repo.enqueue(
        JobPayload(kind=JobKind.META_SCAN, record_id="rec_2", input_version="v1")
    )

    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))

    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="white_screen",
        attempt=4,
        worker="worker",
        lease_token=lease.lease_token,
    )
    stored = await job_repo.get(job.id)

    assert stored.status is JobStatus.DELAYED
    assert stored.available_at == clock.now() + timedelta(minutes=15)


async def test_locked_first_job_is_skipped_by_second_leaser(db_engine, clock):
    """PostgreSQL-specific row skipping; SQLite commits serialized claims instead."""
    if db_engine.dialect.name != "postgresql":
        pytest.skip("SQLite has one writer; independent concurrent claims tested separately")
    from rabbit_hole.persistence.legacy_jobs import JobRepository

    seed_repo = JobRepository(db_engine, clock)
    first_job = await seed_repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="rec_3", input_version="v1")
    )
    second_job = await seed_repo.enqueue(
        JobPayload(kind=JobKind.LINK_VALIDATION, record_id="rec_4", input_version="v1")
    )

    try:
        async with (
            db_engine.connect() as first_connection,
            db_engine.connect() as second_connection,
        ):
            first_transaction = await first_connection.begin()
            second_transaction = await second_connection.begin()
            try:
                first_repo = JobRepository(first_connection, clock)
                second_repo = JobRepository(second_connection, clock)
                first = await first_repo.lease_next(
                    "worker-a", lease_for=timedelta(minutes=5)
                )
                assert first is not None
                second = await asyncio.wait_for(
                    second_repo.lease_next("worker-b", lease_for=timedelta(minutes=5)),
                    timeout=1,
                )
            finally:
                await second_transaction.rollback()
                await first_transaction.rollback()
    finally:
        async with db_engine.begin() as cleanup:
            await cleanup.execute(
                runtime_jobs.delete().where(
                    runtime_jobs.c.id.in_([first_job.id, second_job.id])
                )
            )

    assert second is not None
    assert {first.id, second.id} == {first_job.id, second_job.id}
    assert first.lease_until == clock.now() + timedelta(minutes=5)


async def test_expired_lease_is_reclaimed(job_repo, clock):
    """Removing expiration recovery would strand work after a worker crash."""
    job = await job_repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="rec_5", input_version="v1")
    )
    leased = await job_repo.lease_next("dead-worker", lease_for=timedelta(minutes=1))

    assert leased is not None
    clock.advance(timedelta(minutes=2))
    reclaimed = await job_repo.lease_next("new-worker", lease_for=timedelta(minutes=1))

    assert reclaimed is not None
    assert reclaimed.id == job.id
    assert reclaimed.leased_by == "new-worker"


async def test_checkpoint_is_upserted_by_job_and_stage(job_repo):
    """Dropping checkpoint upsert would lose recovery progress for a stage."""
    job = await job_repo.enqueue(
        JobPayload(kind=JobKind.META_SCAN, record_id="rec_6", input_version="v1")
    )

    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))

    assert lease is not None
    await job_repo.checkpoint(
        job.id,
        "collect",
        {"cursor": "first"},
        worker="worker",
        lease_token=lease.lease_token,
    )
    await job_repo.checkpoint(
        job.id,
        "collect",
        {"cursor": "second"},
        worker="worker",
        lease_token=lease.lease_token,
    )

    assert await job_repo.get_checkpoint(job.id, "collect") == {"cursor": "second"}


async def test_non_meta_retry_escalates_after_three_delays(job_repo, clock):
    """Changing the non-Meta terminal branch would hide repeated transient failures."""
    job = await job_repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="rec_7", input_version="v1")
    )

    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="http_503",
        attempt=1,
        worker="worker",
        lease_token=lease.lease_token,
    )
    assert (await job_repo.get(job.id)).available_at == clock.now() + timedelta(
        minutes=1
    )
    clock.advance(timedelta(minutes=1))
    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="http_503",
        attempt=2,
        worker="worker",
        lease_token=lease.lease_token,
    )
    assert (await job_repo.get(job.id)).available_at == clock.now() + timedelta(
        minutes=5
    )
    clock.advance(timedelta(minutes=5))
    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="http_503",
        attempt=3,
        worker="worker",
        lease_token=lease.lease_token,
    )
    assert (await job_repo.get(job.id)).available_at == clock.now() + timedelta(
        minutes=15
    )
    clock.advance(timedelta(minutes=15))
    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="http_503",
        attempt=4,
        worker="worker",
        lease_token=lease.lease_token,
    )

    assert (await job_repo.get(job.id)).status is JobStatus.NEEDS_HUMAN


async def test_meta_retry_escalates_after_fifth_attempt(job_repo, clock):
    """Changing Meta's terminal branch would retry beyond its approved limit."""
    job = await job_repo.enqueue(
        JobPayload(kind=JobKind.META_SCAN, record_id="rec_8", input_version="v1")
    )

    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="white_screen",
        attempt=3,
        worker="worker",
        lease_token=lease.lease_token,
    )
    assert (await job_repo.get(job.id)).status is JobStatus.DELAYED
    assert (await job_repo.get(job.id)).available_at == clock.now() + timedelta(
        minutes=15
    )
    clock.advance(timedelta(minutes=15))
    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="white_screen",
        attempt=5,
        worker="worker",
        lease_token=lease.lease_token,
    )

    assert (await job_repo.get(job.id)).status is JobStatus.DELAYED
    clock.advance(timedelta(minutes=15))
    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None
    await job_repo.retry(
        job.id,
        failure="white_screen",
        attempt=6,
        worker="worker",
        lease_token=lease.lease_token,
    )

    assert (await job_repo.get(job.id)).status is JobStatus.NEEDS_HUMAN


async def test_expired_worker_cannot_write_reclaimed_job(job_repo, clock):
    """Dropping lease fencing lets a crashed worker overwrite the replacement worker."""
    job = await job_repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="rec_9", input_version="v1")
    )
    first_lease = await job_repo.lease_next("worker-a", lease_for=timedelta(minutes=1))

    assert first_lease is not None
    clock.advance(timedelta(minutes=2))
    second_lease = await job_repo.lease_next("worker-b", lease_for=timedelta(minutes=5))

    assert second_lease is not None
    with pytest.raises(StaleLeaseError):
        await job_repo.complete(
            job.id, worker="worker-a", lease_token=first_lease.lease_token
        )
    with pytest.raises(StaleLeaseError):
        await job_repo.retry(
            job.id,
            failure="old_worker",
            attempt=1,
            worker="worker-a",
            lease_token=first_lease.lease_token,
        )
    with pytest.raises(StaleLeaseError):
        await job_repo.checkpoint(
            job.id,
            "collect",
            {"stale": True},
            worker="worker-a",
            lease_token=first_lease.lease_token,
        )

    completed = await job_repo.complete(
        job.id, worker="worker-b", lease_token=second_lease.lease_token
    )

    assert completed.status is JobStatus.SUCCEEDED


async def test_renew_extends_only_the_current_lease(job_repo, clock):
    job = await job_repo.enqueue(
        JobPayload(
            kind=JobKind.LINK_VALIDATION, record_id="rec_renew", input_version="v1"
        )
    )
    lease = await job_repo.lease_next("worker-a", lease_for=timedelta(minutes=1))
    assert lease is not None

    clock.advance(timedelta(seconds=30))
    renewed = await job_repo.renew(
        job.id,
        worker="worker-a",
        lease_token=lease.lease_token,
        lease_for=timedelta(minutes=5),
    )

    assert renewed.lease_token == lease.lease_token
    assert renewed.lease_until == clock.now() + timedelta(minutes=5)
    with pytest.raises(StaleLeaseError):
        await job_repo.renew(
            job.id,
            worker="other-worker",
            lease_token=lease.lease_token,
            lease_for=timedelta(minutes=5),
        )


async def test_terminal_failure_is_typed_and_releases_lease(job_repo):
    job = await job_repo.enqueue(
        JobPayload(
            kind=JobKind.LINK_VALIDATION, record_id="rec_terminal", input_version="v1"
        )
    )
    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None

    failed = await job_repo.needs_human(
        job.id,
        failure="unsupported_market",
        detail="Phase 1 executes only US",
        worker="worker",
        lease_token=lease.lease_token,
    )

    assert failed.status is JobStatus.NEEDS_HUMAN
    assert failed.failure_code == "unsupported_market"
    assert failed.failure_detail == "Phase 1 executes only US"
    assert failed.leased_by is None
    assert failed.lease_token is None


async def test_requeue_is_explicit_and_fails_closed_for_active_lease(job_repo):
    job = await job_repo.enqueue(
        JobPayload(
            kind=JobKind.KEYWORD_SCAN, record_id="rec_requeue", input_version="v1"
        )
    )
    lease = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert lease is not None

    with pytest.raises(ActiveLeaseError):
        await job_repo.requeue(job.id)

    failed = await job_repo.needs_human(
        job.id,
        failure="operator_review",
        detail="review required",
        worker="worker",
        lease_token=lease.lease_token,
    )
    assert failed.status is JobStatus.NEEDS_HUMAN

    requeued = await job_repo.requeue(job.id)

    assert requeued.status is JobStatus.READY
    assert requeued.attempt == 0
    assert requeued.failure_code is None
    assert requeued.failure_detail is None
