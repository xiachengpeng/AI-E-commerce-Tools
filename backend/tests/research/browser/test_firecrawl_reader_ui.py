"""Choosing a paid reader must survive enqueue and stop/retry."""
from playwright.async_api import expect

pytest_plugins = ("test_workbench_recovery",)


async def test_explicit_reader_frozen_on_task_and_retry(recovery_page):
    from test_landing_progress_ui import landing_product
    page, _store, _project, _pid = await landing_product(recovery_page)
    selector = page.get_by_label("商品页读取方式", exact=True)
    await expect(selector).to_have_value("local")
    await selector.select_option("firecrawl")
    await page.get_by_role("button", name="自动读取商品页", exact=True).click()
    card = page.locator("[data-landing-progress]")
    await expect(card).to_contain_text("Firecrawl")
    await expect(selector).to_be_disabled()
    await card.get_by_role("button", name="停止读取", exact=True).click()
    await expect(card).to_contain_text("可能已计费")
    await card.get_by_role("button", name="重试读取商品页", exact=True).click()
    await expect(card).to_contain_text("Firecrawl")
    await card.get_by_role("button", name="停止读取", exact=True).click()
