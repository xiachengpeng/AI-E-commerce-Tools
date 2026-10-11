import pytest

from rabbit_hole.input_urls import canonical_supplier_inputs
from rabbit_hole.trends import TrendLabel, TrendSeries, classify_trend


def series(values, window="12m"):
    return TrendSeries(values=values, window=window)


def test_trends_spec_relative_baseline_and_long_window():
    assert classify_trend(series([20] * 52)).label == TrendLabel.STABLE_HIGH
    rising = series([20] * 39 + [23] * 13)
    assert classify_trend(rising, series([2] * 260, "5y")).label == TrendLabel.RISING
    assert (
        classify_trend(rising, series([90] * 208 + [30] * 52, "5y")).label
        != TrendLabel.RISING
    )
    assert (
        classify_trend(series([0] * 27 + [20] * 25)).label
        == TrendLabel.INSUFFICIENT_DATA
    )


def test_trends_does_not_compare_independent_normalizations():
    short = series([20] * 39 + [25] * 13)
    long = series(([10] * 30 + [30] * 8 + [10] * 14) * 5, "5y")
    scaled = series([point.value * 3 for point in long.points], "5y")
    assert classify_trend(short, long).label == classify_trend(short, scaled).label
    assert (
        classify_trend(short, long).features.yoy_by_year
        == classify_trend(short, scaled).features.yoy_by_year
    )


@pytest.mark.parametrize(
    "alias",
    [
        "link",
        "url",
        "meta_url",
        "landing_url",
        "人工｜广告或落地页链接",
        "人工｜商品链接",
    ],
)
def test_durable_input_aliases_remove_secrets(alias):
    fields, invalid = canonical_supplier_inputs(
        {alias: "https://shop.example/products/a?token=secret&variant=123#secret"}
    )
    assert not invalid
    assert fields[alias] == "https://shop.example/products/a?variant=123"


def test_meta_link_keeps_only_ad_identity():
    fields, _ = canonical_supplier_inputs(
        {"link": "https://www.facebook.com/ads/library/?id=123&access_token=secret"}
    )
    assert fields["link"] == "https://www.facebook.com/ads/library/?id=123"


def test_landing_output_urls_and_structural_strike_through():
    from rabbit_hole.integrations.collectors.landing import LandingCollector

    snapshot = LandingCollector._snapshot(
        b'<s>USD 40</s><p>Sale today</p><img src="/a.jpg?token=secret"><p>Buy now</p>',
        "https://shop.example/p?token=secret",
    )
    assert snapshot.funnel.strike_through_price
    assert snapshot.final_url == "https://shop.example/p"
    assert snapshot.images == ("https://shop.example/a.jpg",)


async def test_synonyms_are_normalized_before_limit():
    from rabbit_hole.integrations.collectors.google import GoogleTrendsCollector

    class Source:
        async def fetch_weekly_series(self, query, geo, window):
            return series([20] * (260 if window == "5y" else 52), window)

    result = await GoogleTrendsCollector(Source()).collect(
        "bottle",
        synonyms=(" BOTTLE ", "water bottle", " Water   Bottle", "sports bottle"),
    )
    assert result.value.actual_queries == ("bottle", "water bottle", "sports bottle")


def test_meta_output_redirect_and_media_urls_remove_secrets():
    from rabbit_hole.integrations.collectors.meta import MetaAd

    ad = MetaAd(
        ad_id="123",
        query="product",
        advertiser="shop",
        is_active=True,
        landing_url="https://shop.example/a?token=secret",
        final_landing_url="https://shop.example/b?access_token=secret",
        media_url="https://media.example/a?signature=secret",
    )
    assert ad.landing_url == "https://shop.example/a"
    assert ad.final_landing_url == "https://shop.example/b"
    assert ad.media_url == "https://media.example/a"


def test_seasonal_peak_windows_must_fit_four_week_span():
    years = []
    for peak in (10, 14, 18):
        years += [10] * peak + [40] * 8 + [10] * (44 - peak)
    assert (
        classify_trend(series([20] * 52), series(years, "5y")).label
        != TrendLabel.SEASONAL
    )


def test_uncomputed_cli_score_is_missing_not_zero():
    from pathlib import Path

    from test_scoring import _input

    cli_module = __import__(_input.__module__)
    from rabbit_hole.scoring import EvaluationResult

    report = cli_module.render(
        [
            cli_module.Evaluation(
                {"name": "Incomplete"},
                EvaluationResult(status="待补充证据", missing_fields=("quote",)),
            )
        ],
        Path("input.csv"),
    )
    assert "未评分" in report
    assert "未知" in report
    assert "0/25" not in report


async def test_pipeline_does_not_truncate_synonyms_before_generic_removal():
    from test_pipeline import FakeMeta, job, meta_success, pipeline

    from rabbit_hole.domain.legacy import JobKind
    from rabbit_hole.integrations.collectors.meta import MetaQuery

    class CaptureMeta(FakeMeta):
        observed = None

        async def collect(self, query, **kwargs):
            self.observed = query
            return await super().collect(query, **kwargs)

    data = {
        "AUTO｜实际搜索词": "bottle",
        "AUTO｜同义变体": " BOTTLE | water bottle | Water   Bottle | sports bottle",
        "人工｜状态": "待扫描",
    }
    meta = CaptureMeta(meta_success())
    service, _, _ = pipeline(data=data, meta=meta)
    await service.run(job(JobKind.KEYWORD_SCAN, data))
    assert (
        meta.observed.actual_queries
        == MetaQuery(
            query="bottle", approved_synonyms=("water bottle", "sports bottle")
        ).actual_queries
    )


async def test_collected_redirect_chain_and_json_ld_urls_are_secret_free():
    import httpx

    from rabbit_hole.integrations.collectors.landing import LandingCollector
    from rabbit_hole.security import SafeUrlClient

    def response(request):
        if request.url.path == "/entry":
            return httpx.Response(
                302,
                headers={
                    "location": "/product?access_token=secret-redirect&variant=12"
                },
            )
        return httpx.Response(
            200,
            text="<p>"
            + "Portable product description. " * 10
            + '</p><script type="application/ld+json">{"@type":"Product","url":"https://shop.example/product?token=secret-json","image":["https://shop.example/a.jpg?signature=secret-image"],"offers":{"price":"79"}}</script>',
        )

    client = SafeUrlClient(
        resolver=lambda _host, _port: ["93.184.216.34"],
        transport=httpx.MockTransport(response),
    )
    result = await LandingCollector(client).collect(
        "https://shop.example/entry?token=secret-input"
    )
    assert result.ok
    output = result.value.model_dump()
    assert output.get("redirect_chain") == (
        "https://shop.example/entry",
        "https://shop.example/product?variant=12",
    )
    assert "secret-" not in result.value.model_dump_json()


async def test_collector_applies_configured_trend_thresholds():
    from rabbit_hole.integrations.collectors.google import GoogleTrendsCollector
    from rabbit_hole.trends import TrendThresholds

    class Source:
        async def fetch_weekly_series(self, query, geo, window):
            return (
                series([20] * 260, "5y")
                if window == "5y"
                else series([0] * 20 + [20] * 32)
            )

    result = await GoogleTrendsCollector(
        Source(), thresholds=TrendThresholds(coverage=0.75)
    ).collect("bottle")
    assert result.value.label == TrendLabel.INSUFFICIENT_DATA
    assert result.value.results["bottle"].thresholds["coverage"] == "0.75"
