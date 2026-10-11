"""Translate saved ads for reading without changing source evidence."""
from uuid import uuid4

from playwright.async_api import expect

pytest_plugins = ("test_workbench_recovery",)


async def saved_ad(recovery_page, text="Travel with your pet."):
    page, store, project = recovery_page
    project = await store.command(project["id"], project["version"], str(uuid4()), "add_keyword", {"text": "pet travel", "type": "category"})
    word = project["keywords"][0]["id"]
    project = await store.command(project["id"], project["version"], str(uuid4()), "approve_keyword", {"keyword_id": word, "approved": True})
    project = await store.command(project["id"], project["version"], str(uuid4()), "collection_result", {
        "keyword_id": word, "status": "complete", "ads": [{"id": "translate-ad", "primary_text": text, "advertiser": "Pet Shop", "active": True}],
    }, actor="automation")
    await page.reload()
    return page, store, project


async def test_switch_chinese_back_and_rerender_uses_one_request(recovery_page):
    page, store, project = await saved_ad(recovery_page)
    requests = []
    async def translate(route):
        requests.append(route.request.post_data_json)
        await route.fulfill(json={"translated": "带宠物一起旅行。", "cached": False})
    await page.route("**/ads/translate", translate)
    workspace = page.locator("[data-focus-workspace]")
    await workspace.get_by_role("button", name="切换为中文", exact=True).first.click()
    await expect(workspace.locator(".focus-source-quote")).to_have_text("带宠物一起旅行。")
    await expect(workspace).to_contain_text("仅供阅读")
    await workspace.get_by_role("button", name="查看原文", exact=True).first.click()
    await expect(workspace.locator(".focus-source-quote")).to_have_text("Travel with your pet.")
    await workspace.get_by_role("button", name="切换为中文", exact=True).first.click()
    await page.evaluate("render()")
    await expect(workspace.locator(".focus-source-quote")).to_have_text("带宠物一起旅行。")
    assert len(requests) == 1
    assert requests[0]["expected_text"] == "Travel with your pet."
    current = await store.get(project["id"])
    assert current["version"] == project["version"]
    assert current["keywords"][0]["ads"][0]["primary_text"] == "Travel with your pet."


async def test_translation_failure_keeps_source_and_allows_retry(recovery_page):
    page, store, project = await saved_ad(recovery_page)
    async def failure(route):
        await route.fulfill(status=503, json={"detail": "阿里云密钥缺少机器翻译权限"})
    await page.route("**/ads/translate", failure)
    workspace = page.locator("[data-focus-workspace]")
    await workspace.get_by_role("button", name="切换为中文", exact=True).first.click()
    await expect(workspace.locator(".focus-source-quote")).to_have_text("Travel with your pet.")
    await expect(workspace).to_contain_text("阿里云密钥缺少机器翻译权限")
    await expect(workspace.get_by_role("button", name="重试翻译", exact=True).first).to_be_enabled()
    assert (await store.get(project["id"]))["version"] == project["version"]

async def test_translation_button_visible_before_scrolling_long_ad(recovery_page):
    page, store, project = await saved_ad(recovery_page, "Travel with your pet. " * 200)
    await page.set_viewport_size({"width": 1440, "height": 900})
    await expect(page.locator("[data-focus-workspace]")).to_be_visible()
    await page.evaluate("showAds(S.project.keywords[0])")
    await expect(page.locator("#dialog").get_by_role("button", name="切换为中文", exact=True)).to_be_in_viewport()
    assert (await store.get(project["id"]))["version"] == project["version"]


async def test_template_copy_shows_explanation_without_translation(recovery_page):
    page, store, project = await saved_ad(recovery_page, "{{product.brand}}")
    await expect(page.locator("[data-focus-workspace]")).to_be_visible()
    await page.evaluate("showAds(S.project.keywords[0])")
    dialog = page.locator("#dialog")
    await expect(dialog).to_contain_text("动态商品广告，未获取可用正文")
    await expect(dialog).not_to_contain_text("{{product.brand}}")
    await expect(dialog.get_by_role("button", name="切换为中文", exact=True)).to_have_count(0)
    await expect(dialog.get_by_role("link", name="查看原广告 ↗")).to_be_visible()
    assert (await store.get(project["id"]))["keywords"][0]["ads"][0]["primary_text"] == "{{product.brand}}"
