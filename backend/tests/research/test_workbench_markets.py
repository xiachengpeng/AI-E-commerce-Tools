from datetime import UTC, datetime, timedelta

import pytest
from playwright.async_api import async_playwright

from rabbit_hole.application.imports import parse_trends_csv
from rabbit_hole.domain.project import WorkbenchError, new_project
from rabbit_hole.integrations.collectors.provider_api import (
    ProviderError,
    parse_serpapi_series,
)

MARKETS = ["US", "GB", "CA", "AU", "DE", "FR", "JP"]


@pytest.mark.parametrize("market", MARKETS)
def test_project_and_trends_import_use_selected_market(market):
    assert new_project("research", "travel", market=market)["market"] == market
    start = datetime.now(UTC).date() - timedelta(weeks=52)
    rows = "\n".join(f"{start + timedelta(weeks=i)},70" for i in range(52))
    data = {"query": "organizer", "market": market, "window": "12m",
            "csv": f"Week,organizer: ({market})\n" + rows}
    assert parse_trends_csv(data)["market"] == market
    data["csv"] = "Week,organizer: (ZZ)\n" + rows
    with pytest.raises(ValueError, match="地区"):
        parse_trends_csv(data)


def test_unknown_market_rejected_and_default_preserved():
    assert new_project("research", "travel")["market"] == "US"
    with pytest.raises(WorkbenchError, match="market"):
        new_project("research", "travel", market="ZZ")


@pytest.mark.parametrize("market", MARKETS)
def test_serpapi_validates_selected_country(market):
    rows = [{"timestamp": str(1700000000 + i * 604800),
             "values": [{"query": "organizer", "extracted_value": 30}]}
            for i in range(52)]
    data = {"search_metadata": {"status": "Success"},
            "search_parameters": {"q": "organizer", "geo": market, "date": "today 12-m"},
            "interest_over_time": {"timeline_data": rows}}
    assert parse_serpapi_series(data, "organizer", "12m", market=market).geo == market
    data["search_parameters"]["geo"] = "ZZ"
    with pytest.raises(ProviderError, match="地区"):
        parse_serpapi_series(data, "organizer", "12m", market=market)


@pytest.mark.asyncio
@pytest.mark.parametrize("market,label", [
    ("GB", "United Kingdom"), ("CA", "Canada"), ("AU", "Australia"),
    ("DE", "Germany"), ("FR", "France"), ("JP", "Japan")])
async def test_meta_visible_country_must_match_selected_country(market, label):
    from rabbit_hole.integrations.collectors.meta import MetaPageHealthError
    from rabbit_hole.integrations.collectors.meta_live import PublicMetaPage
    from tests.test_meta_live import HTML

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page()
        await page.route("https://www.facebook.com/**",
                         lambda r: r.fulfill(body=HTML.replace("美国", label)))
        adapter = PublicMetaPage(page)
        await adapter.apply_filter("market", market)
        await adapter.apply_filter("query", '"portable organizer"')
        assert (await adapter.displayed_filters())["market"] == market
        assert f"country={market}" in page.url
        await page.get_by_role("combobox").first.evaluate("(node)=>node.textContent='United States'")
        with pytest.raises(MetaPageHealthError, match="displayed_filters_mismatch"):
            await adapter.health_check()
        await browser.close()


def test_manual_trends_cannot_mix_country_evidence():
    from tests.test_workbench_domain import NOW, add_product, command

    state = new_project("UK research", "travel", market="GB", now=NOW)
    product = add_product(state)
    evidence = {"product_id": product["id"], "channel": "trends", "query": "organizer",
                "window": "12m", "conclusion": "stable-high", "market": "US", "confirmed": False,
                "observed_at": NOW.isoformat(), "source_url": "https://trends.google.com/trends/explore"}
    with pytest.raises(WorkbenchError, match="market"):
        command(state, "evidence", evidence)
    evidence["market"] = "GB"
    command(state, "evidence", evidence)
    assert product["evidence"][-1]["market"] == "GB"


def test_trends_source_keeps_country_and_query_without_credentials():
    from urllib.parse import parse_qs, urlsplit

    from rabbit_hole.input_urls import canonical_research_url

    cleaned = canonical_research_url("https://trends.google.com/trends/explore?q=Reisetasche&geo=DE&date=today+12-m&api_key=private&token=secret")
    assert parse_qs(urlsplit(cleaned).query) == {"q": ["Reisetasche"], "geo": ["DE"], "date": ["today 12-m"]}
    assert "private" not in cleaned and "secret" not in cleaned
