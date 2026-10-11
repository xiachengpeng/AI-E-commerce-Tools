"""Focused navigation preserves sources and manual execution boundaries."""
from uuid import uuid4

from playwright.async_api import expect

pytest_plugins = ("test_workbench_recovery",)


async def add_word(store, project, phrase):
    return await store.command(
        project["id"], project["version"], str(uuid4()), "add_keyword",
        {"text": phrase, "type": "scenario"},
    )


async def add_lead(store, project, name, word_id):
    return await store.command(
        project["id"], project["version"], str(uuid4()), "add_product",
        {"name": name, "url": "https://example.com/" + str(uuid4()),
         "source_keyword_ids": [word_id]},
    )


async def test_switching_word_shows_only_that_words_leads_without_searching(recovery_page):
    page, store, project = recovery_page
    project = await add_word(store, project, "pet travel")
    first = project["keywords"][0]["id"]
    project = await add_word(store, project, "camping storage")
    second = project["keywords"][1]["id"]
    project = await add_lead(store, project, "旅行杯", first)
    project = await add_lead(store, project, "露营袋", second)
    version = project["version"]
    await page.reload()
    workspace = page.locator("[data-focus-workspace]")
    await expect(workspace).to_contain_text("旅行杯")
    await page.get_by_role("button", name="切换搜索词", exact=True).click()
    await page.get_by_label("查找搜索词").fill("camping")
    await page.locator("[data-keyword-choice]").filter(has_text="camping storage").click()
    await expect(workspace).to_contain_text("露营袋")
    await expect(workspace).not_to_contain_text("旅行杯")
    current = await store.get(project["id"])
    assert current["version"] == version
    assert all(word["status"] == "pending_review" for word in current["keywords"])


async def test_next_lead_opens_its_own_product_identity(recovery_page):
    page, store, project = recovery_page
    project = await add_word(store, project, "travel packing")
    word = project["keywords"][0]["id"]
    project = await add_lead(store, project, "旅行袋 A", word)
    project = await add_lead(store, project, "旅行袋 B", word)
    await page.reload()
    workspace = page.locator("[data-focus-workspace]")
    await expect(workspace).to_contain_text("旅行袋 A")
    await workspace.get_by_role("button", name="下一条线索", exact=True).click()
    await expect(workspace).to_contain_text("旅行袋 B")
    await workspace.get_by_role("button", name="识别商品：旅行袋 B", exact=True).click()
    await expect(page.get_by_role("dialog")).to_be_visible()
    await expect(page.get_by_role("textbox", name="产品名称", exact=True)).to_have_value("旅行袋 B")
    await page.get_by_role("button", name="取消", exact=True).click()
    await expect(workspace).to_contain_text("旅行袋 B")


async def test_active_search_can_be_stopped_after_switching_back(recovery_page):
    from rabbit_hole.application.actions import enqueue_action
    page, store, project = recovery_page
    project = await add_word(store, project, "road trip")
    word = project["keywords"][0]["id"]
    project = await add_word(store, project, "camping")
    project = await store.command(
        project["id"], project["version"], str(uuid4()), "approve_keyword",
        {"keyword_id": word, "approved": True},
    )
    await enqueue_action(store, project["id"], {
        "kind": "scan", "version": project["version"], "keyword_id": word,
    })
    await page.reload()
    await page.get_by_role("button", name="切换搜索词", exact=True).click()
    await page.locator("[data-keyword-choice]").filter(has_text='"camping"').click()
    await page.get_by_role("button", name="切换搜索词", exact=True).click()
    await page.locator("[data-keyword-choice]").filter(has_text='"road trip"').click()
    workspace = page.locator("[data-focus-workspace]")
    await workspace.get_by_role("button", name="停止本次搜索", exact=True).click()
    await expect(workspace.get_by_role("button", name="重试搜索", exact=True)).to_be_visible()
    current = await store.get(project["id"])
    assert current["keywords"][0]["status"] != "running"


async def test_shared_keyword_does_not_misattribute_an_ads_text(recovery_page):
    page, store, project = recovery_page
    project = await add_word(store, project, "travel bag")
    word = project["keywords"][0]["id"]
    project = await add_lead(store, project, "人工加入的袋子", word)
    project = await store.command(
        project["id"], project["version"], str(uuid4()), "approve_keyword",
        {"keyword_id": word, "approved": True},
    )
    await store.command(
        project["id"], project["version"], str(uuid4()), "collection_result",
        {"keyword_id": word, "status": "complete", "ads": [{
            "id": "other-ad", "advertiser": "另一广告主", "active": True,
            "primary_text": "Only belongs to the other product",
            "landing_url": "https://example.com/other-product",
        }]}, actor="automation",
    )
    await page.reload()
    workspace = page.locator("[data-focus-workspace]")
    await expect(workspace).to_contain_text("人工加入的袋子")
    await expect(workspace).to_contain_text("未绑定具体广告")
    await expect(workspace).not_to_contain_text("Only belongs to the other product")


async def test_search_capture_is_optional_and_keeps_next_action_visible(recovery_page):
    import base64

    page, store, project = recovery_page
    project = await add_word(store, project, "packing case")
    word = project["keywords"][0]["id"]
    project = await add_lead(store, project, "隔离截图线索", word)
    await page.set_viewport_size({"width": 1440, "height": 1024})
    await page.route(
        "**/actions/capture-test/screenshot",
        lambda route: route.fulfill(
            content_type="image/png",
            body=base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9kAAAAASUVORK5CYII="),
        ),
    )
    await page.reload()
    await expect(page.locator("[data-focus-workspace]")).to_be_visible()
    await page.evaluate(
        "id => {S.keywordActions[id]={id:'capture-test',result:{evidence_id:'isolated'}};render()}",
        word,
    )
    capture = page.locator(".focus-capture-details")
    await expect(capture).to_have_count(1)
    assert not await capture.evaluate("node => node.open")
    await expect(page.locator(".focus-log-drawer > summary")).to_be_in_viewport()
    await capture.locator("summary").click()
    await expect(capture.locator("img")).to_be_visible()
    await expect(capture).to_contain_text("非当前商品专属素材")
    assert (await store.get(project["id"]))["version"] == project["version"]
