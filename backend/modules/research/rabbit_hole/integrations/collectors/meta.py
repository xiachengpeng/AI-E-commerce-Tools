"""Resilient Meta Ad Library collection and deterministic creative screening."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from copy import copy
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum
from html.parser import HTMLParser
from typing import Any, Literal, Protocol, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID

from playwright.async_api import (
    Browser,
    BrowserContext,
    Page,
)
from playwright.async_api import (
    TimeoutError as PlaywrightTimeoutError,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

from rabbit_hole.domain.legacy import Clock, SystemClock
from rabbit_hole.input_urls import canonical_research_url
from rabbit_hole.integrations.collectors.base import CollectorError, CollectorResult
from rabbit_hole.keyword_phrases import canonical_phrase
from rabbit_hole.persistence.evidence_store import StoredEvidence
from rabbit_hole.persistence.legacy_jobs import StaleLeaseError

_TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
}
_PRODUCT_PAGE_TYPES = {"product", "product_detail"}
_IDENTIFY_PAGE_TYPES = {"category", "collection", "home", "multi_product"}
_CAPTCHA_MARKERS = ("captcha", "security check", "confirm you're human")
_ACCESS_RESTRICTION_MARKERS = (
    "temporarily blocked",
    "access denied",
    "log in to continue",
)
_HTML_VOID_ELEMENTS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}
_IMMEDIATE_RECOVERY_ACTIONS = {
    1: "refresh",
    2: "reopen",
    3: "new_context",
}
_RECOVERY_PHASES = {*_IMMEDIATE_RECOVERY_ACTIONS.values(), "schedule_retry"}


class MetaQuery(BaseModel):
    """One generic product query plus no more than two human-approved synonyms."""

    model_config = ConfigDict(frozen=True)

    query: str
    market: Literal["US"] = "US"
    approved_synonyms: tuple[str, ...] = ()
    max_ads: int = Field(default=500, ge=1, le=500)
    time_limit_seconds: int = Field(default=15 * 60, ge=1)
    no_new_scroll_limit: int = Field(default=3, ge=1)

    @field_validator("query")
    @classmethod
    def _nonempty_query(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("query must not be empty")
        return normalized

    @field_validator("approved_synonyms", mode="before")
    @classmethod
    def _normalize_synonyms(
        cls, value: object, info: ValidationInfo
    ) -> tuple[str, ...]:
        if value is None:
            return ()
        if isinstance(value, str) or not isinstance(value, Sequence):
            raise TypeError("approved_synonyms must be a sequence of strings")
        generic = str(info.data.get("query", "")).casefold()
        result: list[str] = []
        seen = {generic}
        for item in value:
            if not isinstance(item, str):
                raise TypeError("approved synonyms must be strings")
            normalized = " ".join(item.split())
            folded = normalized.casefold()
            if not normalized or folded in seen:
                continue
            seen.add(folded)
            result.append(normalized)
            if len(result) == 2:
                break
        return tuple(result)

    @property
    def actual_queries(self) -> tuple[str, ...]:
        return tuple(
            _exact_phrase(item) for item in (self.query, *self.approved_synonyms)
        )


class MetaAd(BaseModel):
    """Observable fields from one Meta Ad Library card."""

    model_config = ConfigDict(frozen=True)

    ad_id: str
    advertiser: str
    page_id: str | None = None
    start_date: date | None = None
    is_active: bool
    observable_active_days: int | None = Field(default=None, ge=0)
    observed_at: datetime | None = None
    primary_text: str = ""
    hook: str = ""
    landing_url: str | None = None
    final_landing_url: str | None = None
    media_url: str | None = None
    landing_page_type: str = "unknown"
    product_fingerprint: str | None = None
    media_hash: str | None = None
    perceptual_hash: str | None = None
    media_accessible: bool | None = None
    relevance_verified: bool = False
    human_confirmed_distinct: bool = False
    query: str

    @field_validator("landing_url", "final_landing_url", "media_url")
    @classmethod
    def _safe_urls(cls, value: str | None) -> str | None:
        return canonical_research_url(value) if value else None

    @field_validator("ad_id", "advertiser", "query")
    @classmethod
    def _required_text(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("required Meta ad text must not be empty")
        return normalized


class CreativeDecision(StrEnum):
    DUPLICATE = "duplicate"
    DISTINCT = "distinct"
    NEEDS_CONFIRMATION = "待确认创意"


class MetaProductGroup(BaseModel):
    model_config = ConfigDict(frozen=True)

    group_key: str
    normalized_landing_url: str | None
    product_fingerprint: str | None
    advertiser: str
    identity_status: str
    ads: tuple[MetaAd, ...]


class CoarseScreenResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    passed: bool
    max_observable_active_days: int | None
    verified_active_creatives: int
    status: str
    reasons: tuple[str, ...]


class QueryCoverage(BaseModel):
    model_config = ConfigDict(frozen=True)

    actual_query: str
    displayed_filters: dict[str, str]
    result_count: int
    scroll_count: int
    stop_reason: Literal[
        "page_end",
        "no_results",
        "no_new_ads_3_scrolls",
        "time_limit",
        "count_limit",
    ]
    truncated: bool
    relevance_verified: bool = False
    screenshot_evidence_ids: tuple[str, ...] = ()


class SearchBatchResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    query: MetaQuery
    actual_queries: tuple[str, ...]
    ads: tuple[MetaAd, ...]
    coverage: tuple[QueryCoverage, ...]
    collected_at: datetime
    truncated: bool
    competition_verified: bool


def _exact_phrase(value: str) -> str:
    return canonical_phrase(value).quoted


def normalize_landing_url(value: str | None) -> str | None:
    """Normalize a final landing URL without discarding product-significant query data."""

    if value is None:
        return None
    try:
        parsed = urlsplit(value.strip())
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        host = parsed.hostname.lower()
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    default_port = (scheme == "https" and port == 443) or (
        scheme == "http" and port == 80
    )
    netloc = host if port is None or default_port else f"{host}:{port}"
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/":
        path = path.rstrip("/")
    query = urlencode(
        sorted(
            (name, item)
            for name, item in parse_qsl(parsed.query, keep_blank_values=True)
            if not name.lower().startswith("utm_")
            and name.lower() not in _TRACKING_QUERY_KEYS
        ),
        doseq=True,
    )
    return urlunsplit((scheme, netloc, path, query, ""))


def creative_decision(
    left: MetaAd, right: MetaAd, *, similarity: float | None = None
) -> CreativeDecision:
    """Classify two creatives using deterministic evidence in priority order."""

    if left.media_hash and right.media_hash and left.media_hash == right.media_hash:
        return CreativeDecision.DUPLICATE
    if left.human_confirmed_distinct or right.human_confirmed_distinct:
        return CreativeDecision.DISTINCT
    if left.media_accessible is not True or right.media_accessible is not True:
        return CreativeDecision.NEEDS_CONFIRMATION
    measured = similarity
    if measured is None:
        measured = _perceptual_similarity(left.perceptual_hash, right.perceptual_hash)
    if measured is None:
        return CreativeDecision.NEEDS_CONFIRMATION
    if measured >= 95:
        return CreativeDecision.DUPLICATE
    if measured < 85 and _copy_or_hook_clearly_differs(left, right):
        return CreativeDecision.DISTINCT
    return CreativeDecision.NEEDS_CONFIRMATION


def _copy_or_hook_clearly_differs(left: MetaAd, right: MetaAd) -> bool:
    left_signature = (
        _normalized_creative_text(left.primary_text),
        _normalized_creative_text(left.hook),
    )
    right_signature = (
        _normalized_creative_text(right.primary_text),
        _normalized_creative_text(right.hook),
    )
    return (
        any(left_signature)
        and any(right_signature)
        and left_signature != right_signature
    )


def _normalized_creative_text(value: str) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", value.casefold()).split())


def _perceptual_similarity(left: str | None, right: str | None) -> float | None:
    if not left or not right or len(left) != len(right):
        return None
    try:
        left_value = int(left, 16)
        right_value = int(right, 16)
    except ValueError:
        return None
    bit_count = len(left) * 4
    if bit_count == 0:
        return None
    distance = (left_value ^ right_value).bit_count()
    return 100.0 * (bit_count - distance) / bit_count


def verified_distinct_creatives(ads: Sequence[MetaAd]) -> tuple[MetaAd, ...]:
    """Return conservative representative creatives; ambiguous items never count."""

    representatives: list[MetaAd] = []
    for candidate in ads:
        if candidate.human_confirmed_distinct:
            if any(
                candidate.media_hash
                and representative.media_hash == candidate.media_hash
                for representative in representatives
            ):
                continue
            representatives.append(candidate)
            continue
        if candidate.media_accessible is not True or (
            not candidate.media_hash and not candidate.perceptual_hash
        ):
            continue
        decisions = [creative_decision(candidate, item) for item in representatives]
        if CreativeDecision.DUPLICATE in decisions:
            continue
        if CreativeDecision.NEEDS_CONFIRMATION in decisions:
            continue
        representatives.append(candidate)
    return tuple(representatives)


def group_ads(ads: Sequence[MetaAd]) -> tuple[MetaProductGroup, ...]:
    """Deduplicate by ad ID, then group by final URL, fingerprint, and advertiser."""

    unique: dict[str, MetaAd] = {}
    for item in ads:
        unique.setdefault(item.ad_id, item)
    grouped: dict[tuple[str, str], list[MetaAd]] = {}
    group_metadata: dict[tuple[str, str], tuple[str | None, str | None, str]] = {}
    facts: list[tuple[MetaAd, str | None, str | None, str]] = []
    fingerprint_groups_by_landing: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for item in unique.values():
        normalized_url = normalize_landing_url(
            item.final_landing_url or item.landing_url
        )
        fingerprint = _optional_normalized(item.product_fingerprint)
        advertiser_key = " ".join(item.advertiser.casefold().split())
        facts.append((item, normalized_url, fingerprint, advertiser_key))
        if fingerprint is None:
            continue
        key = (f"fingerprint:{fingerprint}", advertiser_key)
        grouped.setdefault(key, []).append(item)
        group_metadata.setdefault(key, (normalized_url, fingerprint, item.advertiser))
        if normalized_url is not None:
            fingerprint_groups_by_landing.setdefault(
                (normalized_url, advertiser_key), set()
            ).add(key)
    for item, normalized_url, fingerprint, advertiser_key in facts:
        if fingerprint is not None:
            continue
        candidates = (
            fingerprint_groups_by_landing.get((normalized_url, advertiser_key), set())
            if normalized_url is not None
            else set()
        )
        key = (
            next(iter(candidates))
            if len(candidates) == 1
            else (f"landing:{normalized_url or 'missing-url'}", advertiser_key)
        )
        grouped.setdefault(key, []).append(item)
        group_metadata.setdefault(key, (normalized_url, None, item.advertiser))
    result: list[MetaProductGroup] = []
    for key, members in grouped.items():
        normalized_url, fingerprint, advertiser = group_metadata[key]
        page_types = {item.landing_page_type.casefold() for item in members}
        identifiable = (
            normalized_url is not None
            and page_types
            and page_types.issubset(_PRODUCT_PAGE_TYPES)
            and page_types.isdisjoint(_IDENTIFY_PAGE_TYPES)
        )
        identity_status = "已识别具体产品" if identifiable else "待识别具体产品"
        result.append(
            MetaProductGroup(
                group_key="|".join(key),
                normalized_landing_url=normalized_url,
                product_fingerprint=fingerprint if identifiable else None,
                advertiser=advertiser,
                identity_status=identity_status,
                ads=tuple(members),
            )
        )
    return tuple(result)


def coarse_screen(group: MetaProductGroup) -> CoarseScreenResult:
    active = tuple(item for item in group.ads if item.is_active)
    ages = [
        item.observable_active_days
        for item in active
        if item.observable_active_days is not None
    ]
    max_age = max(ages) if ages else None
    distinct = verified_distinct_creatives(active)
    ambiguous_creatives = _has_ambiguous_creative_evidence(active)
    passed = (
        group.identity_status != "待识别具体产品"
        and max_age is not None
        and max_age >= 30
        and len(distinct) >= 3
    )
    reasons: list[str] = []
    if group.identity_status == "待识别具体产品":
        reasons.append("landing page does not identify one product")
    if max_age is None or max_age < 30:
        reasons.append("no active ad has 30 observable days")
    if len(distinct) < 3:
        reasons.append("fewer than three verified-distinct active creatives")
    if ambiguous_creatives:
        reasons.append("one or more active creatives require confirmation")
    if passed:
        status = "值得深入"
    elif group.identity_status == "待识别具体产品":
        status = "待识别具体产品"
    elif ambiguous_creatives:
        status = "待确认创意"
    else:
        status = "观察池"
    return CoarseScreenResult(
        passed=passed,
        max_observable_active_days=max_age,
        verified_active_creatives=len(distinct),
        status=status,
        reasons=tuple(reasons),
    )


def _has_ambiguous_creative_evidence(ads: Sequence[MetaAd]) -> bool:
    for index, item in enumerate(ads):
        if not item.human_confirmed_distinct and (
            item.media_accessible is not True
            or (not item.media_hash and not item.perceptual_hash)
        ):
            return True
        if any(
            creative_decision(item, other) is CreativeDecision.NEEDS_CONFIRMATION
            for other in ads[:index]
        ):
            return True
    return False


def _optional_normalized(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = " ".join(value.split())
    return normalized or None


class _CardHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: list[dict[str, str]] = []
        self._card: dict[str, str] | None = None
        self._card_depth = 0
        self._roles: list[tuple[int, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name: value or "" for name, value in attrs}
        if self._card is None and "data-meta-ad-card" in attributes:
            self._card = {
                name.removeprefix("data-"): value
                for name, value in attributes.items()
                if name.startswith("data-")
            }
            self._card_depth = 1
            return
        if self._card is None:
            return
        if tag in _HTML_VOID_ELEMENTS:
            return
        self._card_depth += 1
        role = attributes.get("data-role")
        if role:
            self._roles.append((self._card_depth, role))
        if role == "landing-link" and attributes.get("href"):
            self._card.setdefault("landing-url", attributes["href"])

    def handle_data(self, data: str) -> None:
        if self._card is None or not self._roles:
            return
        role = self._roles[-1][1]
        self._card[role] = self._card.get(role, "") + data

    def handle_endtag(self, tag: str) -> None:
        if self._card is None:
            return
        if self._roles and self._roles[-1][0] == self._card_depth:
            self._roles.pop()
        self._card_depth -= 1
        if self._card_depth == 0:
            self.cards.append(self._card)
            self._card = None
            self._roles.clear()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _HTML_VOID_ELEMENTS:
            self.handle_endtag(tag)


class MetaAdParser:
    """Pure HTML parser kept separate from Playwright selectors and UI actions."""

    def parse(self, html: str, *, query: str, observed_on: date) -> tuple[MetaAd, ...]:
        parser = _CardHTMLParser()
        parser.feed(html)
        ads: list[MetaAd] = []
        for card in parser.cards:
            start_date = _parse_date(card.get("start-date"))
            is_active = card.get("active", "").casefold() == "true"
            explicit_days = _parse_nonnegative_int(card.get("active-days"))
            observable_days = explicit_days
            if observable_days is None and is_active and start_date is not None:
                observable_days = max(0, (observed_on - start_date).days)
            ads.append(
                MetaAd(
                    ad_id=card.get("ad-id", ""),
                    advertiser=card.get("advertiser", ""),
                    page_id=_optional_normalized(card.get("page-id")),
                    start_date=start_date,
                    is_active=is_active,
                    observable_active_days=observable_days,
                    primary_text=" ".join(card.get("primary-text", "").split()),
                    hook=" ".join(card.get("hook", "").split()),
                    landing_url=_optional_normalized(card.get("landing-url")),
                    final_landing_url=_optional_normalized(
                        card.get("final-landing-url")
                    ),
                    landing_page_type=card.get("page-type", "unknown"),
                    product_fingerprint=_optional_normalized(
                        card.get("product-fingerprint")
                    ),
                    media_hash=_optional_normalized(card.get("media-hash")),
                    perceptual_hash=_optional_normalized(card.get("perceptual-hash")),
                    media_accessible=_parse_optional_bool(card.get("media-accessible")),
                    relevance_verified=(
                        _parse_optional_bool(card.get("relevance-verified")) is True
                    ),
                    query=query,
                )
            )
        return tuple(ads)


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _parse_nonnegative_int(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _parse_optional_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    if value.casefold() == "true":
        return True
    if value.casefold() == "false":
        return False
    return None


class MetaPageHealthError(RuntimeError):
    """The UI cannot prove that filters/results are healthy."""


class MetaPage(Protocol):
    source_url: str

    async def apply_filter(self, name: str, value: str) -> None: ...
    async def displayed_filters(self) -> dict[str, str]: ...
    async def health_check(self) -> None: ...
    async def read_batch(self, *, query: str) -> tuple[MetaAd, ...]: ...
    async def scroll(self) -> None: ...
    async def at_end(self) -> bool: ...
    async def no_results_confirmed(self) -> bool: ...
    async def screenshot(self) -> bytes: ...
    async def refresh(self) -> None: ...
    async def reopen(self) -> None: ...
    async def restore_checkpoint(self, checkpoint: dict[str, Any]) -> None: ...


class MetaPageFactory(Protocol):
    async def create(self) -> MetaPage: ...
    async def new_context(self) -> MetaPage: ...


class EvidenceWriter(Protocol):
    def put(self, **kwargs: Any) -> StoredEvidence: ...


class MetaJobRepository(Protocol):
    async def checkpoint(
        self,
        job_id: UUID,
        stage: str,
        data: dict[str, Any],
        *,
        worker: str,
        lease_token: UUID | None,
    ) -> None: ...

    async def get_checkpoint(
        self, job_id: UUID, stage: str
    ) -> dict[str, Any] | None: ...

    async def retry(self, job_id: UUID, **kwargs: Any) -> object: ...


@dataclass(frozen=True, slots=True)
class MetaSelectors:
    market: str = "[data-testid='country-filter']"
    status: str = "[data-testid='status-filter']"
    media_type: str = "[data-testid='media-type-filter']"
    search_mode: str = "[data-testid='search-mode-filter']"
    query: str = "[data-testid='search-input']"
    results: str = "[data-testid='ad-library-results']"
    loading: str = "[data-testid='ad-library-loading']"
    end: str = "[data-testid='ad-library-end']"
    no_results: str = "[data-testid='ad-library-no-results']"


class PlaywrightMetaPage:
    """UI-only page object; parsing is delegated to :class:`MetaAdParser`."""

    def __init__(
        self,
        page: Page,
        *,
        selectors: MetaSelectors | None = None,
        parser: MetaAdParser | None = None,
        clock: Clock | None = None,
        source_url: str = "https://www.facebook.com/ads/library/",
        settle_timeout_ms: float = 10_000,
    ) -> None:
        self._page = page
        self._selectors = selectors or MetaSelectors()
        self._parser = parser or MetaAdParser()
        self._clock = clock or SystemClock()
        self.source_url = source_url
        self._settle_timeout_ms = settle_timeout_ms
        self._displayed: dict[str, str] = {}

    async def apply_filter(self, name: str, value: str) -> None:
        _raise_for_access_text(await self._page.locator("body").inner_text())
        selector = cast(str, getattr(self._selectors, name))
        locator = self._page.locator(selector)
        if name == "query":
            await locator.fill(value)
            await locator.press("Enter")
        else:
            await locator.select_option(value)
        displayed = await self._read_displayed(locator)
        if not displayed:
            raise MetaPageHealthError(f"filter_unreadable:{name}")
        self._displayed[name] = displayed

    async def _read_displayed(self, locator: Any) -> str:
        try:
            value = await locator.input_value()
        except Exception:  # noqa: BLE001 -- UI controls can expose text instead
            value = await locator.text_content()
        return " ".join(str(value or "").split())

    async def displayed_filters(self) -> dict[str, str]:
        return dict(self._displayed)

    async def health_check(self) -> None:
        body = await self._page.locator("body").inner_text()
        _raise_for_access_text(body)
        if not body.strip():
            raise MetaPageHealthError("white_screen")
        loading = self._page.locator(self._selectors.loading)
        if await loading.count() and await loading.is_visible():
            try:
                await loading.wait_for(state="hidden", timeout=self._settle_timeout_ms)
            except PlaywrightTimeoutError as exc:
                raise MetaPageHealthError("infinite_loading") from exc
            if await loading.is_visible():
                raise MetaPageHealthError("infinite_loading")
        settled_body = await self._page.locator("body").inner_text()
        _raise_for_access_text(settled_body)
        if not settled_body.strip():
            raise MetaPageHealthError("white_screen")
        for name in ("market", "status", "media_type", "search_mode", "query"):
            selector = cast(str, getattr(self._selectors, name))
            locator = self._page.locator(selector)
            if await locator.count() == 0:
                raise MetaPageHealthError(f"missing_control:{name}")
            if not await locator.is_visible():
                raise MetaPageHealthError(f"control_not_visible:{name}")
            if not await locator.is_enabled():
                raise MetaPageHealthError(f"control_not_ready:{name}")
            expected = self._displayed.get(name)
            if expected is not None and await self._read_displayed(locator) != expected:
                raise MetaPageHealthError(f"filter_not_settled:{name}")
        if await self.no_results_confirmed():
            return
        results = self._page.locator(self._selectors.results)
        if await results.count() == 0:
            raise MetaPageHealthError("missing_results")
        if not await results.is_visible():
            raise MetaPageHealthError("results_not_visible")

    async def read_batch(self, *, query: str) -> tuple[MetaAd, ...]:
        return self._parser.parse(
            await self._page.content(),
            query=query.strip('"').replace(r"\"", '"'),
            observed_on=self._clock.now().astimezone(UTC).date(),
        )

    async def scroll(self) -> None:
        await self._page.evaluate("window.scrollTo(0, document.body.scrollHeight)")

    async def at_end(self) -> bool:
        end = self._page.locator(self._selectors.end)
        return bool(await end.count() and await end.is_visible())

    async def no_results_confirmed(self) -> bool:
        empty = self._page.locator(self._selectors.no_results)
        return bool(await empty.count() and await empty.is_visible())

    async def screenshot(self) -> bytes:
        return await self._page.screenshot(full_page=True)

    async def refresh(self) -> None:
        await self._page.reload(wait_until="domcontentloaded")

    async def reopen(self) -> None:
        await self._page.goto(self.source_url, wait_until="domcontentloaded")

    async def restore_checkpoint(self, checkpoint: dict[str, Any]) -> None:
        scroll_count = checkpoint.get("scroll_count", 0)
        if not isinstance(scroll_count, int) or scroll_count < 0:
            return
        for _ in range(scroll_count):
            await self.scroll()
            await self.health_check()


def _raise_for_access_text(body: str) -> None:
    normalized = " ".join(body.casefold().split())
    if any(marker in normalized for marker in _CAPTCHA_MARKERS):
        raise MetaPageHealthError("captcha")
    if any(marker in normalized for marker in _ACCESS_RESTRICTION_MARKERS):
        raise MetaPageHealthError("access_restricted")


class PlaywrightMetaPageFactory:
    """Creates isolated page objects from an already authenticated browser."""

    def __init__(
        self,
        browser: Browser,
        *,
        storage_state: Any = None,
        selectors: MetaSelectors | None = None,
        clock: Clock | None = None,
        source_url: str = "https://www.facebook.com/ads/library/",
    ) -> None:
        self._browser = browser
        self._storage_state = storage_state
        self._selectors = selectors
        self._clock = clock
        self._source_url = source_url
        self._context: BrowserContext | None = None

    async def create(self) -> PlaywrightMetaPage:
        if self._context is None:
            self._context = await self._browser.new_context(
                storage_state=self._storage_state,
                locale="en-US",
                timezone_id="America/New_York",
                service_workers="block",
            )
        page = await self._context.new_page()
        await page.goto(self._source_url, wait_until="domcontentloaded")
        from rabbit_hole.integrations.collectors.meta_live import PublicMetaPage

        page_type = (
            PlaywrightMetaPage if self._selectors is not None else PublicMetaPage
        )
        return page_type(
            page,
            selectors=self._selectors,
            clock=self._clock,
            source_url=self._source_url,
        )

    async def new_context(self) -> PlaywrightMetaPage:
        if self._context is not None:
            await self._context.close()
            self._context = None
        return await self.create()


@dataclass(slots=True)
class _QueryResult:
    ads: tuple[MetaAd, ...]
    coverage: QueryCoverage


class MetaCollector:
    """Collect complete Meta query coverage with checkpointed recovery."""

    checkpoint_stage = "meta_collect"

    def __init__(
        self,
        page_factory: MetaPageFactory,
        *,
        evidence_store: EvidenceWriter,
        job_repository: MetaJobRepository,
        clock: Clock | None = None,
        collector_version: str = "meta-v1",
    ) -> None:
        self._page_factory = page_factory
        self._evidence_store = evidence_store
        self._jobs = job_repository
        self._clock = clock or SystemClock()
        self._collector_version = collector_version

    async def collect(
        self,
        query: MetaQuery,
        *,
        job_id: UUID,
        record_id: str,
        worker: str,
        lease_token: UUID | None,
        attempt: int = 1,
        manage_retries: bool = True,
        checkpoint_scope: str | None = None,
    ) -> CollectorResult[SearchBatchResult]:
        if checkpoint_scope is not None:
            if re.fullmatch(r"research_meta_[0-9]", checkpoint_scope) is None:
                raise ValueError("invalid Meta checkpoint scope")
            scoped = copy(self)
            scoped.checkpoint_stage = f"meta_collect:{checkpoint_scope}"
            return await scoped.collect(
                query,
                job_id=job_id,
                record_id=record_id,
                worker=worker,
                lease_token=lease_token,
                attempt=attempt,
                manage_retries=manage_retries,
            )
        if attempt < 1 or attempt > 6:
            raise ValueError("Meta attempt must be in 1..6")
        recovery_checkpoint = await self._jobs.get_checkpoint(
            job_id, self.checkpoint_stage
        )
        durable_attempt = _checkpoint_int(recovery_checkpoint, "recovery_attempt")
        if durable_attempt > 6:
            durable_attempt = 0
        effective_attempt = max(attempt, durable_attempt)
        recovery_phase = _checkpoint_recovery_phase(
            recovery_checkpoint, effective_attempt
        )
        if (
            recovery_phase == "schedule_retry"
            and attempt < durable_attempt
            and durable_attempt >= 3
        ):
            pending_failure = MetaPageHealthError(
                _checkpoint_failure_detail(recovery_checkpoint)
            )
            if manage_retries:
                await self._jobs.retry(
                    job_id,
                    failure=_failure_code(pending_failure),
                    attempt=durable_attempt,
                    worker=worker,
                    lease_token=lease_token,
                )
            return _recovery_failure_result(pending_failure, durable_attempt)
        if recovery_phase == "schedule_retry":
            scheduled_failure = MetaPageHealthError(
                _checkpoint_failure_detail(recovery_checkpoint)
            )
            if durable_attempt >= 6:
                return _recovery_failure_result(scheduled_failure, durable_attempt)
            effective_attempt = max(effective_attempt, durable_attempt + 1)
            recovery_phase = None
        try:
            page = await self._page_factory.create()
        except StaleLeaseError:
            raise
        except Exception as exc:  # noqa: BLE001 -- browser startup is a source failure
            retry_attempt = 3 if effective_attempt < 4 else effective_attempt
            await self._checkpoint_unavailable_page_failure(
                query,
                exc,
                recovery_attempt=retry_attempt,
                recovery_phase="schedule_retry",
                job_id=job_id,
                worker=worker,
                lease_token=lease_token,
            )
            if manage_retries:
                await self._jobs.retry(
                    job_id,
                    failure=_failure_code(exc),
                    attempt=retry_attempt,
                    worker=worker,
                    lease_token=lease_token,
                )
            return _recovery_failure_result(exc, retry_attempt)
        if effective_attempt >= 4:
            try:
                return await self._run_once(
                    page,
                    query,
                    job_id=job_id,
                    record_id=record_id,
                    worker=worker,
                    lease_token=lease_token,
                )
            except StaleLeaseError:
                raise
            except Exception as exc:  # noqa: BLE001 -- source failures become typed
                await self._checkpoint_failure(
                    page,
                    exc,
                    recovery_attempt=effective_attempt,
                    recovery_phase="schedule_retry",
                    job_id=job_id,
                    record_id=record_id,
                    worker=worker,
                    lease_token=lease_token,
                )
                if manage_retries:
                    await self._jobs.retry(
                        job_id,
                        failure=_failure_code(exc),
                        attempt=effective_attempt,
                        worker=worker,
                        lease_token=lease_token,
                    )
                return _recovery_failure_result(exc, effective_attempt)

        if recovery_phase is None and effective_attempt > 1:
            recovery_phase = _IMMEDIATE_RECOVERY_ACTIONS[effective_attempt]
        if recovery_phase is None:
            try:
                return await self._run_once(
                    page,
                    query,
                    job_id=job_id,
                    record_id=record_id,
                    worker=worker,
                    lease_token=lease_token,
                )
            except StaleLeaseError:
                raise
            except Exception as exc:  # noqa: BLE001 -- exact recovery sequence below
                failure: Exception = exc
        else:
            failure = MetaPageHealthError(
                _checkpoint_failure_detail(recovery_checkpoint)
            )
        for recovery_attempt in range(effective_attempt, 4):
            action = _IMMEDIATE_RECOVERY_ACTIONS[recovery_attempt]
            await self._checkpoint_failure(
                page,
                failure,
                recovery_attempt=recovery_attempt,
                recovery_phase=action,
                job_id=job_id,
                record_id=record_id,
                worker=worker,
                lease_token=lease_token,
            )
            if recovery_attempt < 3 and manage_retries:
                await self._jobs.retry(
                    job_id,
                    failure=_failure_code(failure),
                    attempt=recovery_attempt,
                    worker=worker,
                    lease_token=lease_token,
                )
            try:
                if action == "refresh":
                    await page.refresh()
                elif action == "reopen":
                    await page.reopen()
                else:
                    page = await self._page_factory.new_context()
                return await self._run_once(
                    page,
                    query,
                    job_id=job_id,
                    record_id=record_id,
                    worker=worker,
                    lease_token=lease_token,
                )
            except StaleLeaseError:
                raise
            except Exception as exc:  # noqa: BLE001 -- advance exact recovery state
                failure = exc
        await self._checkpoint_failure(
            page,
            failure,
            recovery_attempt=3,
            recovery_phase="schedule_retry",
            job_id=job_id,
            record_id=record_id,
            worker=worker,
            lease_token=lease_token,
        )
        if manage_retries:
            await self._jobs.retry(
                job_id,
                failure=_failure_code(failure),
                attempt=3,
                worker=worker,
                lease_token=lease_token,
            )
        return _recovery_failure_result(failure, 3)

    async def _run_once(
        self,
        page: MetaPage,
        query: MetaQuery,
        *,
        job_id: UUID,
        record_id: str,
        worker: str,
        lease_token: UUID | None,
    ) -> CollectorResult[SearchBatchResult]:
        checkpoint = await self._jobs.get_checkpoint(job_id, self.checkpoint_stage)
        prior_ads, prior_coverage, start_index = _resume_values(checkpoint)
        all_ads: dict[str, MetaAd] = {item.ad_id: item for item in prior_ads}
        coverage = list(prior_coverage)
        batch_started_at = _checkpoint_datetime(checkpoint, "batch_started_at")
        if batch_started_at is None:
            batch_started_at = self._clock.now().astimezone(UTC)
        if any(item.truncated for item in coverage):
            start_index = len(query.actual_queries)
        for query_index in range(start_index, len(query.actual_queries)):
            actual_query = query.actual_queries[query_index]
            seed = (
                _checkpoint_ads(checkpoint, "current_ads")
                if checkpoint
                and checkpoint.get("actual_query") == actual_query
                and query_index == start_index
                else ()
            )
            query_result = await self._collect_query(
                page,
                query,
                actual_query,
                query_index=query_index,
                seed=seed,
                completed_ads=tuple(all_ads.values()),
                completed_coverage=tuple(coverage),
                batch_started_at=batch_started_at,
                checkpoint=checkpoint,
                job_id=job_id,
                record_id=record_id,
                worker=worker,
                lease_token=lease_token,
            )
            for item in query_result.ads:
                all_ads.setdefault(item.ad_id, item)
            coverage.append(query_result.coverage)
            checkpoint = None
            if query_result.coverage.truncated:
                break
        if not all_ads and (
            not coverage or any(item.stop_reason != "no_results" for item in coverage)
        ):
            raise MetaPageHealthError("empty_results")
        truncated = any(item.truncated for item in coverage)
        actual_queries = tuple(item.actual_query for item in coverage)
        competition_verified = (
            len(coverage) == len(query.actual_queries)
            and actual_queries == query.actual_queries
            and not truncated
            and all(item.relevance_verified for item in coverage)
        )
        value = SearchBatchResult(
            query=query,
            actual_queries=actual_queries,
            ads=tuple(all_ads.values()),
            coverage=tuple(coverage),
            collected_at=self._clock.now().astimezone(UTC),
            truncated=truncated,
            competition_verified=competition_verified,
        )
        if not all_ads:
            return CollectorResult(
                error=CollectorError(
                    code="no_results",
                    detail="Meta explicitly displayed no results; product evidence remains unavailable",
                    retriable=False,
                    source="meta-ad-library",
                ),
                evidence={
                    f"empty-page-{index}-{position}": reference
                    for index, item in enumerate(coverage)
                    for position, reference in enumerate(item.screenshot_evidence_ids)
                },
            )
        return CollectorResult.success(value)

    async def _collect_query(
        self,
        page: MetaPage,
        query: MetaQuery,
        actual_query: str,
        *,
        query_index: int,
        seed: tuple[MetaAd, ...],
        completed_ads: tuple[MetaAd, ...],
        completed_coverage: tuple[QueryCoverage, ...],
        batch_started_at: datetime,
        checkpoint: dict[str, Any] | None,
        job_id: UUID,
        record_id: str,
        worker: str,
        lease_token: UUID | None,
    ) -> _QueryResult:
        query_checkpoint = (
            checkpoint
            if checkpoint and checkpoint.get("actual_query") == actual_query
            else None
        )
        expected_filters = {
            "market": "US",
            "status": "active",
            "media_type": "video",
            "search_mode": "exact_phrase",
            "query": actual_query,
        }
        for name, value in expected_filters.items():
            await page.apply_filter(name, value)
            await page.health_check()
        displayed = await page.displayed_filters()
        if displayed != expected_filters:
            raise MetaPageHealthError("displayed_filters_mismatch")
        if query_checkpoint is not None:
            await page.restore_checkpoint(query_checkpoint)
            await page.health_check()
        seen = {item.ad_id: item for item in seed}
        completed_ad_ids = {item.ad_id for item in completed_ads}
        screenshot_ids = list(
            _checkpoint_strings(query_checkpoint, "current_screenshot_evidence_ids")
            if query_checkpoint is not None
            else ()
        )
        scroll_count = _checkpoint_int(query_checkpoint, "scroll_count")
        no_new_scrolls = _checkpoint_int(query_checkpoint, "no_new_scrolls")
        batch_index = _checkpoint_int(query_checkpoint, "batch_index")
        started_at = _checkpoint_datetime(query_checkpoint, "query_started_at")
        if started_at is None:
            started_at = self._clock.now().astimezone(UTC)
        while True:
            batch = await page.read_batch(query=actual_query)
            before = len(seen)
            for item in batch:
                if item.ad_id in seen or item.ad_id in completed_ad_ids:
                    seen.setdefault(item.ad_id, item)
                    continue
                if len(completed_ad_ids | seen.keys()) >= query.max_ads:
                    break
                seen[item.ad_id] = item
            if scroll_count > 0:
                no_new_scrolls = no_new_scrolls + 1 if len(seen) == before else 0
            elapsed = (
                self._clock.now().astimezone(UTC) - batch_started_at
            ).total_seconds()
            stop_reason: str | None = None
            truncated = False
            no_results_confirmed = not seen and await page.no_results_confirmed()
            if len(completed_ad_ids | seen.keys()) >= query.max_ads:
                stop_reason = "count_limit"
                truncated = True
            elif elapsed >= query.time_limit_seconds:
                stop_reason = "time_limit"
                truncated = True
            elif no_results_confirmed:
                stop_reason = "no_results"
            elif await page.at_end():
                stop_reason = "page_end"
            elif no_new_scrolls >= query.no_new_scroll_limit:
                stop_reason = "no_new_ads_3_scrolls"
            partial_truncation = bool(completed_ads) and truncated
            if (
                not seen
                and stop_reason is not None
                and stop_reason != "no_results"
                and not partial_truncation
            ):
                raise MetaPageHealthError("empty_results")
            query_coverage = (
                QueryCoverage(
                    actual_query=actual_query,
                    displayed_filters=displayed,
                    result_count=len(seen),
                    scroll_count=scroll_count,
                    stop_reason=cast(Any, stop_reason),
                    truncated=truncated,
                    relevance_verified=(
                        stop_reason == "no_results"
                        or (
                            bool(seen)
                            and all(item.relevance_verified for item in seen.values())
                        )
                    ),
                    screenshot_evidence_ids=(*screenshot_ids, "pending"),
                )
                if stop_reason is not None
                else None
            )
            batch_index += 1
            evidence_id = await self._save_batch(
                page,
                query_index=query_index,
                actual_query=actual_query,
                displayed=displayed,
                current_ads=tuple(seen.values()),
                completed_ads=completed_ads,
                completed_coverage=completed_coverage,
                current_screenshot_ids=tuple(screenshot_ids),
                query_coverage=query_coverage,
                scroll_count=scroll_count,
                no_new_scrolls=no_new_scrolls,
                batch_index=batch_index,
                batch_started_at=batch_started_at,
                query_started_at=started_at,
                job_id=job_id,
                record_id=record_id,
                worker=worker,
                lease_token=lease_token,
            )
            screenshot_ids.append(evidence_id)
            if query_coverage is not None:
                query_coverage = query_coverage.model_copy(
                    update={"screenshot_evidence_ids": tuple(screenshot_ids)}
                )
                return _QueryResult(tuple(seen.values()), query_coverage)
            await page.scroll()
            scroll_count += 1
            await page.health_check()

    async def _save_batch(
        self,
        page: MetaPage,
        *,
        query_index: int,
        actual_query: str,
        displayed: dict[str, str],
        current_ads: tuple[MetaAd, ...],
        completed_ads: tuple[MetaAd, ...],
        completed_coverage: tuple[QueryCoverage, ...],
        current_screenshot_ids: tuple[str, ...],
        query_coverage: QueryCoverage | None,
        scroll_count: int,
        no_new_scrolls: int,
        batch_index: int,
        batch_started_at: datetime,
        query_started_at: datetime,
        job_id: UUID,
        record_id: str,
        worker: str,
        lease_token: UUID | None,
    ) -> str:
        screenshot = await page.screenshot()
        collected_at = self._clock.now().astimezone(UTC)
        saved = self._evidence_store.put(
            market="US",
            record_id=record_id,
            collected_at=collected_at,
            raw=screenshot,
            source_url=page.source_url,
            content_type="image/png",
        )
        coverage = list(completed_coverage)
        if query_coverage is not None:
            coverage.append(
                query_coverage.model_copy(
                    update={
                        "screenshot_evidence_ids": (
                            *query_coverage.screenshot_evidence_ids[:-1],
                            saved.object_id,
                        )
                    }
                )
            )
        next_query_index = query_index + (1 if query_coverage is not None else 0)
        previous = await self._jobs.get_checkpoint(job_id, self.checkpoint_stage) or {}
        data: dict[str, Any] = {
            "recovery_events": previous.get("recovery_events", []),
            "actual_query_index": next_query_index,
            "actual_query": actual_query,
            "displayed_filters": displayed,
            "seen_ad_ids": list(dict.fromkeys(item.ad_id for item in current_ads)),
            "current_ads": [item.model_dump(mode="json") for item in current_ads],
            "current_screenshot_evidence_ids": [
                *current_screenshot_ids,
                saved.object_id,
            ],
            "ads": [
                item.model_dump(mode="json")
                for item in _unique_ads((*completed_ads, *current_ads))
            ],
            "coverage": [item.model_dump(mode="json") for item in coverage],
            "scroll_count": scroll_count,
            "no_new_scrolls": no_new_scrolls,
            "batch_index": batch_index,
            "batch_started_at": batch_started_at.isoformat(),
            "query_started_at": query_started_at.isoformat(),
            "screenshot_evidence_id": saved.object_id,
            "collector_version": self._collector_version,
        }
        await self._jobs.checkpoint(
            job_id,
            self.checkpoint_stage,
            data,
            worker=worker,
            lease_token=lease_token,
        )
        return saved.object_id

    async def _checkpoint_failure(
        self,
        page: MetaPage,
        failure: Exception,
        *,
        recovery_attempt: int,
        recovery_phase: str,
        job_id: UUID,
        record_id: str,
        worker: str,
        lease_token: UUID | None,
    ) -> None:
        prior = await self._jobs.get_checkpoint(job_id, self.checkpoint_stage) or {}
        events = list(prior.get("recovery_events", []))
        event = {
            "attempt": recovery_attempt,
            "action": recovery_phase,
            "failure_code": _failure_code(failure),
        }
        if event not in events:
            events.append(event)
        prior_query = prior.get("actual_query")
        try:
            displayed = await page.displayed_filters()
        except Exception:  # noqa: BLE001 -- preserve the original page failure
            displayed = {}
        actual_query = displayed.get("query")
        if not actual_query and isinstance(prior.get("actual_query"), str):
            actual_query = prior["actual_query"]
        checkpoint_base = dict(prior)
        if (
            isinstance(actual_query, str)
            and isinstance(prior_query, str)
            and actual_query != prior_query
        ):
            checkpoint_base.update(
                {
                    "current_ads": [],
                    "current_screenshot_evidence_ids": [],
                    "seen_ad_ids": [],
                    "scroll_count": 0,
                    "no_new_scrolls": 0,
                    "batch_index": 0,
                    "query_started_at": self._clock.now().astimezone(UTC).isoformat(),
                }
            )
        seen_ad_ids = checkpoint_base.get("seen_ad_ids")
        if not isinstance(seen_ad_ids, list) or not all(
            isinstance(item, str) for item in seen_ad_ids
        ):
            seen_ad_ids = []
        scroll_count = _checkpoint_int(checkpoint_base, "scroll_count")
        screenshot_evidence_id: str | None = None
        screenshot_error: str | None = None
        try:
            screenshot = await page.screenshot()
            saved = self._evidence_store.put(
                market="US",
                record_id=record_id,
                collected_at=self._clock.now().astimezone(UTC),
                raw=screenshot,
                source_url=page.source_url,
                content_type="image/png",
            )
            screenshot_evidence_id = saved.object_id
        except Exception as exc:  # noqa: BLE001 -- a closed page cannot be captured
            screenshot_error = _failure_code(exc)
        await self._jobs.checkpoint(
            job_id,
            self.checkpoint_stage,
            {
                **checkpoint_base,
                "recovery_events": events,
                "actual_query": actual_query,
                "displayed_filters": displayed,
                "result_position": {
                    "seen_ad_ids": seen_ad_ids,
                    "scroll_count": scroll_count,
                },
                "failure_code": _failure_code(failure),
                "failure_screenshot_evidence_id": screenshot_evidence_id,
                "failure_screenshot_error": screenshot_error,
                "recovery_attempt": recovery_attempt,
                "recovery_phase": recovery_phase,
                "collector_version": self._collector_version,
            },
            worker=worker,
            lease_token=lease_token,
        )

    async def _checkpoint_unavailable_page_failure(
        self,
        query: MetaQuery,
        failure: Exception,
        *,
        recovery_attempt: int,
        recovery_phase: str,
        job_id: UUID,
        worker: str,
        lease_token: UUID | None,
    ) -> None:
        prior = await self._jobs.get_checkpoint(job_id, self.checkpoint_stage) or {}
        actual_query = prior.get("actual_query")
        if not isinstance(actual_query, str) or not actual_query:
            actual_query = query.actual_queries[0]
        await self._jobs.checkpoint(
            job_id,
            self.checkpoint_stage,
            {
                **prior,
                "actual_query": actual_query,
                "result_position": {
                    "seen_ad_ids": list(_checkpoint_strings(prior, "seen_ad_ids")),
                    "scroll_count": _checkpoint_int(prior, "scroll_count"),
                },
                "failure_code": _failure_code(failure),
                "failure_screenshot_evidence_id": None,
                "failure_screenshot_error": "page unavailable before screenshot",
                "recovery_attempt": recovery_attempt,
                "recovery_phase": recovery_phase,
                "collector_version": self._collector_version,
            },
            worker=worker,
            lease_token=lease_token,
        )


def _checkpoint_recovery_phase(
    checkpoint: Mapping[str, Any] | None, recovery_attempt: int
) -> str | None:
    if _checkpoint_int(checkpoint, "recovery_attempt") != recovery_attempt:
        return None
    value = checkpoint.get("recovery_phase") if checkpoint else None
    return value if isinstance(value, str) and value in _RECOVERY_PHASES else None


def _checkpoint_failure_detail(checkpoint: Mapping[str, Any] | None) -> str:
    value = checkpoint.get("failure_code") if checkpoint else None
    return value if isinstance(value, str) and value else "resume_recovery"


def _recovery_failure_result(
    failure: Exception, attempt: int
) -> CollectorResult[SearchBatchResult]:
    return CollectorResult.failure(
        CollectorError(
            code="needs_human" if attempt >= 6 else "delayed_retry",
            detail=_failure_code(failure),
            retriable=attempt < 6,
            source="meta-ad-library",
        )
    )


def _failure_code(failure: Exception) -> str:
    detail = " ".join(str(failure).split())
    if not detail:
        return type(failure).__name__
    return detail[:200]


def _checkpoint_ads(
    checkpoint: Mapping[str, Any] | None, key: str
) -> tuple[MetaAd, ...]:
    if not checkpoint:
        return ()
    value = checkpoint.get(key)
    if not isinstance(value, list):
        return ()
    result: list[MetaAd] = []
    for item in value:
        try:
            result.append(MetaAd.model_validate(item))
        except Exception:  # noqa: BLE001 -- malformed recovery data fails closed
            return ()
    return tuple(result)


def _resume_values(
    checkpoint: Mapping[str, Any] | None,
) -> tuple[tuple[MetaAd, ...], tuple[QueryCoverage, ...], int]:
    ads = _checkpoint_ads(checkpoint, "ads")
    coverage: list[QueryCoverage] = []
    if checkpoint and isinstance(checkpoint.get("coverage"), list):
        for item in checkpoint["coverage"]:
            try:
                coverage.append(QueryCoverage.model_validate(item))
            except Exception:  # noqa: BLE001 -- malformed recovery data fails closed
                return (), (), 0
    start = _checkpoint_int(checkpoint, "actual_query_index")
    return ads, tuple(coverage), max(0, start)


def _checkpoint_int(checkpoint: Mapping[str, Any] | None, key: str) -> int:
    if not checkpoint:
        return 0
    value = checkpoint.get(key)
    return value if isinstance(value, int) and value >= 0 else 0


def _checkpoint_strings(
    checkpoint: Mapping[str, Any] | None, key: str
) -> tuple[str, ...]:
    if not checkpoint:
        return ()
    value = checkpoint.get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return ()
    return tuple(value)


def _checkpoint_datetime(
    checkpoint: Mapping[str, Any] | None, key: str
) -> datetime | None:
    if not checkpoint:
        return None
    value = checkpoint.get(key)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(UTC)


def _unique_ads(ads: Sequence[MetaAd]) -> tuple[MetaAd, ...]:
    return tuple({item.ad_id: item for item in ads}.values())
