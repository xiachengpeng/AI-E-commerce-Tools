from __future__ import annotations

from collections import deque
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from pydantic import ValidationError

from rabbit_hole.integrations.collectors.meta import (
    CreativeDecision,
    MetaAd,
    MetaAdParser,
    MetaCollector,
    MetaPageHealthError,
    MetaQuery,
    PlaywrightMetaPage,
    _exact_phrase,
    coarse_screen,
    creative_decision,
    group_ads,
    normalize_landing_url,
    verified_distinct_creatives,
)

FIXTURES = Path(__file__).parent / "fixtures" / "meta"


class MutableClock:
    def __init__(self, value: datetime | None = None) -> None:
        self.value = value or datetime(2026, 9, 5, tzinfo=UTC)

    def now(self) -> datetime:
        return self.value

    def advance(self, delta: timedelta) -> None:
        self.value += delta


class BodyTextLocator:
    def __init__(self, text: str) -> None:
        self.text = text

    async def inner_text(self) -> str:
        return self.text


class BodyTextPage:
    def __init__(self, text: str) -> None:
        self.text = text

    def locator(self, selector: str) -> BodyTextLocator:
        assert selector == "body"
        return BodyTextLocator(self.text)


class HealthLocator:
    def __init__(
        self,
        *,
        count: int = 1,
        visible: bool = True,
        enabled: bool = True,
        value: str = "",
        wait_times_out: bool = False,
        on_wait: Callable[[], None] | None = None,
    ) -> None:
        self.count_value = count
        self.visible = visible
        self.enabled = enabled
        self.value = value
        self.wait_times_out = wait_times_out
        self.on_wait = on_wait

    async def count(self) -> int:
        return self.count_value

    async def is_visible(self) -> bool:
        return self.visible

    async def is_enabled(self) -> bool:
        return self.enabled

    async def input_value(self) -> str:
        return self.value

    async def text_content(self) -> str:
        return self.value

    async def inner_text(self) -> str:
        return self.value

    async def select_option(self, value: str) -> None:
        self.value = value

    async def fill(self, value: str) -> None:
        self.value = value

    async def press(self, key: str) -> None:
        assert key == "Enter"

    async def wait_for(self, *, state: str, timeout: float) -> None:
        assert state == "hidden"
        assert timeout > 0
        if self.wait_times_out:
            raise PlaywrightTimeoutError("loading did not settle")
        if self.on_wait is not None:
            self.on_wait()
        self.visible = False


class HealthPage:
    def __init__(self) -> None:
        self.locators = {
            "body": HealthLocator(value="Meta Ad Library"),
            "[data-testid='country-filter']": HealthLocator(value="US"),
            "[data-testid='status-filter']": HealthLocator(value="active"),
            "[data-testid='media-type-filter']": HealthLocator(value="video"),
            "[data-testid='search-mode-filter']": HealthLocator(value="exact_phrase"),
            "[data-testid='search-input']": HealthLocator(value='"portable organizer"'),
            "[data-testid='ad-library-results']": HealthLocator(),
            "[data-testid='ad-library-loading']": HealthLocator(count=0),
            "[data-testid='ad-library-no-results']": HealthLocator(count=0),
        }

    def locator(self, selector: str) -> HealthLocator:
        return self.locators[selector]


def ad(
    ad_id: str,
    *,
    advertiser: str = "Acme",
    active: bool = True,
    active_days: int | None = 31,
    media_hash: str | None = None,
    perceptual_hash: str | None = None,
    media_accessible: bool | None = True,
    final_url: str = "https://shop.example/products/organizer",
    fingerprint: str | None = "organizer-v1",
    page_type: str = "product",
    primary_text: str | None = None,
    hook: str | None = None,
    relevance_verified: bool = True,
    human_confirmed_distinct: bool = False,
    query: str = "portable organizer",
) -> MetaAd:
    return MetaAd(
        ad_id=ad_id,
        advertiser=advertiser,
        page_id="page-1",
        start_date=date(2026, 8, 5),
        is_active=active,
        observable_active_days=active_days,
        primary_text=primary_text or f"copy {ad_id}",
        hook=hook or f"hook {ad_id}",
        landing_url=final_url,
        final_landing_url=final_url,
        landing_page_type=page_type,
        product_fingerprint=fingerprint,
        media_hash=media_hash or f"media-{ad_id}",
        perceptual_hash=perceptual_hash,
        media_accessible=media_accessible,
        relevance_verified=relevance_verified,
        human_confirmed_distinct=human_confirmed_distinct,
        query=query,
    )


def product_group(
    *,
    active_days: list[int],
    perceptual_hashes: list[str],
    active: list[bool] | None = None,
):
    flags = active or [True] * len(active_days)
    ads = [
        ad(
            str(index),
            active=flags[index],
            active_days=days,
            perceptual_hash=perceptual_hashes[index],
        )
        for index, days in enumerate(active_days)
    ]
    return group_ads(ads)[0]


def test_group_passes_only_with_old_ad_and_three_active_distinct_creatives() -> None:
    group = product_group(
        active_days=[31, 10, 5],
        perceptual_hashes=["0000000000000000", "ffffffffffffffff", "5555555555555555"],
    )

    result = coarse_screen(group)

    assert result.passed is True
    assert result.max_observable_active_days == 31
    assert result.verified_active_creatives == 3
    assert result.status == "值得深入"


@pytest.mark.parametrize(
    ("days", "hashes", "expected_days", "expected_creatives"),
    [
        ([30, 10], ["0" * 16, "f" * 16], 30, 2),
        (
            [20, 20, 20, 20, 20],
            ["0" * 16, "f" * 16, "5" * 16, "a" * 16, "3" * 16],
            20,
            5,
        ),
    ],
)
def test_coarse_screen_requires_both_thresholds(
    days: list[int], hashes: list[str], expected_days: int, expected_creatives: int
) -> None:
    result = coarse_screen(product_group(active_days=days, perceptual_hashes=hashes))

    assert result.passed is False
    assert result.max_observable_active_days == expected_days
    assert result.verified_active_creatives == expected_creatives
    assert result.status == "观察池"


def test_inactive_creatives_do_not_count_toward_three() -> None:
    group = product_group(
        active_days=[40, 20, 10],
        perceptual_hashes=["0" * 16, "f" * 16, "5" * 16],
        active=[True, True, False],
    )

    result = coarse_screen(group)

    assert result.passed is False
    assert result.verified_active_creatives == 2


def test_exact_media_hash_wins_over_other_similarity_signals() -> None:
    left = ad("1", media_hash="same", perceptual_hash="0" * 16)
    right = ad("2", media_hash="same", perceptual_hash="f" * 16)

    assert creative_decision(left, right) is CreativeDecision.DUPLICATE


@pytest.mark.parametrize(
    ("similarity", "expected"),
    [
        (95.0, CreativeDecision.DUPLICATE),
        (84.99, CreativeDecision.DISTINCT),
        (85.0, CreativeDecision.NEEDS_CONFIRMATION),
        (94.99, CreativeDecision.NEEDS_CONFIRMATION),
    ],
)
def test_perceptual_similarity_thresholds(
    similarity: float, expected: CreativeDecision
) -> None:
    assert creative_decision(ad("1"), ad("2"), similarity=similarity) is expected


def test_low_visual_similarity_without_distinct_copy_or_hook_needs_confirmation() -> (
    None
):
    left = ad("1", primary_text="Same offer!", hook="See it in action")
    right = ad("2", primary_text=" same offer ", hook="SEE IT IN ACTION.")

    assert (
        creative_decision(left, right, similarity=40.0)
        is CreativeDecision.NEEDS_CONFIRMATION
    )


def test_three_ads_with_same_media_are_one_creative() -> None:
    ads = [
        ad(str(index), media_hash="same", perceptual_hash="0" * 16)
        for index in range(3)
    ]

    assert [item.ad_id for item in verified_distinct_creatives(ads)] == ["0"]


def test_accessible_exact_hash_is_enough_to_identify_first_creative() -> None:
    only = ad("exact-only", media_hash="content-hash", perceptual_hash=None)

    assert verified_distinct_creatives([only]) == (only,)


def test_ambiguous_or_inaccessible_media_does_not_count_as_verified() -> None:
    ads = [
        ad("clear", media_hash="clear", perceptual_hash="0" * 16),
        ad("ambiguous", media_hash="ambiguous", perceptual_hash="000000000000003f"),
        ad(
            "inaccessible",
            media_hash=None,
            perceptual_hash=None,
            media_accessible=False,
        ),
    ]

    assert [item.ad_id for item in verified_distinct_creatives(ads)] == ["clear"]
    group = group_ads(ads)[0]
    assert coarse_screen(group).status == "待确认创意"


def test_human_confirmed_distinct_media_can_close_the_manual_review_gap() -> None:
    confirmed = ad(
        "confirmed",
        media_hash="confirmed-content",
        perceptual_hash=None,
        media_accessible=False,
        human_confirmed_distinct=True,
    )

    assert verified_distinct_creatives([confirmed]) == (confirmed,)


def test_grouping_normalizes_final_url_and_deduplicates_ad_ids() -> None:
    first = ad(
        "1",
        final_url="HTTPS://Shop.Example:443/products/organizer/?utm_source=meta&size=m",
    )
    duplicate_id = first.model_copy(
        update={"final_landing_url": "https://shop.example/products/other"}
    )
    same_product = ad(
        "2",
        final_url="https://shop.example/products/organizer?size=m&fbclid=tracking",
    )

    groups = group_ads([first, duplicate_id, same_product])

    assert len(groups) == 1
    assert [item.ad_id for item in groups[0].ads] == ["1", "2"]
    assert groups[0].normalized_landing_url == (
        "https://shop.example/products/organizer?size=m"
    )


def test_distinct_query_identified_products_are_not_grouped_together() -> None:
    groups = group_ads(
        [
            ad("1", final_url="https://shop.example/?p=123", fingerprint=None),
            ad("2", final_url="https://shop.example/?p=456", fingerprint=None),
        ]
    )

    assert len(groups) == 2


def test_product_fingerprint_groups_same_advertiser_across_landing_urls() -> None:
    groups = group_ads(
        [
            ad("1", final_url="https://shop.example/products/organizer"),
            ad("2", final_url="https://shop.example/pages/organizer-offer"),
        ]
    )

    assert len(groups) == 1
    assert {item.ad_id for item in groups[0].ads} == {"1", "2"}
    assert groups[0].product_fingerprint == "organizer-v1"


def test_same_landing_and_advertiser_attach_missing_fingerprint_to_known_product() -> (
    None
):
    groups = group_ads(
        [
            ad("1"),
            ad("2", fingerprint=None),
        ]
    )

    assert len(groups) == 1
    assert {item.ad_id for item in groups[0].ads} == {"1", "2"}
    assert groups[0].product_fingerprint == "organizer-v1"


def test_product_page_without_fingerprint_uses_temporary_landing_identity() -> None:
    group = group_ads([ad("1", fingerprint=None, page_type="product")])[0]

    assert group.identity_status == "已识别具体产品"
    assert group.product_fingerprint is None
    assert group.normalized_landing_url == "https://shop.example/products/organizer"


@pytest.mark.parametrize("page_type", ["category", "home", "multi_product"])
def test_non_product_landing_pages_are_identification_leads(page_type: str) -> None:
    group = group_ads(
        [
            ad(
                "lead",
                page_type=page_type,
                fingerprint=None,
                final_url="https://shop.example/collections/all",
            )
        ]
    )[0]

    assert group.identity_status == "待识别具体产品"
    assert group.product_fingerprint is None
    assert coarse_screen(group).status == "待识别具体产品"


def test_normalize_landing_url_removes_tracking_but_preserves_product_query() -> None:
    assert (
        normalize_landing_url(
            "https://SHOP.example:443/p/item/?utm_medium=cpc&variant=blue#details"
        )
        == "https://shop.example/p/item?variant=blue"
    )


def test_meta_query_is_us_only_and_caps_deduplicated_approved_synonyms() -> None:
    query = MetaQuery(
        query=" portable organizer ",
        market="US",
        approved_synonyms=(
            "travel organizer",
            "travel organizer",
            "bag organizer",
            "ignored",
        ),
    )

    assert query.query == "portable organizer"
    assert query.approved_synonyms == ("travel organizer", "bag organizer")
    assert query.actual_queries == (
        '"portable organizer"',
        '"travel organizer"',
        '"bag organizer"',
    )
    with pytest.raises(ValidationError):
        MetaQuery(query="organizer", market="CA")


@pytest.mark.parametrize("text", ['"portable organizer"', "“portable organizer”"])
def test_already_quoted_keyword_has_one_pair_of_search_quotes(text):
    assert MetaQuery(query=text).actual_queries == ('"portable organizer"',)


@pytest.mark.parametrize(
    "text", ['"portable organizer" travel', '""portable organizer" travel"']
)
def test_nested_keyword_quotes_become_one_exact_phrase(text):
    assert _exact_phrase(text) == '"portable organizer travel"'


def test_fixture_parser_extracts_structured_ads_without_browser_network() -> None:
    parsed = MetaAdParser().parse(
        (FIXTURES / "results.html").read_text(),
        query="portable organizer",
        observed_on=date(2026, 9, 5),
    )

    assert [item.ad_id for item in parsed] == ["1001", "1002"]
    assert parsed[0].advertiser == "Acme Storage"
    assert parsed[0].observable_active_days == 66
    assert parsed[0].is_active is True
    assert parsed[0].relevance_verified is True
    assert parsed[0].primary_text == "Keep every cable in its place."
    assert parsed[0].landing_page_type == "product"
    assert parsed[1].hook == "Pack once, find it fast"


@pytest.mark.parametrize(
    ("body", "failure_code"),
    [
        ("Complete this CAPTCHA to continue", "captcha"),
        ("You are temporarily blocked from using this feature", "access_restricted"),
    ],
)
async def test_page_object_classifies_access_controls_before_filter_timeout(
    body: str, failure_code: str
) -> None:
    page = PlaywrightMetaPage(BodyTextPage(body))  # type: ignore[arg-type]

    with pytest.raises(MetaPageHealthError, match=f"^{failure_code}$"):
        await page.apply_filter("market", "US")


@pytest.mark.parametrize(
    ("selector", "change", "failure_code"),
    [
        ("[data-testid='country-filter']", "visible", "control_not_visible:market"),
        ("[data-testid='status-filter']", "enabled", "control_not_ready:status"),
        (
            "[data-testid='ad-library-results']",
            "visible",
            "results_not_visible",
        ),
    ],
)
async def test_health_check_requires_visible_ready_controls_and_results(
    selector: str, change: str, failure_code: str
) -> None:
    raw_page = HealthPage()
    setattr(raw_page.locators[selector], change, False)
    page = PlaywrightMetaPage(raw_page)  # type: ignore[arg-type]

    with pytest.raises(MetaPageHealthError, match=f"^{failure_code}$"):
        await page.health_check()


async def test_health_check_rejects_filter_value_that_has_not_settled() -> None:
    raw_page = HealthPage()
    page = PlaywrightMetaPage(raw_page)  # type: ignore[arg-type]
    await page.apply_filter("market", "US")
    raw_page.locators["[data-testid='country-filter']"].value = "CA"

    with pytest.raises(MetaPageHealthError, match="^filter_not_settled:market$"):
        await page.health_check()


async def test_health_check_waits_for_loading_and_fails_if_it_never_settles() -> None:
    raw_page = HealthPage()
    raw_page.locators["[data-testid='ad-library-loading']"] = HealthLocator(
        visible=True, wait_times_out=True
    )
    page = PlaywrightMetaPage(raw_page)  # type: ignore[arg-type]

    with pytest.raises(MetaPageHealthError, match="^infinite_loading$"):
        await page.health_check()


async def test_health_check_accepts_visible_no_results_with_hidden_results() -> None:
    raw_page = HealthPage()
    raw_page.locators["[data-testid='ad-library-results']"].visible = False
    raw_page.locators["[data-testid='ad-library-no-results']"] = HealthLocator(
        visible=True
    )
    page = PlaywrightMetaPage(raw_page)  # type: ignore[arg-type]

    await page.health_check()


@pytest.mark.parametrize(
    ("settled_body", "failure_code"),
    [
        ("Complete this CAPTCHA to continue", "captcha"),
        ("Access denied while loading results", "access_restricted"),
    ],
)
async def test_health_check_rechecks_access_markers_after_loading_settles(
    settled_body: str, failure_code: str
) -> None:
    raw_page = HealthPage()
    body = raw_page.locators["body"]
    raw_page.locators["[data-testid='ad-library-loading']"] = HealthLocator(
        visible=True, on_wait=lambda: setattr(body, "value", settled_body)
    )
    page = PlaywrightMetaPage(raw_page)  # type: ignore[arg-type]

    with pytest.raises(MetaPageHealthError, match=f"^{failure_code}$"):
        await page.health_check()


async def test_health_check_verifies_filter_again_after_loading_settles() -> None:
    raw_page = HealthPage()
    page = PlaywrightMetaPage(raw_page)  # type: ignore[arg-type]
    await page.apply_filter("market", "US")
    market = raw_page.locators["[data-testid='country-filter']"]
    raw_page.locators["[data-testid='ad-library-loading']"] = HealthLocator(
        visible=True, on_wait=lambda: setattr(market, "value", "CA")
    )

    with pytest.raises(MetaPageHealthError, match="^filter_not_settled:market$"):
        await page.health_check()


class FakeEvidenceStore:
    def __init__(self) -> None:
        self.puts: list[dict[str, Any]] = []

    def put(self, **kwargs: Any) -> SimpleNamespace:
        self.puts.append(kwargs)
        return SimpleNamespace(object_id=f"evidence-{len(self.puts)}")


class FakeJobRepository:
    def __init__(self, checkpoint: dict[str, Any] | None = None) -> None:
        self.initial_checkpoint = checkpoint
        self.checkpoints: list[dict[str, Any]] = []
        self.retry_calls: list[dict[str, Any]] = []

    async def checkpoint(
        self,
        job_id: UUID,
        stage: str,
        data: dict[str, Any],
        *,
        worker: str,
        lease_token: UUID | None,
    ) -> None:
        self.checkpoints.append(
            {
                "job_id": job_id,
                "stage": stage,
                "data": data,
                "worker": worker,
                "lease_token": lease_token,
            }
        )

    async def get_checkpoint(self, job_id: UUID, stage: str) -> dict[str, Any] | None:
        if self.checkpoints:
            return self.checkpoints[-1]["data"]
        return self.initial_checkpoint

    async def retry(self, job_id: UUID, **kwargs: Any) -> SimpleNamespace:
        self.retry_calls.append({"job_id": job_id, **kwargs})
        return SimpleNamespace(status="unused")


class FakePageState:
    def __init__(
        self,
        batches_by_query: dict[str, list[list[MetaAd]]],
        *,
        read_errors: list[str] | None = None,
        screenshot_errors: list[str] | None = None,
        confirmed_empty: bool = False,
        explicit_end: bool = True,
        advance_per_scroll: timedelta = timedelta(0),
        advance_per_new_query: timedelta = timedelta(0),
        clock: MutableClock | None = None,
    ) -> None:
        self.batches_by_query = batches_by_query
        self.read_errors = deque(read_errors or [])
        self.screenshot_errors = deque(screenshot_errors or [])
        self.confirmed_empty = confirmed_empty
        self.explicit_end = explicit_end
        self.advance_per_scroll = advance_per_scroll
        self.advance_per_new_query = advance_per_new_query
        self.clock = clock
        self.indices: dict[str, int] = {}
        self.events: list[Any] = []


class FakeMetaPage:
    def __init__(self, state: FakePageState) -> None:
        self.state = state
        self.current_query = ""
        self.filters: dict[str, str] = {}
        self.source_url = "https://www.facebook.com/ads/library/"

    async def apply_filter(self, name: str, value: str) -> None:
        self.state.events.append(("filter", name, value))
        self.filters[name] = value
        if name == "query":
            if (
                self.current_query
                and self.current_query != value
                and self.state.clock is not None
            ):
                self.state.clock.advance(self.state.advance_per_new_query)
            self.current_query = value
            self.state.indices.setdefault(value, 0)

    async def displayed_filters(self) -> dict[str, str]:
        return dict(self.filters)

    async def health_check(self) -> None:
        self.state.events.append("health")

    async def read_batch(self, *, query: str) -> tuple[MetaAd, ...]:
        self.state.events.append(("read", query))
        if self.state.read_errors:
            raise MetaPageHealthError(self.state.read_errors.popleft())
        batches = self.state.batches_by_query.get(query, [[]])
        index = min(self.state.indices.get(query, 0), len(batches) - 1)
        return tuple(batches[index])

    async def scroll(self) -> None:
        self.state.events.append("scroll")
        self.state.indices[self.current_query] = (
            self.state.indices.get(self.current_query, 0) + 1
        )
        if self.state.clock is not None:
            self.state.clock.advance(self.state.advance_per_scroll)

    async def at_end(self) -> bool:
        batches = self.state.batches_by_query.get(self.current_query, [[]])
        return (
            self.state.explicit_end
            and self.state.indices.get(self.current_query, 0) >= len(batches) - 1
        )

    async def no_results_confirmed(self) -> bool:
        return self.state.confirmed_empty

    async def screenshot(self) -> bytes:
        if self.state.screenshot_errors:
            raise RuntimeError(self.state.screenshot_errors.popleft())
        return f"png:{self.current_query}:{self.state.indices.get(self.current_query, 0)}".encode()

    async def refresh(self) -> None:
        self.state.events.append("refresh")

    async def reopen(self) -> None:
        self.state.events.append("reopen")

    async def restore_checkpoint(self, checkpoint: dict[str, Any]) -> None:
        self.state.events.append(("restore", checkpoint))


class FakePageFactory:
    def __init__(self, state: FakePageState) -> None:
        self.state = state

    async def create(self) -> FakeMetaPage:
        self.state.events.append("create")
        return FakeMetaPage(self.state)

    async def new_context(self) -> FakeMetaPage:
        self.state.events.append("new_context")
        return FakeMetaPage(self.state)


class FailingPageFactory:
    async def create(self) -> FakeMetaPage:
        raise RuntimeError("browser context unavailable")

    async def new_context(self) -> FakeMetaPage:
        raise RuntimeError("browser context unavailable")


async def collect_with_fakes(
    state: FakePageState,
    *,
    query: MetaQuery | None = None,
    repo: FakeJobRepository | None = None,
    evidence: FakeEvidenceStore | None = None,
    clock: MutableClock | None = None,
    attempt: int = 1,
    manage_retries: bool = True,
):
    used_repo = repo or FakeJobRepository()
    used_evidence = evidence or FakeEvidenceStore()
    job_id = uuid4()
    lease_token = uuid4()
    collector = MetaCollector(
        FakePageFactory(state),
        evidence_store=used_evidence,
        job_repository=used_repo,
        clock=clock or state.clock or MutableClock(),
    )
    result = await collector.collect(
        query or MetaQuery(query="portable organizer"),
        job_id=job_id,
        record_id="record-1",
        worker="worker-1",
        lease_token=lease_token,
        attempt=attempt,
        manage_retries=manage_retries,
    )
    return result, used_repo, used_evidence, job_id, lease_token


async def test_page_object_applies_and_records_required_filters_with_health_checks() -> (
    None
):
    actual = '"portable organizer"'
    state = FakePageState({actual: [[ad("1")]]})

    result, _, _, _, _ = await collect_with_fakes(state)

    assert result.ok is True
    assert result.value is not None
    coverage = result.value.coverage[0]
    assert coverage.displayed_filters == {
        "market": "US",
        "status": "active",
        "media_type": "video",
        "search_mode": "exact_phrase",
        "query": actual,
    }
    filter_events = [
        event
        for event in state.events
        if isinstance(event, tuple) and event[0] == "filter"
    ]
    assert [event[1] for event in filter_events] == [
        "market",
        "status",
        "media_type",
        "search_mode",
        "query",
    ]
    first_read = state.events.index(("read", actual))
    assert state.events[:first_read].count("health") == 5


async def test_each_result_batch_saves_screenshot_and_fenced_checkpoint() -> None:
    actual = '"portable organizer"'
    state = FakePageState({actual: [[ad("1")], [ad("1"), ad("2")]]})

    result, repo, evidence, job_id, lease_token = await collect_with_fakes(state)

    assert result.ok is True
    assert len(evidence.puts) == 2
    assert len(repo.checkpoints) == 2
    assert all(item["job_id"] == job_id for item in repo.checkpoints)
    assert all(item["worker"] == "worker-1" for item in repo.checkpoints)
    assert all(item["lease_token"] == lease_token for item in repo.checkpoints)
    assert repo.checkpoints[-1]["data"]["seen_ad_ids"] == ["1", "2"]
    assert repo.checkpoints[-1]["data"]["screenshot_evidence_id"] == "evidence-2"
    assert state.events.count("health") == 6


async def test_resumed_query_keeps_previously_saved_screenshot_evidence() -> None:
    actual = '"portable organizer"'
    prior_ad = ad("1")
    checkpoint = {
        "actual_query_index": 0,
        "actual_query": actual,
        "current_ads": [prior_ad.model_dump(mode="json")],
        "current_screenshot_evidence_ids": ["evidence-prior"],
        "scroll_count": 0,
    }
    repo = FakeJobRepository(checkpoint)
    state = FakePageState({actual: [[prior_ad, ad("2")]]})

    result, _, _, _, _ = await collect_with_fakes(state, repo=repo, attempt=4)

    assert result.value is not None
    assert result.value.coverage[0].screenshot_evidence_ids == (
        "evidence-prior",
        "evidence-1",
    )


async def test_resume_next_query_does_not_reuse_previous_query_scroll_state() -> None:
    query = MetaQuery(
        query="portable organizer", approved_synonyms=("travel organizer",)
    )
    first_ad = ad("1")
    checkpoint = {
        "actual_query_index": 1,
        "actual_query": query.actual_queries[0],
        "ads": [first_ad.model_dump(mode="json")],
        "coverage": [
            {
                "actual_query": query.actual_queries[0],
                "displayed_filters": {
                    "market": "US",
                    "status": "active",
                    "media_type": "video",
                    "search_mode": "exact_phrase",
                    "query": query.actual_queries[0],
                },
                "result_count": 1,
                "scroll_count": 3,
                "stop_reason": "page_end",
                "truncated": False,
                "relevance_verified": True,
                "screenshot_evidence_ids": ["evidence-first"],
            }
        ],
        "scroll_count": 3,
        "no_new_scrolls": 3,
        "batch_index": 4,
        "current_screenshot_evidence_ids": ["evidence-first"],
        "batch_started_at": datetime(2026, 9, 5, tzinfo=UTC).isoformat(),
        "query_started_at": datetime(2026, 9, 5, tzinfo=UTC).isoformat(),
    }
    repo = FakeJobRepository(checkpoint)
    state = FakePageState({query.actual_queries[1]: [[ad("2")]]})

    result, _, _, _, _ = await collect_with_fakes(
        state, query=query, repo=repo, attempt=4
    )

    assert result.value is not None
    assert result.value.coverage[1].scroll_count == 0
    assert result.value.coverage[1].screenshot_evidence_ids == ("evidence-1",)


async def test_failure_on_new_query_resets_previous_query_checkpoint_state() -> None:
    query = MetaQuery(
        query="portable organizer", approved_synonyms=("travel organizer",)
    )
    first_ad = ad("1")
    checkpoint = {
        "actual_query_index": 1,
        "actual_query": query.actual_queries[0],
        "ads": [first_ad.model_dump(mode="json")],
        "coverage": [
            {
                "actual_query": query.actual_queries[0],
                "displayed_filters": {
                    "market": "US",
                    "status": "active",
                    "media_type": "video",
                    "search_mode": "exact_phrase",
                    "query": query.actual_queries[0],
                },
                "result_count": 1,
                "scroll_count": 3,
                "stop_reason": "page_end",
                "truncated": False,
                "relevance_verified": True,
                "screenshot_evidence_ids": ["evidence-first"],
            }
        ],
        "current_ads": [first_ad.model_dump(mode="json")],
        "scroll_count": 3,
        "no_new_scrolls": 3,
        "batch_index": 4,
        "current_screenshot_evidence_ids": ["evidence-first"],
        "batch_started_at": datetime(2026, 9, 5, tzinfo=UTC).isoformat(),
        "query_started_at": datetime(2026, 9, 5, tzinfo=UTC).isoformat(),
    }
    repo = FakeJobRepository(checkpoint)
    state = FakePageState(
        {query.actual_queries[1]: [[ad("2")]]}, read_errors=["white_screen"]
    )

    result, _, _, _, _ = await collect_with_fakes(state, query=query, repo=repo)

    assert result.value is not None
    assert result.value.coverage[1].result_count == 1
    assert result.value.coverage[1].scroll_count == 0
    assert [item.ad_id for item in result.value.ads] == ["1", "2"]


async def test_stop_at_explicit_page_end_is_complete() -> None:
    actual = '"portable organizer"'
    state = FakePageState({actual: [[ad("1")]]}, explicit_end=True)

    result, _, _, _, _ = await collect_with_fakes(state)

    assert result.value is not None
    assert result.value.coverage[0].stop_reason == "page_end"
    assert result.value.truncated is False
    assert result.value.competition_verified is True


async def test_stop_after_three_scrolls_without_new_ad_ids() -> None:
    actual = '"portable organizer"'
    state = FakePageState(
        {actual: [[ad("1")], [ad("1")], [ad("1")], [ad("1")]]},
        explicit_end=False,
    )

    result, _, _, _, _ = await collect_with_fakes(state)

    assert result.value is not None
    assert result.value.coverage[0].stop_reason == "no_new_ads_3_scrolls"
    assert result.value.coverage[0].scroll_count == 3
    assert result.value.truncated is False


async def test_time_limit_and_count_limit_are_truncated() -> None:
    actual = '"portable organizer"'
    clock = MutableClock()
    timed = FakePageState(
        {actual: [[ad("1")], [ad("2")]]},
        explicit_end=False,
        advance_per_scroll=timedelta(minutes=16),
        clock=clock,
    )
    timed_result, _, _, _, _ = await collect_with_fakes(timed, clock=clock)
    many = [ad(str(index)) for index in range(500)]
    counted = FakePageState({actual: [many]}, explicit_end=False)
    count_result, _, _, _, _ = await collect_with_fakes(counted)

    assert timed_result.value is not None
    assert timed_result.value.coverage[0].stop_reason == "time_limit"
    assert timed_result.value.truncated is True
    assert count_result.value is not None
    assert count_result.value.coverage[0].stop_reason == "count_limit"
    assert count_result.value.truncated is True
    assert len(count_result.value.ads) == 500


async def test_count_limit_never_returns_more_ads_than_the_configured_cap() -> None:
    actual = '"portable organizer"'
    result, _, _, _, _ = await collect_with_fakes(
        FakePageState({actual: [[ad("1"), ad("2"), ad("3")]]}, explicit_end=False),
        query=MetaQuery(query="portable organizer", max_ads=2),
    )

    assert result.value is not None
    assert [item.ad_id for item in result.value.ads] == ["1", "2"]
    assert result.value.coverage[0].result_count == 2
    assert result.value.coverage[0].stop_reason == "count_limit"


async def test_count_limit_is_shared_across_generic_and_synonym_queries() -> None:
    query = MetaQuery(
        query="portable organizer",
        approved_synonyms=("travel organizer", "bag organizer"),
        max_ads=3,
    )
    state = FakePageState(
        {
            query.actual_queries[0]: [[ad("1"), ad("2")]],
            query.actual_queries[1]: [[ad("3"), ad("4")]],
            query.actual_queries[2]: [[ad("5")]],
        }
    )

    result, _, _, _, _ = await collect_with_fakes(state, query=query)

    assert result.value is not None
    assert [item.ad_id for item in result.value.ads] == ["1", "2", "3"]
    assert len(result.value.coverage) == 2
    assert result.value.actual_queries == query.actual_queries[:2]
    assert result.value.coverage[-1].stop_reason == "count_limit"
    assert result.value.truncated is True
    assert result.value.competition_verified is False


async def test_time_limit_is_shared_across_generic_and_synonym_queries() -> None:
    clock = MutableClock()
    query = MetaQuery(
        query="portable organizer",
        approved_synonyms=("travel organizer", "bag organizer"),
        time_limit_seconds=15 * 60,
    )
    state = FakePageState(
        {
            query.actual_queries[0]: [[ad("1")]],
            query.actual_queries[1]: [[ad("2")]],
            query.actual_queries[2]: [[ad("3")]],
        },
        advance_per_new_query=timedelta(minutes=16),
        clock=clock,
    )

    result, _, _, _, _ = await collect_with_fakes(state, query=query, clock=clock)

    assert result.value is not None
    assert [item.ad_id for item in result.value.ads] == ["1", "2"]
    assert len(result.value.coverage) == 2
    assert result.value.coverage[-1].stop_reason == "time_limit"
    assert result.value.truncated is True


async def test_shared_time_limit_preserves_prior_ads_when_next_query_is_empty() -> None:
    clock = MutableClock()
    query = MetaQuery(
        query="portable organizer",
        approved_synonyms=("travel organizer",),
        time_limit_seconds=15 * 60,
    )
    state = FakePageState(
        {
            query.actual_queries[0]: [[ad("1")]],
            query.actual_queries[1]: [[]],
        },
        advance_per_new_query=timedelta(minutes=16),
        clock=clock,
    )

    result, _, _, _, _ = await collect_with_fakes(state, query=query, clock=clock)

    assert result.ok is True
    assert result.value is not None
    assert [item.ad_id for item in result.value.ads] == ["1"]
    assert result.value.coverage[-1].result_count == 0
    assert result.value.coverage[-1].stop_reason == "time_limit"
    assert result.value.truncated is True
    assert result.value.competition_verified is False


async def test_competition_is_verified_only_when_generic_and_synonyms_complete() -> (
    None
):
    query = MetaQuery(
        query="portable organizer",
        approved_synonyms=("travel organizer", "bag organizer", "ignored"),
    )
    batches = {
        actual: [[ad(str(index), query=actual.strip('"'))]]
        for index, actual in enumerate(query.actual_queries)
    }
    complete, _, _, _, _ = await collect_with_fakes(FakePageState(batches), query=query)
    truncated_state = FakePageState(batches, explicit_end=False)
    truncated_state.indices[query.actual_queries[-1]] = 0
    truncated, _, _, _, _ = await collect_with_fakes(
        truncated_state,
        query=MetaQuery(
            query="portable organizer",
            max_ads=1,
            approved_synonyms=("travel organizer",),
        ),
    )

    assert complete.value is not None
    assert complete.value.actual_queries == query.actual_queries
    assert complete.value.competition_verified is True
    assert truncated.value is not None
    assert truncated.value.competition_verified is False


async def test_competition_remains_unverified_without_relevance_evidence() -> None:
    actual = '"portable organizer"'
    state = FakePageState(
        {actual: [[ad("1", relevance_verified=False)]]}, explicit_end=True
    )

    result, _, _, _, _ = await collect_with_fakes(state)

    assert result.value is not None
    assert result.value.coverage[0].relevance_verified is False
    assert result.value.competition_verified is False


async def test_empty_results_are_never_returned_as_success() -> None:
    actual = '"portable organizer"'
    state = FakePageState({actual: [[]]})

    result, repo, _, _, _ = await collect_with_fakes(state)

    assert result.ok is False
    assert result.value is None
    assert result.error is not None
    assert repo.retry_calls[-1]["attempt"] == 3


async def test_pipeline_owned_retry_keeps_the_current_lease_for_writeback() -> None:
    """The collector may checkpoint failure, but must not release the lease."""

    actual = '"portable organizer"'
    state = FakePageState({actual: [[]]})

    result, repo, _, _, _ = await collect_with_fakes(
        state,
        manage_retries=False,
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error.retriable is True
    assert repo.retry_calls == []
    assert repo.checkpoints[-1]["data"]["recovery_phase"] == "schedule_retry"


async def test_explicit_no_results_ui_is_typed_non_success_with_evidence() -> None:
    actual = '"portable organizer"'
    state = FakePageState({actual: [[]]}, confirmed_empty=True)

    result, repo, _, _, _ = await collect_with_fakes(state)

    assert result.ok is False
    assert result.error.code == "no_results"
    assert result.evidence
    assert repo.retry_calls == []


async def test_browser_setup_failure_returns_typed_delayed_result() -> None:
    repo = FakeJobRepository()
    collector = MetaCollector(
        FailingPageFactory(),
        evidence_store=FakeEvidenceStore(),
        job_repository=repo,
        clock=MutableClock(),
    )

    result = await collector.collect(
        MetaQuery(query="portable organizer"),
        job_id=uuid4(),
        record_id="record-1",
        worker="worker-1",
        lease_token=uuid4(),
    )

    assert result.value is None
    assert result.error is not None
    assert result.error.code == "delayed_retry"
    assert result.error.detail == "browser context unavailable"
    assert [item["attempt"] for item in repo.retry_calls] == [3]
    assert repo.checkpoints[-1]["data"]["failure_screenshot_evidence_id"] is None


async def test_three_immediate_recoveries_are_refresh_reopen_new_context() -> None:
    actual = '"portable organizer"'
    state = FakePageState(
        {actual: [[]]}, read_errors=["white", "white", "loading", "white"]
    )

    result, repo, _, _, _ = await collect_with_fakes(state)

    recoveries = [
        event
        for event in state.events
        if isinstance(event, str) and event in {"refresh", "reopen", "new_context"}
    ]
    assert recoveries == ["refresh", "reopen", "new_context"]
    assert [item["attempt"] for item in repo.retry_calls] == [1, 2, 3]
    assert result.error is not None
    assert result.error.code == "delayed_retry"
    assert result.error.retriable is True
    failure_checkpoint = repo.checkpoints[-1]["data"]
    assert failure_checkpoint["actual_query"] == actual
    assert failure_checkpoint["result_position"] == {
        "seen_ad_ids": [],
        "scroll_count": 0,
    }
    assert failure_checkpoint["failure_screenshot_evidence_id"]


@pytest.mark.parametrize(
    (
        "requested_attempt",
        "durable_attempt",
        "recovery_phase",
        "expected_actions",
        "expected_retries",
    ),
    [
        (2, 2, "reopen", ["reopen", "new_context"], [2, 3]),
        (3, 3, "new_context", ["new_context"], [3]),
        (1, 3, "new_context", ["new_context"], [3]),
    ],
)
async def test_reclaimed_immediate_attempt_resumes_durable_recovery_phase(
    requested_attempt: int,
    durable_attempt: int,
    recovery_phase: str,
    expected_actions: list[str],
    expected_retries: list[int],
) -> None:
    actual = '"portable organizer"'
    checkpoint = {
        "actual_query": actual,
        "recovery_attempt": durable_attempt,
        "recovery_phase": recovery_phase,
    }
    repo = FakeJobRepository(checkpoint)
    state = FakePageState({actual: [[]]}, read_errors=["white_screen"] * 6)

    result, used_repo, _, _, _ = await collect_with_fakes(
        state, repo=repo, attempt=requested_attempt
    )

    recovery_actions = [
        event
        for event in state.events
        if isinstance(event, str) and event in {"refresh", "reopen", "new_context"}
    ]
    assert recovery_actions == expected_actions
    assert [item["attempt"] for item in used_repo.retry_calls] == expected_retries
    assert all(
        item["data"]["recovery_attempt"] >= durable_attempt for item in repo.checkpoints
    )
    assert repo.checkpoints[-1]["data"]["recovery_phase"] == "schedule_retry"
    assert result.error is not None
    assert result.error.code == "delayed_retry"


async def test_interruption_before_delayed_retry_scheduling_finishes_it_once() -> None:
    actual = '"portable organizer"'
    checkpoint = {
        "actual_query": actual,
        "recovery_attempt": 3,
        "recovery_phase": "schedule_retry",
        "failure_detail": "white_screen",
    }
    repo = FakeJobRepository(checkpoint)
    state = FakePageState({actual: [[]]})

    result, used_repo, _, _, _ = await collect_with_fakes(state, repo=repo, attempt=2)

    assert state.events == []
    assert [item["attempt"] for item in used_repo.retry_calls] == [3]
    assert result.error is not None
    assert result.error.code == "delayed_retry"


@pytest.mark.parametrize(
    ("completed_attempt", "next_attempt", "expected_code"),
    [
        (3, 4, "delayed_retry"),
        (4, 5, "delayed_retry"),
        (5, 6, "needs_human"),
    ],
)
async def test_reclaimed_delayed_retry_advances_monotonically(
    completed_attempt: int, next_attempt: int, expected_code: str
) -> None:
    actual = '"portable organizer"'
    checkpoint = {
        "actual_query": actual,
        "recovery_attempt": completed_attempt,
        "recovery_phase": "schedule_retry",
        "failure_detail": "white_screen",
    }
    repo = FakeJobRepository(checkpoint)
    state = FakePageState({actual: [[]]}, read_errors=["white_screen"])

    result, used_repo, _, _, _ = await collect_with_fakes(
        state, repo=repo, attempt=completed_attempt
    )

    assert [item["attempt"] for item in used_repo.retry_calls] == [next_attempt]
    assert repo.checkpoints[-1]["data"]["recovery_attempt"] == next_attempt
    assert repo.checkpoints[-1]["data"]["recovery_phase"] == "schedule_retry"
    assert result.error is not None
    assert result.error.code == expected_code


async def test_failed_crash_screenshot_does_not_bypass_typed_recovery() -> None:
    actual = '"portable organizer"'
    state = FakePageState(
        {actual: [[]]},
        read_errors=["white", "white", "loading", "white"],
        screenshot_errors=["page already closed"],
    )

    result, repo, _, _, _ = await collect_with_fakes(state)

    assert result.error is not None
    assert result.error.code == "delayed_retry"
    assert [item["attempt"] for item in repo.retry_calls] == [1, 2, 3]
    assert repo.checkpoints[0]["data"]["failure_screenshot_evidence_id"] is None
    assert (
        repo.checkpoints[0]["data"]["failure_screenshot_error"] == "page already closed"
    )


@pytest.mark.parametrize("attempt", [4, 5])
async def test_delayed_attempts_reuse_checkpoint_and_delay_again(attempt: int) -> None:
    actual = '"portable organizer"'
    checkpoint = {"actual_query": actual, "seen_ad_ids": ["prior"], "scroll_count": 2}
    repo = FakeJobRepository(checkpoint)
    state = FakePageState({actual: [[]]}, read_errors=["white"])

    result, used_repo, _, _, _ = await collect_with_fakes(
        state, repo=repo, attempt=attempt
    )

    assert ("restore", checkpoint) in state.events
    assert state.events.index(("filter", "query", actual)) < state.events.index(
        ("restore", checkpoint)
    )
    assert [item["attempt"] for item in used_repo.retry_calls] == [attempt]
    assert result.error is not None
    assert result.error.code == "delayed_retry"


async def test_sixth_failure_is_needs_human_and_never_empty_success() -> None:
    actual = '"portable organizer"'
    state = FakePageState({actual: [[]]}, read_errors=["infinite_loading"])

    result, repo, _, _, _ = await collect_with_fakes(state, attempt=6)

    assert [item["attempt"] for item in repo.retry_calls] == [6]
    assert result.ok is False
    assert result.value is None
    assert result.error is not None
    assert result.error.code == "needs_human"
    assert result.error.retriable is False
