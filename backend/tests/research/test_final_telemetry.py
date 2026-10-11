from collections import deque
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace

from test_meta_collector import FakeEvidenceStore, FakePageFactory, FakePageState, ad

from rabbit_hole.domain.legacy import JobKind, JobPayload
from rabbit_hole.integrations.collectors.meta import MetaQuery
from rabbit_hole.monitoring import Telemetry
from rabbit_hole.runtime.legacy import RuntimeMetaCollector


async def test_collector_recovery_and_captcha_reach_runtime_telemetry(
    db_transaction, job_repo, clock, monkeypatch
):
    state = FakePageState(
        {'"organizer"': [[ad("1")]]},
        read_errors=deque(["captcha", "page_crash", "page_crash"]),
    )

    async def close():
        pass

    async def launch(**kwargs):
        return SimpleNamespace(close=close)

    @asynccontextmanager
    async def browser():
        yield SimpleNamespace(chromium=SimpleNamespace(launch=launch))

    monkeypatch.setattr("rabbit_hole.runtime.legacy.async_playwright", browser)
    monkeypatch.setattr(
        "rabbit_hole.runtime.legacy.PlaywrightMetaPageFactory",
        lambda _: FakePageFactory(state),
    )
    await job_repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="source", input_version="1")
    )
    job = await job_repo.lease_next("test", lease_for=timedelta(minutes=5))
    telemetry = Telemetry(db_transaction, clock)
    result = await RuntimeMetaCollector(
        FakeEvidenceStore(), job_repo, telemetry
    ).collect(
        MetaQuery(query="organizer"),
        job_id=job.id,
        record_id="source",
        worker="test",
        lease_token=job.lease_token,
        manage_retries=False,
    )
    assert result.ok
    snapshot = await telemetry.snapshot()
    assert snapshot.recoveries == 3
    assert snapshot.captchas == 1
    assert not any(alert.code == "meta_success_rate" for alert in snapshot.alerts)
    # A later delayed invocation must not charge the same checkpoint event twice.
    await RuntimeMetaCollector(FakeEvidenceStore(), job_repo, telemetry).collect(
        MetaQuery(query="organizer"),
        job_id=job.id,
        record_id="source",
        worker="test",
        lease_token=job.lease_token,
        attempt=4,
        manage_retries=False,
    )
    later = await telemetry.snapshot()
    assert later.recoveries == 3
    assert later.captchas == 1
