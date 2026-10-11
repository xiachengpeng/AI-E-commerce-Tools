from datetime import date

import pytest
from playwright.async_api import async_playwright

from rabbit_hole.integrations.collectors.meta import MetaPageHealthError

# Minimal DOM preserving the roles, text and dynamic-content boundary observed
# on the public Ad Library on 2026-09-12. This is a regression fixture, not live proof.
HTML = """<html><head><meta charset="utf-8"></head><body>
<div role="combobox">美国</div><div role="combobox">所有广告</div>
<input type="search" value='"portable organizer"'>
<h3>约110条结果</h3><p>这些结果包含精准匹配你搜索短语的广告。</p>
<button>筛选条件</button><p>投放状态：正在投放的广告</p><p>素材类型：视频</p>
<section><div><span>投放中</span><span>资料库编号：1942814716372014</span>
<span>2026年5月12日开始投放</span></div><button>查看广告详情</button>
<div class="_7jyh" data-testid="ad-library-dynamic-content-container">
<a href="https://www.facebook.com/apothecarybrands/">Apothecary Brands</a>
<strong>赞助内容</strong><div role="button">Micro-habits for a new Mom.</div>
<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fproducts%2Fcase">Portable Organizer</a>
</div></section><button>显示更多</button></body></html>"""


@pytest.mark.asyncio
@pytest.mark.parametrize("dynamic", [True, False])
async def test_public_dom_filters_and_cards_without_fixture_markers(dynamic):
    from rabbit_hole.integrations.collectors.meta_live import PublicMetaPage

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page()
        html = (
            HTML
            if dynamic
            else HTML.replace(' data-testid="ad-library-dynamic-content-container"', "")
        )
        await page.route("https://www.facebook.com/**", lambda r: r.fulfill(body=html))
        adapter = PublicMetaPage(page)
        filters = {
            "market": "US",
            "status": "active",
            "media_type": "video",
            "search_mode": "exact_phrase",
            "query": '"portable organizer"',
        }
        for name, value in filters.items():
            await adapter.apply_filter(name, value)
            await adapter.health_check()
        assert await adapter.displayed_filters() == filters
        ads = await adapter.read_batch(query="portable organizer")
        assert len(ads) == 1
        assert ads[0].ad_id == "1942814716372014"
        assert ads[0].advertiser == "Apothecary Brands"
        assert ads[0].start_date == date(2026, 5, 12)
        assert ads[0].observed_at is not None
        assert ads[0].observable_active_days is not None
        assert ads[0].landing_url == "https://example.com/products/case"
        assert ads[0].media_hash is None
        assert ads[0].relevance_verified is False
        await page.get_by_role("searchbox").fill("different")
        with pytest.raises(MetaPageHealthError, match="displayed_filters_mismatch"):
            await adapter.health_check()
        await browser.close()


@pytest.mark.asyncio
async def test_public_dom_rejects_missing_media_filter():
    from rabbit_hole.integrations.collectors.meta_live import PublicMetaPage

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page()
        await page.route(
            "https://www.facebook.com/**",
            lambda r: r.fulfill(body=HTML.replace("素材类型：视频", "素材类型：图片")),
        )
        adapter = PublicMetaPage(page)
        with pytest.raises(MetaPageHealthError, match="displayed_filters_mismatch"):
            await adapter.apply_filter("query", '"portable organizer"')
        await browser.close()


async def test_public_video_url_survives_workbench_projection():
    from rabbit_hole.application.actions import ad_projection
    from rabbit_hole.integrations.collectors.meta_live import PublicMetaPage
    async with async_playwright() as pw:
        browser=await pw.chromium.launch()
        page=await browser.new_page()
        html=HTML.replace("<strong>赞助内容</strong>", '<strong>赞助内容</strong><video preload="none" src="https://example.com/clip.mp4"></video>')
        await page.route("https://www.facebook.com/**", lambda r:r.fulfill(body=html))
        adapter=PublicMetaPage(page)
        await adapter.apply_filter("query", '"portable organizer"')
        ads=await adapter.read_batch(query="portable organizer")
        assert ad_projection(ads[0])["media"] == [{"kind":"video","url":"https://example.com/clip.mp4"}]
        await browser.close()
