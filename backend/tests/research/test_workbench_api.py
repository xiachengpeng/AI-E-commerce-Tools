from uuid import uuid4

import httpx
import pytest

from rabbit_hole.runtime.server import create_app


async def test_stop_action_route_requires_csrf_and_stops_queued_scan(db_engine):
    from rabbit_hole.application.actions import enqueue_action, get_action
    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    store = WorkbenchStore(db_engine)
    app.state.workbench_store = store
    project = await store.create('stop route', 'test', 'US', str(uuid4()))
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    url = f"/workbench/api/projects/{project['id']}/actions/{queued['id']}/stop"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://localhost:8000') as client:
        assert (await client.post(url, json={'attempt': 0})).status_code == 403
        token = (await client.get('/workbench/api/session')).json()['csrf_token']
        response = await client.post(url, headers={'X-Workbench-Token': token}, json={'attempt': 0})
    assert response.status_code == 200
    assert response.json()['status'] == 'blocked'
    assert (await get_action(db_engine, project['id'], queued['id']))['status'] == 'blocked'


async def test_sources_use_the_same_integration_status_as_integrations():
    async def healthy():
        return True

    async def failed():
        return False

    app = create_app(
        checks={
            "database": healthy,
            "storage": healthy,
            "meta": failed,
            "trends": healthy,
            "ai": failed,
        }
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        integrations = (await client.get("/integrations")).json()["integrations"]
        catalog = (await client.get("/workbench/api/sources")).json()
        sources = catalog["sources"]

    by_key = {item["key"]: item for item in sources}
    assert integrations["meta"]["status"] == "degraded"
    assert by_key["meta"]["status"] == "degraded"
    assert by_key["meta"]["available"] is False
    assert by_key["trends"]["status"] == "healthy"
    assert by_key["trends"]["available"] is True
    assert by_key["ai"]["status"] == "degraded"
    for key in ("amazon", "tiktok", "pinterest", "similarweb", "supplier"):
        assert by_key[key]["available"] is True
        assert by_key[key]["automation_state"] != "connected"
        assert by_key[key]["next_step"]
        assert by_key[key]["official_docs_url"].startswith("https://")
    assert "未接入 TikTok 广告 API" in by_key["tiktok"]["automation_reason"]
    assert "订阅" in by_key["similarweb"]["automation_reason"]
    assert "成本" in by_key["supplier"]["next_step"]
    assert catalog["feasibility_checked_at"] == "2026-09-30"


@pytest.mark.asyncio
async def test_business_writes_require_local_origin_and_csrf():
    app = create_app(checks={})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        r = await client.get("/workbench/api/session")
        assert r.status_code == 200
        token = r.json()["csrf_token"]
        assert (
            await client.post("/workbench/api/projects", json={})
        ).status_code == 403
        assert (
            await client.post(
                "/workbench/api/projects",
                headers={"X-Workbench-Token": token, "Origin": "https://evil.example"},
                json={},
            )
        ).status_code == 403
        assert (
            await client.post(
                "/workbench/api/projects", headers={"X-Workbench-Token": token}, json={}
            )
        ).status_code == 503
        assert (
            await client.get("/workbench/api/session", headers={"Host": "evil.example"})
        ).status_code == 403


@pytest.mark.asyncio
async def test_configured_lan_ip_allows_same_origin_and_keeps_csrf(monkeypatch):
    monkeypatch.setenv("RABBIT_HOLE_LAN_IP", "192.168.31.217")
    app = create_app(checks={})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://192.168.31.217:8000"
    ) as client:
        session = await client.get("/workbench/api/session")
        assert session.status_code == 200
        token = session.json()["csrf_token"]
        assert (await client.post("/workbench/api/projects", json={})).status_code == 403
        assert (
            await client.post(
                "/workbench/api/projects",
                headers={"X-Workbench-Token": token},
                json={},
            )
        ).status_code == 503
        assert (
            await client.get("/workbench/api/session", headers={"Host": "evil.example"})
        ).status_code == 403


@pytest.mark.asyncio
async def test_browser_cannot_submit_automated_collection_results():
    app = create_app(checks={})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://127.0.0.1:8000"
    ) as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        response = await client.post(
            "/workbench/api/projects/00000000-0000-0000-0000-000000000000/commands",
            headers={"X-Workbench-Token": token},
            json={
                "version": 1,
                "command_id": "x",
                "action": "collection_result",
                "payload": {},
            },
        )
        assert response.status_code == 403


async def test_rule_configuration_is_a_versioned_user_command(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    service = WorkbenchStore(db_engine)
    app.state.workbench_store = service
    project = await service.create("配置验收", "收纳", "US", str(uuid4()))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        response = await client.post(
            f"/workbench/api/projects/{project['id']}/commands",
            headers={"X-Workbench-Token": token},
            json={
                "action": "configure_rules",
                "version": project["version"],
                "command_id": str(uuid4()),
                "payload": {"rules": {"max_weight_kg": 1.5}, "reason": "限制物流重量"},
            },
        )
        assert response.status_code == 200
        assert response.json()["rules"]["max_weight_kg"] == 1.5
        assert response.json()["rules_version"] == 2


async def test_logistics_profile_can_be_saved_through_local_command_api(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    service = WorkbenchStore(db_engine)
    app.state.workbench_store = service
    project = await service.create("物流 API", "收纳", "US", str(uuid4()))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        response = await client.post(
            f"/workbench/api/projects/{project['id']}/commands",
            headers={"X-Workbench-Token": token},
            json={
                "action": "set_logistics_profile",
                "version": project["version"],
                "command_id": str(uuid4()),
                "payload": {
                    "carrier": "Example Express",
                    "service": "US line",
                    "source_url": "https://carrier.example/rates",
                    "observed_at": "2026-09-29T00:00:00Z",
                    "confirmed": True,
                    "volumetric_divisor_cm3_per_kg": 6000,
                },
            },
        )
    assert response.status_code == 200
    assert response.json()["logistics_profile"]["version"] == 1


async def test_invalid_command_shape_and_oversized_body_are_rejected():
    app = create_app(checks={})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as c:
        headers = {
            "X-Workbench-Token": (await c.get("/workbench/api/session")).json()[
                "csrf_token"
            ]
        }
        path = "/workbench/api/projects/00000000-0000-0000-0000-000000000000/commands"
        r = await c.post(path, headers=headers, json={"action": []})
        assert r.status_code == 422
        r = await c.post(path, headers=headers, content='{"action":NaN}')
        assert r.status_code == 422
        r = await c.post(path, headers=headers, content="x" * 1_000_001)
        assert r.status_code == 413


async def test_invalid_action_cursor_is_rejected_instead_of_restarting_first_page(
    db_engine,
):
    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    store = WorkbenchStore(db_engine)
    app.state.workbench_store = store
    project = await store.create("cursor API", "test", "US", str(uuid4()))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        response = await client.get(
            f"/workbench/api/projects/{project['id']}/actions?cursor=not-a-cursor"
        )
    assert response.status_code == 422


async def test_research_intelligence_is_read_only_guarded_and_project_scoped(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    store = WorkbenchStore(db_engine)
    app.state.workbench_store = store
    project = await store.create("read-only intelligence", "travel", "US", str(uuid4()))
    other = await store.create("other intelligence", "storage", "US", str(uuid4()))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        path = f"/workbench/api/projects/{project['id']}/intelligence"
        response = await client.get(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["keywords"] == []
        assert response.json()["calibration"] == []
        report = await client.get(f"/workbench/api/projects/{project['id']}/report")
        assert "研究洞察（描述性统计）" in report.text
        assert "无可比的已确认测试轮次" in report.text
        assert (await client.get(path, headers={"Host": "evil.example"})).status_code == 403
        assert (await client.get("/workbench/api/projects/bad-id/intelligence")).status_code == 404
        missing = str(uuid4())
        assert (await client.get(f"/workbench/api/projects/{missing}/intelligence")).status_code == 404
        other_response = await client.get(f"/workbench/api/projects/{other['id']}/intelligence")
        assert other_response.status_code == 200
        assert other_response.json()["window"]["start"] == other["created_at"]


async def test_offer_link_replay_is_idempotent_in_project_store(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore

    service = WorkbenchStore(db_engine)
    project = await service.create("同款重复提交", "旅行收纳", "US", str(uuid4()))
    for name, url in (("A", "https://a.example/p/1"), ("B", "https://b.example/p/2")):
        project = await service.command(
            project["id"], project["version"], str(uuid4()), "add_product",
            {"name": name, "url": url},
        )
    first, second = project["products"]
    payload = {
        "first_product_id": first["id"], "second_product_id": second["id"],
        "name": "同款收纳", "reason": "人工比对外观和规格",
    }
    key, before = str(uuid4()), project["version"]
    linked = await service.command(project["id"], before, key, "link_product_offers", payload)
    replay = await service.command(project["id"], before, key, "link_product_offers", payload)
    assert linked["version"] == replay["version"] == before + 1
    assert len(replay["product_concepts"]) == 1
    assert [item["action"] for item in replay["product_concepts"][0]["history"]] == ["linked"]


@pytest.mark.parametrize(
    "action",
    [
        "confirm_test_result",
        "revise_test_result",
        "void_test_result",
        "restore_keyword",
        "merge_products",
        "link_product_offers",
        "split_product_offer",
        "undo_offer_link",
    ],
)
async def test_result_lifecycle_commands_are_allowed_browser_actions(action):
    app = create_app(checks={})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        response = await client.post(
            "/workbench/api/projects/00000000-0000-0000-0000-000000000000/commands",
            headers={"X-Workbench-Token": token},
            json={
                "version": 0,
                "command_id": str(uuid4()),
                "action": action,
                "payload": {},
            },
        )

    assert response.status_code != 403


@pytest.mark.parametrize(
    "action",
    [
        "triage_product",
        "restore_product",
        "focus_product",
        "confirm_product",
        "confirm_creatives",
    ],
)
async def test_guided_selection_user_actions_are_allowed(action):
    app = create_app(checks={})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        response = await client.post(
            "/workbench/api/projects/00000000-0000-0000-0000-000000000000/commands",
            headers={"X-Workbench-Token": token},
            json={
                "version": 0,
                "command_id": str(uuid4()),
                "action": action,
                "payload": {},
            },
        )

    assert response.status_code != 403


async def test_stale_triage_command_conflicts_without_duplicate_history(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    store = WorkbenchStore(db_engine)
    app.state.workbench_store = store
    project = await store.create("并发初筛", "旅行收纳", "US", str(uuid4()))
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_product",
        {"name": "Travel organizer", "url": "https://shop.example/p/a"},
    )
    product_id = project["products"][0]["id"]
    stale_version = project["version"]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        path = f"/workbench/api/projects/{project['id']}/commands"
        first = await client.post(
            path,
            headers={"X-Workbench-Token": token},
            json={
                "version": stale_version,
                "command_id": str(uuid4()),
                "action": "triage_product",
                "payload": {
                    "product_id": product_id,
                    "disposition": "retained",
                    "reason": "商品相关，进入深挖",
                },
            },
        )
        second = await client.post(
            path,
            headers={"X-Workbench-Token": token},
            json={
                "version": stale_version,
                "command_id": str(uuid4()),
                "action": "triage_product",
                "payload": {
                    "product_id": product_id,
                    "disposition": "rejected",
                    "reason": "重复点击不应生效",
                },
            },
        )

    saved = await store.get(project["id"])
    assert first.status_code == 200
    assert second.status_code == 409
    assert saved["products"][0]["triage"]["state"] == "retained"
    assert len(saved["products"][0]["triage"]["history"]) == 1


async def test_command_event_persists_only_sanitized_url_payload(db_engine):
    from sqlalchemy import select

    from rabbit_hole.persistence.projects import WorkbenchStore, workbench_events

    store = WorkbenchStore(db_engine)
    project = await store.create("URL event", "travel", "US", str(uuid4()))
    await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_product",
        {
            "name": "Product",
            "url": (
                "https://shop.example/?p=123&token=SYNTHETIC_BEARER"
                "&X-Amz-Signature=SYNTHETIC_SIGNATURE"
            ),
        },
    )
    async with db_engine.connect() as connection:
        payload = (
            await connection.execute(
                select(workbench_events.c.payload).where(
                    workbench_events.c.project_id == project["id"],
                    workbench_events.c.action == "add_product",
                )
            )
        ).scalar_one()

    assert payload["url"] == "https://shop.example/?p=123"
    assert "SYNTHETIC" not in str(payload)


async def test_real_store_browser_flow_persists_and_exports(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    app.state.workbench_store = WorkbenchStore(db_engine)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://localhost:8000"
    ) as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        headers = {"X-Workbench-Token": token}
        r = await client.post(
            "/workbench/api/projects",
            headers=headers,
            json={
                "title": "API isolated test",
                "direction": "travel",
                "market": "US",
                "command_id": str(uuid4()),
            },
        )
        assert r.status_code == 200
        p = r.json()
        path = f"/workbench/api/projects/{p['id']}"
        for action, payload in [
            (
                "add_product",
                {"name": "test product", "url": "https://shop.example/p/a"},
            ),
            ("evaluate", {}),
            ("decide", {"pool": "observe", "reason": "Missing real evidence"}),
            (
                "review",
                {
                    "conclusion": "Research only",
                    "lessons": "Need supplier quote",
                    "next_keywords": [],
                },
            ),
        ]:
            if p["products"]:
                payload["product_id"] = p["products"][0]["id"]
            r = await client.post(
                path + "/commands",
                headers=headers,
                json={
                    "version": p["version"],
                    "command_id": str(uuid4()),
                    "action": action,
                    "payload": payload,
                },
            )
            assert r.status_code == 200, r.text
            p = r.json()
        fetched = (await client.get(path)).json()
        assert fetched["products"][0]["reviews"][0]["kind"] == "research"
        assert fetched["products"][0]["scores"][0]["total"] is None
        report = await client.get(path + "/report")
        assert report.status_code == 200
        assert "Missing real evidence" in report.text
        assert "attachment" in report.headers["content-disposition"]
