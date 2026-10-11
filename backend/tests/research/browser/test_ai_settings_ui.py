"""Configuration changes against a private test vault, without real AI calls."""
from playwright.async_api import expect

pytest_plugins = ("test_workbench_recovery",)


async def test_relay_can_be_saved_refreshed_and_changed_without_echoing_key(recovery_page, monkeypatch, tmp_path):
    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    page, _, project = recovery_page
    await page.locator('[data-nav="sources"]').click()
    await page.get_by_label("接口地址（Base URL）").fill("https://relay.example/v1")
    await page.get_by_label("模型名称").fill("research-model")
    await page.get_by_label("AI API Key").fill("isolated-relay-secret")
    await page.get_by_role("button", name="保存 AI 配置", exact=True).click()
    await expect(page.locator("[data-ai-feedback]")).to_contain_text("已保存")
    await expect(page.get_by_label("AI API Key")).to_have_value("")
    assert "isolated-relay-secret" not in await page.locator("body").inner_text()
    await page.reload()
    await expect(page.locator('#heading')).to_have_text(project['title'])
    await page.locator('[data-nav="sources"]').click()
    await expect(page.get_by_label("模型名称")).to_have_value("research-model")
    await page.get_by_label("模型名称").fill("next-model")
    await page.get_by_role("button", name="保存 AI 配置", exact=True).click()
    await expect(page.locator("[data-ai-feedback]")).to_contain_text("已保存")
    from rabbit_hole.integrations.ai_settings import AISettings
    assert AISettings().resolve().api_key == "isolated-relay-secret"
    assert AISettings().resolve().model == "next-model"
