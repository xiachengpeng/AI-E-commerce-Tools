"""Automatic relevance must be grounded, fenced, and separate from selection."""
from copy import deepcopy
from datetime import UTC, datetime

import pytest

from rabbit_hole.domain.project import WorkbenchError, apply_command, new_project

NOW = datetime(2026, 10, 8, 1, tzinfo=UTC)


def fixture():
    state = new_project("Travel", "travel storage", "US", now=NOW)
    def command(kind, payload, actor="automation"):
        apply_command(state, kind, payload, actor=actor, now=NOW)
    command("add_keyword", {"text": "organizer", "type": "function"}, "user")
    word = state["keywords"][0]
    command("approve_keyword", {"keyword_id": word["id"], "approved": True}, "user")
    command("collection_result", {"keyword_id": word["id"], "status": "complete", "ads": [{
        "id": "ad1", "advertiser": "Travel", "landing_url": "https://shop.example/products/cubes",
        "primary_text": "Packing cubes keep travel essentials organized.", "active": True}]})
    product = state["products"][0]
    command("landing_result", {"product_id": product["id"], "snapshot": {
        "body_text": "Packing cubes. Organize travel essentials in your suitcase.",
        "title": "Packing cubes", "page_type": "product",
        "final_url": product["url"]}, "source_url": product["url"], "observed_at": NOW.isoformat()})
    return state, word, product


def assessment(state, product):
    from rabbit_hole.domain.provenance import source_passages
    from rabbit_hole.domain.verification import verification_fingerprint
    sources = source_passages(state, product["id"])
    return {"product_id": product["id"], "status": "matched", "confidence": "high", "keyword_relevant": True,
        "name": "Packing cubes", "reason": "商品页与广告都描述旅行收纳袋，链接为当前商品。",
        "fingerprint": verification_fingerprint(state, product),
        "citations": [{"source_id": s.source_id, "source_kind": s.source_kind,
                      "source_quote": "Packing cubes", "content_hash": s.content_hash}
                     for s in sources]}


def test_ai_match_unlocks_expansion_without_passing_coarse_gate():
    state, _, product = fixture()
    apply_command(state, "verification_result", {"assessments": [assessment(state, product)]},
                  actor="automation", now=NOW)
    assert product["identification"]["relevance_confirmed"] is True
    assert product["identification"]["confirmation_method"] == "ai"
    assert product["identification"]["passed"] is False
    assert product["triage"]["state"] == "pending"
    assert product["verification"]["status"] == "matched"


@pytest.mark.parametrize("mutation", ["fake_quote", "one_source", "low_confidence", "wrong_hash"])
def test_unsupported_match_stays_for_review(mutation):
    state, _, product = fixture()
    item = assessment(state, product)
    if mutation == "fake_quote": item["citations"][0]["source_quote"] = "Fabricated evidence"
    if mutation == "one_source": item["citations"] = item["citations"][:1]
    if mutation == "low_confidence": item["confidence"] = "low"
    if mutation == "wrong_hash": item["citations"][0]["content_hash"] = "other"
    apply_command(state, "verification_result", {"assessments": [item]}, actor="automation", now=NOW)
    assert not product["identification"].get("relevance_confirmed")
    assert product["verification"]["status"] == "needs_review"


def test_changed_identity_or_sources_cannot_apply_cached_match():
    state, _, product = fixture()
    item = assessment(state, product)
    product["landing_snapshot"]["body_text"] = "A different product"
    product["landing_snapshot"]["content_hash"] = "different"
    apply_command(state, "verification_result", {"assessments": [item]}, actor="automation", now=NOW)
    assert not product["identification"].get("relevance_confirmed")
    assert product["verification"]["status"] == "needs_review"


def test_manual_confirmation_is_never_overwritten_by_ai():
    state, _, product = fixture()
    item = assessment(state, product)
    apply_command(state, "confirm_product", {"product_id": product["id"], "name": "User choice",
        "url": product["url"], "reason": "已经人工核对", "relevance_confirmed": True},
        actor="user", now=NOW)
    original = deepcopy(product["identification"])
    apply_command(state, "verification_result", {"assessments": [item]}, actor="automation", now=NOW)
    assert product["identification"] == original


def test_verification_result_is_not_a_user_writable_command():
    state, _, product = fixture()
    with pytest.raises(WorkbenchError):
        apply_command(state, "verification_result", {"assessments": [assessment(state, product)]},
                      actor="user", now=NOW)

async def test_batch_verification_queues_page_reads_once_and_is_idempotent(db_engine):
    from rabbit_hole.application.actions import enqueue_action, list_actions
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    project = await store.create("Batch", "travel storage", "US", __import__("uuid").uuid4().hex)
    project = await store.command(project["id"], project["version"], __import__("uuid").uuid4().hex,
        "add_keyword", {"text": "organizer", "type": "function"})
    wid = project["keywords"][0]["id"]
    project = await store.command(project["id"], project["version"], __import__("uuid").uuid4().hex,
        "approve_keyword", {"keyword_id": wid, "approved": True})
    project = await store.command(project["id"], project["version"], __import__("uuid").uuid4().hex,
        "collection_result", {"keyword_id": wid, "status": "complete", "ads": [{
            "id": "batch-ad", "advertiser": "Travel", "landing_url": "https://shop.example/products/cubes",
            "primary_text": "Packing cubes keep travel essentials organized.", "active": True}]},
        actor="automation")
    data = {"kind": "verify", "version": project["version"], "keyword_id": wid, "landing_mode": "local"}
    import asyncio
    first, second = await asyncio.gather(
        enqueue_action(store, project["id"], data), enqueue_action(store, project["id"], data))
    assert first["id"] == second["id"]
    assert second["disposition"] == "unchanged"
    rows = (await list_actions(db_engine, project["id"]))["actions"]
    assert sorted(a["kind"] for a in rows) == ["landing", "verify"]


async def test_verification_stop_also_fences_its_owned_page_reads(db_engine):
    from uuid import uuid4

    from rabbit_hole.application.actions import enqueue_action, get_action, stop_action
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    project = await store.create("Stop batch", "travel storage", "US", str(uuid4()))
    project = await store.command(project["id"], project["version"], str(uuid4()),
        "add_keyword", {"text": "organizer", "type": "function"})
    wid = project["keywords"][0]["id"]
    project = await store.command(project["id"], project["version"], str(uuid4()),
        "add_product", {"name": "Travel", "url": "https://shop.example/products/cubes",
                        "source_keyword_ids": [wid]})
    batch = await enqueue_action(store, project["id"],
        {"kind": "verify", "version": project["version"], "keyword_id": wid, "landing_mode": "local"})
    await stop_action(store, project["id"], batch["id"], 0)
    from rabbit_hole.application.actions import list_actions
    rows = (await list_actions(db_engine, project["id"]))["actions"]
    assert all(a["status"] == "blocked" for a in rows)
    assert (await get_action(db_engine, project["id"], batch["id"]))["error_code"] == "stopped"

async def test_real_runner_batch_uses_one_ai_request_and_keeps_selection_manual(db_engine, monkeypatch):
    import json
    from types import SimpleNamespace
    from uuid import uuid4

    from sqlalchemy import delete

    from rabbit_hole.application.actions import actions, enqueue_action, get_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.integrations.ai_settings import AISettings
    from rabbit_hole.persistence.projects import WorkbenchStore

    async with db_engine.begin() as c:
        await c.execute(delete(actions))
    store = WorkbenchStore(db_engine)
    project = await store.create("AI batch", "travel storage", "US", str(uuid4()))
    project = await store.command(project["id"], project["version"], str(uuid4()),
        "add_keyword", {"text": "organizer", "type": "function"})
    wid = project["keywords"][0]["id"]
    project = await store.command(project["id"], project["version"], str(uuid4()),
        "approve_keyword", {"keyword_id": wid, "approved": True})
    project = await store.command(project["id"], project["version"], str(uuid4()),
        "collection_result", {"keyword_id": wid, "status": "complete", "ads": [{
            "id": "ai-ad", "advertiser": "Travel", "landing_url": "https://shop.example/products/cubes",
            "primary_text": "Packing cubes keep travel essentials organized.", "active": True}]},
        actor="automation")
    product = project["products"][0]
    project = await store.command(project["id"], project["version"], str(uuid4()),
        "landing_result", {"product_id": product["id"], "snapshot": {
            "body_text": "Packing cubes. Organize travel essentials in your suitcase.",
            "title": "Packing cubes", "page_type": "product", "final_url": product["url"]},
            "source_url": product["url"], "observed_at": NOW.isoformat()}, actor="automation")
    calls = []
    class FakeClient:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        async def create(self, **kwargs):
            calls.append(kwargs)
            entries = json.loads(kwargs["messages"][1]["content"])
            rows = [{"product_id": e["product_id"], "name": "Packing cubes",
                     "status": "matched", "confidence": "high", "keyword_relevant": True,
                     "reason": "原广告与商品页都显示同款旅行收纳袋，符合收纳搜索词。",
                     "citations": [{**{k: s[k] for k in ("source_id", "source_kind", "content_hash")},
                                    "source_quote": "Packing cubes"} for s in e["sources"]]}
                    for e in entries]
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"assessments": rows})))])
        async def close(self):
            pass
    monkeypatch.setattr("openai.AsyncOpenAI", FakeClient)
    monkeypatch.setattr(AISettings, "resolve", lambda *_: SimpleNamespace(api_key="test-only", model="test", base_url=""))
    queued = await enqueue_action(store, project["id"], {"kind": "verify",
        "version": project["version"], "keyword_id": wid, "landing_mode": "local"})
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    await runner.run_once()
    result = await get_action(db_engine, project["id"], queued["id"])
    assert result["status"] == "complete", result
    assert result["result"]["matched"] == 1
    saved = await store.get(project["id"])
    assert saved["products"][0]["name"] == "Packing cubes"
    assert saved["products"][0]["identification"]["relevance_confirmed"]
    assert not saved["products"][0]["identification"]["passed"]
    assert saved["products"][0]["triage"]["state"] == "pending"
    assert len(saved["keywords"]) == 1
    assert len(calls) == 1
    assert (await enqueue_action(store, project["id"], {"kind": "verify",
        "version": saved["version"], "keyword_id": wid}))["count"] == 0
