"""Reference layout keeps browsing local and does not invent media or identity."""
import base64
from uuid import uuid4

from playwright.async_api import expect

pytest_plugins = ("test_workbench_recovery",)


async def collected_lead(recovery_page):
    page, store, project = recovery_page
    project = await store.command(project["id"], project["version"], str(uuid4()), "add_keyword",
                                 {"text": "portable organizer", "type": "category"})
    wid = project["keywords"][0]["id"]
    project = await store.command(project["id"], project["version"], str(uuid4()), "approve_keyword",
                                 {"keyword_id": wid, "approved": True})
    project = await store.command(project["id"], project["version"], str(uuid4()), "collection_result",
                                 {"keyword_id": wid, "status": "complete", "ads": [{
                                     "id": "ad-gallery", "advertiser": "Travel", "active": True,
                                     "landing_url": "https://example.com/products/organizer",
                                     "primary_text": "Keep your travel essentials organized.",
                                     "media": [{"kind": "image", "url": "https://cdn.example/one.jpg"},
                                               {"kind": "image", "url": "https://cdn.example/two.jpg"}]}]},
                                 actor="automation")
    await page.route("https://cdn.example/**", lambda route: route.fulfill(status=200, content_type="image/png",
        body=base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9kAAAAASUVORK5CYII=")))
    await page.reload()
    await expect(page.locator("[data-focus-workspace]")).to_be_visible()
    return page, store, project


async def test_gallery_changes_only_the_preview_and_keeps_original_on_right(recovery_page):
    page, store, project = await collected_lead(recovery_page)
    await expect(page.locator(".focus-media-stage .focus-media-content")).to_have_attribute("src", "https://cdn.example/one.jpg")
    await expect(page.locator(".focus-lead-info")).to_contain_text("Keep your travel essentials organized.")
    await page.get_by_role("button", name="查看素材 2", exact=True).click()
    await expect(page.locator(".focus-media-stage .focus-media-content")).to_have_attribute("src", "https://cdn.example/two.jpg")
    await expect(page.get_by_role("button", name="复制原文", exact=True)).to_be_visible()
    assert (await store.get(project["id"]))["version"] == project["version"]


async def test_broken_media_keeps_original_source_and_recovery_visible(recovery_page):
    page, _store, _project = await collected_lead(recovery_page)
    await page.route("https://cdn.example/**", lambda route: route.abort())
    await page.reload()
    await expect(page.locator(".focus-media-stage")).to_contain_text("素材暂时无法加载")
    await expect(page.locator(".focus-lead-info").get_by_role("link", name="查看原广告")).to_be_visible()


async def test_missing_media_does_not_use_unrelated_ad(recovery_page):
    page, store, project = await collected_lead(recovery_page)
    await page.evaluate("()=>{const w=focusCurrentWord();w.ads[0].media=[];render();}")
    await expect(page.locator(".focus-media-stage")).to_contain_text("这条广告未保存图片或视频")
    await expect(page.locator(".focus-media-stage .focus-media-content")).to_have_count(0)
    assert (await store.get(project["id"]))["version"] == project["version"]


async def test_video_preview_uses_controls_without_automatic_playback(recovery_page):
    page, _store, _project = await collected_lead(recovery_page)
    await page.evaluate("()=>{focusCurrentWord().ads[0].media=[{kind:'video',url:'https://cdn.example/clip.mp4',preview_url:'https://cdn.example/one.jpg'}];render();}")
    video=page.locator(".focus-media-stage video")
    await expect(video).to_have_attribute("src","https://cdn.example/clip.mp4")
    await expect(video).to_have_attribute("preload","none")
    assert await video.evaluate("node=>node.controls && !node.autoplay")


async def test_workspace_fits_mobile_width(recovery_page):
    page, _store, _project = await collected_lead(recovery_page)
    await page.set_viewport_size({"width":390,"height":844})
    await expect(page.locator(".focus-media-stage")).to_be_visible()
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")

async def test_choose_product_or_ad_media_without_fallback(recovery_page):
    page, store, project = await collected_lead(recovery_page)
    await page.evaluate("()=>{const p=focusProducts(focusCurrentWord())[0];p.landing_snapshot={images:['https://cdn.example/product.jpg']};render();}")
    await page.get_by_role("button", name="商品图", exact=True).click()
    await expect(page.locator(".focus-media-content")).to_have_attribute("src", "https://cdn.example/product.jpg")
    await page.get_by_role("button", name="广告素材", exact=True).click()
    await expect(page.locator(".focus-media-content")).to_have_attribute("src", "https://cdn.example/one.jpg")
    await page.evaluate("()=>{focusCurrentWord().ads[0].media=[];render();}")
    await expect(page.locator(".focus-media-stage")).to_contain_text("这条广告未保存图片或视频")
    await expect(page.get_by_role("button", name="下载当前素材", exact=True)).to_be_disabled()
    assert (await store.get(project["id"]))["version"] == project["version"]


async def test_download_uses_selected_type_and_index_and_reports_failure(recovery_page):
    page, _store, _project = await collected_lead(recovery_page)
    await page.get_by_role("button", name="查看素材 2", exact=True).click()
    requests=[]
    async def failed(route):
        requests.append(route.request.url)
        await route.fulfill(status=502, content_type="application/json", body='{"detail":"来源链接已失效"}')
    await page.route("**/media-download?**", failed)
    await page.get_by_role("button", name="下载当前素材", exact=True).click()
    await expect(page.locator("[data-download-feedback]")).to_contain_text("来源链接已失效")
    assert "source=ad" in requests[0] and "index=1" in requests[0]

    await page.unroute("**/media-download?**", failed)
    await page.route("**/media-download?**", lambda r: r.fulfill(status=200,
        headers={"Content-Type":"image/png","Content-Disposition":'attachment; filename="selected.png"'},
        body=b"selected-image-bytes"))
    async with page.expect_download() as pending:
        await page.get_by_role("button", name="下载当前素材", exact=True).click()
    download=await pending.value
    assert download.suggested_filename=="selected.png"
    from pathlib import Path
    assert Path(await download.path()).read_bytes()==b"selected-image-bytes"

async def test_project_confirmation_opens_directly_and_cancel_preserves_branch(recovery_page):
    page, store, project = await collected_lead(recovery_page)
    await page.get_by_role("button", name="识别商品：Travel", exact=True).click()
    await expect(page.get_by_role("dialog")).to_be_visible()
    assert await page.evaluate("S.view") == "project"
    await page.get_by_role("button", name="取消", exact=True).click()
    await expect(page.locator("[data-focus-workspace]")).to_be_visible()
    assert (await store.get(project["id"]))["version"] == project["version"]


async def test_confirmed_product_stays_in_current_exploration(recovery_page):
    page, store, project = await collected_lead(recovery_page)
    word_id=project["keywords"][0]["id"]
    await page.get_by_role("button", name="识别商品：Travel", exact=True).click()
    await page.get_by_role("textbox", name="产品名称", exact=True).fill("Travel Organizer")
    await page.get_by_role("textbox", name="广告与商品相关性依据", exact=True).fill("广告中的整理袋用途与商品页面一致，已核对具体商品。")
    await page.get_by_role("checkbox", name="我已核对广告与此商品相关", exact=True).check()
    await page.get_by_role("button", name="保存并继续", exact=True).click()
    await expect(page.get_by_role("dialog")).not_to_be_visible()
    await expect(page.locator("[data-focus-workspace]")).to_be_visible()
    await expect(page.locator(".focus-lead-info h2")).to_have_text("Travel Organizer")
    assert await page.evaluate("S.view") == "project"
    assert await page.evaluate("S.explorationKeyword") == word_id
    saved=await store.get(project["id"])
    assert saved["products"][0]["identification"]["relevance_confirmed"] is True
    assert len(saved["keywords"]) == 1


async def test_project_next_action_uses_viewed_product_not_global_focus(recovery_page):
    page, _store, _project = await collected_lead(recovery_page)
    await page.evaluate("()=>{S.project.guidance={kind:'deep_dive',product_id:'other',title:'继续深挖其他商品',reason:'Other',step:'identification'};render();}")
    guide=page.locator("[data-primary-guidance]")
    await expect(guide).not_to_contain_text("其他商品")
    await expect(guide).to_contain_text("Travel")
    await page.get_by_role("button", name="判断是否保留当前商品", exact=True).click()
    await expect(page.locator("[data-current-lead]")).to_contain_text("Travel")

async def test_existing_product_page_confirmation_still_opens_its_form(recovery_page):
    page, _store, _project = await collected_lead(recovery_page)
    await page.get_by_role("button", name="读取商品页", exact=True).click()
    await page.get_by_role("button", name="确认具体商品", exact=True).click()
    await expect(page.get_by_role("dialog")).to_be_visible()
    await expect(page.get_by_role("textbox", name="产品名称", exact=True)).to_have_value("Travel")
    await page.get_by_role("button", name="取消", exact=True).click()
    assert await page.evaluate("S.view") == "product"

async def test_batch_verification_has_reader_choice_progress_and_manual_fallback(recovery_page):
    page, _store, _project = await collected_lead(recovery_page)
    await expect(page.get_by_role("button", name="自动核对当前词", exact=True)).to_be_visible()
    await page.get_by_label("自动核对的商品页读取方式").select_option("firecrawl")
    requests = []
    async def queued(route):
        requests.append(route.request.post_data_json)
        await route.fulfill(status=200, content_type="application/json",
            body='{"id":"verify-one","status":"ready","disposition":"queued","count":1}')
    await page.route("**/workbench/api/projects/*/actions", queued)
    await page.get_by_role("button", name="自动核对当前词", exact=True).click()
    assert requests[-1]["kind"] == "verify"
    assert requests[-1]["landing_mode"] == "firecrawl"
    await expect(page.locator("[data-verification-panel]")).to_contain_text("已提交")
    await expect(page.get_by_role("button", name="识别商品：Travel", exact=True)).to_be_visible()

async def test_batch_skip_moves_mismatches_to_observation_without_deleting_evidence(recovery_page):
    from datetime import UTC, datetime

    from rabbit_hole.domain.provenance import source_passages
    from rabbit_hole.domain.verification import verification_fingerprint
    page, store, project = await collected_lead(recovery_page)
    p = project["products"][0]
    project = await store.command(project["id"], project["version"], str(uuid4()), "landing_result",
        {"product_id": p["id"], "snapshot": {"body_text": "Keep your travel essentials organized.",
         "page_type": "product", "final_url": p["url"]}, "source_url": p["url"],
         "observed_at": datetime.now(UTC).isoformat()}, actor="automation")
    p = project["products"][0]
    project = await store.command(project["id"], project["version"], str(uuid4()), "verification_result",
        {"assessments": [{"product_id": p["id"], "fingerprint": verification_fingerprint(project, p),
         "status": "mismatch", "name": "travel essentials", "reason": "广告和页面可能与入口不相关，需要核对。",
         "citations": [{"source_id": s.source_id, "source_kind": s.source_kind,
          "source_quote": "travel essentials", "content_hash": s.content_hash}
          for s in source_passages(project, p["id"])]}]}, actor="automation")
    await page.reload()
    await page.get_by_role("button", name="批量跳过不相关线索（1）", exact=True).click()
    await expect(page.locator("[data-verification-panel]")).to_contain_text("0 个可能不相关")
    saved = await store.get(project["id"])
    assert saved["products"][0]["triage"]["state"] == "observing"
    assert len(saved["keywords"][0]["ads"]) == 1
    assert len(saved["products"]) == 1
    assert "批量跳过" in saved["products"][0]["triage"]["reason"]
