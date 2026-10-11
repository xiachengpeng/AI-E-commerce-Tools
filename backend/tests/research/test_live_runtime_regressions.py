from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from rabbit_hole.integrations.collectors.landing import LandingCollector, _PageParser
from rabbit_hole.runtime.legacy import BrowserTrendsStrategy, TrendsPageError


def test_landing_body_excludes_executable_and_hidden_content():
    parser = _PageParser()
    parser.feed(
        "<title>Product</title><script>secret_js</script><style>css</style>"
        "<template>hidden</template><p>Visible</p>"
        '<script type="application/ld+json">{"name":"Product"}</script>'
    )
    assert parser.text_parts == ["Product", "Visible"]
    assert parser.json_scripts == ['{"name":"Product"}']


def test_product_variant_offers_and_recommendation_links():
    raw = b"""<html><head><title>Pilly</title></head><body>
    <svg><title>Visa</title></svg><p>Recommended $17.97</p>
    <a href="/products/a">A</a><a href="/products/b">B</a>
    <script type="application/ld+json">{"@type":"Product","offers":[
    {"price":39.97,"priceCurrency":"USD"},{"price":39.97,"priceCurrency":"USD"}]}</script></body></html>"""
    result = LandingCollector._snapshot(raw, "https://shop.example/products/pilly")
    assert result.title == "Pilly"
    assert result.price == "39.97"
    assert result.page_type == "product"


def test_different_variant_prices_are_not_silently_selected():
    assert (
        LandingCollector._price(
            [{"@type": "Product", "offers": [{"price": 10}, {"price": 20}]}],
            "$5 recommended",
        )
        is None
    )


@pytest.mark.asyncio
async def test_trends_navigation_rate_limit_is_not_a_timeline_timeout():
    page = MagicMock()
    page.goto = AsyncMock(return_value=MagicMock(status=429))
    captured = MagicMock()
    captured.value = None
    page.expect_response.return_value.__aenter__ = AsyncMock(return_value=captured)
    page.expect_response.return_value.__aexit__ = AsyncMock(return_value=False)
    context = MagicMock(new_page=AsyncMock(return_value=page))
    browser = MagicMock(new_context=AsyncMock(return_value=context), close=AsyncMock())
    playwright = MagicMock()
    playwright.chromium.launch = AsyncMock(return_value=browser)
    with patch("rabbit_hole.runtime.legacy.async_playwright") as factory:
        factory.return_value.__aenter__ = AsyncMock(return_value=playwright)
        factory.return_value.__aexit__ = AsyncMock(return_value=False)
        with pytest.raises(TrendsPageError, match="access_restricted"):
            await BrowserTrendsStrategy().fetch_weekly_series("organizer", "US", "12m")
