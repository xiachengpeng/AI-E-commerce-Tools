"""Real browser recovery against an isolated PostgreSQL-backed local API."""

import asyncio
import re
import socket
import threading
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import uvicorn
from playwright.async_api import async_playwright, expect


async def test_blocked_scan_action_offers_retry_when_keyword_is_stuck_running(recovery_page):
    page, store, project = recovery_page
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare pet travel', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    from rabbit_hole.application.actions import enqueue_action
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    project = await store.get(project['id'])
    await store.command(project['id'], project['version'], str(uuid4()), 'keyword_state', {'keyword_id': word_id, 'status': 'running'}, actor='automation')
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(status='blocked', error_code='source_error'))
    await page.reload()
    await expand_secondary_research(page)
    row = page.locator('.secondary-research table tr').filter(has_text='rare pet travel')
    await expect(row.get_by_role('button', name='重试搜索')).to_be_visible()
    await row.get_by_role('button', name='重试搜索').click()
    await expect(row.get_by_role('button', name='停止')).to_be_visible()
    await row.get_by_role('button', name='停止').click()


async def test_cloud_stop_and_restart_survives_twenty_newer_records(recovery_page, monkeypatch):
    import rabbit_hole.integrations.provider_budget as provider
    from rabbit_hole.application.actions import enqueue_action, list_actions

    async def abort_stub(*args):
        return None

    monkeypatch.setattr(provider, 'abort_apify_run', abort_stub)
    page, store, project = recovery_page
    for name, payload in [
        ('configure_collection', {'meta': 'api', 'trends': 'ui'}),
        ('add_keyword', {'text': 'older cloud keyword', 'type': 'function'}),
    ]:
        project = await store.command(project['id'], project['version'], str(uuid4()), name, payload)
    word = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word, 'approved': True})
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word})
    now = datetime.now(UTC)
    async with store.engine.begin() as c:
        original = dict((await c.execute(select(actions).where(actions.c.id == UUID(queued['id'])))).mappings().one())
        await c.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(payload={**original['payload'], 'apify_run': {'id': 'old-cloud', 'status': 'RUNNING'}}))
        for i in range(25):
            await c.execute(insert(actions).values(id=uuid4(), project_id=UUID(project['id']), dedupe_key=str(uuid4()), kind='keywords', status='complete', input_version=1, payload={}, attempt=1, created_at=now+timedelta(seconds=i), updated_at=now))
    await page.reload()
    await expand_secondary_research(page)
    row = page.locator('.secondary-research table tr').filter(has_text='older cloud keyword')
    await expect(row).to_contain_text('Apify 云端运行中')
    await row.get_by_role('button', name='停止', exact=True).click()
    await expect(row).to_contain_text('已停止')
    await row.get_by_role('button', name='重新搜索', exact=True).click()
    await expect(row.get_by_role('button', name='停止', exact=True)).to_be_visible()
    current = (await list_actions(store.engine, project['id']))['keyword_actions'][word]
    assert current['id'] != queued['id']
    await row.get_by_role('button', name='停止', exact=True).click()


async def test_plain_http_browser_can_add_keyword_without_secure_crypto(recovery_page):
    page, store, project = recovery_page
    await page.add_init_script("Object.defineProperty(crypto, 'randomUUID', {value:undefined}); Object.defineProperty(crypto, 'subtle', {value:undefined});")
    await page.reload()
    await expand_secondary_research(page)
    await page.get_by_role('button', name='＋ 添加关键词', exact=True).click()
    await page.locator('#editor [name=text]').fill('plain http keyword')
    await page.locator('#editor button[type=submit]').click()
    await expect(page.locator('#dialog')).not_to_be_visible()
    assert any('plain http keyword' in w['text'] for w in (await store.get(project['id']))['keywords'])


async def test_completed_empty_scan_keeps_bounded_sample_explanation(recovery_page):
    from rabbit_hole.application.actions import enqueue_action
    page, store, project = recovery_page
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'empty sample keyword', 'type': 'function'})
    word = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word, 'approved': True})
    q = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word})
    project = await store.get(project['id'])
    await store.command(project['id'], project['version'], str(uuid4()), 'collection_result', {'keyword_id': word, 'ads': [], 'status': 'complete', 'message': '本次采集 0 条；限定样本不能据此判断没有机会。'}, actor='automation')
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(q['id'])).values(status='complete', result={'empty': True}))
    await page.reload()
    await expand_secondary_research(page)
    row = page.locator('.secondary-research table tr').filter(has_text='empty sample keyword')
    await expect(row).to_contain_text('本次采集 0 条')
    await expect(row).to_contain_text('不能据此判断没有机会')


async def test_queued_scan_has_stop_control(recovery_page):
    page, store, project = recovery_page
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'pet carrier bag', 'type': 'function'})
    word_id = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word_id, 'approved': True})
    from rabbit_hole.application.actions import enqueue_action
    await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word_id})
    await page.reload()
    await expand_secondary_research(page)
    row = page.locator('.secondary-research table tr').filter(has_text='pet carrier bag')
    await row.get_by_role('button', name='停止').click()
    await expect(row.get_by_role('button', name='重试搜索')).to_be_visible()


async def test_provider_modes_and_live_log_refresh(recovery_page):
    page, store, project = recovery_page
    await expand_secondary_research(page)
    await page.get_by_role('button', name='设置采集模式').click()
    await page.locator('#editor [name="meta"]').select_option('api')
    await page.locator('#editor [name="trends"]').select_option('ui')
    await page.locator('#editor button[type="submit"]').click()
    await page.reload()
    await expand_secondary_research(page)
    await expect(page.get_by_text('Meta：API（Apify） · Trends：UI 自动化', exact=True)).to_be_visible()
    from rabbit_hole.integrations.provider_jobs import append_log
    await append_log(store.engine, project['id'], str(uuid4()), 1, 'probe', '隔离测试：日志即时到达')
    await expect(page.locator('[data-live-log-lines]')).to_contain_text('日志即时到达', timeout=10000)


async def test_api_key_form_never_echoes_secret(recovery_page, tmp_path, monkeypatch):
    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    page, _, project = recovery_page
    await page.locator('[data-nav="sources"]').click()
    await expect(page.get_by_text('采集 API 密钥')).to_be_visible()
    field = page.get_by_label('Apify API Key')
    await field.fill('secret-test-value')
    await page.get_by_role('button', name='保存 Apify').click()
    await expect(page.get_by_text('已保存，新请求使用新密钥。')).to_be_visible()
    assert 'secret-test-value' not in await page.locator('body').inner_text()
    assert await field.input_value() == ''
    await page.reload()
    # Reload restores the project asynchronously; wait before navigating away.
    await expect(page.locator('#heading')).to_have_text(project['title'])
    await page.locator('[data-nav="sources"]').click()
    await expect(page.get_by_text('已配置（未验证本次可用性）')).to_be_visible()
from sqlalchemy import insert, select, update
from rabbit_hole.persistence.sql import create_engine as create_async_engine
from sqlalchemy.pool import NullPool

from rabbit_hole.application.actions import actions
from rabbit_hole.persistence.projects import WorkbenchStore, workbench_projects
from rabbit_hole.runtime.server import create_app


@pytest.fixture
async def recovery_page(migrated_database):
    engine = create_async_engine(migrated_database, poolclass=NullPool)
    store = WorkbenchStore(engine)
    project = await store.create(
        "浏览器恢复 " + str(uuid4()), "隔离验收", "US", str(uuid4())
    )
    app = create_app(checks={})
    app.state.workbench_store = store
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    thread = threading.Thread(
        target=server.run, kwargs={"sockets": [sock]}, daemon=True
    )
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        assert server.started
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            page = await browser.new_page()
            await page.route(
                "**/workbench/api/projects/*/sync",
                lambda r: r.fulfill(json={"runs": []}),
            )
            await page.goto(f"http://127.0.0.1:{port}/")
            await (
                page.locator(".card")
                .filter(has_text=project["title"])
                .get_by_role("button", name="继续选品")
                .click()
            )
            await expect(page.locator("#heading")).to_have_text(project["title"])
            yield page, store, project
            await browser.close()
    finally:
        server.should_exit = True
        await asyncio.to_thread(thread.join, 5)
        sock.close()
        await engine.dispose()


@pytest.fixture
async def guided_page(migrated_database):
    engine = create_async_engine(migrated_database, poolclass=NullPool)
    store = WorkbenchStore(engine)
    project = await store.create(
        "引导式选品 " + str(uuid4()), "旅行收纳", "US", str(uuid4())
    )
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_keyword",
        {"text": "portable organizer", "type": "category"},
    )
    keyword_id = project["keywords"][0]["id"]
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "approve_keyword",
        {"keyword_id": keyword_id, "approved": True},
    )
    project = await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "collection_result",
        {
            "keyword_id": keyword_id,
            "status": "complete",
            "ads": [
                {
                    "id": "ad-01",
                    "advertiser": "广告主 01",
                    "start_date": "2026-08-01",
                    "landing_url": "https://shop.example/p/01",
                    "primary_text": "Portable organizer for every trip",
                    "active": True,
                }
            ],
        },
        actor="automation",
    )
    for index in range(1, 20):
        project = await store.command(
            project["id"],
            project["version"],
            str(uuid4()),
            "add_product",
            {
                "name": f"广告主 {index:02d} 商品",
                "url": f"https://shop.example/p/{index:02d}",
                "source_keyword_ids": [keyword_id],
            },
        )
    app = create_app(checks={})
    app.state.workbench_store = store
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    thread = threading.Thread(
        target=server.run, kwargs={"sockets": [sock]}, daemon=True
    )
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        assert server.started
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            page = await browser.new_page()
            await page.route(
                "**/workbench/api/projects/*/sync",
                lambda route: route.fulfill(json={"runs": []}),
            )
            await page.goto(f"http://127.0.0.1:{port}/")
            await (
                page.locator(".card")
                .filter(has_text=project["title"])
                .get_by_role("button", name="继续选品")
                .click()
            )
            await expect(page.locator("#heading")).to_have_text(project["title"])
            yield page, store, project
            await browser.close()
    finally:
        server.should_exit = True
        await asyncio.to_thread(thread.join, 5)
        sock.close()
        await engine.dispose()


async def test_optional_research_can_be_recorded_and_survives_refresh(recovery_page):
    page, _, _ = recovery_page
    await page.get_by_role("button", name="＋ 添加已有商品").click()
    await page.locator('#editor [name="name"]').fill("Travel cubes")
    await page.locator('#editor [name="url"]').fill("https://shop.example/p/cubes")
    await page.locator("#submit-form").click()
    await page.get_by_role("button", name="打开产品档案 →").click()
    await page.get_by_text("辅助研究：创意参考、邮件/弃购/分析/再营销").click()
    await page.get_by_role("button", name="记录创意参考").click()
    await page.locator('#editor [name="source_ad_id"]').fill("ad-1")
    await page.locator('#editor [name="source_url"]').fill("https://facebook.com/ad/1")
    await page.locator('#editor [name="format"]').fill("UGC video")
    await page.locator('#editor [name="hook"]').fill("Packing mess")
    await page.locator('#editor [name="pattern_note"]').fill("Before and after")
    await page.locator("#submit-form").click()
    await expect(page.get_by_text("ad-1 · UGC video")).to_be_visible()
    await page.get_by_role("button", name="记录漏斗调查").click()
    await page.locator('#editor [name="area"]').select_option("abandoned_cart")
    await page.locator('#editor [name="status"]').select_option("observed")
    await page.locator('#editor [name="method"]').select_option("script_detected")
    await page.locator('#editor [name="source_url"]').fill("https://shop.example/p/cubes")
    await page.locator('#editor [name="observed_at"]').fill(
        datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M")
    )
    await page.locator("#submit-form").click()
    await expect(page.get_by_text("弃购：观察到线索 · 仅发现脚本，流程未确认")).to_be_visible()
    await page.reload()
    await page.get_by_role("button", name="打开产品档案 →").click()
    await page.get_by_text("辅助研究：创意参考、邮件/弃购/分析/再营销").click()
    await expect(page.get_by_text("ad-1 · UGC video")).to_be_visible()
    await expect(page.get_by_text("弃购：观察到线索 · 仅发现脚本，流程未确认")).to_be_visible()


async def test_research_review_has_honest_empty_state_and_survives_navigation(recovery_page):
    page, _, project = recovery_page
    await page.get_by_role("button", name="研究与复盘报告").click()
    card = page.locator(".panel").filter(has_text=project["title"])
    await card.get_by_role("button", name="查看研究复盘").click()
    review = page.locator("[data-research-review]")
    await expect(review).to_contain_text("样本不足")
    await expect(review).to_be_in_viewport()
    await expect(review).to_contain_text("暂无可归因发现记录")
    await expect(review).to_contain_text("无可比的已确认测试轮次")
    assert "最佳关键词" not in await review.inner_text()
    await page.reload()
    await expect(page.locator("[data-research-review]")).to_contain_text("样本不足")
    await page.get_by_role("button", name="研究项目").click()
    await page.get_by_role("button", name="研究与复盘报告").click()
    await expect(page.locator("[data-research-review]")).to_contain_text("样本不足")


async def test_research_review_shows_two_of_five_without_inventing_channel_success(recovery_page):
    page, store, project = recovery_page
    project = await store.command(
        project["id"], project["version"], str(uuid4()), "add_keyword",
        {"text": "packing cubes", "type": "category"},
    )
    keyword_id = project["keywords"][0]["id"]
    for index in range(5):
        project = await store.command(
            project["id"], project["version"], str(uuid4()), "add_product",
            {"name": f"线索 {index}", "url": f"https://shop.example/p/{index}",
             "source_keyword_ids": [keyword_id]},
        )
    for item in project["products"][:2]:
        project = await store.command(
            project["id"], project["version"], str(uuid4()), "triage_product",
            {"product_id": item["id"], "disposition": "retained", "reason": "人工核对"},
        )
    project = await store.command(
        project["id"], project["version"], str(uuid4()), "add_keyword",
        {"text": "unused travel case", "type": "scenario"},
    )
    await page.reload()
    await expect(page.locator("#heading")).to_have_text(project["title"])
    await page.get_by_role("button", name="研究与复盘报告").click()
    card = page.locator(".panel").filter(has_text=project["title"])
    await card.get_by_role("button", name="查看研究复盘").click()
    review = page.locator("[data-research-review]")
    await expect(review).to_contain_text("活动卖家档案 5 个")
    await expect(review).to_contain_text("2/5（40%）")
    await expect(review).to_contain_text("Amazon")
    await expect(review).to_contain_text("暂无可归因发现记录")
    assert "Amazon · 当前保留 0%" not in await review.inner_text()
    pending = review.locator("[data-unobserved-keywords]")
    await expect(pending).to_contain_text("未产生扫描或商品关联的关键词：1 个")
    await expect(pending.get_by_text('"unused travel case"')).to_be_hidden()
    await pending.locator("summary").click()
    await expect(pending.get_by_text('"unused travel case"')).to_be_visible()


async def expand_secondary_research(page):
    for _ in range(200):
        if await page.evaluate("(!S.form || !S.form.submitting) && !S.writeBusy"):
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("workbench save did not settle")
    secondary = page.locator("details.secondary-research")
    if await secondary.get_attribute("open") is None:
        await secondary.locator("summary").click()
    return secondary


async def choose_triage_reason(page, label, note=""):
    await page.get_by_label(label, exact=True).check()
    if note:
        await page.locator('[name="reason"]').fill(note)


async def focus_first_product(store, project):
    current = await store.get(project["id"])
    product_id = current["products"][0]["id"]
    current = await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "triage_product",
        {
            "product_id": product_id,
            "disposition": "retained",
            "reason": "进入深挖",
        },
    )
    await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "focus_product",
        {"product_id": product_id},
    )
    return product_id


async def test_home_has_one_primary_selection_action_and_named_queue(guided_page):
    page, _, _ = guided_page
    primary = page.locator('[data-primary-guidance="true"]')
    await expect(primary).to_have_count(1)
    await expect(primary).to_contain_text("判断当前商品是否值得保留")
    await primary.get_by_role("button", name="判断是否保留当前商品").click()
    await expect(page.locator('[data-current-lead="true"]')).to_be_visible()
    await expect(page.locator(".queue-row")).to_have_count(0)
    await expect(page.get_by_text("广告主 01", exact=True).first).to_be_visible()
    await expect(page.get_by_text('来源词："portable organizer"').first).to_be_visible()


async def test_queue_progressive_loading_and_exact_source_summary(guided_page):
    page, _, _ = guided_page
    await page.locator('[data-nav="todos"]').click()
    pending = page.locator(".queue-group").filter(has_text="待快速筛选")

    await expect(pending.locator(".queue-row")).to_have_count(10)
    await expect(pending.locator(".queue-row").first).to_contain_text(
        "精确来源：广告主 01 · 1 条广告 · 投放始于 2026-08-01"
    )
    more = pending.get_by_role("button", name="加载更多（剩余 9 条）")
    await expect(more).to_be_visible()
    await more.click()

    await expect(pending.locator(".queue-row")).to_have_count(19)
    await expect(
        pending.get_by_role("button", name="加载更多", exact=False)
    ).to_have_count(0)


async def test_lead_heading_focus_survives_direct_and_automatic_navigation(
    guided_page,
):
    page, _, _ = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await expect(page.locator('[data-current-lead="true"] h2')).to_be_focused()

    await page.get_by_role("button", name="暂时观察", exact=True).click()
    await choose_triage_reason(page, "证据不足，稍后再看")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator('[data-current-lead="true"] h2')).to_be_focused()


async def test_desktop_secondary_research_tools_are_collapsed(guided_page):
    page, _, project = guided_page
    await page.get_by_role("button", name="← 全部项目").click()
    card = page.locator(".card").filter(has_text=project["title"])
    await expect(card.get_by_role("button", name="继续选品")).to_be_visible()
    await card.get_by_role("button", name="继续选品").click()
    await expect(page.get_by_text("待筛线索", exact=True)).to_be_visible()

    secondary = page.locator("details.secondary-research")
    await expect(secondary).not_to_have_attribute("open", "")
    await expect(secondary.get_by_text("补充线索与研究设置")).to_be_visible()
    await secondary.locator("summary").click()
    await expect(secondary).to_contain_text("单次批量扫描上限 20")
    await expect(secondary).to_contain_text("每日扫描预算 20")
    await expect(secondary.get_by_role("button", name="＋ 添加关键词")).to_be_visible()
    await expect(secondary.get_by_role("button", name="扫描全部已审核词")).to_be_visible()


@pytest.mark.parametrize("viewport_width", [375, 1440])
async def test_guided_selection_has_no_horizontal_page_overflow(
    guided_page, viewport_width
):
    page, _, _ = guided_page
    await page.set_viewport_size({"width": viewport_width, "height": 900})
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await expect(page.get_by_role("heading", name="快速筛选线索")).to_be_visible()

    dimensions = await page.evaluate(
        "({ page: document.documentElement.scrollWidth, viewport: window.innerWidth })"
    )
    assert dimensions["page"] <= dimensions["viewport"]


async def test_guided_retain_focus_survives_reload(guided_page):
    page, store, project = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="保留并深挖", exact=True).click()
    await choose_triage_reason(
        page, "商品明确，值得深挖", "商品与广告匹配，值得继续核对"
    )
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    await expect(page.locator("#heading")).to_have_text("广告主 01")
    await expect(page.get_by_role("button", name="确认具体商品")).to_be_visible()
    saved = await store.get(project["id"])
    assert saved["focus_product_id"] == saved["products"][0]["id"]

    await page.reload()
    await expect(page.locator("#heading")).to_have_text("广告主 01")
    await expect(page.get_by_role("button", name="确认具体商品")).to_be_visible()


async def test_four_phase_workspace_expands_only_the_current_phase(guided_page):
    page, _, _ = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="保留并深挖", exact=True).click()
    await choose_triage_reason(page, "商品明确，值得深挖")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    await expect(page.locator(".phase-button")).to_have_count(4)
    await expect(page.locator(".phase-substeps")).to_have_count(1)
    await expect(page.locator(".phase-substeps")).to_contain_text("识别具体商品")
    await expect(page.locator(".phase-button").nth(1)).to_contain_text("未到此步")
    await expect(page.locator(".phase-button").nth(2)).to_contain_text("未到此步")
    await expect(page.locator(".phase-button").nth(3)).to_contain_text("未到此步")


async def test_landing_observation_first_when_identity_has_no_snapshot(guided_page):
    page, _, _ = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="保留并深挖", exact=True).click()
    await choose_triage_reason(page, "有可验证商品页", "商品页需要先读取核对")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    observe = page.get_by_role("button", name="自动读取商品页", exact=True)
    confirm = page.get_by_role("button", name="确认具体商品", exact=True)
    await expect(observe).to_have_class("primary")
    await expect(confirm).not_to_have_class("primary")


async def test_focus_card_and_contextual_triage_feedback(guided_page):
    page, _, _ = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="保留并深挖", exact=True).click()
    await choose_triage_reason(page, "商品明确，值得深挖")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    await expect(page.locator("#alert")).to_contain_text(
        "已保留“广告主 01”，并设为当前深挖商品"
    )
    await expect(page.locator("#alert")).to_have_attribute("role", "status")
    await page.locator('[data-nav="todos"]').click()
    focus = page.locator('[data-current-focus="true"]')
    await expect(focus).to_have_count(1)
    await expect(focus).to_contain_text("广告主 01")
    await expect(focus.get_by_role("button", name="继续深挖")).to_be_visible()


async def test_triage_criteria_and_session_progress(guided_page):
    page, _, _ = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()

    lead = page.locator('[data-current-lead="true"]')
    await expect(lead.get_by_role("heading", name="待识别商品")).to_be_visible()
    await expect(lead.get_by_text("当前记录：广告主 01", exact=True)).to_be_visible()
    await expect(lead.locator(".triage-criteria li")).to_have_count(3)
    await expect(lead).to_contain_text("本次已处理 0 条 · 剩余 19 条")


async def test_exact_origin_excludes_unbound_keyword_ads(guided_page):
    page, _, _ = guided_page
    await page.locator('[data-nav="todos"]').click()
    pending = page.locator(".queue-group").filter(has_text="待快速筛选")
    await pending.locator(".queue-row").nth(1).get_by_role(
        "button", name="筛选这条线索"
    ).click()

    lead = page.locator('[data-current-lead="true"]')
    await expect(lead).to_contain_text("未绑定具体来源广告")
    await expect(lead.get_by_role("link", name="查看原广告")).to_have_count(0)
    await expect(lead.get_by_text("Portable organizer for every trip")).to_have_count(0)


async def test_quick_reason_is_required_and_note_is_optional(guided_page):
    page, store, project = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="暂时观察", exact=True).click()

    choices = page.get_by_role("radio")
    await expect(choices).to_have_count(3)
    await expect(choices.first).to_have_attribute("required", "")
    await expect(page.locator('[name="reason"]')).not_to_have_attribute("required", "")
    await page.get_by_label("证据不足，稍后再看").check()
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()

    saved = await store.get(project["id"])
    assert saved["products"][0]["triage"]["reason"] == "证据不足，稍后再看"


async def test_undo_latest_triage_reopens_the_same_lead_and_preserves_history(
    guided_page,
):
    page, store, project = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="暂时观察", exact=True).click()
    await choose_triage_reason(page, "证据不足，稍后再看")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    undo = page.locator("#alert").get_by_role("button", name="撤销刚才判断")
    await expect(undo).to_be_visible()
    await undo.click()

    lead = page.locator('[data-current-lead="true"]')
    await expect(lead.get_by_text("当前记录：广告主 01", exact=True)).to_be_visible()
    await expect(page.locator("#alert")).to_contain_text(
        "已撤销刚才判断，请重新选择"
    )
    saved = await store.get(project["id"])
    assert saved["products"][0]["triage"]["state"] == "pending"
    assert len(saved["products"][0]["triage"]["history"]) == 2
    assert saved["products"][0]["triage"]["history"][-1]["to"] == "pending"


async def test_disposing_pending_lead_skips_retained_focus_and_loads_next_pending(
    guided_page,
):
    page, _, _ = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="保留并深挖", exact=True).click()
    await choose_triage_reason(page, "商品明确，值得深挖", "先保留一条进入深挖")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#heading")).to_have_text("广告主 01")

    await page.locator('[data-nav="todos"]').click()
    pending_group = page.locator(".queue-group").filter(has_text="待快速筛选")
    await pending_group.get_by_role("button", name="筛选这条线索").first.click()
    await expect(page.locator('[data-current-lead="true"]')).to_contain_text(
        "广告主 02 商品"
    )
    await page.get_by_role("button", name="暂时观察", exact=True).click()
    await choose_triage_reason(page, "证据不足，稍后再看", "继续处理下一条")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    await expect(page.locator('[data-current-lead="true"]')).to_contain_text(
        "广告主 03 商品"
    )
    await expect(page.locator('[data-current-lead="true"]')).to_contain_text(
        "本次已处理 1 条 · 剩余 17 条"
    )


@pytest.mark.parametrize(
    ("button_name", "disposition", "reason_choice"),
    [
        ("暂时观察", "observing", "证据不足，稍后再看"),
        ("淘汰这条线索", "rejected", "广告信号不足"),
    ],
)
async def test_guided_triage_requires_reason_and_loads_next_lead(
    guided_page, button_name, disposition, reason_choice
):
    page, store, project = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name=button_name, exact=True).click()
    choices = page.get_by_role("radio")
    await expect(choices.first).to_have_attribute("required", "")
    await expect(page.locator('[name="reason"]')).not_to_have_attribute("required", "")
    if disposition == "rejected":
        await expect(
            page.get_by_role("heading", name="确认淘汰这条线索")
        ).to_be_visible()
    await choose_triage_reason(page, reason_choice, "当前证据不足，不进入深挖")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    await expect(page.locator('[data-current-lead="true"]')).to_contain_text(
        "广告主 02 商品"
    )
    saved = await store.get(project["id"])
    assert saved["products"][0]["triage"]["state"] == disposition
    assert len(saved["products"][0]["triage"]["history"]) == 1


async def test_guided_triage_lost_response_is_idempotent(guided_page):
    page, store, project = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="暂时观察", exact=True).click()
    await choose_triage_reason(page, "来源暂不可访问", "等待更多来源")

    async def lose_response(route):
        await route.fetch()
        await route.abort()

    await page.route("**/workbench/api/projects/*/commands", lose_response, times=1)
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#form-error")).to_be_visible()
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()

    saved = await store.get(project["id"])
    assert saved["products"][0]["triage"]["state"] == "observing"
    assert len(saved["products"][0]["triage"]["history"]) == 1


async def test_guided_rejected_lead_can_be_restored_from_queue(guided_page):
    page, store, project = guided_page
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    await page.get_by_role("button", name="淘汰这条线索", exact=True).click()
    await choose_triage_reason(page, "与当前选品方向不符")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()

    await page.locator('[data-nav="todos"]').click()
    rejected = page.locator(".queue-group").filter(has_text="已淘汰")
    await rejected.get_by_role("button", name="恢复线索").click()
    await page.locator('[name="reason"]').fill("获得新的可核验商品链接")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()

    saved = await store.get(project["id"])
    assert saved["products"][0]["triage"]["state"] == "pending"
    assert saved["products"][0]["triage"]["history"][-1]["from"] == "rejected"
    assert saved["products"][0]["triage"]["history"][-1]["to"] == "pending"


async def test_split_forms_keep_identity_and_coarse_gate_separate(guided_page):
    page, store, project = guided_page
    current = await store.get(project["id"])
    product_id = current["products"][0]["id"]
    current = await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "triage_product",
        {
            "product_id": product_id,
            "disposition": "retained",
            "reason": "进入深挖",
        },
    )
    await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "focus_product",
        {"product_id": product_id},
    )
    await page.reload()
    await expect(page.locator("#heading")).to_have_text("广告主 01")

    await page.get_by_role("button", name="确认具体商品", exact=True).click()
    await expect(page.locator('[name="active_days"]')).to_have_count(0)
    await expect(page.locator('[name="creative_1_id"]')).to_have_count(0)
    await page.locator('[name="reason"]').fill("广告和详情页展示同一商品")
    await page.locator('[name="relevance_confirmed"]').check()
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()

    saved = await store.get(project["id"])
    assert saved["products"][0]["identification"]["passed"] is False
    await page.get_by_role("button", name="广告粗筛", exact=False).click()
    await page.get_by_role("button", name="确认粗筛素材", exact=True).click()
    await expect(page.locator('[name="active_days"]')).to_be_visible()
    await expect(page.locator('[name="active_days"]')).to_have_value("")
    await expect(page.locator('[name="creative_1_id"]')).to_be_visible()


async def test_product_header_shows_evidence_health_and_continuity(guided_page):
    page, store, project = guided_page
    await focus_first_product(store, project)
    async with store.engine.begin() as connection:
        state = (
            await connection.execute(
                select(workbench_projects.c.state).where(
                    workbench_projects.c.id == project["id"]
                )
            )
        ).scalar_one()
        state["products"][0]["identification"].update(
            {
                "relevance_confirmed": True,
                "ad_age_days": 52,
                "currently_active": True,
                "continuity_status": "unknown",
            }
        )
        await connection.execute(
            update(workbench_projects)
            .where(workbench_projects.c.id == project["id"])
            .values(state=state)
        )

    await page.reload()
    health = page.locator('[data-evidence-health="true"]')
    await expect(health).to_be_visible()
    await expect(health).to_contain_text("Required 缺口")
    await expect(health).to_contain_text("Recommended 缺口")
    await expect(health).to_contain_text("未知项")
    await expect(health).to_contain_text("评分有效性")
    await expect(health).to_contain_text("下一步")
    facts = page.locator(".coarse-facts")
    await expect(facts.get_by_text("首次投放距今：52 天", exact=True)).to_be_visible()
    await expect(facts.get_by_text("当前状态：正在投放", exact=True)).to_be_visible()
    await expect(facts.get_by_text("连续性：未验证", exact=True)).to_be_visible()
    await expect(page.get_by_text("连续投放", exact=False)).to_have_count(0)
    await expect(page.get_by_text("查看身份审计字段", exact=True)).to_be_visible()
    await expect(page.get_by_text("continuity_status", exact=True)).not_to_be_visible()


async def test_unconfirmed_ad_age_stays_unknown_in_product_header(guided_page):
    page, store, project = guided_page
    await focus_first_product(store, project)
    await page.reload()
    health = page.locator('[data-evidence-health="true"]')
    await expect(health).to_be_visible()
    await expect(health).to_contain_text("首次投放距今：未知")
    await expect(health).not_to_contain_text("首次投放距今：0 天")


async def test_cross_store_offer_group_can_link_refresh_undo_and_split(guided_page):
    page, store, project = guided_page
    await focus_first_product(store, project)
    await page.reload()
    group = page.locator('[data-offer-concept="true"]')
    await expect(group).to_be_visible()
    await group.get_by_role("button", name="关联同款商品的其他卖家").click()
    await page.get_by_label("商品概念名称").fill("Same travel cubes")
    await page.get_by_label("对照依据").fill("包装与尺寸一致")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(group).to_contain_text("Same travel cubes")
    await expect(group).to_contain_text("证据保留在各卖家档案")
    await page.reload()
    await expect(group).to_contain_text("Same travel cubes")
    await group.get_by_role("button", name="撤销最近关联").click()
    await expect(group).not_to_contain_text("Same travel cubes")
    await group.get_by_role("button", name="关联同款商品的其他卖家").click()
    await page.get_by_label("商品概念名称").fill("Same travel cubes again")
    await page.get_by_label("对照依据").fill("人工复核同款")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await group.get_by_role("button", name="移出此卖家商品").click()
    await page.get_by_label("移出理由").fill("规格不同")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(group).not_to_contain_text("Same travel cubes again")


async def test_source_configuration_explains_integration_health(guided_page):
    page, _, _ = guided_page
    await page.locator('[data-nav="sources"]').click()
    await page.get_by_text("其他来源与人工验证方式", exact=True).click()
    await expect(page.locator(".source-status")).to_have_count(9)
    meta = page.locator(".source-grid .panel").filter(has_text="Meta 广告资料库")
    await expect(meta.locator(".source-status")).to_contain_text(
        re.compile("健康|降级|未配置")
    )
    pinterest = page.locator(".source-grid .panel").filter(has_text="Pinterest")
    await expect(pinterest.locator(".source-status")).to_contain_text("人工提交")
    await expect(pinterest).to_contain_text("自动接入：尚未连接")
    tiktok = page.locator(".source-grid .panel").filter(has_text="TikTok")
    await expect(tiktok).to_contain_text("未接入 TikTok 广告 API")
    supplier = page.locator(".source-grid .panel").filter(has_text="Supplier")
    await expect(supplier).to_contain_text("成本与风险核算")
    await expect(page.get_by_text("可行性核验：2026-09-30")).to_be_visible()


async def test_score_drilldown_shows_rules_and_evidence(guided_page):
    page, store, project = guided_page
    await focus_first_product(store, project)
    async with store.engine.begin() as connection:
        state = (
            await connection.execute(
                select(workbench_projects.c.state).where(
                    workbench_projects.c.id == project["id"]
                )
            )
        ).scalar_one()
        product = state["products"][0]
        product["scores"] = [
            {
                "id": str(uuid4()),
                "revision": product["revision"],
                "created_at": "2026-09-22T08:00:00+00:00",
                "status": "complete",
                "missing": [],
                "total": 21,
                "recommendation": "建议进入测试候选",
                "rule_version": 3,
                "score_version": "workbench-score-v1",
                "dimensions": [
                    {
                        "key": "demand_trend",
                        "score": 5,
                        "reason": "需求趋势按现有 0–5 评分规则计算。",
                        "rule_ids": ["score.demand_trend.existing_rubric.v1"],
                        "evidence_ids": ["evidence:trends:12m"],
                        "missing_evidence": [],
                        "calculation": "任一窗口 rising 计 5 分。",
                        "calculated_at": "2026-09-22T08:00:00+00:00",
                    }
                ],
                "final_gates": [
                    {
                        "key": "contribution_margin",
                        "kind": "final_hard_gate",
                        "status": "pass",
                        "rule_id": "gate.contribution_margin",
                        "evidence_ids": ["evidence:economics:1"],
                        "reason": "贡献毛利率达到项目门槛。",
                    }
                ],
            }
        ]
        await connection.execute(
            update(workbench_projects)
            .where(workbench_projects.c.id == project["id"])
            .values(state=state)
        )

    await page.reload()
    await expect(page.locator('[data-evidence-health="true"]')).to_be_visible()
    await page.evaluate("S.step='score'; render()")
    await expect(page.get_by_text("需求趋势", exact=True)).to_be_visible()
    await page.get_by_text("查看需求趋势评分依据", exact=True).click()
    drilldown = page.locator('[data-score-dimension="demand_trend"]')
    await expect(drilldown).to_contain_text("规则 ID")
    await expect(drilldown).to_contain_text("score.demand_trend.existing_rubric.v1")
    await expect(drilldown).to_contain_text("证据 ID")
    await expect(drilldown).to_contain_text("evidence:trends:12m")
    await expect(drilldown).to_contain_text("计算方法")
    await expect(page.get_by_text("最终硬门槛", exact=True)).to_be_visible()


async def test_logistics_profile_and_package_weights_are_readable(guided_page):
    page, store, project = guided_page
    product_id = await focus_first_product(store, project)
    current = await store.get(project["id"])
    await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "economics",
        {
            "product_id": product_id,
            "weight_kg": 0.8,
            "package_length_cm": 30,
            "package_width_cm": 20,
            "package_height_cm": 10,
            "battery": True,
            "quote_date": "2026-09-01T00:00:00+00:00",
        },
    )
    await page.reload()
    await expect(page.locator('[data-evidence-health="true"]')).to_be_visible()
    await page.evaluate("S.step='economics'; render()")
    await expect(page.get_by_text("体积重：未知")).to_be_visible()
    await expect(page.get_by_text("计费重：未知")).to_be_visible()
    await expect(page.get_by_text("报价时效：已过期", exact=False)).to_be_visible()
    await page.get_by_role("button", name="设置承运商物流规则").click()
    await page.locator('[name="carrier"]').fill("Example Express")
    await page.locator('[name="service"]').fill("US line")
    await page.locator('[name="source_url"]').fill("https://carrier.example/rates")
    await page.locator('[name="volumetric_divisor_cm3_per_kg"]').fill("6000")
    await page.locator('[name="confirmed"]').check()
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    await expect(page.get_by_text("体积重：1 kg")).to_be_visible()
    await expect(page.get_by_text("计费重：1 kg")).to_be_visible()
    await page.reload()
    await expect(page.locator('[data-evidence-health="true"]')).to_be_visible()
    await page.evaluate("S.step='economics'; render()")
    await expect(page.get_by_text("承运商：Example Express", exact=False)).to_be_visible()


async def test_keyword_form_saves_explicit_compound_types(recovery_page):
    page, store, project = recovery_page
    for text, kind in [
        ("messy suitcase travel", "pain_scenario"),
        ("office traveler", "scenario_audience"),
    ]:
        await page.locator("details.secondary-research").evaluate("el => el.open = true")
        await page.get_by_role("button", name="＋ 添加关键词").click()
        await page.locator('[name="text"]').fill(text)
        await page.locator('[name="type"]').select_option(kind)
        await page.get_by_role("button", name="保存并继续", exact=True).click()
        await expect(page.locator("#dialog")).not_to_be_visible()

    saved = await store.get(project["id"])
    assert [word["type"] for word in saved["keywords"]] == [
        "pain_scenario",
        "scenario_audience",
    ]


async def test_similarweb_form_saves_traffic_scope(guided_page):
    page, store, project = guided_page
    await focus_first_product(store, project)
    await page.reload()
    await expect(page.locator('[data-evidence-health="true"]')).to_be_visible()
    await page.evaluate("S.step='channels'; render()")
    await page.get_by_role("button", name="＋ Similarweb").click()
    await expect(page.locator('[name="review_due_at"]')).to_have_value("")
    await expect(page.locator('[name="valid_until"]')).to_have_value("")
    await page.locator('[name="source_url"]').fill("https://similarweb.example/shop")
    await page.locator('[name="conclusion"]').fill("站点访问量")
    await page.locator('[name="confirmed"]').check()
    await page.locator('[name="direct_share"]').fill("35")
    await page.locator('[name="monthly_visits"]').fill("100000")
    await page.locator('[name="traffic_scope"]').select_option("domain")
    await page.locator('[name="traffic_url"]').fill("https://shop.example/")
    await page.locator('[name="traffic_period"]').fill("2026-09")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    await expect(page.locator("#dialog")).not_to_be_visible()
    await expect(page.get_by_text("范围：域名", exact=False)).to_be_visible()
    saved = await store.get(project["id"])
    traffic = saved["products"][0]["evidence"][-1]
    assert traffic["traffic_scope"] == "domain"
    assert traffic["monthly_visits"] == 100_000
    assert traffic["review_due_at"] is None
    assert traffic["valid_until"] is None


async def test_domain_sales_scenario_stays_separate_from_real_tests(guided_page):
    page, store, project = guided_page
    product_id = await focus_first_product(store, project)
    current = await store.get(project["id"])
    current = await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "economics",
        {"product_id": product_id, "aov": 75},
    )
    await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "evidence",
        {
            "product_id": product_id,
            "channel": "similarweb",
            "source_url": "https://similarweb.example/shop",
            "observed_at": datetime.now(UTC).isoformat(),
            "conclusion": "站点访问量",
            "confirmed": True,
            "direct_share": 35,
            "monthly_visits": 100_000,
            "traffic_scope": "domain",
            "traffic_url": "https://shop.example/",
            "traffic_period": "2026-09",
        },
    )
    await page.reload()
    await expect(page.locator('[data-evidence-health="true"]')).to_be_visible()
    await page.evaluate("S.step='economics'; render()")
    await page.get_by_role("button", name="新增销量情景估算").click()
    await page.locator('[name="cvr_low"]').fill("1")
    await page.locator('[name="cvr_base"]').fill("2")
    await page.locator('[name="cvr_high"]').fill("3")
    await page.locator('[name="cvr_source"]').fill("用户手工情景，尚无实际测试")
    await page.get_by_role("button", name="保存并继续", exact=True).click()

    card = page.locator('[data-sales-estimate="true"]')
    await expect(card).to_contain_text("情景估算，不是真实测试")
    await expect(card).to_contain_text("商品级订单/营收：未知")
    await expect(card).to_contain_text("低")
    await expect(card).to_contain_text("高")
    saved = await store.get(project["id"])
    assert len(saved["products"][0]["estimates"]) == 1
    assert saved["products"][0]["test_results"] == []
    await page.reload()
    await expect(page.locator('[data-evidence-health="true"]')).to_be_visible()
    await page.evaluate("S.step='economics'; render()")
    await expect(page.locator('[data-sales-estimate="true"]')).to_be_visible()


async def test_evidence_cards_show_unknown_and_expired_freshness(guided_page):
    page, store, project = guided_page
    product_id = await focus_first_product(store, project)
    current = await store.get(project["id"])
    current = await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "evidence",
        {
            "product_id": product_id,
            "channel": "amazon",
            "source_url": "https://amazon.example/item",
            "observed_at": datetime.now(UTC).isoformat(),
            "conclusion": "人工观察",
            "confirmed": True,
        },
    )
    observed = datetime.now(UTC) - timedelta(days=3)
    await store.command(
        project["id"],
        current["version"],
        str(uuid4()),
        "evidence",
        {
            "product_id": product_id,
            "channel": "meta",
            "source_url": "https://facebook.com/ads/library/?id=123",
            "observed_at": observed.isoformat(),
            "valid_until": (observed + timedelta(days=1)).isoformat(),
            "conclusion": "人工观察",
            "confirmed": True,
            "advertiser_count": 4,
            "brand_concentration": "low",
            "differentiation": "high",
        },
    )
    await page.reload()
    await expect(page.locator('[data-evidence-health="true"]')).to_be_visible()
    await page.evaluate("S.step='channels'; render()")
    amazon = page.locator(".evidence").filter(has_text="Amazon").first
    meta = page.locator(".evidence").filter(has_text="Meta 广告").first
    await expect(amazon).to_contain_text("时效未知")
    await expect(meta).to_contain_text("已过期")
    await expect(meta).to_contain_text("重新核对")


async def test_normalization_warning_blocks_approval_and_previews_edit(recovery_page):
    page, store, project = recovery_page
    await store.command(
        project["id"],
        project["version"],
        str(uuid4()),
        "add_keyword",
        {"text": "portable organizer", "type": "category"},
    )
    async with store.engine.begin() as connection:
        state = (
            await connection.execute(
                select(workbench_projects.c.state).where(
                    workbench_projects.c.id == project["id"]
                )
            )
        ).scalar_one()
        state["keywords"][0]["text"] = '""portable organizer" travel"'
        await connection.execute(
            update(workbench_projects)
            .where(workbench_projects.c.id == project["id"])
            .values(state=state)
        )

    await page.reload()
    await expect(page.locator("#heading")).to_have_text(project["title"])
    await expand_secondary_research(page)
    keyword_row = page.locator("tr").filter(has_text="portable organizer")
    await expect(keyword_row.get_by_text("格式需修正", exact=False)).to_be_visible()
    await expect(keyword_row.get_by_role("button", name="审核通过")).to_have_count(0)
    await keyword_row.get_by_role("button", name="修改").click()
    await page.locator('[name="text"]').fill("“portable organizer” travel")
    await expect(page.locator('[data-keyword-preview="true"]')).to_have_text(
        '实际搜索："portable organizer travel"'
    )


async def test_keyword_draft_survives_cancel_and_reload(recovery_page):
    page, _, project = recovery_page
    await expand_secondary_research(page)
    await page.get_by_role("button", name="＋ 添加关键词", exact=True).click()
    await page.locator('[name="text"]').fill("travel pouch")
    await page.locator('[name="meaning"]').fill("旅行袋草稿")
    await page.get_by_role("button", name="取消", exact=True).click()
    await page.get_by_role("button", name="＋ 添加关键词", exact=True).click()
    await expect(page.locator('[name="text"]')).to_have_value("travel pouch")
    await page.reload()
    await expect(page.locator("#heading")).to_have_text(project["title"])
    await expand_secondary_research(page)
    await page.get_by_role("button", name="＋ 添加关键词", exact=True).click()
    await expect(page.locator('[name="meaning"]')).to_have_value("旅行袋草稿")
    await page.get_by_role("button", name="放弃草稿", exact=True).click()
    await expect(page.locator('[name="text"]')).to_have_value("")


async def test_url_and_file_are_not_written_to_draft_storage(recovery_page):
    page, _, _ = recovery_page
    await page.get_by_role("button", name="＋ 添加已有商品", exact=True).click()
    await page.locator('[name="name"]').fill("商品草稿")
    await page.locator('[name="url"]').fill(
        "https://shop.example/?p=123&token=SYNTHETIC_BEARER"
    )
    await page.get_by_role("button", name="取消", exact=True).click()
    stored = await page.evaluate("JSON.stringify({...sessionStorage})")
    assert "商品草稿" in stored
    assert "SYNTHETIC" not in stored and "https://shop.example" not in stored
    await page.get_by_role("button", name="＋ 添加已有商品", exact=True).click()
    await expect(page.locator('[name="name"]')).to_have_value("商品草稿")
    await expect(page.locator('[name="url"]')).to_have_value("")


async def test_saved_command_refresh_failure_is_visible_outside_closed_modal(
    recovery_page,
):
    page, store, project = recovery_page
    await expand_secondary_research(page)
    await page.get_by_role("button", name="＋ 添加关键词", exact=True).click()
    await page.locator('[name="text"]').fill("travel pouch")
    await page.route(
        "**/workbench/api/projects",
        lambda r: r.abort() if r.request.method == "GET" else r.continue_(),
    )
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()
    await expect(page.locator("#alert")).to_contain_text("已保存")
    await expect(page.locator("#alert")).to_contain_text("刷新")
    await expect(page.locator("#alert")).to_have_attribute("role", "alert")
    assert (await store.get(project["id"]))["keywords"][0]["text"] == '"travel pouch"'


async def test_version_conflict_preserves_input_and_allows_explicit_resubmit(
    recovery_page,
):
    page, store, project = recovery_page
    await expand_secondary_research(page)
    await page.get_by_role("button", name="＋ 添加关键词", exact=True).click()
    await page.locator('[name="text"]').fill("travel pouch")
    await store.command(
        project["id"],
        0,
        str(uuid4()),
        "add_keyword",
        {"text": "other bag", "type": "pain"},
    )
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#form-error")).to_contain_text("草稿")
    await expect(page.locator('[name="text"]')).to_have_value("travel pouch")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()
    p = await store.get(project["id"])
    assert p["version"] == 2
    assert len(p["keywords"]) == 2


async def test_lost_post_response_can_be_retried_without_duplicate_event(recovery_page):
    page, store, project = recovery_page
    await expand_secondary_research(page)
    await page.get_by_role("button", name="＋ 添加关键词", exact=True).click()
    await page.locator('[name="text"]').fill("travel pouch")

    async def lose_response(route):
        await route.fetch()
        await route.abort()

    await page.route("**/workbench/api/projects/*/commands", lose_response, times=1)
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#form-error")).to_be_visible()
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()
    p = await store.get(project["id"])
    assert p["version"] == 1
    assert len(p["keywords"]) == 1


async def test_archive_restore_ui_requires_fresh_review(recovery_page):
    page, store, project = recovery_page
    await expand_secondary_research(page)
    await page.get_by_role("button", name="＋ 添加关键词", exact=True).click()
    await page.locator('[name="text"]').fill("travel pouch")
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#alert")).to_contain_text("已保存")
    await expand_secondary_research(page)
    await page.get_by_role("button", name="不再采用", exact=True).click()
    await expect(page.locator("#alert")).to_contain_text("已保存")
    await expand_secondary_research(page)
    keyword_row = page.locator(".secondary-research table tr").filter(
        has_text="travel pouch"
    )
    await keyword_row.get_by_role(
        "button", name="恢复并重新审核", exact=True
    ).click()
    await expect(page.locator("#alert")).to_contain_text("已保存恢复操作")
    await expand_secondary_research(page)
    await expect(
        keyword_row.get_by_role("button", name="审核通过", exact=True)
    ).to_be_visible()
    p = await store.get(project["id"])
    assert p["keywords"][0]["status"] == "pending_review"
    assert p["keywords"][0]["approved"] is False


@pytest.mark.parametrize("secure_crypto", [True, False])
async def test_uncertain_new_project_cannot_be_resubmitted_with_changed_input(
    recovery_page, secure_crypto,
):
    page, store, _ = recovery_page
    if not secure_crypto:
        await page.evaluate("Object.defineProperty(crypto, 'randomUUID', {value:undefined}); Object.defineProperty(crypto, 'subtle', {value:undefined});")
    original_title = "响应丢失项目 " + str(uuid4())
    changed_title = "修改后的新项目 " + str(uuid4())
    await page.get_by_role("button", name="＋ 新建研究", exact=True).click()
    await page.locator('[name="title"]').fill(original_title)
    await page.locator('[name="direction"]').fill("旅行收纳")
    await page.locator('[name="market"]').select_option("US")

    async def lose_response(route):
        if route.request.method == "POST":
            await route.fetch()
            await route.abort()
        else:
            await route.continue_()

    await page.route("**/workbench/api/projects", lose_response)
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.locator("#form-error")).to_be_visible()
    await page.locator('[name="title"]').fill(changed_title)
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(
        page.get_by_role("button", name="保存并继续", exact=True)
    ).to_be_enabled()
    await expect(page.locator("#dialog")).to_be_visible()
    projects = await store.list_projects()
    assert len([p for p in projects if p["title"] == original_title]) == 1
    assert not any(p["title"] == changed_title for p in projects)


async def test_new_project_has_a_valid_default_market(recovery_page):
    page, _, _ = recovery_page
    await page.get_by_role("button", name="＋ 新建研究", exact=True).click()
    await expect(page.locator('[name="market"]')).to_have_value("US")


async def test_batch_partial_outcomes_are_shown_in_page(recovery_page):
    page, _, _ = recovery_page
    await expand_secondary_research(page)
    await page.route(
        "**/workbench/api/projects/*/actions",
        lambda route: (
            route.fulfill(
                json={
                    "requested": 3,
                    "queued": 1,
                    "unchanged": 1,
                    "failed": [
                        {
                            "text": '"small bag"',
                            "code": "budget",
                            "message": "扫描预算不足",
                        }
                    ],
                }
            )
            if route.request.method == "POST"
            else route.fulfill(json={"actions": []})
        ),
    )
    await page.get_by_role("button", name="扫描全部已审核词", exact=True).click()
    await expect(page.locator("#alert")).to_contain_text("1 个已排队")
    await expect(page.locator("#alert")).to_contain_text("1 个无需重复")
    await expect(
        page.locator("details.secondary-research").get_by_text(
            "查看未排队关键词与原因", exact=True
        )
    ).to_be_visible()
    await page.get_by_text("查看未排队关键词与原因", exact=True).click()
    await expect(
        page.get_by_text('"small bag"：扫描预算不足', exact=True)
    ).to_be_visible()


async def test_keyword_buttons_show_local_progress_and_batch_result(recovery_page):
    page, _, _ = recovery_page
    secondary = await expand_secondary_research(page)
    release_response = asyncio.Event()

    async def delayed_batch(route):
        if route.request.method == "POST":
            await release_response.wait()
            await route.fulfill(json={"requested": 0, "queued": 0, "unchanged": 0, "failed": []})
        else:
            await route.fulfill(json={"actions": [], "next_cursor": None})

    await page.route("**/workbench/api/projects/*/actions", delayed_batch)
    try:
        await secondary.get_by_role("button", name="扫描全部已审核词").click()
        feedback = secondary.locator("[data-keyword-feedback]")
        await expect(feedback).to_contain_text("正在检查已审核词")
        await expect(feedback).to_be_in_viewport()
    finally:
        release_response.set()
    await expect(feedback).to_contain_text("没有可扫描的已审核词")


async def test_ai_keyword_failure_is_visible_beside_button(recovery_page):
    page, _, _ = recovery_page
    secondary = await expand_secondary_research(page)

    async def unavailable_ai(route):
        if route.request.method == "POST":
            await asyncio.sleep(0.35)
            await route.fulfill(status=503, json={"detail": "AI 服务暂不可用"})
        else:
            await route.fulfill(json={"actions": [], "next_cursor": None})

    await page.route("**/workbench/api/projects/*/actions", unavailable_ai)
    await secondary.get_by_role("button", name="AI 建议初始词").click()
    feedback = secondary.locator("[data-keyword-feedback]")
    await expect(feedback).to_contain_text("AI 服务暂不可用")
    await expect(feedback).to_be_in_viewport()


async def test_existing_ai_request_does_not_claim_new_queue(recovery_page):
    page, _, _ = recovery_page
    secondary = await expand_secondary_research(page)
    await page.route(
        "**/workbench/api/projects/*/actions",
        lambda route: route.fulfill(
            json={"id": str(uuid4()), "status": "complete", "disposition": "unchanged"}
            if route.request.method == "POST"
            else {"actions": [], "next_cursor": None}
        ),
    )
    await secondary.get_by_role("button", name="AI 建议初始词").click()
    await expect(secondary.locator("[data-keyword-feedback]")).to_contain_text(
        "这次 AI 请求已存在"
    )
    await expect(page.locator("#alert")).not_to_contain_text("已加入队列")


async def test_ai_action_blocked_is_highlighted_at_keyword_buttons(recovery_page):
    page, _, _ = recovery_page
    secondary = await expand_secondary_research(page)
    action_id = str(uuid4())
    recorded_at = datetime.now(UTC).isoformat()

    async def blocked_action(route):
        if route.request.method == "POST":
            await route.fulfill(
                json={"id": action_id, "status": "queued", "disposition": "queued"}
            )
        else:
            await route.fulfill(
                json={
                    "actions": [{
                        "id": action_id, "kind": "keywords", "label": "AI 初始词",
                        "status": "blocked", "message": "AI 服务暂不可用",
                        "created_at": recorded_at, "updated_at": recorded_at,
                        "result": None,
                    }],
                    "next_cursor": None,
                }
            )

    await page.route("**/workbench/api/projects/*/actions*", blocked_action)
    await secondary.get_by_role("button", name="AI 建议初始词").click()
    feedback = secondary.locator("[data-keyword-feedback]")
    await expect(feedback).to_contain_text("AI 服务暂不可用")
    await expect(feedback).to_have_class(re.compile("keyword-feedback-error"))


async def test_added_keyword_has_local_next_step(recovery_page):
    page, _, _ = recovery_page
    secondary = await expand_secondary_research(page)
    await secondary.get_by_role("button", name="＋ 添加关键词").click()
    await expect(page.locator("#dialog")).to_be_visible()
    await page.locator('#editor [name="text"]').fill("portable organizer")
    await page.locator("#submit-form").click()
    feedback = secondary.locator("[data-keyword-feedback]")
    await expect(feedback).to_contain_text("审核通过")
    await expect(feedback).to_be_in_viewport()


async def test_action_history_loads_more_without_losing_existing_rows(recovery_page):
    page, store, project = recovery_page
    now = datetime.now(UTC)
    rows = [
        {
            "id": uuid4(),
            "dedupe_key": f"browser-history:{project['id']}:{index}",
            "project_id": UUID(project["id"]),
            "kind": "keywords",
            "status": "complete",
            "input_version": 0,
            "payload": {},
            "result": {},
            "created_at": now - timedelta(seconds=index),
            "updated_at": now - timedelta(seconds=index),
            "attempt": 1,
        }
        for index in range(41)
    ]
    async with store.engine.begin() as connection:
        await connection.execute(insert(actions), rows)

    await page.reload()
    await expect(page.locator("#heading")).to_have_text(project["title"])
    await expand_secondary_research(page)
    await page.locator(".focus-log-drawer > summary").click()
    await expect(page.locator(".action-record")).to_have_count(20)
    await page.get_by_role("button", name="加载更早记录", exact=True).click()
    await expect(page.locator(".action-record")).to_have_count(40)
    await expand_secondary_research(page)

    await page.route(
        "**/workbench/api/projects/*/actions?limit=20&cursor=*",
        lambda route: route.abort(),
        times=1,
    )
    await page.get_by_role("button", name="加载更早记录", exact=True).click()
    await expand_secondary_research(page)
    await expect(page.get_by_text("较早记录加载失败", exact=False)).to_be_visible()
    await expect(page.locator(".action-record")).to_have_count(40)


async def test_csv_and_url_text_are_excluded_from_session_draft(recovery_page):
    page, store, project = recovery_page
    p = await store.command(
        project["id"],
        0,
        str(uuid4()),
        "add_product",
        {"name": "隔离商品", "url": "https://shop.example/p/a"},
    )
    await page.reload()
    await expect(page.locator("#heading")).to_have_text(project["title"])
    await page.get_by_role("button", name="打开产品档案", exact=False).click()
    await page.evaluate("S.step='channels'; render()")
    await page.get_by_role("button", name="导入 Trends CSV", exact=True).click()
    await page.locator('[name="query"]').fill("travel pouch")
    await page.locator('[name="source_url"]').fill(
        "https://trends.google.com/?token=SYNTHETIC_URL"
    )
    await page.locator('[name="csv"]').set_input_files(
        {
            "name": "source.csv",
            "mimeType": "text/csv",
            "buffer": b"SYNTHETIC_CSV_CONTENT",
        }
    )
    stored = await page.evaluate("JSON.stringify({...sessionStorage})")
    assert "travel pouch" in stored
    assert "SYNTHETIC" not in stored
    assert p["products"][0]["id"] in stored


async def test_drafts_of_distinct_products_never_mix(recovery_page):
    page, store, project = recovery_page
    p = await store.command(
        project["id"],
        0,
        str(uuid4()),
        "add_product",
        {"name": "商品 A", "url": "https://shop.example/p/a"},
    )
    p = await store.command(
        project["id"],
        p["version"],
        str(uuid4()),
        "add_product",
        {"name": "商品 B", "url": "https://shop.example/p/b"},
    )
    await page.evaluate("id => openProject(id)", p["id"])
    await (
        page.locator(".card")
        .filter(has_text="商品 A")
        .get_by_role("button", name="打开产品档案")
        .click()
    )
    await page.get_by_role("button", name="确认具体商品", exact=True).click()
    await page.locator('[name="reason"]').fill("只属于 A 的草稿")
    await page.get_by_role("button", name="取消", exact=True).click()
    await page.get_by_role("button", name=project["title"], exact=True).click()
    await (
        page.locator(".card")
        .filter(has_text="商品 B")
        .get_by_role("button", name="打开产品档案")
        .click()
    )
    await page.get_by_role("button", name="确认具体商品", exact=True).click()
    await expect(page.locator('[name="reason"]')).to_have_value("")


@pytest.mark.parametrize("width", [1324, 390, 375])
async def test_quick_triage_collapses_bound_ads_and_keeps_decisions_visible(guided_page, width):
    page, store, project = guided_page
    keyword_id = project["keywords"][0]["id"]
    project = await store.command(
        project["id"], project["version"], str(uuid4()), "collection_result",
        {"keyword_id": keyword_id, "status": "complete", "ads": [
            {"id": f"extra-{i}", "advertiser": "Same seller",
             "landing_url": "https://shop.example/p/01",
             "primary_text": f"Additional evidence {i} " + "Long source copy. " * 100,
             "active": True} for i in range(6)
        ]}, actor="automation",
    )
    before = await store.get(project["id"])
    await page.set_viewport_size({"width": width, "height": 900})
    await page.reload()
    await page.get_by_role("button", name="判断是否保留当前商品").click()
    lead = page.locator('[data-current-lead="true"]')
    await expect(lead.locator(".triage-representative .evidence")).to_have_count(1)
    await expect(lead).to_contain_text("7 条关联广告记录")
    await expect(lead).to_contain_text("不代表独立创意数量或连续投放证明")
    more = lead.locator("details.triage-more-ads")
    await expect(more).not_to_have_attribute("open", "")
    await expect(more.locator(".evidence")).to_have_count(0)
    await more.locator("summary").click()
    await expect(more.locator(".evidence")).to_have_count(6)
    await expect(more.get_by_text("Additional evidence 5", exact=False)).to_be_visible()
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await expect(lead.get_by_role("button", name="保留并深挖", exact=True)).to_be_in_viewport()
    await expect(lead.get_by_role("button", name="暂时观察", exact=True)).to_be_in_viewport()
    await expect(lead.get_by_role("button", name="淘汰这条线索", exact=True)).to_be_in_viewport()
    await more.locator("summary").click()
    await expect(more.locator(".evidence").first).to_be_hidden()
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    after = await store.get(project["id"])
    assert after["version"] == before["version"]
    assert after["products"] == before["products"]

async def test_project_delete_requires_name_and_survives_reload(recovery_page):
    page, store, project = recovery_page
    await page.get_by_role("button", name="研究项目", exact=True).click()
    card = page.locator(".card").filter(has_text=project["title"])
    await card.get_by_role("button", name="删除项目", exact=True).click()
    await page.get_by_role("button", name="取消", exact=True).click()
    assert (await store.get(project["id"]))["id"] == project["id"]
    await card.get_by_role("button", name="删除项目", exact=True).click()
    await page.locator('#editor [name="title"]').fill("wrong")
    await page.get_by_role("button", name="确认删除项目", exact=True).click()
    await expect(page.locator("#form-error")).to_contain_text("项目名称不一致")
    await page.locator('#editor [name="title"]').fill(project["title"])
    await page.get_by_role("button", name="确认删除项目", exact=True).click()
    await expect(page.locator("#dialog")).not_to_be_visible()
    await expect(page.locator(".card").filter(has_text=project["title"])).to_have_count(0)
    await page.reload()
    await expect(page.locator(".card").filter(has_text=project["title"])).to_have_count(0)
    from rabbit_hole.domain.project import WorkbenchError
    with pytest.raises(WorkbenchError, match="研究项目不存在"):
        await store.get(project["id"])


async def test_new_project_country_options_and_saved_market(recovery_page):
    page, store, _ = recovery_page
    await page.locator('#new-project').click()
    selector = page.locator('#editor [name=market]')
    assert await selector.locator('option').evaluate_all('(nodes)=>nodes.map(n=>n.value)') == ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP']
    await page.locator('#editor [name=title]').fill('Isolated German research')
    await page.locator('#editor [name=direction]').fill('Travel storage')
    await selector.select_option('DE')
    await page.locator('#editor button[type=submit]').click()
    await expect(page.locator('#dialog')).not_to_be_visible()
    project = await page.evaluate('S.project')
    assert (await store.get(project['id']))['market'] == 'DE'
    await page.get_by_role('button', name='添加入口词', exact=True).click()
    await expect(page.locator('#dialog')).to_contain_text('当地语言')
    await page.locator('#editor [name=text]').fill('Reisetasche')
    await page.locator('#editor button[type=submit]').click()
    await expect(page.locator('#dialog')).not_to_be_visible()
    saved = await store.get(project['id'])
    assert saved['keywords'][0]['text'] == '"Reisetasche"'


async def test_project_direction_ai_fills_empty_and_previews_existing_text(recovery_page):
    page, store, _ = recovery_page
    requests = []
    draft = '围绕水晶饰品和宗教主题配饰研究加拿大市场的具体产品与礼赠场景。'
    async def complete(route):
        requests.append(route.request.post_data_json)
        await route.fulfill(json={'direction': draft})
    await page.route('**/workbench/api/project-direction', complete)
    before = len(await store.list_projects())
    await page.locator('#new-project').click()
    await page.get_by_role('button', name='AI 帮写', exact=True).click()
    await expect(page.locator('[data-direction-status]')).to_contain_text('项目名称')
    assert not requests
    await page.locator('#editor [name=title]').fill('水晶饰品+宗教信仰')
    await page.locator('#editor [name=market]').select_option('CA')
    await page.get_by_role('button', name='AI 帮写', exact=True).click()
    await expect(page.locator('#editor [name=direction]')).to_have_value(draft)
    assert requests == [{'title': '水晶饰品+宗教信仰', 'market': 'CA'}]
    await page.locator('#editor [name=direction]').fill('我自己的研究目标')
    await page.get_by_role('button', name='AI 帮写', exact=True).click()
    await expect(page.locator('[data-direction-preview]')).to_contain_text(draft)
    await expect(page.locator('#editor [name=direction]')).to_have_value('我自己的研究目标')
    await page.get_by_role('button', name='使用这段建议', exact=True).click()
    await expect(page.locator('#editor [name=direction]')).to_have_value(draft)
    assert len(await store.list_projects()) == before
    await page.get_by_role('button', name='取消', exact=True).click()


async def test_direction_ai_failure_and_late_result_preserve_user_input(recovery_page):
    page, _, _ = recovery_page
    await page.locator('#new-project').click()
    await page.locator('#editor [name=title]').fill('original title')
    await page.locator('#editor [name=direction]').fill('原来的目标')
    await page.route('**/workbench/api/project-direction', lambda r: r.fulfill(status=503, json={'detail':'AI 接口暂时无法连接'}))
    await page.get_by_role('button', name='AI 帮写', exact=True).click()
    await expect(page.locator('[data-direction-status]')).to_contain_text('无法连接')
    await expect(page.locator('#editor [name=direction]')).to_have_value('原来的目标')
    await page.unroute('**/workbench/api/project-direction')
    async def delayed(route):
        await asyncio.sleep(0.5)
        await route.fulfill(json={'direction':'过期的建议'})
    await page.route('**/workbench/api/project-direction', delayed)
    await page.get_by_role('button', name='AI 帮写', exact=True).click()
    await expect(page.locator('[data-direction-status]')).to_contain_text('正在')
    await page.locator('#editor [name=title]').fill('changed title')
    await expect(page.locator('[data-direction-status]')).to_contain_text('已改变')
    await expect(page.locator('#editor [name=direction]')).to_have_value('原来的目标')
    await expect(page.locator('#submit-form')).to_be_enabled()
    await page.get_by_role('button', name='取消', exact=True).click()


async def test_closing_direction_request_does_not_change_reopened_form(recovery_page):
    page, _, _ = recovery_page
    started = asyncio.Event()
    release = asyncio.Event()
    async def delayed(route):
        started.set()
        await release.wait()
        await route.fulfill(json={'direction':'属于旧表单的建议'})
    await page.route('**/workbench/api/project-direction', delayed)
    await page.locator('#new-project').click()
    await page.locator('#editor [name=title]').fill('旧项目')
    await page.get_by_role('button', name='AI 帮写', exact=True).click()
    await started.wait()
    await page.get_by_role('button', name='取消', exact=True).click()
    await page.locator('#new-project').click()
    await page.locator('#editor [name=direction]').fill('重新打开后的目标')
    release.set()
    await asyncio.sleep(0.2)
    await expect(page.locator('#editor [name=direction]')).to_have_value('重新打开后的目标')
    await expect(page.locator('#submit-form')).to_be_enabled()
    await page.get_by_role('button', name='取消', exact=True).click()

async def test_idle_log_connection_status_survives_project_rerender(recovery_page):
    page, store, project = recovery_page
    status = page.locator("[data-live-log-status]")
    await expect(status).to_contain_text("推送已连接", timeout=10000)
    # An existing healthy stream must survive redraw even when a new connection would fail.
    await page.route("**/workbench/api/projects/*/log-stream*", lambda route: route.abort())
    project = await store.command(project["id"], project["version"], str(uuid4()), "add_keyword", {"text": "idle status regression", "type": "function"})
    await expect(page.locator("#subtitle")).to_contain_text("1 个关键词", timeout=10000)
    await expect(status).to_contain_text("推送已连接", timeout=10000)
