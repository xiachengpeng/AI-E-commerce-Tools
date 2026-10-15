from __future__ import annotations

import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from rabbit_hole.integrations.collectors.google import GoogleTrendsCollector
from rabbit_hole.integrations.feishu import FeishuClient, WriteConflict
from rabbit_hole.pipeline import FeishuMutation, RetryablePipelineError
from rabbit_hole.runtime import legacy as runtime


def test_feishu_url_cells_read_back_as_urls_for_pipeline_consumers():
    record = FeishuClient.record_version(
        {
            "id": "rec_url",
            "fields": {
                "AUTO｜来源URL": "[source](https://example.com/a)",
                "AUTO｜原始值": "[source](https://example.com/a)",
            },
        }
    )
    assert record.fields["AUTO｜来源URL"] == "https://example.com/a"
    assert record.fields["AUTO｜原始值"] == "[source](https://example.com/a)"


def timeline(count=52):
    start = datetime(2025, 9, 7, tzinfo=UTC)
    return {
        "default": {
            "timelineData": [
                {
                    "time": str(int((start + timedelta(weeks=i)).timestamp())),
                    "value": [i % 101],
                    "hasData": [True],
                    "formattedValue": [str(i % 101)],
                }
                for i in range(count)
            ]
        }
    }


def test_trends_parser_retains_only_observed_weekly_dates_and_indices():
    result = runtime.parse_trends_timeline(
        ")]}'\n" + json.dumps(timeline()), query="pet brush", geo="US", window="12m"
    )
    assert result.points[0].week.isoformat() == "2025-09-07"
    assert result.points[-1].value == 51
    assert len(result.points) == 52


def test_workflow_verification_accepts_feishu_cell_normalization():
    matches = runtime.FeishuWorkflowAdapter._cell_matches

    assert matches("text", "", None)
    assert matches(
        "datetime",
        "2026-09-12T08:13:29.711207+00:00",
        "2026-09-12T16:13:29.711+08:00",
    )
    assert not matches("text", "expected", None)
    assert not matches(
        "datetime",
        "2026-09-12T08:13:29.711207+00:00",
        "2026-09-12T16:13:30.711+08:00",
    )


def test_workflow_verification_accepts_date_only_at_base_midnight():
    matches = runtime.FeishuWorkflowAdapter._cell_matches
    assert matches("datetime", "2026-05-12", "2026-05-12T00:00:00.000+08:00")
    assert not matches("datetime", "2026-05-12", "2026-05-13T00:00:00.000+08:00")
    assert not matches("datetime", "2026-05-12", "2026-05-12T13:00:00.000+08:00")


def test_workflow_verification_accepts_url_cell_display_wrapping_only():
    matches = runtime.FeishuWorkflowAdapter._cell_matches
    assert matches(
        "url", "https://example.com/a", "[https://example.com/a](https://example.com/a)"
    )
    assert not matches(
        "url", "https://example.com/a", "[https://example.com/a](https://other.com/a)"
    )
    assert not matches(
        "text",
        "https://example.com/a",
        "[https://example.com/a](https://example.com/a)",
    )


@pytest.mark.parametrize(
    "corruption", ["missing", "daily", "missing_value", "over100", "partial", "sparse"]
)
def test_trends_parser_rejects_schema_drift_and_missing_observations(corruption):
    payload = timeline()
    rows = payload["default"]["timelineData"]
    if corruption == "missing":
        payload = {"default": {"renamedTimeline": rows}}
    elif corruption == "daily":
        rows[1]["time"] = str(int(rows[0]["time"]) + 86400)
    elif corruption == "missing_value":
        rows[1]["value"] = []
    elif corruption == "over100":
        rows[1]["value"] = [101]
    elif corruption == "partial":
        rows[1]["isPartial"] = True
    else:
        rows[1]["hasData"] = [False]
    with pytest.raises(runtime.TrendsPageError):
        runtime.parse_trends_timeline(
            json.dumps(payload), query="pet brush", geo="US", window="12m"
        )


async def test_trends_schema_failure_has_static_typed_detail():
    class Broken:
        async def fetch_weekly_series(self, *args):
            raise runtime.TrendsPageError("schema_drift")

    result = await GoogleTrendsCollector(Broken()).collect("pet brush")
    assert result.value.errors[0].code == "schema_drift"
    assert result.value.errors[0].retriable is False
    assert result.value.series_12m == {}


class FakeBase:
    """Base v3 wire contract, including array selects and ID-only creates."""

    def __init__(self):
        self.rows = {}
        self.writes = []
        self.fail_create = False
        self.after_write = None
        self.after_create = None

    def __call__(self, request):
        path = request.url.path
        data = json.loads(request.content) if request.content else {}
        if path.endswith("/tenant_access_token/internal"):
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "tenant_access_token": "fixture-token",
                    "expire": 7200,
                },
            )
        if path.endswith("/tables"):
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": [
                            {"name": "市场评估表", "id": "tblEval"},
                            {"name": "搜索批次", "id": "tblBatch"},
                            {"name": "产品主表", "id": "tblProduct"},
                        ],
                        "has_more": False,
                    },
                },
            )
        if path.endswith("/records/batch_get"):
            records = [self.rows[i] for i in data["record_id_list"] if i in self.rows]
            return httpx.Response(200, json={"code": 0, "data": {"records": records}})
        if path.endswith("/records") and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {"records": list(self.rows.values()), "has_more": False},
                },
            )
        if path.endswith("/records/batch_create"):
            self.writes.append(("create", deepcopy(data)))
            record_id = "rec" + str(len(self.rows) + 1)
            self.rows[record_id] = {
                "id": record_id,
                "fields": deepcopy(data["create_records"][0]),
            }
            if self.after_create:
                self.after_create(self)
            if self.fail_create:
                raise httpx.ReadTimeout(
                    "remote response lost; no retry POST", request=request
                )
            return httpx.Response(
                200, json={"code": 0, "data": {"record_id_list": [record_id]}}
            )
        if path.endswith("/records/batch_update"):
            self.writes.append(("update", deepcopy(data)))
            for key, fields in data["update_records"].items():
                self.rows[key]["fields"].update(fields)
            if self.after_write:
                self.after_write(self)
            return httpx.Response(200, json={"code": 0, "data": {}})
        raise AssertionError((request.method, path, data))


def mutation(**changes):
    data = {
        "operation_key": str(uuid4()),
        "table": "市场评估表",
        "action": "update",
        "record_id": "recInput",
        "expected_version": "v1",
        "current_state": "采集中",
        "state": "待询价",
        "actor": "automation",
        "explicit_revalidation": False,
        "fields": {"AUTO｜运行状态": "已完成"},
    }
    data.update(changes)
    return FeishuMutation(**data)


async def test_feishu_v3_select_reads_get_nonempty_fallback_versions():
    base = FakeBase()
    base.rows["recInput"] = {
        "id": "recInput",
        "fields": {
            "人工｜状态": ["开始验证"],
            "人工｜市场": ["US"],
            "人工｜订单货值": 0,
        },
    }
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        first = await client.get_record("tblEval", "recInput")
        base.rows["recInput"]["fields"]["人工｜订单货值"] = 1
        second = await client.get_record("tblEval", "recInput")
    assert first.fields["人工｜状态"] == "开始验证"
    assert first.fields["人工｜订单货值"] == 0
    assert first.version and first.version != second.version


async def test_workflow_fences_stale_input_and_emits_real_v3_cells(db_transaction):
    base = FakeBase()
    base.rows["recInput"] = {
        "id": "recInput",
        "fields": {"人工｜状态": ["采集中"], "人工｜订单货值": 1},
    }
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        workflow = runtime.FeishuWorkflowAdapter(client, db_transaction)
        initial = await workflow.get_record("市场评估表", "recInput")
        request = mutation(expected_version=initial.version)
        base.rows["recInput"]["fields"]["人工｜订单货值"] = 2
        with pytest.raises(WriteConflict):
            await workflow.apply(request)
        assert base.writes == []
        current = await workflow.get_record("市场评估表", "recInput")
        request = mutation(expected_version=current.version)
        assert await workflow.apply(request) == "recInput"
        assert base.writes[-1] == (
            "update",
            {
                "update_records": {
                    "recInput": {"AUTO｜运行状态": ["已完成"], "人工｜状态": ["待询价"]}
                }
            },
        )
        assert await workflow.apply(request) == "recInput"
        assert len(base.writes) == 1


async def test_ambiguous_create_is_reconciled_without_second_post(db_transaction):
    base = FakeBase()
    base.fail_create = True
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        workflow = runtime.FeishuWorkflowAdapter(client, db_transaction)
        request = mutation(
            table="产品主表",
            action="create",
            record_id=None,
            expected_version=None,
            unique_key="brush|US",
            current_state="新建",
            state="待补充",
            fields={"AUTO｜产品指纹": "brush|US"},
        )
        with pytest.raises(RetryablePipelineError):
            await workflow.apply(request)
        restarted = runtime.FeishuWorkflowAdapter(client, db_transaction)
        assert await restarted.apply(request) == "rec1"
        assert len(base.writes) == 1


async def test_existing_create_never_overwrites_human_final_pool(db_transaction):
    base = FakeBase()
    base.rows["recInput"] = {
        "id": "recInput",
        "fields": {"AUTO｜产品市场唯一键": "brush|US", "人工｜状态": ["测试池"]},
    }
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        workflow = runtime.FeishuWorkflowAdapter(client, db_transaction)
        request = mutation(
            action="create",
            record_id=None,
            expected_version=None,
            unique_key="brush|US",
            current_state="新建",
            state="待询价",
            fields={"AUTO｜产品市场唯一键": "brush|US"},
        )
        assert await workflow.apply(request) == "recInput"
        assert base.writes == []


async def test_post_write_input_change_is_a_conflict_and_is_not_replayed(
    db_transaction,
):
    base = FakeBase()
    base.rows["recInput"] = {
        "id": "recInput",
        "fields": {"人工｜状态": ["采集中"], "人工｜订单货值": 1},
    }
    base.after_write = lambda api: api.rows["recInput"]["fields"].update(
        {"人工｜订单货值": 9}
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        workflow = runtime.FeishuWorkflowAdapter(
            client, db_transaction, verify_delays=()
        )
        before = await workflow.get_record("市场评估表", "recInput")
        request = mutation(expected_version=before.version)
        with pytest.raises(WriteConflict):
            await workflow.apply(request)
        with pytest.raises(WriteConflict):
            await workflow.apply(request)
    assert len(base.writes) == 1
    assert base.rows["recInput"]["fields"]["人工｜订单货值"] == 9


async def test_ambiguous_missing_create_requires_reconciliation_without_repost(
    db_transaction,
):
    base = FakeBase()
    base.fail_create = True
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        workflow = runtime.FeishuWorkflowAdapter(
            client, db_transaction, verify_delays=()
        )
        request = mutation(
            table="产品主表",
            action="create",
            record_id=None,
            expected_version=None,
            unique_key="unseen|US",
            current_state="新建",
            state="待补充",
            fields={},
        )
        with pytest.raises(RetryablePipelineError):
            await workflow.apply(request)
        base.rows.clear()
        with pytest.raises(WriteConflict):
            await workflow.apply(request)
    assert len(base.writes) == 1


async def test_duplicate_operation_cannot_substitute_new_payload(db_transaction):
    base = FakeBase()
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        workflow = runtime.FeishuWorkflowAdapter(client, db_transaction)
        request = mutation(
            table="产品主表",
            action="create",
            record_id=None,
            expected_version=None,
            unique_key="one|US",
            current_state="新建",
            state="待补充",
            fields={},
        )
        await workflow.apply(request)
        altered = request.model_copy(update={"unique_key": "two|US"})
        with pytest.raises(WriteConflict):
            await workflow.apply(altered)
    assert len(base.writes) == 1


def test_feishu_read_normalizes_link_ids_without_losing_order_or_select_values():
    record = FeishuClient.record_version(
        {
            "id": "rec",
            "fields": {
                "AUTO｜产品": [{"id": "rec2"}, {"id": "rec1"}],
                "AUTO｜人群": ["Adults", "Families"],
                "人工｜市场": ["US"],
            },
        }
    )
    assert record.fields["AUTO｜产品"] == ["rec2", "rec1"]
    assert record.fields["AUTO｜人群"] == ["Adults", "Families"]
    assert record.fields["人工｜市场"] == "US"


async def test_alert_uses_search_batches_and_deduplicates(db_transaction):
    base = FakeBase()
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        adapter = runtime.FeishuWorkflowAdapter(client, db_transaction)
        now = datetime.now(UTC)
        await adapter.emit_alert(
            "alert-fixture",
            "queue_wait",
            "A job waited two hours",
            now,
            last_seen=now,
            occurrence_count=1,
        )
        later = now + timedelta(minutes=5)
        await adapter.emit_alert(
            "alert-fixture",
            "queue_wait",
            "A job waited two hours again",
            now,
            last_seen=later,
            occurrence_count=2,
        )
    assert len(base.writes) == 2
    assert base.writes[0][1]["create_records"][0] == {
        "AUTO｜记录类型": "运行告警",
        "AUTO｜失败类型": "queue_wait",
        "AUTO｜错误": "A job waited two hours",
        "AUTO｜首次出现": now.isoformat(),
        "AUTO｜最后出现": now.isoformat(),
        "AUTO｜累计次数": 1,
        "AUTO｜状态": ["需人工处理"],
        "AUTO｜任务ID": "alert:alert-fixture",
    }
    assert base.writes[1][1]["update_records"]["rec1"] == {
        "AUTO｜记录类型": "运行告警",
        "AUTO｜失败类型": "queue_wait",
        "AUTO｜错误": "A job waited two hours again",
        "AUTO｜首次出现": now.isoformat(),
        "AUTO｜最后出现": later.isoformat(),
        "AUTO｜累计次数": 2,
        "AUTO｜状态": ["需人工处理"],
        "AUTO｜任务ID": "alert:alert-fixture",
    }


async def test_lost_alert_create_response_replays_original_outbox_payload(
    db_transaction, clock
):
    """A later observation must reconcile the original remote create, not repost it."""

    from sqlalchemy import select

    from rabbit_hole.monitoring import (
        Alert,
        Monitor,
        OperationalSnapshot,
        Telemetry,
        runtime_alerts,
    )

    class SnapshotTelemetry(Telemetry):
        async def snapshot(self):
            return OperationalSnapshot(
                alerts=[Alert("stable-alert", "queue_wait", "waiting", "event-1")]
            )

    base = FakeBase()
    base.fail_create = True
    telemetry = SnapshotTelemetry(db_transaction, clock)
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        adapter = runtime.FeishuWorkflowAdapter(client, db_transaction)
        monitor = Monitor(telemetry, adapter)

        await monitor.tick()
        initial_last_seen = clock.now()
        first = (await db_transaction.execute(select(runtime_alerts))).mappings().one()
        assert first["sent_count"] == 0
        assert len(base.writes) == 1

        clock.advance(timedelta(minutes=5))
        base.fail_create = False
        await monitor.tick()

    stored = (await db_transaction.execute(select(runtime_alerts))).mappings().one()
    assert stored["last_seen"] == clock.now()
    assert stored["sent_count"] == stored["occurrence_count"] == 1
    assert len(base.writes) == 1
    created = base.rows["rec1"]["fields"]
    assert created["AUTO｜最后出现"] == initial_last_seen.isoformat()


async def test_alert_create_fails_closed_if_remote_duplicate_appears(
    db_transaction,
):
    base = FakeBase()

    def duplicate_created_alert(api):
        api.rows["rec-duplicate"] = {
            "id": "rec-duplicate",
            "fields": {
                "AUTO｜任务ID": "alert:alert-fixture",
                "AUTO｜状态": ["需人工处理"],
            },
        }

    base.after_create = duplicate_created_alert
    async with httpx.AsyncClient(transport=httpx.MockTransport(base)) as http:
        client = FeishuClient("app", "secret", "base", http_client=http)
        adapter = runtime.FeishuWorkflowAdapter(
            client, db_transaction, verify_delays=()
        )
        now = datetime.now(UTC)
        with pytest.raises(WriteConflict):
            await adapter.emit_alert(
                "alert-fixture",
                "queue_wait",
                "A job waited two hours",
                now,
                now,
                1,
            )
    assert len(base.writes) == 1


async def test_default_operator_builds_worker_without_external_factory(monkeypatch):
    from rabbit_hole.cli import DefaultOperatorRuntime

    monkeypatch.delenv("RABBIT_HOLE_WORKER_FACTORY", raising=False)
    created = []

    async def build_worker(**kwargs):
        created.append(kwargs)
        return SimpleNamespace(consumer_count=2)

    monkeypatch.setattr(runtime, "build_worker", build_worker)
    operator = object.__new__(DefaultOperatorRuntime)
    operator.settings = SimpleNamespace(browser_concurrency=2)
    operator.jobs = object()
    operator.feishu = object()
    operator.local_runtime = SimpleNamespace(evidence_store=object(), ai_adapter=object())
    worker = await operator.build_worker()
    assert worker.consumer_count == 2
    assert created[0]["settings"] is operator.settings
