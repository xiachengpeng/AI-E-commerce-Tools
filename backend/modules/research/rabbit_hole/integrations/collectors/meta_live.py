"""Public Ad Library DOM adapter, grounded in the rendered English/Chinese UI.

Only observed fields are populated. Search matching does not establish product
relevance, and a video URL does not establish distinct creative fingerprints.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.async_api import TimeoutError as BrowserTimeout

from rabbit_hole.domain.markets import MARKETS, region_labels
from rabbit_hole.integrations.collectors.meta import (
    MetaAd,
    MetaPageHealthError,
    PlaywrightMetaPage,
    _exact_phrase,
    _raise_for_access_text,
)

CONTENT = "._7jyh"
EMPTY = re.compile(
    r"No ads found|No results found|未找到广告|没有找到.*广告", re.IGNORECASE
)

CARD_DOM = r"""nodes => nodes.map(content => {
    const idPattern = /(?:Library ID\s*:\s*|资料库编号[：:]\s*)(\d+)/g;
    let card = content;
    while (card.parentElement) {
        const ids = [...(card.innerText || '').matchAll(idPattern)];
        if (ids.length === 1) break;
        if (ids.length > 1) return null;
        card = card.parentElement;
    }
    const ids = [...(card.innerText || '').matchAll(idPattern)];
    if (ids.length !== 1) return null;
    const links = [...content.querySelectorAll('a[href]')];
    const advertiser = links.find(a => {
        try { return ['www.facebook.com', 'facebook.com'].includes(new URL(a.href).hostname); }
        catch { return false; }
    });
    const landing = links.find(a => a.href.startsWith('https://l.facebook.com/l.php?'));
    const text = content.querySelector('[role="button"]');
    const video = content.querySelector('video');
    const candidate = video?.currentSrc || video?.src || video?.querySelector('source')?.src || '';
    let media = '';
    try { const u = new URL(candidate); if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) media = u.href; } catch {}
    return {ad_id: ids[0][1], text: card.innerText, media_url: media,
        advertiser: advertiser?.innerText || '', advertiser_url: advertiser?.href || '',
        primary_text: text?.innerText || '', landing_url: landing?.href || ''};
}).filter(Boolean)"""


def _start_date(text: str) -> date | None:
    chinese = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日开始投放", text)
    try:
        if chinese:
            return date(*(int(v) for v in chinese.groups()))
        english = re.search(r"Started running on (\w+ \d{1,2}, \d{4})", text)
        if english:
            for fmt in ("%b %d, %Y", "%B %d, %Y"):
                try:
                    return datetime.strptime(english[1], fmt).replace(tzinfo=UTC).date()
                except ValueError:
                    continue
    except ValueError:
        pass
    return None


class PublicMetaPage(PlaywrightMetaPage):
    """Apply a bounded public search URL, then verify its rendered filter state."""

    _market = "US"

    async def apply_filter(self, name: str, value: str) -> None:
        if name == "market":
            if value not in MARKETS:
                raise MetaPageHealthError("unsupported_filter:market")
            self._market = value
        allowed = {
            "market": self._market,
            "status": "active",
            "media_type": "video",
            "search_mode": "exact_phrase",
        }
        if name != "query":
            if allowed.get(name) != value:
                raise MetaPageHealthError(f"unsupported_filter:{name}")
            self._displayed.clear()
            return
        if not value.strip('"').strip():
            raise MetaPageHealthError("empty_query")
        query = (
            value
            if value.startswith('"') and value.endswith('"')
            else _exact_phrase(value)
        )
        self.source_url = "https://www.facebook.com/ads/library/?" + urlencode(
            {
                "active_status": "active",
                "ad_type": "all",
                "country": self._market,
                "media_type": "video",
                "q": query,
                "search_type": "keyword_exact_phrase",
            }
        )
        await self._page.goto(
            self.source_url, wait_until="domcontentloaded", timeout=30_000
        )
        await (
            self._page.locator(CONTENT)
            .or_(self._page.get_by_text(EMPTY))
            .first.wait_for(state="visible", timeout=30_000)
        )
        self._displayed = {**allowed, "query": query}
        await self.health_check()

    async def health_check(self) -> None:
        # Filter application is assembled before navigating when query arrives.
        if not self._displayed:
            return
        body = await self._page.locator("body").inner_text()
        _raise_for_access_text(body)
        compact = re.sub(r"[\s\u200b]+", "", body)
        controls = await self._page.get_by_role("combobox").all_text_contents()
        market = any(
            re.sub(r"[\s\u200b]+", "", c).casefold() in region_labels(self._market) for c in controls
        )
        category = any(
            re.sub(r"[\s\u200b]+", "", c) in {"所有广告", "Allads"} for c in controls
        )
        search = await self._page.get_by_role("searchbox").input_value()
        actual = dict(parse_qs(urlsplit(self._page.url).query))
        expected_query = self._displayed["query"]
        if not (
            market
            and category
            and search == expected_query
            and actual.get("q") == [expected_query]
            and actual.get("search_type") == ["keyword_exact_phrase"]
            and actual.get("media_type") == ["video"]
            and actual.get("active_status") == ["active"]
            and actual.get("country") == [self._market]
            and actual.get("ad_type") == ["all"]
            and ("正在投放的广告" in compact or "Activeads" in compact)
            and (
                "素材类型：视频" in compact
                or "Mediatype:Videos" in compact
                or "Mediatype:Video" in compact
            )
            and ("精准匹配" in compact or "exactphrase" in compact.lower())
        ):
            raise MetaPageHealthError("displayed_filters_mismatch")
        if (
            not await self._page.locator(CONTENT).count()
            and not await self.no_results_confirmed()
        ):
            raise MetaPageHealthError("missing_results")

    async def read_batch(self, *, query: str) -> tuple[MetaAd, ...]:
        await self.health_check()
        rows = await self._page.locator(CONTENT).evaluate_all(CARD_DOM)
        ads: dict[str, MetaAd] = {}
        observed_at = self._clock.now().astimezone(UTC)
        today = observed_at.date()
        for row in rows:
            started = _start_date(row["text"])
            active = bool(re.search(r"\bActive\b|投放中", row["text"]))
            target = parse_qs(urlsplit(row["landing_url"]).query).get("u", [None])[0]
            if target and urlsplit(target).scheme not in {"http", "https"}:
                target = None
            page_id = urlsplit(row["advertiser_url"]).path.strip("/")
            ads[row["ad_id"]] = MetaAd(
                ad_id=row["ad_id"],
                advertiser=row["advertiser"],
                page_id=page_id if page_id.isdigit() else None,
                start_date=started,
                is_active=active,
                observable_active_days=max(0, (today - started).days)
                if active and started
                else None,
                observed_at=observed_at,
                primary_text=row["primary_text"],
                landing_url=target,
                media_url=row.get("media_url") or None,
                query=query.strip('"').replace(r"\"", '"'),
            )
        if not ads and not await self.no_results_confirmed():
            raise MetaPageHealthError("unrecognized_ad_cards")
        return tuple(ads.values())

    async def no_results_confirmed(self) -> bool:
        return await self._page.get_by_text(EMPTY).first.is_visible()

    async def at_end(self) -> bool:
        # Absence of a load-more button is not proof of complete coverage.
        return False

    async def scroll(self) -> None:
        before = await self._page.locator(CONTENT).count()
        more = self._page.get_by_role(
            "button", name=re.compile(r"^(显示更多|See more|Show more)$", re.IGNORECASE)
        )
        if await more.count() and await more.first.is_visible():
            await more.first.click()
        else:
            await super().scroll()
        # Wait for newly rendered cards, bounded without misreporting completeness.
        try:
            await self._page.wait_for_function(
                "([selector, count]) => document.querySelectorAll(selector).length > count",
                arg=[CONTENT, before],
                timeout=5000,
            )
        except BrowserTimeout:
            pass
