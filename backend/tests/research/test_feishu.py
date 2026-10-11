from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from sqlalchemy import select

from rabbit_hole.domain.legacy import JobKind, JobPayload, JobStatus
from rabbit_hole.integrations.feishu import (
    ALL_VIEWS,
    API_FIELD_LIST,
    API_FIELD_UPDATE,
    API_RECORD_BATCH_GET,
    API_RECORD_LIST,
    API_TABLE_LIST,
    API_TENANT_TOKEN,
    API_VIEW_FILTER,
    API_VIEW_LIST,
    AUTO_FIELD_PREFIX,
    MULTI_SELECT_KEYS,
    TRIGGER_VIEWS,
    BaseSchema,
    FeishuClient,
    FieldSchema,
    RecordVersion,
    TableSchema,
    TriggerPoller,
    TriggerRecord,
    WriteConflict,
    bootstrap_base,
    protected_input_hash,
)
from rabbit_hole.persistence.database import job_checkpoints, runtime_jobs
from rabbit_hole.persistence.legacy_jobs import JobNotRequeueableError, idempotency_key

FIXTURES = Path(__file__).parent / "fixtures" / "feishu"


def fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
async def feishu() -> FeishuClient:
    client = FeishuClient(
        app_id="app-id", app_secret="app-secret", base_token="base-token", retries=1
    )
    try:
        yield client
    finally:
        await client.aclose()


async def test_poller_enqueues_three_explicit_triggers(feishu, job_repo):
    feishu.list_trigger_records = AsyncMock(
        return_value=[
            TriggerRecord(
                table="细分领域池",
                record_id="n1",
                state="待生成",
                version="1",
                fields={"人工｜大类": "Home"},
            ),
            TriggerRecord(
                table="关键词库",
                record_id="kw1",
                state="待扫描",
                version="7",
                fields={"AUTO｜实际搜索词": "organizer"},
            ),
            TriggerRecord(
                table="市场评估表",
                record_id="p1",
                state="开始验证",
                version="3",
                fields={"link": "https://example.test/item", "人工｜预计客单价": 79},
            ),
        ]
    )

    assert await TriggerPoller(feishu, job_repo).poll_once() == 3

    async with job_repo._connection() as connection:  # test observable queue state
        keys = [
            idempotency_key(
                JobPayload(
                    kind=kind,
                    record_id=record_id,
                    input_version=version,
                    protected_input_hash=protected_input_hash(fields),
                )
            )
            for kind, record_id, version, fields in (
                (JobKind.NICHE_DISCOVERY, "n1", "1", {"人工｜大类": "Home"}),
                (JobKind.KEYWORD_SCAN, "kw1", "7", {"AUTO｜实际搜索词": "organizer"}),
                (
                    JobKind.LINK_VALIDATION,
                    "p1",
                    "3",
                    {
                        "link": "https://example.test/item",
                        "人工｜预计客单价": 79,
                    },
                ),
            )
        ]
        rows = await connection.execute(
            select(runtime_jobs.c.kind, runtime_jobs.c.payload).where(
                runtime_jobs.c.idempotency_key.in_(keys)
            )
        )
    stored = list(rows)
    assert {row[0] for row in stored} == {
        JobKind.NICHE_DISCOVERY.value,
        JobKind.KEYWORD_SCAN.value,
        JobKind.LINK_VALIDATION.value,
    }
    link_payload = next(
        JobPayload.model_validate(row[1])
        for row in stored
        if row[0] == JobKind.LINK_VALIDATION.value
    )
    assert link_payload.protected_input_hash == protected_input_hash(link_payload.data)


async def test_poller_canonicalizes_supplier_sources_before_postgres_snapshot(
    feishu, job_repo, caplog
):
    """Cleaning only in scoring leaves supplier credentials in the queue row."""
    source = "https://detail.1688.com/offer/123456789.html"
    raw_source = (
        source + "?token=queue-token-secret&X-Amz-Credential=queue-credential-secret"
        "&X-Amz-Signature=queue-signature-secret#queue-fragment-secret"
    )
    fields = {
        "人工｜状态": "开始验证",
        "link": "https://shop.example/products/portable-blender",
        "人工｜供应商报价来源": raw_source,
        "supplier_quote_source": raw_source,
        "evaluation": {"order": {"supplier_quote_source": raw_source}},
    }
    feishu.list_trigger_records = AsyncMock(
        return_value=[
            TriggerRecord("市场评估表", "quote-safe", "开始验证", "1", fields)
        ]
    )
    poller = TriggerPoller(feishu, job_repo)

    assert await poller.poll_once() == 1
    assert await poller.poll_once() == 0

    async with job_repo._connection() as connection:
        rows = list(
            await connection.execute(
                select(runtime_jobs).where(
                    runtime_jobs.c.payload["record_id"].as_string() == "quote-safe"
                )
            )
        )
    assert len(rows) == 1
    stored = rows[0]._mapping
    safe_fields = {
        **fields,
        "人工｜供应商报价来源": source,
        "supplier_quote_source": source,
        "evaluation": {"order": {"supplier_quote_source": source}},
    }
    assert stored["payload"]["data"] == safe_fields
    assert stored["payload"]["protected_input_hash"] == protected_input_hash(
        safe_fields
    )
    assert stored["status"] == JobStatus.READY.value
    serialized = json.dumps(dict(stored), ensure_ascii=False, default=str) + caplog.text
    for secret in (
        "queue-token-secret",
        "queue-credential-secret",
        "queue-signature-secret",
        "queue-fragment-secret",
        "X-Amz-Credential",
        "X-Amz-Signature",
    ):
        assert secret not in serialized
    assert fields["人工｜供应商报价来源"] == raw_source


@pytest.mark.parametrize(
    "raw_source",
    [
        "https://queue-user-secret:queue-password-secret@supplier.example/quote",
        "https:///quote?token=queue-token-secret",
        "ftp://supplier.example/quote?token=queue-token-secret",
        "https://supplier.example:queue-port-secret/quote",
        "https://[queue-host-secret/quote",
        {"url": "https://supplier.example/quote?token=queue-token-secret"},
    ],
    ids=[
        "userinfo",
        "no-host",
        "non-http",
        "invalid-port",
        "invalid-host",
        "non-string",
    ],
)
async def test_invalid_supplier_source_is_a_redacted_manual_job(
    raw_source, feishu, job_repo, caplog
):
    """Invalid sources must never become ready work or survive an error snapshot."""
    fields = {"人工｜状态": "开始验证", "人工｜供应商报价来源": raw_source}
    feishu.list_trigger_records = AsyncMock(
        return_value=[
            TriggerRecord("市场评估表", "quote-invalid", "开始验证", "1", fields)
        ]
    )
    poller = TriggerPoller(feishu, job_repo)

    assert await poller.poll_once() == 1
    assert await poller.poll_once() == 0

    async with job_repo._connection() as connection:
        stored = (
            (
                await connection.execute(
                    select(runtime_jobs).where(
                        runtime_jobs.c.payload["record_id"].as_string()
                        == "quote-invalid"
                    )
                )
            )
            .one()
            ._mapping
        )
        checkpoints = list(
            await connection.execute(
                select(job_checkpoints).where(job_checkpoints.c.job_id == stored["id"])
            )
        )
    assert stored["status"] == JobStatus.NEEDS_HUMAN.value
    assert stored["failure_code"] == "supplier_quote_source_invalid"
    assert stored["payload"]["data"]["人工｜供应商报价来源"] is None
    assert stored["payload"]["input_error"] == "supplier_quote_source_invalid"
    assert checkpoints == []
    assert await job_repo.lease_next("worker", lease_for=timedelta(minutes=5)) is None
    with pytest.raises(JobNotRequeueableError) as rejected:
        await job_repo.requeue(stored["id"])
    serialized = (
        json.dumps(dict(stored), ensure_ascii=False, default=str)
        + str(rejected.value)
        + caplog.text
    )
    for secret in (
        "queue-user-secret",
        "queue-password-secret",
        "queue-token-secret",
        "queue-port-secret",
        "queue-host-secret",
    ):
        assert secret not in serialized

    feishu.list_trigger_records = AsyncMock(
        return_value=[
            TriggerRecord(
                "市场评估表",
                "quote-invalid",
                "开始验证",
                "2",
                {
                    "人工｜供应商报价来源": "https://www.aliexpress.com/item/100500123.html"
                },
            )
        ]
    )
    await poller.poll_once()
    corrected = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))
    assert corrected is not None
    assert corrected.payload.input_version == "2"
    assert corrected.failure_code is None


def test_supplier_source_hash_ignores_query_credentials_but_tracks_product_path():
    """Canonical snapshots must match current raw Feishu inputs at writeback."""
    source = "https://detail.1688.com/offer/123456789.html"
    assert protected_input_hash(
        {"人工｜供应商报价来源": source}
    ) == protected_input_hash(
        {"人工｜供应商报价来源": source + "?token=ephemeral-secret#fragment-secret"}
    )
    assert protected_input_hash(
        {"人工｜供应商报价来源": source}
    ) != protected_input_hash(
        {"人工｜供应商报价来源": "https://detail.1688.com/offer/987654321.html"}
    )


@pytest.mark.parametrize("source", [None, "", "  "], ids=["null", "empty", "blank"])
async def test_unfilled_supplier_source_does_not_block_initial_research(
    source, feishu, job_repo
):
    """A blank optional cell is missing evidence, not malformed user input."""
    feishu.list_trigger_records = AsyncMock(
        return_value=[
            TriggerRecord(
                "市场评估表",
                "quote-unfilled",
                "开始验证",
                "1",
                {"人工｜供应商报价来源": source},
            )
        ]
    )
    await TriggerPoller(feishu, job_repo).poll_once()

    queued = await job_repo.lease_next("worker", lease_for=timedelta(minutes=5))

    assert queued is not None
    assert queued.payload.data["人工｜供应商报价来源"] is None
    assert queued.payload.input_error is None


@respx.mock
async def test_client_refreshes_tenant_token_once_and_paginates_records(feishu):
    token = respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    records = respx.get(
        API_RECORD_LIST.format(base_token="base-token", table_id="tbl-keyword")
    ).mock(
        side_effect=[
            httpx.Response(200, json=fixture("v3-records-offset-0.json")),
            httpx.Response(200, json=fixture("v3-records-offset-2.json")),
        ]
    )

    result = await feishu.list_records("tbl-keyword")

    assert [item["id"] for item in result] == ["rec-1", "rec-2"]
    assert token.call_count == 1
    assert records.call_count == 2
    assert records.calls[0].request.url.params["limit"] == "100"
    assert records.calls[1].request.url.params["offset"] == "100"


@respx.mock
async def test_client_reads_columnar_record_list_and_batch_get(feishu):
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    columnar = {
        "code": 0,
        "data": {
            "data": [["portable organizer", ["待扫描"]]],
            "fields": ["AUTO｜实际搜索词", "人工｜状态"],
            "field_id_list": ["fld_query", "fld_status"],
            "field_type_list": ["text", "select"],
            "record_id_list": ["rec-columnar"],
            "rev": 31,
            "has_more": False,
        },
    }
    respx.get(
        API_RECORD_LIST.format(base_token="base-token", table_id="tbl-keyword")
    ).mock(return_value=httpx.Response(200, json=columnar))
    respx.post(
        API_RECORD_BATCH_GET.format(base_token="base-token", table_id="tbl-keyword")
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                **columnar,
                "data": {**columnar["data"], "rev": 32},
            },
        )
    )

    listed = await feishu.list_records("tbl-keyword")
    assert listed == [
        {
            "id": "rec-columnar",
            "fields": {
                "AUTO｜实际搜索词": "portable organizer",
                "人工｜状态": ["待扫描"],
            },
        }
    ]
    fetched = await feishu.get_record("tbl-keyword", "rec-columnar")
    assert fetched.record_id == "rec-columnar"
    assert fetched.version.startswith("sha256:")
    assert fetched.version == FeishuClient.record_version(listed[0]).version
    assert fetched.fields["人工｜状态"] == "待扫描"


@respx.mock
async def test_client_resolves_real_table_view_ids_and_uses_v3_record_envelopes(feishu):
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    respx.get(API_TABLE_LIST.format(base_token="base-token")).mock(
        return_value=httpx.Response(200, json=fixture("v3-tables.json"))
    )
    views = respx.get(
        API_VIEW_LIST.format(base_token="base-token", table_id="tbl_niche")
    ).mock(return_value=httpx.Response(200, json=fixture("v3-views.json")))
    records = respx.get(
        API_RECORD_LIST.format(base_token="base-token", table_id="tbl_niche")
    ).mock(
        return_value=httpx.Response(
            200, json={"code": 0, "data": {"records": [], "has_more": False}}
        )
    )

    assert await feishu.list_records("细分领域池", view_name="触发｜待生成") == []

    assert views.call_count == 1
    assert records.calls[0].request.url.params["view_id"] == "vew_niche"


@respx.mock
async def test_record_refetch_uses_batch_get_and_update_uses_top_level_fields(feishu):
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    batch = respx.post(
        API_RECORD_BATCH_GET.format(base_token="base-token", table_id="tbl_market")
    ).mock(return_value=httpx.Response(200, json=fixture("v3-batch-get.json")))
    patch = respx.patch(
        API_RECORD_LIST.format(base_token="base-token", table_id="tbl_market")
        + "/rec-1"
    ).mock(return_value=httpx.Response(200, json=fixture("v3-batch-get.json")))

    assert (await feishu.get_record("tbl_market", "rec-1")).version == "v1"
    await feishu.update_record("tbl_market", "rec-1", {"AUTO｜运行状态": "队列中"})

    assert json.loads(batch.calls[0].request.content) == {"record_id_list": ["rec-1"]}
    assert json.loads(patch.calls[0].request.content) == {"AUTO｜运行状态": "队列中"}


@respx.mock
async def test_v3_table_and_view_creation_envelopes_use_names_and_real_ids(feishu):
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    table = respx.post(API_TABLE_LIST.format(base_token="base-token")).mock(
        return_value=httpx.Response(200, json={"code": 0, "data": {"id": "tbl_new"}})
    )
    view = respx.post(
        API_VIEW_LIST.format(base_token="base-token", table_id="tbl_new")
    ).mock(
        return_value=httpx.Response(200, json={"code": 0, "data": {"id": "vew_new"}})
    )
    filter_update = respx.put(
        API_VIEW_FILTER.format(
            base_token="base-token", table_id="tbl_new", view_id="vew_new"
        )
    ).mock(return_value=httpx.Response(200, json={"code": 0, "data": {}}))
    filter_get = respx.get(
        API_VIEW_FILTER.format(
            base_token="base-token", table_id="tbl_new", view_id="vew_new"
        )
    ).mock(
        return_value=httpx.Response(
            200, json={"code": 0, "data": {"logic": "and", "conditions": []}}
        )
    )

    assert await feishu.create_table("细分领域池") == "tbl_new"
    assert (
        await feishu.create_view(
            "tbl_new", "触发｜待生成", {"logic": "and", "conditions": []}
        )
        == "vew_new"
    )

    assert json.loads(table.calls[0].request.content) == {"name": "细分领域池"}
    assert json.loads(view.calls[0].request.content) == {
        "name": "触发｜待生成",
        "type": "grid",
    }
    assert await feishu.get_view_filter("tbl_new", "vew_new") == {
        "logic": "and",
        "conditions": [],
    }
    assert filter_get.call_count == 1
    await feishu.update_view(
        "tbl_new",
        "vew_new",
        {"logic": "and", "conditions": [["fld", "intersects", ["待生成"]]]},
    )
    assert json.loads(filter_update.calls[0].request.content) == {
        "logic": "and",
        "conditions": [["fld", "intersects", ["待生成"]]],
    }


@respx.mock
async def test_field_create_and_update_parse_direct_field_envelopes(feishu):
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    endpoint = API_FIELD_LIST.format(base_token="base-token", table_id="tbl_market")
    create = respx.post(endpoint).mock(
        return_value=httpx.Response(200, json=fixture("v3-field-create-direct.json"))
    )
    update = respx.put(
        API_FIELD_UPDATE.format(
            base_token="base-token", table_id="tbl_market", field_id="fld_status"
        )
    ).mock(
        return_value=httpx.Response(200, json=fixture("v3-field-update-direct.json"))
    )

    assert (
        await feishu.create_field(
            "tbl_market", {"name": "AUTO｜状态", "type": "select"}
        )
        == "fld_created"
    )
    assert (
        await feishu.update_field(
            "tbl_market", "fld_status", {"name": "AUTO｜状态", "type": "select"}
        )
        == "fld_status"
    )
    assert json.loads(create.calls[0].request.content)["name"] == "AUTO｜状态"
    assert json.loads(update.calls[0].request.content)["type"] == "select"


@respx.mock
async def test_client_honors_retry_after_for_rate_limit(feishu, monkeypatch):
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr("rabbit_hole.integrations.feishu.asyncio.sleep", fake_sleep)
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    endpoint = API_RECORD_LIST.format(base_token="base-token", table_id="tbl-keyword")
    route = respx.get(endpoint).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "3"}, json={"code": 999}),
            httpx.Response(
                200, json={"code": 0, "data": {"items": [], "has_more": False}}
            ),
        ]
    )

    assert await feishu.list_records("tbl-keyword") == []
    assert sleeps == [3.0]
    assert route.call_count == 2


@respx.mock
async def test_client_retries_feishu_concurrent_write_code(feishu, monkeypatch):
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr("rabbit_hole.integrations.feishu.asyncio.sleep", fake_sleep)
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    endpoint = API_RECORD_LIST.format(base_token="base-token", table_id="tbl-keyword")
    route = respx.get(endpoint).mock(
        side_effect=[
            httpx.Response(200, json=fixture("v3-rate-limited-code.json")),
            httpx.Response(
                200, json={"code": 0, "data": {"records": [], "has_more": False}}
            ),
        ]
    )

    assert await feishu.list_records("tbl-keyword") == []
    assert sleeps == [1.0]
    assert route.call_count == 2


async def test_safe_write_refetches_version_and_queues_conflict():
    client = AsyncMock()
    client.get_record.return_value = RecordVersion(
        record_id="p1", version="changed", fields={"人工｜目标市场": "US"}
    )
    outbox = AsyncMock()
    expected = RecordVersion(
        record_id="p1", version="old", fields={"人工｜目标市场": "US"}
    )

    with pytest.raises(WriteConflict):
        await FeishuClient.safe_write(
            client,
            table="市场评估表",
            expected=expected,
            fields={f"{AUTO_FIELD_PREFIX}运行状态": "待人工复核"},
            protected_fields=("人工｜目标市场",),
            outbox=outbox,
        )

    outbox.enqueue.assert_awaited_once()
    assert client.update_record.await_count == 0


async def test_safe_write_queues_outbox_after_write_failure():
    client = AsyncMock()
    client.get_record.return_value = RecordVersion(
        record_id="p1", version="1", fields={}
    )
    client.update_record.side_effect = RuntimeError("network down")
    outbox = AsyncMock()

    with pytest.raises(RuntimeError, match="network down"):
        await FeishuClient.safe_write(
            client,
            table="市场评估表",
            expected=RecordVersion(record_id="p1", version="1", fields={}),
            fields={f"{AUTO_FIELD_PREFIX}运行状态": "待人工复核"},
            protected_fields=(),
            outbox=outbox,
        )

    outbox.enqueue.assert_awaited_once()


async def test_schema_declares_nine_tables_with_owned_fields_and_safe_dry_run():
    schema = BaseSchema.default()
    assert len(schema.tables) == 9
    assert {table.name for table in schema.tables} == {
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
    assert all(table.logical_key in table.field_map for table in schema.tables)
    assert all(
        field.display_name.startswith(("AUTO｜", "人工｜"))
        for table in schema.tables
        for field in table.fields
    )
    coverage = {
        "关键词库": {"chinese_meaning", "synonym_variants", "market"},
        "产品主表": {"category", "niche"},
        "市场评估表": {
            "usd_conversion",
            "human_conclusion",
            "expected_order",
            "bundle_quantity",
            "price",
            "aov",
            "goods_cost",
            "shipping_cost",
            "packaging_cost",
            "tax_cost",
            "ad_cost",
            "payment_rate",
            "payment_fixed",
            "loss_reserve_rate",
            "weight",
            "supplier_quote_unit_cost",
            "supplier_quote_bundle_cost",
            "supplier_quote_confirmed",
            "supplier_quote_valid",
            "supplier_quote_trust",
            "supplier_quote_source",
        },
        "广告与素材": {"rhythm_30s", "comment_signals"},
        "评分记录": {"review_result"},
    }
    assert all(
        keys <= schema_table.field_map.keys()
        for schema_table in schema.tables
        for table, keys in coverage.items()
        if schema_table.name == table
    )
    market_table = next(table for table in schema.tables if table.name == "市场评估表")
    market_fields = market_table.field_map
    required_human_inputs = {
        "expected_order",
        "bundle_quantity",
        "price",
        "aov",
        "goods_cost",
        "shipping_cost",
        "packaging_cost",
        "tax_cost",
        "ad_cost",
        "payment_rate",
        "payment_fixed",
        "loss_reserve_rate",
        "weight",
        "supplier_quote_unit_cost",
        "supplier_quote_bundle_cost",
        "supplier_quote_confirmed",
        "supplier_quote_valid",
        "supplier_quote_trust",
        "supplier_quote_source",
    }
    assert all(market_fields[key].owner == "human" for key in required_human_inputs)

    plan = await bootstrap_base(AsyncMock(), schema=schema, dry_run=True)
    assert plan.tables == 9
    assert plan.destructive_operations == 0
    assert len(plan.views) == 24
    assert all(
        view.field_key is not None and view.state is not None for view in ALL_VIEWS
    )


async def test_bootstrap_adds_missing_select_options_without_destructive_update():
    schema = BaseSchema(
        (
            TableSchema(
                "测试表",
                "key",
                (FieldSchema("key", "AUTO｜键", "select", options=("A", "B")),),
            ),
        )
    )
    client = AsyncMock()
    client.list_tables.return_value = [{"table_name": "测试表", "table_id": "tbl"}]
    client.list_fields.return_value = [
        {
            "id": "fld",
            "name": "AUTO｜键",
            "type": "select",
            "multiple": False,
            "options": [{"name": "A", "color": "blue"}],
            "description": "keep",
        }
    ]
    client.get_field.return_value = {
        "id": "fld",
        "name": "AUTO｜键",
        "type": "select",
        "multiple": False,
        "options": [{"name": "A", "color": "blue"}],
        "description": "keep",
    }

    plan = await bootstrap_base(client, schema=schema)

    assert plan.destructive_operations == 0
    client.update_field.assert_awaited_once()
    assert client.update_field.await_args.args[2]["options"] == [
        {"name": "A", "color": "blue"},
        {"name": "B"},
    ]
    assert client.update_field.await_args.args[2]["description"] == "keep"


@respx.mock
async def test_bootstrap_preserves_direct_field_properties_across_http_list_get_and_put(
    feishu,
):
    schema = BaseSchema(
        (
            TableSchema(
                "测试表",
                "key",
                (FieldSchema("key", "AUTO｜键", "select", options=("A", "B")),),
            ),
        )
    )
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    respx.get(API_TABLE_LIST.format(base_token="base-token")).mock(
        return_value=httpx.Response(
            200,
            json={
                "code": 0,
                "data": {
                    "items": [{"id": "tbl_test", "name": "测试表"}],
                    "has_more": False,
                },
            },
        )
    )
    field_list = respx.get(
        API_FIELD_LIST.format(base_token="base-token", table_id="tbl_test")
    ).mock(
        side_effect=[
            httpx.Response(200, json=fixture("v3-field-list-offset-0.json")),
            httpx.Response(200, json=fixture("v3-field-list-offset-100.json")),
            httpx.Response(200, json=fixture("v3-field-list-offset-0.json")),
            httpx.Response(200, json=fixture("v3-field-list-offset-100.json")),
        ]
    )
    field_get = respx.get(
        API_FIELD_UPDATE.format(
            base_token="base-token", table_id="tbl_test", field_id="fld_status"
        )
    ).mock(return_value=httpx.Response(200, json=fixture("v3-field-get-direct.json")))
    field_put = respx.put(
        API_FIELD_UPDATE.format(
            base_token="base-token", table_id="tbl_test", field_id="fld_status"
        )
    ).mock(
        return_value=httpx.Response(200, json=fixture("v3-field-update-direct.json"))
    )

    plan = await bootstrap_base(feishu, schema=schema)

    expected_existing_option = {
        "id": "opt_a",
        "name": "A",
        "color": "blue",
        "hue": "Blue",
        "lightness": "Lighter",
        "custom_option_property": {"source": "fixture"},
    }
    assert plan.destructive_operations == 0
    assert field_list.call_count == 4
    assert [call.request.url.params["offset"] for call in field_list.calls] == [
        "0",
        "100",
        "0",
        "100",
    ]
    assert field_get.call_count == 1
    assert field_put.call_count == 1
    assert json.loads(field_put.calls[0].request.content) == {
        "name": "AUTO｜键",
        "type": "select",
        "multiple": False,
        "options": [expected_existing_option, {"name": "B"}],
        "style": {
            "type": "plain",
            "format": "fixture-format",
            "custom_style_property": True,
        },
        "description": "keep from GET",
        "field_setting": {"allowed_roles": ["admin"], "locked": True},
        "custom_field_property": {"nested": [1, 2, 3]},
    }


async def test_bootstrap_reconfigures_existing_view_and_creates_missing_view():
    schema = BaseSchema(
        (
            TableSchema(
                "细分领域池",
                "key",
                (
                    FieldSchema(
                        "status",
                        "人工｜状态",
                        "select",
                        owner="human",
                        options=("待生成", "待研究", "待人工选择"),
                    ),
                ),
            ),
        )
    )
    client = AsyncMock()
    field = {
        "id": "fld_status",
        "name": "人工｜状态",
        "type": "select",
        "multiple": False,
        "options": [
            {"name": "待生成"},
            {"name": "待研究"},
            {"name": "待人工选择"},
        ],
    }
    client.list_tables.return_value = [{"id": "tbl_niche", "name": "细分领域池"}]
    client.list_fields.return_value = [field]
    client.get_field.return_value = field
    client.list_views.return_value = [{"id": "vew_research", "name": "运营｜待研究"}]
    client.create_view.side_effect = lambda _table, name, _predicate: name

    async def get_view_filter(_table, view):
        if view == "vew_research":
            return {
                "logic": "and",
                "conditions": [["人工｜状态", "intersects", ["待研究"]]],
            }
        return {"logic": "and", "conditions": []}

    client.get_view_filter.side_effect = get_view_filter

    await bootstrap_base(client, schema=schema)

    assert client.update_view.await_count == 4
    assert client.create_view.await_count == 4


@respx.mock
async def test_directory_lists_follow_numeric_offsets(feishu):
    respx.post(API_TENANT_TOKEN).mock(
        return_value=httpx.Response(200, json=fixture("token.json"))
    )
    route = respx.get(API_TABLE_LIST.format(base_token="base-token")).mock(
        side_effect=[
            httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": [{"id": "tbl_a", "name": "A"}],
                        "has_more": True,
                        "offset": 100,
                    },
                },
            ),
            httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": [{"id": "tbl_b", "name": "B"}],
                        "has_more": False,
                        "offset": 200,
                    },
                },
            ),
        ]
    )
    assert [item["id"] for item in await feishu.list_tables()] == ["tbl_a", "tbl_b"]
    assert route.calls[1].request.url.params["offset"] == "100"


async def test_bootstrap_does_not_put_static_options_over_dynamic_source():
    schema = BaseSchema(
        (
            TableSchema(
                "测试表",
                "key",
                (FieldSchema("key", "AUTO｜键", "select", options=("A",)),),
            ),
        )
    )
    client = AsyncMock()
    client.list_tables.return_value = [{"id": "tbl", "name": "测试表"}]
    direct = {
        "id": "fld",
        "name": "AUTO｜键",
        "type": "select",
        "multiple": False,
        "dynamic_options_source": {"table_id": "tbl", "field_id": "fld"},
    }
    client.list_fields.return_value = [direct]
    client.get_field.return_value = direct
    await bootstrap_base(client, schema=schema)
    client.update_field.assert_not_awaited()


def test_schema_manifest_covers_every_field_contract():
    schema = BaseSchema.default()
    expected = fixture("schema-contract-v1.json")
    actual = {
        "version": 1,
        "tables": [
            {
                "name": table.name,
                "logical_key": table.logical_key,
                "trigger_states": list(table.trigger_states),
                "fields": [
                    {
                        "key": field.key,
                        "display": field.display_name,
                        "type": field.type,
                        "owner": field.owner,
                        "options": list(field.options),
                        "multiple": field.multiple or field.key in MULTI_SELECT_KEYS,
                        "link_target": field.link_table,
                        "formula": field.expression,
                        "style": (
                            {"type": field.style_type}
                            if field.style_type is not None
                            else None
                        ),
                    }
                    for field in table.fields
                ],
            }
            for table in schema.tables
        ],
        "views": [
            {
                "table": view.table,
                "name": view.name,
                "kind": "trigger" if view in TRIGGER_VIEWS else "operation",
                "field_key": view.field_key,
                "state": view.state,
            }
            for view in ALL_VIEWS
        ],
    }

    assert len(expected["tables"]) == 9
    assert sum(len(table["fields"]) for table in expected["tables"]) == 226
    assert len(expected["views"]) == 24
    assert sum(view["kind"] == "trigger" for view in expected["views"]) == 5
    assert actual == expected
