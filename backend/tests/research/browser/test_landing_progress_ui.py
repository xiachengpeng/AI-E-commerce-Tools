"""Product-page progress stays next to the action and guides manual review."""
from uuid import UUID, uuid4

from playwright.async_api import expect
from sqlalchemy import update

pytest_plugins = ("test_workbench_recovery",)


async def landing_product(recovery_page):
    page, store, project = recovery_page
    project = await store.command(project["id"], project["version"], str(uuid4()), "add_product",
                                  {"name": "Cart", "url": "https://example.com/products/cart"})
    pid = project["products"][0]["id"]
    await page.reload()
    await expect(page.get_by_role("heading", name=project["title"], exact=True)).to_be_visible()
    await page.evaluate("(id)=>openProduct(id,'identification')", pid)
    return page, store, project, pid


async def test_queued_landing_shows_progress_and_stop_without_repeated_read(recovery_page):
    page, _store, _project, _pid = await landing_product(recovery_page)
    await page.get_by_role("button", name="自动读取商品页", exact=True).click()
    card = page.locator("[data-landing-progress]")
    await expect(card).to_contain_text("等待读取商品页")
    await expect(card).to_contain_text("下一步")
    await expect(page.get_by_role("button", name="自动读取商品页", exact=True)).to_be_disabled()
    await card.get_by_role("button", name="停止读取", exact=True).click()
    await expect(card).to_contain_text("读取已停止")
    await expect(card.get_by_role("button", name="重试读取商品页")).to_be_visible()


async def test_failed_landing_visible_after_reload_with_manual_next_step(recovery_page):
    from rabbit_hole.application.actions import actions, enqueue_action
    page, store, project, pid = await landing_product(recovery_page)
    action = await enqueue_action(store, project["id"], {"kind": "landing", "version": project["version"], "product_id": pid})
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(action["id"])).values(
            status="blocked", error_code="source_error",
            payload={"diagnostic": "连接失败：请检查网络、DNS或TLS连接", "last_stage": "landing_read"},
        ))
    await page.reload()
    await expect(page.get_by_role("heading", name=project["title"], exact=True)).to_be_visible()
    await page.evaluate("(id)=>openProduct(id,'identification')", pid)
    card = page.locator("[data-landing-progress]")
    await expect(card).to_contain_text("商品页读取失败")
    await expect(card).to_contain_text("连接失败")
    await expect(card).to_contain_text("人工核对")
    await expect(card.get_by_role("link", name="打开商品页人工核对")).to_be_visible()
    await expect(page.get_by_role("button", name="确认具体商品", exact=True)).to_be_enabled()


async def test_snapshot_guides_confirmation_without_claiming_approval(recovery_page):
    page, _store, _project, _pid = await landing_product(recovery_page)
    await page.evaluate("""()=>{const p=product();p.landing_snapshot={
        title:'Stable Cart',price:'$79',page_type:'product',body_text:'A folding cart.',
        observed_at:'2026-10-07T10:00:00Z'};render();}""")
    card = page.locator("[data-landing-progress]")
    await expect(card).to_contain_text("已保存商品页读取结果")
    await expect(card).to_contain_text("Stable Cart")
    await expect(card).to_contain_text("确认具体商品")
    await expect(card).to_contain_text("不代表已通过粗筛")
