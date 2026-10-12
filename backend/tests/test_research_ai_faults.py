"""Synthetic shared-DB fault tests; no actual credentials or external calls."""

import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from pydantic import BaseModel
from services.research_runtime import _research_imports
from sqlalchemy import select, update

_research_imports()


@pytest_asyncio.fixture
async def usage_runtime(tmp_path):
    from migrations.full_merge_v1 import prepare_schema
    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.persistence.projects import WorkbenchStore
    from rabbit_hole.persistence.sql import create_engine, write_transaction

    path = tmp_path / "candidate.db"
    sqlite3.connect(path).close()
    prepare_schema(path, backup_verified=True, target_revision=3)
    engine = create_engine(f"sqlite+aiosqlite:///{path}", initialize_file=False)
    store = WorkbenchStore(engine)
    project = await store.create(
        "usage test", "specific product direction", "US", str(uuid4())
    )
    queued = await enqueue_action(
        store, project["id"], {"kind": "keywords", "version": project["version"]}
    )
    async with write_transaction(engine) as c:
        await c.execute(
            update(actions)
            .where(actions.c.id == UUID(queued["id"]))
            .values(
                status="running",
                attempt=1,
                lease_until=datetime.now(UTC) + timedelta(minutes=5),
                payload={"ai_usage": {}},
            )
        )
    runtime = SimpleNamespace(
        engine=engine, store=store, action_id=queued["id"], project_id=project["id"]
    )
    try:
        yield runtime
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_logical_reservation_is_atomic_idempotent_preserves_daily_budget(
    usage_runtime,
):
    from models.research_ai_usage import reservations
    from rabbit_hole.application.actions import actions, ai_usage
    from services.research_ai_usage import reserve_ai

    r = usage_runtime
    ids = await asyncio.gather(
        *(reserve_ai(r, r.action_id, 1, "keywords") for _ in range(5))
    )
    assert len(set(ids)) == 1
    async with r.engine.connect() as c:
        assert len((await c.execute(select(reservations))).all()) == 1
        row = (
            (await c.execute(select(actions).where(actions.c.id == UUID(r.action_id))))
            .mappings()
            .one()
        )
    assert ai_usage([row], datetime.now(UTC), reservations=False) == 1


@pytest.mark.asyncio
async def test_network_events_redacted_durable_and_late_fenced(usage_runtime):
    from models.research_ai_usage import network_attempts, reservations
    from rabbit_hole.application.actions import actions
    from rabbit_hole.integrations.provider_jobs import read_logs
    from rabbit_hole.persistence.sql import write_transaction
    from services.research_ai_usage import (
        ResearchUsageError,
        record_ai_attempt,
        reserve_ai,
    )

    r = usage_runtime
    rid = await reserve_ai(r, r.action_id, 1, "keywords")
    await record_ai_attempt(
        r,
        rid,
        {
            "status": "submitted",
            "network_attempt": 1,
            "prompt": "secret prompt",
            "api_key": "secret-key",
            "message": "http://127.0.0.1/private",
            "image": "data:image/png;base64,SECRET",
        },
    )
    async with write_transaction(r.engine) as c:
        await c.execute(
            update(actions)
            .where(actions.c.id == UUID(r.action_id))
            .values(status="blocked", attempt=2)
        )
    with pytest.raises(ResearchUsageError, match="围栏"):
        await record_ai_attempt(r, rid, {"status": "succeeded", "network_attempt": 1})
    async with r.engine.connect() as c:
        assert (
            await c.execute(select(reservations.c.status))
        ).scalar_one() == "uncertain"
        assert (
            await c.execute(select(network_attempts.c.status))
        ).scalar_one() == "uncertain"
    logs = await read_logs(r.engine, r.project_id, 0, action_id=r.action_id)
    exported = json.dumps(logs)
    assert logs and all(row["action_id"] == r.action_id for row in logs)
    assert all(
        value not in exported
        for value in (
            "secret prompt",
            "secret-key",
            "127.0.0.1",
            "SECRET",
            "data:image",
        )
    )


@pytest.mark.asyncio
async def test_uncertain_submission_cannot_be_replayed(usage_runtime):
    from services.research_ai_usage import (
        ResearchUsageError,
        record_ai_attempt,
        reserve_ai,
    )

    r = usage_runtime
    rid = await reserve_ai(r, r.action_id, 1, "keywords")
    await record_ai_attempt(r, rid, {"status": "submitted", "network_attempt": 1})
    await record_ai_attempt(r, rid, {"status": "uncertain", "network_attempt": 1})
    with pytest.raises(ResearchUsageError):
        await record_ai_attempt(r, rid, {"status": "submitted", "network_attempt": 2})
    assert await reserve_ai(r, r.action_id, 1, "keywords") == rid


@pytest.mark.asyncio
async def test_budget_exhausted_never_submits_provider(usage_runtime, monkeypatch):
    from rabbit_hole.application.actions import actions
    from rabbit_hole.persistence.sql import write_transaction
    from services.research_ai_usage import ResearchUsageError, reserve_ai

    r = usage_runtime
    monkeypatch.setattr(
        "services.research_ai_usage.effective_rules",
        lambda project: {"ai_daily_limit": 1},
    )
    await reserve_ai(r, r.action_id, 1, "keywords")
    async with write_transaction(r.engine) as c:
        await c.execute(
            update(actions).where(actions.c.id == UUID(r.action_id)).values(attempt=2)
        )
    with pytest.raises(ResearchUsageError) as exc:
        await reserve_ai(r, r.action_id, 2, "keywords")
    assert exc.value.code == "budget"


def test_revision3_is_explicit_backup_gated_preserves_revision2_contract(tmp_path):
    from migrations.full_merge_v1 import prepare_schema

    path = tmp_path / "db"
    sqlite3.connect(path).close()
    assert prepare_schema(path, backup_verified=True)["revision"] == 1
    assert (
        prepare_schema(path, backup_verified=True, target_revision=2)["revision"] == 2
    )
    with pytest.raises(ValueError, match="backup"):
        prepare_schema(path, backup_verified=False, target_revision=3)
    assert (
        prepare_schema(path, backup_verified=True, target_revision=3)["revision"] == 3
    )
    assert prepare_schema(path, backup_verified=True)["revision"] == 3
    assert (
        prepare_schema(path, backup_verified=True, target_revision=2)["revision"] == 3
    )


@pytest.mark.asyncio
async def test_router_observer_fail_closed_and_deadline_after_await(monkeypatch):
    from services.ai_config_service import ProviderSnapshot
    from services.ai_router import AIRouter

    def snapshot(max_retries):
        return ProviderSnapshot(
            id=1,
            incarnation_id="synthetic",
            capability="text",
            name="test",
            protocol="gemini",
            base_url=None,
            api_key="synthetic-secret",
            vertex_project_id=None,
            vertex_location=None,
            vertex_key_path=None,
            model="model",
            timeout_seconds=30,
            max_retries=max_retries,
            config_version=1,
        )

    import inspect

    assert "attempt_observer" in inspect.signature(AIRouter.generate).parameters
    calls = []

    class Transport:
        async def generate(self, *args):
            calls.append("provider")
            return {"candidates": []}

    monkeypatch.setattr("services.ai_router.get_adapter", lambda _: Transport())

    async def fail(event):
        assert not {"api_key", "payload", "prompt", "snapshot"} & set(event)
        raise ValueError("durable observer unavailable")

    with pytest.raises(Exception, match="observer|durable"):
        await AIRouter(base_delay=0).generate(
            "text",
            {"contents": []},
            snapshot=snapshot(max_retries=3),
            attempt_observer=fail,
        )
    assert calls == []

    async def slow(event):
        await asyncio.sleep(0.02)

    from services.ai_router import AIProviderRequestError

    with pytest.raises(AIProviderRequestError):
        await AIRouter(base_delay=0).generate(
            "text",
            {"contents": []},
            snapshot=snapshot(max_retries=3),
            deadline=asyncio.get_running_loop().time() + 0.01,
            attempt_observer=slow,
        )
    assert calls == []


class ValidResult(BaseModel):
    answer: str


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode", ["retry", "timeout", "invalid", "cancel", "cancel_storage", "late"]
)
async def test_adapter_real_controller_durable_faults(usage_runtime, monkeypatch, mode):
    from models.research_ai import ResearchAIRequest
    from models.research_ai_usage import network_attempts, reservations
    from rabbit_hole.application.actions import actions
    from rabbit_hole.persistence.sql import write_transaction
    from services.ai_config_service import ProviderSnapshot
    from services.ai_router import AIRouter
    from services.research_ai_adapter import ResearchAIAdapter

    r = usage_runtime
    snapshot = ProviderSnapshot(
        id=1,
        incarnation_id="fake",
        capability="text",
        name="test",
        protocol="gemini",
        base_url=None,
        api_key="synthetic-key",
        vertex_project_id=None,
        vertex_location=None,
        vertex_key_path=None,
        model="fake-model",
        timeout_seconds=30,
        max_retries=3,
        config_version=1,
    )
    monkeypatch.setattr("services.ai_router.get_snapshot", lambda *args: snapshot)
    submissions = []
    started = asyncio.Event()
    release = asyncio.Event()

    class Transport:
        async def generate(self, snapshot, payload):
            submissions.append(1)
            started.set()
            if mode == "retry" and len(submissions) == 1:
                raise httpx.HTTPStatusError(
                    "sensitive provider detail",
                    request=httpx.Request("POST", "https://internal.test"),
                    response=httpx.Response(
                        429,
                        headers={"Retry-After": "0.001"},
                        request=httpx.Request("POST", "https://internal.test"),
                    ),
                )
            if mode == "timeout":
                raise httpx.ReadTimeout("secret upstream URL")
            if mode in {"cancel", "cancel_storage", "late"}:
                await release.wait()
            value = "{}" if mode == "invalid" else '{"answer":"verified"}'
            return {"candidates": [{"content": {"parts": [{"text": value}]}}]}

    monkeypatch.setattr("services.ai_router.get_adapter", lambda _: Transport())
    adapter = ResearchAIAdapter(
        router=AIRouter(base_delay=0), allow_external=True, usage_runtime=r
    )
    req = ResearchAIRequest(
        operation="keywords",
        schema=ValidResult,
        system_instruction="Verify only",
        untrusted_data="untrusted secret input",
        action_id=r.action_id,
        attempt=1,
    )
    if mode == "cancel_storage":
        from services.research_ai_usage import record_ai_attempt

        async def broken_storage(runtime, reservation_id, event):
            if event["status"] == "cancelled":
                raise RuntimeError("synthetic durable storage failure")
            await record_ai_attempt(runtime, reservation_id, event)

        monkeypatch.setattr(
            "services.research_ai_usage.record_ai_attempt", broken_storage
        )
    task = asyncio.create_task(adapter.generate(req))
    if mode in {"cancel", "cancel_storage", "late"}:
        await started.wait()
        if mode in {"cancel", "cancel_storage"}:
            task.cancel()
        else:
            async with write_transaction(r.engine) as c:
                await c.execute(
                    update(actions)
                    .where(actions.c.id == UUID(r.action_id))
                    .values(status="blocked", attempt=2)
                )
            release.set()
    if mode == "retry":
        assert (await task).answer == "verified"
    elif mode in {"cancel", "cancel_storage"}:
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        from services.ai_router import AIObserverError
        from services.research_ai_adapter import ResearchAIError

        with pytest.raises((AIObserverError, ResearchAIError)):
            await task
    async with r.engine.connect() as c:
        rows = (await c.execute(select(network_attempts))).mappings().all()
        status = (await c.execute(select(reservations.c.status))).scalar_one()
    assert len(submissions) == (2 if mode == "retry" else 1)
    assert len(rows) == len(submissions)
    assert (
        status
        == {
            "retry": "succeeded",
            "timeout": "uncertain",
            "invalid": "failed",
            "cancel": "cancelled",
            "cancel_storage": "submitted",
            "late": "uncertain",
        }[mode]
    )
    if mode in {"timeout", "cancel_storage"}:
        from services.ai_router import AIObserverError

        with pytest.raises(AIObserverError):
            await adapter.generate(req)
        assert len(submissions) == 1


@pytest.mark.asyncio
async def test_runtime_extractor_invalid_schema_is_failure_telemetry(monkeypatch):
    from contextlib import contextmanager
    from unittest.mock import AsyncMock

    from rabbit_hole.runtime.legacy import RuntimeExtractor
    from services.research_ai_adapter import ResearchAIError

    class Adapter:
        @contextmanager
        def extraction_generator(self):
            raise ResearchAIError("schema invalid")
            yield

    telemetry = SimpleNamespace(record=AsyncMock())
    extractor = RuntimeExtractor(
        SimpleNamespace(), None, telemetry, ai_adapter=Adapter()
    )
    with pytest.raises(ResearchAIError):
        await extractor.extract(None)
    data = telemetry.record.call_args.kwargs
    assert data["success"] is False and data["schema_failure"] is True


@pytest.mark.asyncio
async def test_runner_reservation_seam_and_nested_action_context(
    usage_runtime, monkeypatch
):
    from models.research_ai_usage import reservations
    from rabbit_hole.application.actions import actions
    from rabbit_hole.application.runner import WorkbenchRunner
    from services.research_ai_adapter import ResearchAIAdapter

    r = usage_runtime
    async with r.engine.connect() as c:
        action = dict(
            (await c.execute(select(actions).where(actions.c.id == UUID(r.action_id))))
            .mappings()
            .one()
        )
    runner = WorkbenchRunner(r.store, SimpleNamespace(), None)
    project = await r.store.get(r.project_id)
    await runner._reserve_ai(action, project)
    await runner._reserve_ai(action, project)
    async with r.engine.connect() as c:
        assert len((await c.execute(select(reservations))).all()) == 1
    adapter = ResearchAIAdapter(allow_external=False)
    assert hasattr(adapter, "action_context")
    with adapter.action_context(r, action):
        assert adapter._action.get()[1:3] == (r.action_id, 1)
    assert adapter._action.get() is None


@pytest.mark.asyncio
async def test_api_reads_separate_connection_durable_action_logs_and_stream(
    usage_runtime, monkeypatch
):
    from fastapi import FastAPI
    from rabbit_hole.integrations.provider_jobs import append_log
    from rabbit_hole.persistence.projects import WorkbenchStore
    from rabbit_hole.persistence.sql import create_engine
    from routes import research, research_workbench
    from services.research_ai_usage import record_ai_attempt, reserve_ai

    r = usage_runtime
    rid = await reserve_ai(r, r.action_id, 1, "keywords")
    await record_ai_attempt(r, rid, {"status": "submitted", "network_attempt": 1})
    other = str(uuid4())
    await append_log(r.engine, r.project_id, other, 1, "other", "Other action")
    # Independent API engine, proving no worker in-memory SSE dependency.
    api_engine = create_engine(str(r.engine.url), initialize_file=False)
    app = FastAPI()
    app.state.research_runtime = SimpleNamespace(
        store=WorkbenchStore(api_engine), diagnostics=()
    )
    app.include_router(research.router)
    app.include_router(research_workbench.create_workbench_router())
    monkeypatch.setattr("routes.research.load_research_config", dict)

    async def stream(request, reader, *, after):
        rows = await reader(after)
        yield (
            "event: logs\ndata: "
            + json.dumps({"logs": rows, "cursor": rows[-1]["id"]})
            + "\n\n"
        )

    monkeypatch.setattr("rabbit_hole.api.log_stream.stream_logs", stream)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost:9503"
        ) as client:
            token = (await client.get("/api/research/v1/session")).json()["csrf_token"]
            client.headers["X-Research-Token"] = token
            path = f"/api/research/workbench/v1/projects/{r.project_id}"
            queried = await client.get(
                path + "/live-logs", params={"action_id": r.action_id}
            )
            assert queried.status_code == 200
            data = queried.json()
            assert data["logs"] and all(
                row["action_id"] == r.action_id for row in data["logs"]
            )
            assert (
                await client.get(path + "/live-logs", params={"action_id": "bad"})
            ).status_code == 422
            assert (
                await client.get(path + "/live-logs", params={"after": -1})
            ).status_code == 422
            streamed = await client.get(
                path + "/log-stream", params={"action_id": r.action_id}
            )
            assert streamed.status_code == 200 and "ai_submitted" in streamed.text
            assert "Other action" not in streamed.text
            assert queried.headers["cache-control"] == "no-store"
    finally:
        await api_engine.dispose()


def test_partial_revision3_schema_is_refused_atomically(tmp_path):
    from migrations.full_merge_v1 import prepare_schema

    path = tmp_path / "candidate"
    sqlite3.connect(path).close()
    prepare_schema(path, backup_verified=True, target_revision=2)
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE research_ai_reservations (id TEXT PRIMARY KEY)")
    with pytest.raises(ValueError, match="partial"):
        prepare_schema(path, backup_verified=True, target_revision=3)
    with sqlite3.connect(path) as c:
        assert c.execute("SELECT revision FROM full_merge_schema").fetchone()[0] == 2
        assert not c.execute(
            "SELECT name FROM sqlite_master WHERE name='research_ai_network_attempts'"
        ).fetchall()


@pytest.mark.asyncio
async def test_damaged_revision3_is_readonly_unprepared_without_lazy_creation(tmp_path):
    from migrations.full_merge_v1 import prepare_schema
    from services.research_runtime import open_research_runtime, resolve_runtime_paths

    path = tmp_path / "candidate"
    sqlite3.connect(path).close()
    prepare_schema(path, backup_verified=True, target_revision=3)
    with sqlite3.connect(path) as c:
        c.execute("DROP TABLE research_ai_network_attempts")
    async with open_research_runtime(
        resolve_runtime_paths(path, tmp_path / "private")
    ) as runtime:
        assert runtime.diagnostics == ("schema_unprepared",)
    with sqlite3.connect(path) as c:
        assert not c.execute(
            "SELECT name FROM sqlite_master WHERE name='research_ai_network_attempts'"
        ).fetchall()


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit_ids", [False, True])
async def test_nested_generate_inherits_real_action_and_preserves_checkpoint_budget(
    usage_runtime,
    explicit_ids,
):
    from unittest.mock import AsyncMock

    from models.research_ai import ResearchAIRequest
    from models.research_ai_usage import reservations
    from services.research_ai_adapter import ResearchAIAdapter

    r = usage_runtime
    router = AsyncMock()
    router.generate.return_value = {
        "candidates": [{"content": {"parts": [{"text": '{"answer":"verified"}'}]}}]
    }

    # Explicit fake router still must call the trusted submission observer.
    async def generate(*args, **kwargs):
        observer = kwargs["attempt_observer"]
        await observer({"status": "submitted", "network_attempt": 1})
        await observer({"status": "received", "network_attempt": 1})
        return router.generate.return_value

    router.generate.side_effect = generate
    adapter = ResearchAIAdapter(router=router, allow_external=True)
    from rabbit_hole.application.actions import actions

    async with r.engine.connect() as c:
        action = dict(
            (await c.execute(select(actions).where(actions.c.id == UUID(r.action_id))))
            .mappings()
            .one()
        )
    with adapter.action_context(r, action):
        result = await adapter.generate(
            ResearchAIRequest(
                operation="extract",
                schema=ValidResult,
                system_instruction="Only verified data",
                untrusted_data="synthetic input",
                action_id=r.action_id if explicit_ids else None,
                attempt=1 if explicit_ids else 0,
            )
        )
    assert result.answer == "verified"
    async with r.engine.connect() as c:
        row = (await c.execute(select(reservations))).mappings().one()
    assert str(row["action_id"]) == r.action_id and row["operation"] == "extract"
    assert row["status"] == "succeeded"
    assert action["payload"]["ai_usage"][datetime.now(UTC).date().isoformat()] == 1
    assert (
        router.generate.call_args.args[1]["operation_id"]
        == f"research:{r.action_id}:1:extract"
    )


@pytest.mark.asyncio
async def test_exhausted_budget_adapter_does_not_invoke_router(
    usage_runtime, monkeypatch
):
    from unittest.mock import AsyncMock

    from models.research_ai import ResearchAIRequest
    from rabbit_hole.application.actions import actions
    from rabbit_hole.persistence.sql import write_transaction
    from services.research_ai_adapter import ResearchAIAdapter
    from services.research_ai_usage import ResearchUsageError, reserve_ai

    r = usage_runtime
    monkeypatch.setattr(
        "services.research_ai_usage.effective_rules",
        lambda project: {"ai_daily_limit": 1},
    )
    await reserve_ai(r, r.action_id, 1, "keywords")
    async with write_transaction(r.engine) as c:
        await c.execute(
            update(actions).where(actions.c.id == UUID(r.action_id)).values(attempt=2)
        )
    router = AsyncMock()
    adapter = ResearchAIAdapter(router=router, allow_external=True, usage_runtime=r)
    with pytest.raises(ResearchUsageError) as exc:
        await adapter.generate(
            ResearchAIRequest(
                operation="keywords",
                schema=ValidResult,
                system_instruction="Verify",
                untrusted_data="synthetic",
                action_id=r.action_id,
                attempt=2,
            )
        )
    assert exc.value.code == "budget"
    router.generate.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("max_retries", [0, 1])
@pytest.mark.parametrize("failed_event", ["received", "uncertain"])
async def test_final_attempt_observer_storage_failure_never_reopens_paid_replay(
    usage_runtime, monkeypatch, max_retries, failed_event
):
    from models.research_ai import ResearchAIRequest
    from models.research_ai_usage import network_attempts, reservations
    from rabbit_hole.application.actions import actions, ai_usage
    from rabbit_hole.persistence.sql import write_transaction
    from services.ai_config_service import ProviderSnapshot
    from services.ai_router import AIObserverError, AIProviderRequestError, AIRouter
    from services.research_ai_adapter import ResearchAIAdapter
    from services.research_ai_usage import ResearchUsageError, record_ai_attempt

    r = usage_runtime
    snapshot = ProviderSnapshot(
        id=1,
        incarnation_id="synthetic",
        capability="text",
        name="synthetic",
        protocol="gemini",
        base_url=None,
        api_key="synthetic-secret",
        vertex_project_id=None,
        vertex_location=None,
        vertex_key_path=None,
        model="synthetic",
        timeout_seconds=30,
        max_retries=max_retries,
        config_version=1,
    )
    monkeypatch.setattr("services.ai_router.get_snapshot", lambda *args: snapshot)
    submissions = []

    class Transport:
        async def generate(self, snapshot, payload):
            submissions.append(1)
            if len(submissions) <= max_retries:
                request = httpx.Request("POST", "https://synthetic.test")
                raise httpx.HTTPStatusError(
                    "synthetic rate limit",
                    request=request,
                    response=httpx.Response(
                        429, headers={"Retry-After": "0"}, request=request
                    ),
                )
            if failed_event == "uncertain":
                raise httpx.ReadTimeout("synthetic response timeout")
            return {
                "candidates": [
                    {"content": {"parts": [{"text": '{"answer":"verified"}'}]}}
                ]
            }

    monkeypatch.setattr("services.ai_router.get_adapter", lambda _: Transport())
    failures = []

    async def transient_storage(runtime, reservation_id, event):
        if event["status"] == failed_event and not failures:
            failures.append(1)
            raise ResearchUsageError("synthetic durable write unavailable")
        await record_ai_attempt(runtime, reservation_id, event)

    monkeypatch.setattr(
        "services.research_ai_usage.record_ai_attempt", transient_storage
    )
    adapter = ResearchAIAdapter(
        router=AIRouter(base_delay=0), allow_external=True, usage_runtime=r
    )
    req = ResearchAIRequest(
        operation="keywords",
        schema=ValidResult,
        system_instruction="Only verified data",
        untrusted_data="synthetic input",
        action_id=r.action_id,
        attempt=1,
    )
    with pytest.raises((AIObserverError, AIProviderRequestError)) as failure:
        await adapter.generate(req)
    # Assert the durable state before the exception classification: the previous
    # defect mapped provider failure and cleanup overwrote submitted with failed.
    async with r.engine.connect() as c:
        ledger = (await c.execute(select(reservations))).mappings().all()
        networks = (await c.execute(select(network_attempts))).mappings().all()
    assert len(ledger) == 1 and ledger[0]["status"] == "submitted"
    assert len(networks) == max_retries + 1
    assert isinstance(failure.value, AIObserverError)
    assert failure.value.code == "submission_uncertain"
    async with write_transaction(r.engine) as c:
        await c.execute(
            update(actions).where(actions.c.id == UUID(r.action_id)).values(attempt=2)
        )
    with pytest.raises(ResearchUsageError) as replay:
        await adapter.generate(req.model_copy(update={"attempt": 2}))
    assert replay.value.code == "submission_uncertain"
    assert len(submissions) == max_retries + 1
    async with r.engine.connect() as c:
        assert len((await c.execute(select(reservations))).all()) == 1
        row = (
            (await c.execute(select(actions).where(actions.c.id == UUID(r.action_id))))
            .mappings()
            .one()
        )
    assert ai_usage([row], datetime.now(UTC), reservations=False) == 1
