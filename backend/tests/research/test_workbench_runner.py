from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest


async def test_scan_retry_failure_updates_keyword_after_prior_failure(db_engine, monkeypatch):
    from types import SimpleNamespace

    from rabbit_hole.application.actions import SourceFailure, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create('retry status', 'test', 'US', str(uuid4()))
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    runner = WorkbenchRunner(store, SimpleNamespace(), None)

    async def fail_after_running(action, _project):
        await runner.save(action, 'keyword_state', {'keyword_id': word_id, 'status': 'running'}, suffix=str(action['attempt']))
        raise SourceFailure('source_error')

    monkeypatch.setattr(runner, 'execute', fail_after_running)
    await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    await runner.run_once()
    project = await store.get(project['id'])
    assert project['keywords'][0]['status'] == 'blocked'
    await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    await runner.run_once()
    assert (await store.get(project['id']))['keywords'][0]['status'] == 'blocked'


async def test_stop_running_scan_fences_result_and_allows_retry(db_engine):
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import (
        actions,
        enqueue_action,
        get_action,
        stop_action,
    )
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create('stop scan', 'test', 'US', str(uuid4()))
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(status='running', attempt=1))
    project = await store.get(project['id'])
    await store.command(project['id'], project['version'], str(uuid4()), 'keyword_state', {'keyword_id': word_id, 'status': 'running'}, actor='automation')
    stopped = await stop_action(store, project['id'], queued['id'], 1)
    assert stopped['status'] == 'blocked'
    assert '停止' in stopped['diagnostic']
    assert (await store.get(project['id']))['keywords'][0]['status'] == 'blocked'
    assert (await get_action(db_engine, project['id'], queued['id']))['status'] == 'blocked'
    project = await store.get(project['id'])
    retried = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    assert retried['disposition'] == 'retried'
    assert retried['id'] == queued['id']
    await stop_action(store, project['id'], queued['id'], 1)


async def test_stopped_worker_attempt_cannot_write_late_result(db_engine, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from rabbit_hole.application.actions import enqueue_action, get_action, stop_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create('stop in flight', 'test', 'US', str(uuid4()))
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    started, resume = asyncio.Event(), asyncio.Event()

    async def late_result(action, _project):
        started.set()
        await resume.wait()
        await runner.save(action, 'keyword_state', {'keyword_id': word_id, 'status': 'running'}, suffix='late')
        return {'ads': 1}

    monkeypatch.setattr(runner, 'execute', late_result)
    task = asyncio.create_task(runner.run_once())
    await started.wait()
    await stop_action(store, project['id'], queued['id'], 1)
    resume.set()
    assert await task
    assert (await get_action(db_engine, project['id'], queued['id']))['status'] == 'blocked'
    assert (await store.get(project['id']))['keywords'][0]['status'] == 'blocked'


async def test_stop_does_not_hide_already_saved_scan_result(db_engine):
    from rabbit_hole.application.actions import enqueue_action, get_action, stop_action
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create('saved scan', 'test', 'US', str(uuid4()))
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    project = await store.get(project['id'])
    from uuid import NAMESPACE_URL, uuid5

    await store.command(project['id'], project['version'], str(uuid5(NAMESPACE_URL, f"{queued['id']}:collection_result:")), 'collection_result', {'keyword_id': word_id, 'ads': [], 'status': 'complete'}, actor='automation')
    with pytest.raises(WorkbenchError) as error:
        await stop_action(store, project['id'], queued['id'], 0)
    assert error.value.status == 409
    assert (await get_action(db_engine, project['id'], queued['id']))['status'] == 'ready'
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(status='complete'))


async def test_stop_waits_for_inflight_result_commit(db_engine, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from rabbit_hole.application.actions import enqueue_action, get_action, stop_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create('result race', 'test', 'US', str(uuid4()))
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    entered, release = asyncio.Event(), asyncio.Event()
    original_command = store.command

    async def paused_command(*args, **kwargs):
        if args[3] == 'collection_result':
            entered.set()
            await release.wait()
        return await original_command(*args, **kwargs)

    monkeypatch.setattr(store, 'command', paused_command)

    async def save_result(action, _project):
        await runner.save(action, 'collection_result', {'keyword_id': word_id, 'ads': [], 'status': 'complete'})
        return {'ads': 0}

    monkeypatch.setattr(runner, 'execute', save_result)
    running = asyncio.create_task(runner.run_once())
    await entered.wait()
    stopping = asyncio.create_task(stop_action(store, project['id'], queued['id'], 1))
    await asyncio.sleep(0.05)
    release.set()
    assert await running
    with pytest.raises(WorkbenchError) as error:
        await stopping
    assert error.value.status == 409
    assert (await get_action(db_engine, project['id'], queued['id']))['status'] == 'complete'


def test_ad_projection_keeps_age_observation_and_unknown_continuity() -> None:
    from types import SimpleNamespace

    from rabbit_hole.application.actions import ad_projection

    observed_at = datetime(2026, 9, 21, 8, 30, tzinfo=UTC)
    projected = ad_projection(
        SimpleNamespace(
            ad_id="ad-1",
            advertiser="Example",
            start_date=observed_at.date(),
            landing_url="https://shop.example/products/item",
            primary_text="Example ad",
            is_active=True,
            observable_active_days=42,
            observed_at=observed_at,
        )
    )

    assert projected["started_at"] == "2026-09-21"
    assert projected["ad_age_days"] == 42
    assert projected["currently_active"] is True
    assert projected["observed_at"] == "2026-09-21T08:30:00+00:00"
    assert projected["continuity_status"] == "unknown"


@pytest.mark.parametrize(
    "content",
    ['{"keywords":[]}', '{"keywords":[{"text":" ","type":"pain"}]}', "not json"],
)
async def test_invalid_ai_response_never_becomes_durable_cache(
    db_engine, monkeypatch, content
):
    import json
    from types import SimpleNamespace
    from uuid import UUID

    import httpx
    import openai
    from sqlalchemy import select

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    real_client = openai.AsyncOpenAI
    responses = [
        content,
        json.dumps({"keywords": [{"text": "travel pouch", "type": "pain"}]}),
    ]

    def transport(request):
        return httpx.Response(
            200,
            json={
                "id": "completion-1",
                "object": "chat.completion",
                "created": 1,
                "model": "test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": responses.pop(0)},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    monkeypatch.setattr(
        openai,
        "AsyncOpenAI",
        lambda **kw: real_client(
            **kw,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)),
        ),
    )
    store = WorkbenchStore(db_engine)
    p = await store.create("invalid-ai", "test", "US", str(uuid4()))
    queued = await enqueue_action(store, p["id"], {"kind": "keywords", "version": 0})
    runner = WorkbenchRunner(
        store,
        SimpleNamespace(
            openai_api_key="synthetic",
            openai_model="test",
            openai_base_url="https://ai.example/v1",
        ),
        None,
    )
    await runner.run_once()
    async with db_engine.connect() as connection:
        row = (
            (
                await connection.execute(
                    select(actions).where(actions.c.id == UUID(queued["id"]))
                )
            )
            .mappings()
            .one()
        )
    assert row["error_code"] == "invalid_ai_response"
    assert "candidates" not in row["payload"]
    p = await store.get(p["id"])
    assert p["keywords"] == []
    await enqueue_action(store, p["id"], {"kind": "keywords", "version": p["version"]})
    await runner.run_once()
    assert (await store.get(p["id"]))["keywords"][0]["text"] == '"travel pouch"'


async def test_legacy_invalid_ai_cache_is_removed_before_explicit_retry(db_engine):
    from types import SimpleNamespace
    from uuid import UUID

    from sqlalchemy import select, update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create("invalid-legacy-ai", "test", "US", str(uuid4()))
    queued = await enqueue_action(store, p["id"], {"kind": "keywords", "version": 0})
    async with db_engine.begin() as c:
        row = (
            (await c.execute(select(actions).where(actions.c.id == UUID(queued["id"]))))
            .mappings()
            .one()
        )
        await c.execute(
            update(actions)
            .where(actions.c.id == row["id"])
            .values(
                payload={
                    **row["payload"],
                    "candidates": [{"text": " ", "type": "pain"}],
                }
            )
        )
    await WorkbenchRunner(
        store, SimpleNamespace(openai_api_key=None, openai_model=None), None
    ).run_once()
    async with db_engine.connect() as c:
        row = (
            (await c.execute(select(actions).where(actions.c.id == UUID(queued["id"]))))
            .mappings()
            .one()
        )
    assert row["error_code"] == "invalid_ai_response"
    assert "candidates" not in row["payload"]


def test_ai_validation_uses_real_source_and_discards_invalid_entries():
    from rabbit_hole.application.actions import validated_candidates

    candidates, ignored = validated_candidates(
        [
            {"text": "travel pouch", "type": "pain", "source_quote": "fits a carry-on"},
            {"text": "travel pouch", "type": "pain", "source_quote": "fits a carry-on"},
            {
                "text": "other bag",
                "type": "function",
                "source_quote": "invented passage",
            },
            {"text": "收纳", "type": "pain"},
            {"text": " ", "type": "pain"},
            {"text": "good bag", "type": "bad-type"},
        ],
        source="This pouch fits a carry-on.",
    )
    assert candidates == [
        {"text": "travel pouch", "type": "pain", "source_quote": "fits a carry-on"}
    ]
    assert ignored == 5


def test_ai_validation_normalizes_nested_quotes_before_deduplication():
    from rabbit_hole.application.actions import validated_candidates

    candidates, ignored = validated_candidates(
        [
            {"text": '"portable organizer" travel', "type": "scenario"},
            {"text": "portable organizer travel", "type": "scenario"},
        ]
    )

    assert candidates == [{"text": "portable organizer travel", "type": "scenario"}]
    assert ignored == 1


def test_ai_validation_keeps_explicit_compound_keyword_types():
    from rabbit_hole.application.actions import validated_candidates

    candidates, ignored = validated_candidates(
        [
            {"text": "messy suitcase travel", "type": "pain_scenario"},
            {"text": "office traveler", "type": "scenario_audience"},
        ]
    )

    assert [item["type"] for item in candidates] == [
        "pain_scenario",
        "scenario_audience",
    ]
    assert ignored == 0


def test_ai_validation_requires_declared_single_source():
    from rabbit_hole.application.actions import validated_candidates
    from rabbit_hole.domain.provenance import SourcePassage

    source = SourcePassage(
        source_id="landing:product:1:hash",
        source_kind="landing",
        product_id="product",
        identity_revision=1,
        text="This pouch fits a carry-on.",
        content_hash="hash",
    )
    valid, ignored = validated_candidates(
        [
            {
                "text": "travel pouch",
                "type": "pain",
                "source_id": source.source_id,
                "source_kind": "landing",
                "source_quote": "fits a carry-on",
            }
        ],
        sources={source.source_id: source},
    )
    assert ignored == 0
    assert valid[0]["source_id"] == source.source_id

    invalid, ignored = validated_candidates(
        [
            {
                "text": "other pouch",
                "type": "pain",
                "source_id": "ad:other-product:1:keyword:ad",
                "source_kind": "ad",
                "source_quote": "fits a carry-on",
            }
        ],
        sources={source.source_id: source},
    )
    assert invalid == []
    assert ignored == 1


async def _expansion_action_fixture(db_engine):
    from rabbit_hole.application.actions import enqueue_action
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create(
        "cached expansion", "travel storage", "US", str(uuid4())
    )
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_keyword",
        {"text": "packing cubes", "type": "category"},
    )
    root = project["keywords"][0]
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_product",
        {
            "name": "Compression cubes",
            "url": "https://shop.example/p/cubes",
            "source_keyword_ids": [root["id"]],
        },
    )
    product = project["products"][0]
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "identify",
        {
            "product_id": product["id"],
            "name": product["name"],
            "url": product["url"],
            "relevance_confirmed": True,
            "active_days": 45,
            "reason": "The source matches the product.",
            "creatives": [
                {
                    "id": f"creative-{i}",
                    "source_url": f"https://facebook.com/{i}",
                    "distinct": True,
                    "active": True,
                }
                for i in range(3)
            ],
        },
    )
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "landing_result",
        {
            "product_id": product["id"],
            "source_url": product["url"],
            "observed_at": datetime.now(UTC).isoformat(),
            "snapshot": {
                "body_text": "These cubes fit inside carry-on luggage.",
                "content_hash": "current",
            },
        },
        actor="automation",
    )
    action = await enqueue_action(
        store,
        project["id"],
        {
            "kind": "expand",
            "version": project["version"],
            "keyword_id": root["id"],
            "product_id": product["id"],
        },
    )
    return store, project, root, product, action


async def test_v1_expansion_cache_blocks_without_replaying_candidates(db_engine):
    from types import SimpleNamespace
    from uuid import UUID

    from sqlalchemy import select, update

    from rabbit_hole.application.actions import actions
    from rabbit_hole.application.runner import WorkbenchRunner

    store, project, root, _product, queued = await _expansion_action_fixture(db_engine)
    async with db_engine.begin() as connection:
        row = (
            (
                await connection.execute(
                    select(actions).where(actions.c.id == UUID(queued["id"]))
                )
            )
            .mappings()
            .one()
        )
        await connection.execute(
            update(actions)
            .where(actions.c.id == row["id"])
            .values(
                payload={
                    **row["payload"],
                    "candidate_cache_version": 1,
                    "candidates": [
                        {
                            "text": "carry on organizer",
                            "type": "scenario",
                            "source_quote": "fit inside carry-on luggage",
                        }
                    ],
                }
            )
        )
    assert await WorkbenchRunner(
        store, SimpleNamespace(openai_api_key=None, openai_model=None), None
    ).run_once()
    async with db_engine.connect() as connection:
        row = (
            (
                await connection.execute(
                    select(actions).where(actions.c.id == UUID(queued["id"]))
                )
            )
            .mappings()
            .one()
        )
    assert row["error_code"] == "source_contract_changed"
    assert "candidates" not in row["payload"]
    assert (await store.get(project["id"]))["keywords"] == [root]


async def test_v2_expansion_cache_resumes_only_with_current_source(db_engine):
    from types import SimpleNamespace
    from uuid import UUID

    from sqlalchemy import select, update

    from rabbit_hole.application.actions import actions
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.domain.provenance import source_passages

    store, project, _root, product, queued = await _expansion_action_fixture(db_engine)
    passage = source_passages(project, product["id"])[0]
    async with db_engine.begin() as connection:
        row = (
            (
                await connection.execute(
                    select(actions).where(actions.c.id == UUID(queued["id"]))
                )
            )
            .mappings()
            .one()
        )
        await connection.execute(
            update(actions)
            .where(actions.c.id == row["id"])
            .values(
                payload={
                    **row["payload"],
                    "candidate_cache_version": 2,
                    "candidates": [
                        {
                            "text": "carry on organizer",
                            "type": "scenario",
                            "source_id": passage.source_id,
                            "source_kind": passage.source_kind,
                            "source_quote": "fit inside carry-on luggage",
                        }
                    ],
                }
            )
        )
    assert await WorkbenchRunner(
        store, SimpleNamespace(openai_api_key=None, openai_model=None), None
    ).run_once()
    saved = await store.get(project["id"])
    assert saved["keywords"][-1]["source_id"] == passage.source_id


async def test_legacy_partial_ai_cache_keeps_acknowledged_command_indices(db_engine):
    from types import SimpleNamespace
    from uuid import NAMESPACE_URL, UUID, uuid5

    from sqlalchemy import select, update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create("partial legacy cache", "test", "US", str(uuid4()))
    q = await enqueue_action(store, p["id"], {"kind": "keywords", "version": 0})
    first = {"text": "travel pouch", "type": "pain"}
    second = {"text": "packing cube", "type": "function"}
    await store.command(
        p["id"],
        0,
        str(uuid5(NAMESPACE_URL, f"{q['id']}:add_keyword:1")),
        "add_keyword",
        first,
        actor="automation",
    )
    async with db_engine.begin() as c:
        row = (
            (await c.execute(select(actions).where(actions.c.id == UUID(q["id"]))))
            .mappings()
            .one()
        )
        await c.execute(
            update(actions)
            .where(actions.c.id == row["id"])
            .values(payload={**row["payload"], "candidates": [None, first, second]})
        )
    await WorkbenchRunner(
        store, SimpleNamespace(openai_api_key=None, openai_model=None), None
    ).run_once()
    p = await store.get(p["id"])
    assert {w["text"] for w in p["keywords"]} == {'"travel pouch"', '"packing cube"'}


def test_scan_ad_projection_does_not_claim_creative_confirmation():
    from rabbit_hole.application.actions import ad_projection
    from rabbit_hole.integrations.collectors.meta import MetaAd

    result = ad_projection(
        MetaAd(
            ad_id="123",
            advertiser="Shop",
            is_active=True,
            query="portable organizer",
            landing_url="https://shop.example/products/a",
        )
    )
    assert result["id"] == "123"
    assert result["active"] is True
    assert "verified_creatives" not in result
    assert result["landing_url"] == "https://shop.example/products/a"


async def test_ai_resume_uses_durable_suggestions_without_api_credentials(db_engine):
    from types import SimpleNamespace
    from uuid import UUID

    from sqlalchemy import select, update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create("cached-ai", "test", "US", str(uuid4()))
    q = await enqueue_action(
        store, p["id"], {"kind": "keywords", "version": p["version"]}
    )
    async with db_engine.begin() as c:
        row = dict(
            (await c.execute(select(actions).where(actions.c.id == UUID(q["id"]))))
            .mappings()
            .one()
        )
        payload = {
            **row["payload"],
            "candidates": [
                {"text": "travel pouch", "type": "category", "meaning": "旅行袋"}
            ],
        }
        await c.execute(
            update(actions).where(actions.c.id == row["id"]).values(payload=payload)
        )
    runner = WorkbenchRunner(
        store, SimpleNamespace(openai_api_key=None, openai_model=None), None
    )
    assert await runner.run_once()
    result = await store.get(p["id"])
    assert result["keywords"][0]["text"] == '"travel pouch"'


@pytest.mark.asyncio
async def test_queue_cannot_run_unapproved_word_without_creating_action(db_engine):
    from rabbit_hole.application.actions import enqueue_action
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create("runner-test", "test", "US", str(uuid4()))
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_keyword",
        {"text": "organizer", "type": "function"},
    )
    with pytest.raises(Exception, match="审核"):
        await enqueue_action(
            store,
            project["id"],
            {
                "kind": "scan",
                "version": project["version"],
                "keyword_id": project["keywords"][0]["id"],
            },
        )


async def test_ai_retries_count_towards_budget(db_engine):
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create("budget-test", "test", "US", str(uuid4()))
    result = await enqueue_action(
        store, p["id"], {"kind": "keywords", "version": p["version"]}
    )
    async with db_engine.begin() as c:
        await c.execute(
            update(actions)
            .where(actions.c.id == UUID(result["id"]))
            .values(status="blocked", attempt=10)
        )
    with pytest.raises(WorkbenchError, match="上限"):
        await enqueue_action(
            store, p["id"], {"kind": "keywords", "version": p["version"]}
        )


@pytest.mark.asyncio
async def test_approved_queue_persists_keyword_state_and_result(db_engine):
    from types import SimpleNamespace

    from sqlalchemy import select, update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create("queue-contract", "test", "US", str(uuid4()))
    p = await store.command(
        p["id"],
        0,
        str(uuid4()),
        "add_keyword",
        {"text": "organizer", "type": "function"},
    )
    kid = p["keywords"][0]["id"]
    p = await store.command(
        p["id"],
        p["version"],
        str(uuid4()),
        "approve_keyword",
        {"keyword_id": kid, "approved": True},
    )
    queued = await enqueue_action(
        store, p["id"], {"version": p["version"], "kind": "scan", "keyword_id": kid}
    )
    p = await store.get(p["id"])
    assert p["keywords"][0]["status"] == "queued"
    async with db_engine.begin() as c:
        from uuid import UUID

        await c.execute(
            update(actions)
            .where(actions.c.id == UUID(queued["id"]))
            .values(status="running", attempt=1)
        )
        row = dict(
            (await c.execute(select(actions).where(actions.c.id == UUID(queued["id"]))))
            .mappings()
            .one()
        )
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    result = await runner.save(
        row, "collection_result", {"keyword_id": kid, "status": "complete", "ads": []}
    )
    assert result["keywords"][0]["status"] == "complete"
    # Simulate process loss after the result commit but before action completion.
    async with db_engine.begin() as c:
        await c.execute(
            update(actions)
            .where(actions.c.id == row["id"])
            .values(status="running", lease_until=datetime(2000, 1, 1, tzinfo=UTC))
        )

    async def must_not_refetch(*args):
        raise AssertionError("Committed source result must not be fetched again")

    runner.execute = must_not_refetch
    assert await runner.run_once()
    async with db_engine.connect() as c:
        recovered = (
            (await c.execute(select(actions).where(actions.c.id == row["id"])))
            .mappings()
            .one()
        )
    assert recovered["status"] == "complete"
    assert recovered["result"]["recovered"] is True


async def test_configured_ai_limit_counts_attempts_and_retry_reservations(db_engine):
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create("configured-ai-budget", "test", "US", str(uuid4()))
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "configure_rules",
        {"rules": {"ai_daily_limit": 1}, "reason": "One AI attempt per day"},
    )
    queued = await enqueue_action(
        store, project["id"], {"kind": "keywords", "version": project["version"]}
    )
    async with db_engine.begin() as connection:
        await connection.execute(
            update(actions)
            .where(actions.c.id == UUID(queued["id"]))
            .values(status="blocked", attempt=1)
        )

    with pytest.raises(WorkbenchError, match="1"):
        await enqueue_action(
            store,
            project["id"],
            {"kind": "keywords", "version": project["version"]},
        )


async def test_configured_daily_scan_budget_is_enforced_by_queue(db_engine):
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create("configured-scan-budget", "test", "US", str(uuid4()))
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "configure_rules",
        {
            "rules": {"scan_batch_limit": 5, "daily_scan_budget": 1},
            "reason": "One scan per UTC day for this project",
        },
    )
    for word in ("organizer", "packing cube"):
        project = await store.command(
            project["id"],
            project["version"],
            str(uuid4()),
            "add_keyword",
            {"text": word, "type": "function"},
        )
        project = await store.command(
            project["id"],
            project["version"],
            str(uuid4()),
            "approve_keyword",
            {"keyword_id": project["keywords"][-1]["id"], "approved": True},
        )
    first, second = (word["id"] for word in project["keywords"])
    queued = await enqueue_action(
        store,
        project["id"],
        {"kind": "scan", "version": project["version"], "keyword_id": first},
    )
    project = await store.get(project["id"])
    with pytest.raises(WorkbenchError, match="预算"):
        await enqueue_action(
            store,
            project["id"],
            {"kind": "scan", "version": project["version"], "keyword_id": second},
        )
    async with db_engine.begin() as connection:
        await connection.execute(
            update(actions)
            .where(actions.c.id == UUID(queued["id"]))
            .values(status="complete")
        )


async def test_historical_scan_actions_do_not_lock_future_daily_budget(db_engine):
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create("daily-reset", "test", "US", str(uuid4()))
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "configure_rules",
        {
            "rules": {"scan_batch_limit": 20, "daily_scan_budget": 20},
            "reason": "Twenty scans per UTC day",
        },
    )
    for index in range(21):
        project = await store.command(
            project["id"],
            project["version"],
            str(uuid4()),
            "add_keyword",
            {"text": f"keyword {index}", "type": "function"},
        )
        project = await store.command(
            project["id"],
            project["version"],
            str(uuid4()),
            "approve_keyword",
            {"keyword_id": project["keywords"][-1]["id"], "approved": True},
        )
    for keyword in project["keywords"][:20]:
        latest = await store.get(project["id"])
        await enqueue_action(
            store,
            project["id"],
            {
                "kind": "scan",
                "version": latest["version"],
                "keyword_id": keyword["id"],
            },
        )
    yesterday = datetime.now(UTC) - timedelta(days=1)
    async with db_engine.begin() as connection:
        await connection.execute(
            update(actions)
            .where(actions.c.project_id == UUID(project["id"]))
            .values(status="complete", created_at=yesterday, updated_at=yesterday)
        )
    latest = await store.get(project["id"])

    current = await enqueue_action(
        store,
        project["id"],
        {
            "kind": "scan",
            "version": latest["version"],
            "keyword_id": latest["keywords"][20]["id"],
        },
    )

    assert current["status"] == "ready"
    assert current["disposition"] == "queued"
    async with db_engine.begin() as connection:
        await connection.execute(
            update(actions)
            .where(actions.c.id == UUID(current["id"]))
            .values(status="complete")
        )


async def test_batch_scan_returns_partial_outcomes_without_losing_queue(db_engine):
    from rabbit_hole.application.actions import enqueue_action, list_actions
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create("batch-outcomes", "test", "US", str(uuid4()))
    p = await store.command(
        p["id"],
        0,
        str(uuid4()),
        "configure_rules",
        {
            "rules": {"scan_batch_limit": 1, "daily_scan_budget": 10},
            "reason": "one keyword per manual batch",
        },
    )
    for text in ("travel pouch", "packing cube", "small bag"):
        p = await store.command(
            p["id"],
            p["version"],
            str(uuid4()),
            "add_keyword",
            {"text": text, "type": "pain"},
        )
        p = await store.command(
            p["id"],
            p["version"],
            str(uuid4()),
            "approve_keyword",
            {"keyword_id": p["keywords"][-1]["id"], "approved": True},
        )
    result = await enqueue_action(
        store, p["id"], {"kind": "scan_all", "version": p["version"]}
    )
    assert result["requested"] == 1
    assert result["queued"] == 1
    assert result["unchanged"] == 0
    assert result["failed"] == []
    assert len((await list_actions(db_engine, p["id"]))["actions"]) == 1
    latest = await store.get(p["id"])
    repeated = await enqueue_action(
        store,
        p["id"],
        {
            "kind": "scan",
            "version": latest["version"],
            "keyword_id": p["keywords"][0]["id"],
        },
    )
    assert repeated["disposition"] == "unchanged"
    assert len((await list_actions(db_engine, p["id"]))["actions"]) == 1
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions

    async with db_engine.begin() as c:
        await c.execute(
            update(actions)
            .where(actions.c.project_id == UUID(p["id"]))
            .values(status="complete")
        )


async def test_queued_ai_action_blocks_when_rule_snapshot_changes(db_engine):
    from types import SimpleNamespace
    from uuid import UUID

    from sqlalchemy import select

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create("stale-rule-action", "test", "US", str(uuid4()))
    queued = await enqueue_action(
        store, project["id"], {"kind": "keywords", "version": project["version"]}
    )
    project = await store.get(project["id"])
    await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "configure_rules",
        {"rules": {"ai_daily_limit": 5}, "reason": "Reduce daily AI budget"},
    )
    runner = WorkbenchRunner(
        store,
        SimpleNamespace(openai_api_key=None, openai_model=None),
        None,
    )

    assert await runner.run_once()
    async with db_engine.connect() as connection:
        row = (
            (
                await connection.execute(
                    select(actions).where(actions.c.id == UUID(queued["id"]))
                )
            )
            .mappings()
            .one()
        )
    assert row["status"] == "blocked"
    assert row["error_code"] == "input_changed"


def test_ai_daily_usage_does_not_move_old_attempts_to_today():
    from datetime import UTC, datetime

    from rabbit_hole.application.actions import ai_usage

    now = datetime(2026, 9, 17, tzinfo=UTC)
    row = {
        "attempt": 11,
        "updated_at": now,
        "status": "blocked",
        "payload": {"ai_usage": {"2026-09-16": 10, "2026-09-17": 1}},
    }
    assert ai_usage([row], now, reservations=True) == 1
    row["status"] = "ready"
    assert ai_usage([row], now, reservations=True) == 2
    assert ai_usage([row], now, reservations=False) == 1
    row["payload"]["candidates"] = [{"text": "saved"}]
    assert ai_usage([row], now, reservations=True) == 1


async def test_legacy_retry_keeps_prior_day_and_cached_recovery_ignores_limit(
    db_engine,
):
    from datetime import UTC, datetime, timedelta
    from uuid import UUID

    from sqlalchemy import select, update

    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create("legacy retry", "test", "US", str(uuid4()))
    action = await enqueue_action(store, p["id"], {"kind": "keywords", "version": 0})
    yesterday = datetime.now(UTC) - timedelta(days=1)
    async with db_engine.begin() as c:
        await c.execute(
            update(actions)
            .where(actions.c.id == UUID(action["id"]))
            .values(status="blocked", attempt=10, updated_at=yesterday)
        )
    await enqueue_action(store, p["id"], {"kind": "keywords", "version": 0})
    async with db_engine.begin() as c:
        row = (
            (await c.execute(select(actions).where(actions.c.id == UUID(action["id"]))))
            .mappings()
            .one()
        )
        assert row["payload"]["ai_usage"][yesterday.date().isoformat()] == 10
        payload = dict(row["payload"])
        payload.update(
            ai_usage={datetime.now(UTC).date().isoformat(): 10},
            candidates=[{"text": "cached"}],
        )
        await c.execute(
            update(actions)
            .where(actions.c.id == UUID(action["id"]))
            .values(status="blocked", payload=payload)
        )
    assert (await enqueue_action(store, p["id"], {"kind": "keywords", "version": 0}))[
        "status"
    ] == "ready"


async def test_action_history_uses_stable_cursor_and_project_bound_lookup(db_engine):
    from uuid import UUID

    from sqlalchemy import insert

    from rabbit_hole.application.actions import actions, get_action, list_actions
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    first = await store.create("cursor one", "test", "US", str(uuid4()))
    second = await store.create("cursor two", "test", "US", str(uuid4()))
    stamp = datetime.now(UTC)
    ids = [UUID(int=value) for value in (1, 2, 3)]
    async with db_engine.begin() as connection:
        for action_id in ids:
            await connection.execute(
                insert(actions).values(
                    id=action_id,
                    dedupe_key=f"cursor:{action_id}",
                    project_id=UUID(first["id"]),
                    kind="keywords",
                    status="complete",
                    input_version=0,
                    payload={},
                    result={"observed_at": stamp.isoformat()},
                    created_at=stamp,
                    updated_at=stamp,
                    attempt=1,
                )
            )

    page = await list_actions(db_engine, first["id"], limit=2)
    assert [item["id"] for item in page["actions"]] == [str(ids[2]), str(ids[1])]
    assert page["next_cursor"]
    older = await list_actions(
        db_engine, first["id"], limit=2, cursor=page["next_cursor"]
    )
    assert [item["id"] for item in older["actions"]] == [str(ids[0])]
    assert older["next_cursor"] is None
    assert await get_action(db_engine, first["id"], str(ids[0])) is not None
    assert await get_action(db_engine, second["id"], str(ids[0])) is None


async def test_scan_action_stats_count_attempts_and_completed_within_one_project(db_engine):
    from uuid import UUID

    from sqlalchemy import insert

    from rabbit_hole.application.actions import actions, scan_action_stats
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    first = await store.create("scan stats one", "travel", "US", str(uuid4()))
    second = await store.create("scan stats two", "travel", "US", str(uuid4()))
    stamp = datetime.now(UTC)
    rows = [
        (first["id"], "word-1", "blocked", 2),
        (first["id"], "word-1", "complete", 3),
        (first["id"], "word-1", "ready", 0),
        (first["id"], "word-2", "complete", 1),
        (second["id"], "word-1", "complete", 9),
        (first["id"], "word-1", "complete", 4),
    ]
    async with db_engine.begin() as connection:
        for project_id, keyword_id, status, attempt in rows:
            action_id = uuid4()
            await connection.execute(insert(actions).values(
                id=action_id, dedupe_key=f"scan-stats:{action_id}",
                project_id=UUID(project_id), keyword_id=keyword_id,
                kind="scan" if attempt != 4 else "landing",
                status=status, input_version=0, payload={}, result={},
                created_at=stamp, updated_at=stamp, attempt=attempt,
            ))

    assert await scan_action_stats(db_engine, first["id"]) == {
        "word-1": {"attempts": 5, "completed": 1},
        "word-2": {"attempts": 1, "completed": 1},
    }


async def test_action_pages_are_complete_stable_and_strictly_validated(db_engine):
    import base64
    import json
    from uuid import UUID

    from sqlalchemy import insert

    from rabbit_hole.application.actions import actions, list_actions
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    project = await store.create("long action history", "test", "US", str(uuid4()))
    stamp = datetime.now(UTC)
    rows = [
        {
            "id": UUID(int=(1 << 64) + value),
            "dedupe_key": f"long-cursor:{value}",
            "project_id": UUID(project["id"]),
            "kind": "keywords",
            "status": "complete",
            "input_version": 0,
            "payload": {},
            "result": {},
            "created_at": stamp,
            "updated_at": stamp,
            "attempt": 1,
        }
        for value in range(1, 106)
    ]
    async with db_engine.begin() as connection:
        await connection.execute(insert(actions), rows)

    seen: list[str] = []
    cursor = None
    while True:
        page = await list_actions(db_engine, project["id"], limit=20, cursor=cursor)
        seen.extend(item["id"] for item in page["actions"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(seen) == len(set(seen)) == 105

    for invalid_limit in (True, 0, 101):
        with pytest.raises(ValueError, match="limit"):
            await list_actions(db_engine, project["id"], limit=invalid_limit)

    forged = base64.urlsafe_b64encode(
        json.dumps(
            {
                "created_at": stamp.isoformat(),
                "id": str(UUID(int=(1 << 64) + 1)),
                "extra": "not allowed",
            }
        ).encode()
    ).decode()
    with pytest.raises(ValueError, match="cursor"):
        await list_actions(db_engine, project["id"], cursor=forged)
