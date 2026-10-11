"""Unsearched, empty, failed and historical results remain distinct in real UI."""
from uuid import UUID, uuid4

from playwright.async_api import expect
from sqlalchemy import update

from rabbit_hole.application.actions import actions, enqueue_action

pytest_plugins = ("test_workbench_recovery",)


async def word(store, p, text):
    return await store.command(p["id"], p["version"], str(uuid4()), "add_keyword", {"text": text, "type": "function"})


async def approve(store, p, key):
    return await store.command(p["id"], p["version"], str(uuid4()), "approve_keyword", {"keyword_id": key, "approved": True})


async def test_unsearched_entry_has_no_zero_count_and_begins_at_review(recovery_page):
    page, store, project = recovery_page
    project = await word(store, project, "foldable")
    await page.reload()
    workspace = page.locator("[data-focus-workspace]")
    await expect(workspace.locator("[data-search-summary]")).to_contain_text("尚未搜索")
    await expect(workspace.locator("[data-search-summary]")).not_to_contain_text("0 条")
    await expect(workspace.locator(".focus-stages .active")).to_have_text("1看广告")
    await expect(workspace).to_contain_text("下一步：修改或审核")
    await page.get_by_role("button", name="切换搜索词", exact=True).click()
    choice = page.locator("[data-keyword-choice]")
    await expect(choice).to_contain_text("尚未搜索")
    await expect(choice).not_to_contain_text("0 条广告")
    assert (await store.get(project["id"]))["version"] == project["version"]


async def test_latest_zero_search_does_not_erase_or_mislabel_historical_ads(recovery_page):
    page, store, project = recovery_page
    project = await word(store, project, "organizer")
    key = project["keywords"][0]["id"]
    project = await approve(store, project, key)
    q = await enqueue_action(store, project["id"], {"kind": "scan", "version": project["version"], "keyword_id": key})
    project = await store.get(project["id"])
    project = await store.command(project["id"], project["version"], str(uuid4()), "collection_result", {
        "keyword_id": key, "status": "complete", "ads": [{"id": "historical-ad", "advertiser": "Isolated", "active": True, "primary_text": "Historical source text"}],
    }, actor="automation")
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(q["id"])).values(status="complete", result={"ads": 0}))
    await page.reload()
    summary = page.locator("[data-search-summary]")
    await expect(summary).to_contain_text("本次采集 0 条（限定样本）")
    await expect(summary).to_contain_text("累计保留 1 条广告")
    assert len((await store.get(project["id"]))["keywords"][0]["ads"]) == 1


async def test_stopped_scan_is_not_reported_as_empty_and_has_recovery(recovery_page):
    page, store, project = recovery_page
    project = await word(store, project, "camping")
    key = project["keywords"][0]["id"]
    project = await approve(store, project, key)
    q = await enqueue_action(store, project["id"], {"kind": "scan", "version": project["version"], "keyword_id": key})
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(q["id"])).values(status="blocked", error_code="stopped"))
    await page.reload()
    workspace = page.locator("[data-focus-workspace]")
    await expect(workspace.locator("[data-search-summary]")).to_contain_text("本次已停止")
    await expect(workspace.locator("[data-search-summary]")).not_to_contain_text("0 条广告")
    await expect(workspace.get_by_role("button", name="重试搜索", exact=True)).to_be_visible()
    assert not await page.locator(".focus-guidance").is_visible()


async def test_ai_entry_failure_is_visible_in_exploration_without_opening_settings(recovery_page):
    page, store, project = recovery_page

    async def reject_post(route):
        if route.request.method == "POST":
            await route.fulfill(status=503, json={"detail": "隔离模拟：AI 服务不可用"})
        else:
            await route.continue_()

    await page.route("**/workbench/api/projects/*/actions", reject_post)
    await page.get_by_role("button", name="AI 生成入口词", exact=True).click()
    feedback = page.locator("[data-entry-feedback]")
    await expect(feedback).to_contain_text("AI 服务不可用")
    await expect(feedback).to_be_in_viewport()
    assert not await page.locator("details.secondary-research").evaluate("node => node.open")
    assert (await store.get(project["id"]))["version"] == project["version"]
