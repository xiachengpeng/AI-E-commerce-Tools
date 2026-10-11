from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import insert, select

from rabbit_hole.domain.legacy import JobKind, JobPayload

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_liveness_is_independent_and_readiness_fails_closed_without_details():
    from rabbit_hole.runtime.server import create_app

    async def healthy():
        return True

    async def failed():
        raise RuntimeError("secret-token https://admin:password@example.com")

    client = TestClient(
        create_app(checks={"database": healthy, "storage": failed, "feishu": failed})
    )
    assert client.get("/health").json() == {"status": "ok"}
    response = client.get("/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "failed": ["storage"]}
    assert "secret" not in response.text
    integrations = client.get("/integrations")
    assert integrations.status_code == 200
    assert integrations.json()["integrations"]["feishu"]["status"] == "degraded"
    assert "secret" not in integrations.text


def test_migration_database_url_prefers_runtime_environment(monkeypatch):
    """Deployments must migrate the same database selected by service settings."""

    from rabbit_hole.migrations import migration_database_url

    monkeypatch.setenv(
        "RABBIT_HOLE_DATABASE_URL",
        "postgresql+psycopg://runtime:secret@db:5432/rabbit_runtime",
    )

    assert migration_database_url("postgresql+psycopg://ini:wrong@db:5432/ini") == (
        "postgresql+psycopg://runtime:secret@db:5432/rabbit_runtime"
    )


async def test_readiness_times_out_and_retains_deterministic_dependency_order():
    from rabbit_hole.runtime.server import create_app

    async def hangs():
        await asyncio.sleep(1)
        return True

    app = create_app(
        checks={"database": hangs, "storage": hangs, "feishu": hangs},
        readiness_timeout=0.01,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test"
    ) as client:
        response = await client.get("/ready")
    assert response.status_code == 503
    assert response.json()["failed"] == ["database", "storage"]


def test_default_integration_status_uses_public_feishu_token_probe(monkeypatch):
    """Optional integration status must not bind itself to Feishu internals."""
    from rabbit_hole.runtime import server as api

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def execute(self, statement):
            return None

    class Engine:
        dialect = SimpleNamespace(name="postgresql")
        def connect(self):
            return Connection()

        async def dispose(self):
            return None

    class S3:
        def close(self):
            return None

    class Feishu:
        probed = False
        base_token = "isolated-readiness-test"

        def __init__(self, *args):
            return None

        async def probe_token(self):
            type(self).probed = True
            return True

        async def aclose(self):
            return None

    monkeypatch.setattr(
        api,
        "get_settings",
        lambda: SimpleNamespace(
            feishu_app_id="app",
            feishu_app_secret="secret",
            feishu_base_app_token="base",
            s3_endpoint="http://storage.test",
            s3_access_key="access",
            s3_secret_key="secret",
            s3_bucket="private-evidence",
            openai_api_key=None,
            openai_model=None,
        ),
    )
    monkeypatch.setattr(api, "create_database_engine", lambda settings: Engine())
    monkeypatch.setattr(api, "FeishuClient", Feishu)
    monkeypatch.setattr(api, "create_storage_client", lambda settings: S3())
    monkeypatch.setattr(api, "storage_is_private", lambda *args: True)

    with TestClient(api.create_app()) as client:
        assert client.get("/ready").status_code == 200
        assert Feishu.probed is False
        integrations = client.get("/integrations")
        assert integrations.status_code == 200
        assert integrations.json()["integrations"]["feishu"]["status"] == "healthy"
    assert Feishu.probed


def test_unconfigured_optional_integrations_are_explicit():
    from rabbit_hole.runtime.server import create_app

    async def healthy():
        return True

    client = TestClient(
        create_app(checks={"database": healthy, "storage": healthy})
    )

    assert client.get("/ready").status_code == 200
    integrations = client.get("/integrations").json()["integrations"]
    assert integrations["meta"]["status"] == "healthy"
    assert integrations["trends"]["status"] == "healthy"
    assert integrations["ai"]["status"] == "unconfigured"
    assert integrations["feishu"]["status"] == "unconfigured"


async def test_persistent_metrics_are_idempotent_bounded_and_visible_across_processes(
    db_transaction,
    clock,
    job_repo,
):
    from rabbit_hole.monitoring import Telemetry
    from rabbit_hole.runtime.server import create_app

    telemetry = Telemetry(db_transaction, clock)
    await job_repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="rec-secret", input_version="1")
    )
    await telemetry.record(
        "event-1",
        source="meta",
        success=False,
        recoveries=3,
        captcha=True,
        duration_seconds=12,
    )
    await telemetry.record("event-1", source="meta", success=False, recoveries=3)
    await telemetry.record("job-1", source="job", success=True, duration_seconds=20)
    await telemetry.record("candidate-1", source="candidate", success=True)
    await telemetry.record("ai-1", source="ai", success=False, schema_failure=True)
    with pytest.raises(ValueError):
        await telemetry.record("bad", source="https://secret.example", success=True)
    with pytest.raises(ValueError):
        await telemetry.record(
            "negative", source="meta", success=True, duration_seconds=float("nan")
        )
    app = create_app(telemetry=Telemetry(db_transaction, clock))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test"
    ) as client:
        response = await client.get("/metrics")
    assert response.status_code == 200
    for sample in (
        'job_queue_depth{status="ready"} 1.0',
        'collector_failure_total{source="meta"} 1.0',
        "meta_recovery_total 3.0",
        "meta_captcha_total 1.0",
        "job_duration_seconds_sum 20.0",
        "daily_candidates 1.0",
        "ai_schema_failure_total 1.0",
        "feishu_outbox_depth 0.0",
    ):
        assert sample in response.text
    assert "rec-secret" not in response.text and "event-1" not in response.text


async def test_alerts_fire_at_thresholds_once_and_survive_retry(
    db_transaction, clock, job_repo
):
    from rabbit_hole.monitoring import Monitor, Telemetry, runtime_alerts
    from rabbit_hole.persistence.database import feishu_outbox

    telemetry = Telemetry(db_transaction, clock)
    await job_repo.enqueue(
        JobPayload(kind=JobKind.KEYWORD_SCAN, record_id="waiting", input_version="1")
    )
    await db_transaction.execute(
        insert(feishu_outbox).values(
            id=uuid4(),
            record_id="rec",
            record_version="1",
            payload={},
            status="ready",
            attempt=0,
            available_at=clock.now(),
            created_at=clock.now(),
            updated_at=clock.now(),
        )
    )
    for index in range(5):
        await telemetry.record(str(index), source="meta", success=False)

    class Sink:
        fail = True

        def __init__(self):
            self.alerts = {}

        async def emit_alert(
            self, key, code, message, created_at, last_seen, occurrence_count
        ):
            if self.fail:
                raise ConnectionError("private secret")
            self.alerts[key] = (code, created_at, last_seen, occurrence_count)

    sink = Sink()
    monitor = Monitor(telemetry, sink)
    await monitor.tick()
    assert sink.alerts == {}
    assert len((await db_transaction.execute(select(runtime_alerts))).all()) == 2
    sink.fail = False
    clock.advance(timedelta(hours=2))
    await monitor.tick()
    await monitor.tick()
    assert sorted(value[0] for value in sink.alerts.values()) == [
        "collector_failures",
        "meta_success_rate",
        "outbox_wait",
        "queue_wait",
    ]
    assert len(sink.alerts) == 4
    assert all(
        row.sent_count == row.occurrence_count
        for row in (await db_transaction.execute(select(runtime_alerts))).all()
    )


async def test_alert_occurrence_count_changes_only_for_new_event_fingerprint(
    db_transaction, clock
):
    from rabbit_hole.monitoring import Alert, Monitor, Telemetry, runtime_alerts

    telemetry = Telemetry(db_transaction, clock)

    class Sink:
        def __init__(self):
            self.calls = []

        async def emit_alert(
            self, key, code, message, created_at, last_seen, occurrence_count
        ):
            self.calls.append(
                (key, code, message, created_at, last_seen, occurrence_count)
            )

    class SnapshotTelemetry(Telemetry):
        def __init__(self, database, clock):
            super().__init__(database, clock)
            self.current = Alert("stable-incident", "queue_wait", "waiting", "event-1")

        async def snapshot(self):
            snapshot = await super().snapshot()
            snapshot.alerts = [self.current]
            return snapshot

    telemetry = SnapshotTelemetry(db_transaction, clock)
    sink = Sink()
    monitor = Monitor(telemetry, sink)
    await monitor.tick()
    await monitor.tick()
    row = (await db_transaction.execute(select(runtime_alerts))).one()
    assert row.occurrence_count == 1
    assert row.sent_count == 1
    assert len(sink.calls) == 1

    clock.advance(timedelta(minutes=1))
    telemetry.current = Alert("stable-incident", "queue_wait", "waiting", "event-2")
    await monitor.tick()
    row = (await db_transaction.execute(select(runtime_alerts))).one()
    assert row.occurrence_count == 2
    assert row.sent_count == 2
    assert len(sink.calls) == 2
    assert sink.calls[-1][-1] == 2
    assert sink.calls[-1][3] == sink.calls[0][3]
    assert sink.calls[-1][4] == clock.now()


async def test_success_resets_consecutive_failure_alert_and_no_sample_is_not_failure(
    db_transaction,
    clock,
):
    from rabbit_hole.monitoring import Monitor, Telemetry

    telemetry = Telemetry(db_transaction, clock)

    class Sink:
        def __init__(self):
            self.codes = []

        async def emit_alert(self, key, code, message, created_at):
            self.codes.append(code)

    sink = Sink()
    monitor = Monitor(telemetry, sink)
    await monitor.tick()
    assert sink.codes == []
    for index in range(4):
        await telemetry.record(f"f{index}", source="landing", success=False)
        clock.advance(timedelta(seconds=1))
    await telemetry.record("success", source="landing", success=True)
    clock.advance(timedelta(seconds=1))
    await telemetry.record("last", source="landing", success=False)
    await monitor.tick()
    assert sink.codes == []


def test_storage_readiness_rejects_public_or_unversioned_bucket():
    from rabbit_hole.runtime.server import storage_is_private

    class S3:
        versioned = True
        policy = '{"Statement":[{"Effect":"Deny","Principal":"*","Action":"s3:*"}]}'

        def head_bucket(self, **kwargs):
            return {}

        def get_bucket_versioning(self, **kwargs):
            return {"Status": "Enabled" if self.versioned else "Suspended"}

        def get_bucket_acl(self, **kwargs):
            return {"Grants": [{"Grantee": {"Type": "CanonicalUser"}}]}

        def get_bucket_policy(self, **kwargs):
            return {"Policy": self.policy}

    s3 = S3()
    assert storage_is_private(s3, "evidence")
    s3.versioned = False
    assert not storage_is_private(s3, "evidence")
    s3.versioned = True
    s3.policy = '{"Statement":[{"Effect":"Allow","Principal":{"AWS":"*"}}]}'
    assert not storage_is_private(s3, "evidence")


async def test_worker_maintenance_keeps_retrying_when_alert_delivery_fails():
    from rabbit_hole.worker import Worker

    class Jobs:
        async def lease_next(self, *args, **kwargs):
            return None

    class Pipeline:
        pass

    stop = asyncio.Event()
    calls = []

    async def maintenance():
        calls.append("tick")
        if len(calls) == 1:
            raise ConnectionError("private external error")
        stop.set()

    class FastWorker(Worker):
        async def _wait_or_stop(self, stop):
            await asyncio.sleep(0)

    worker = FastWorker(
        jobs=Jobs(),
        pipeline=Pipeline(),
        poller=None,
        worker_id="test",
        browser_concurrency=1,
        poll_seconds=10,
        maintenance=maintenance,
    )
    await asyncio.wait_for(worker.run_forever(stop_event=stop), timeout=1)
    assert calls == ["tick", "tick"]


def test_container_runtime_is_non_root_and_does_not_copy_local_secrets_or_sessions():
    dockerfile = (PROJECT_ROOT / "Dockerfile").read_text(encoding="utf-8")
    compose = (PROJECT_ROOT / "compose.yaml").read_text(encoding="utf-8")
    dockerignore = (PROJECT_ROOT / ".dockerignore").read_text(encoding="utf-8")

    assert "FROM python:3.12-slim" in dockerfile
    assert "playwright install --with-deps chromium" in dockerfile
    assert "USER rabbit" in dockerfile
    assert "COPY .env" not in dockerfile
    assert "browser-profile" not in dockerfile
    assert ".env" in dockerignore and ".feishu-browser-profile" in dockerignore
    assert "api:" in compose and "worker:" in compose
    assert "postgres:16" in compose and "minio" in compose
    assert "rabbit_hole.runtime.server" in compose and "rabbit_hole.worker" in compose
    assert "/ready" in compose and "worker-health" in compose
    assert "backend:" in compose and "internal: true" in compose
    assert compose.count("networks: [backend, egress]") == 3


def test_operator_runbook_has_staging_fences_and_recovery_procedures():
    runbook = (PROJECT_ROOT / "docs/operations/rabbit-hole-runbook.md").read_text(
        encoding="utf-8"
    )

    for required in (
        "bootstrap-feishu --dry-run",
        "九张业务表",
        "payment",
        "reserve",
        "alembic upgrade head",
        "private",
        "Meta",
        "CAPTCHA",
        "requeue",
        "评分规则",
        "evidence",
        "rollback",
        "待人工复核",
    ):
        assert required in runbook
