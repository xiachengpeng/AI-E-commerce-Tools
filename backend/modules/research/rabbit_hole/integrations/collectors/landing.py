"""Landing-page collector that records directly observable page evidence."""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from hashlib import sha256
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, field_validator

from rabbit_hole.input_urls import canonical_research_url, canonical_supplier_inputs
from rabbit_hole.integrations.collectors.base import CollectorError, CollectorResult
from rabbit_hole.security import (
    BrowserValidationProxy,
    RedirectLimitExceeded,
    ResponseTooLarge,
    SafeUrlClient,
    UnsafeUrl,
)


class FunnelEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    first_screen_hook: str | None = None
    cta: str | None = None
    reviews_or_ugc: bool = False
    trust_badges: bool = False
    faq: bool = False
    shipping_quality_returns: bool = False
    bundles: bool = False
    strike_through_price: bool = False
    quantity_discount: bool = False
    email_capture: bool | None = None
    abandoned_cart: bool | None = None
    remarketing: bool | None = None


class LandingSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True)

    title: str | None = None
    price: str | None = None
    price_currency: str | None = None
    price_source: str | None = None
    price_parser_version: int = 2
    body_text: str
    json_ld: tuple[dict[str, Any], ...] = ()
    images: tuple[str, ...] = ()
    final_url: str
    requested_url: str | None = None
    http_final_url: str | None = None
    http_status_code: int | None = None
    browser_final_url: str | None = None
    browser_status_code: int | None = None
    rendering_mode: str = "http"
    redirect_chain: tuple[str, ...] = ()
    page_type: str
    content_hash: str
    funnel: FunnelEvidence
    needs_product_resolution: bool = False

    @field_validator("final_url")
    @classmethod
    def sanitize_final_url(cls, value: str) -> str:
        return canonical_research_url(value)

    @field_validator("requested_url", "http_final_url", "browser_final_url")
    @classmethod
    def sanitize_optional_url(cls, value: str | None) -> str | None:
        return canonical_research_url(value) if value else None

    @field_validator("rendering_mode")
    @classmethod
    def validate_rendering_mode(cls, value: str) -> str:
        if value not in {"http", "browser", "firecrawl"}:
            raise ValueError("rendering_mode must be http, browser or firecrawl")
        return value

    @field_validator("http_status_code", "browser_status_code", mode="before")
    @classmethod
    def validate_status_code(cls, value: Any) -> int | None:
        if value is None:
            return None
        if type(value) is not int or not 100 <= value <= 599:
            raise ValueError("status code must be an integer from 100 to 599")
        return value

    @field_validator("json_ld")
    @classmethod
    def sanitize_json_ld(
        cls, values: tuple[dict[str, Any], ...]
    ) -> tuple[dict[str, Any], ...]:
        return tuple(canonical_supplier_inputs(item)[0] for item in values)

    @field_validator("images", "redirect_chain")
    @classmethod
    def sanitize_images(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                canonical_research_url(value)
                for value in values
                if urlsplit(value).scheme in {"http", "https"}
            )
        )


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.paragraphs: list[str] = []
        self._paragraph: list[str] = []
        self.buttons: list[str] = []
        self._button: list[str] = []
        self.images: list[str] = []
        self.main_images: list[str] = []
        self.gallery_images: list[str] = []
        self.og_images: list[str] = []
        self.regions: list[tuple[str, str]] = []
        self._paragraph_allowed = True
        self.links: list[str] = []
        self.json_scripts: list[str] = []
        self._script: list[str] = []
        self._is_json_script = False
        self.has_strike = False
        self.price_meta: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"s", "del"}:
            self.has_strike = True
        attributes = dict(attrs)
        if tag == "meta":
            key = attributes.get("property") or attributes.get("name")
            field = {"og:price:amount": "amount", "product:price:amount": "amount", "og:price:currency": "currency", "product:price:currency": "currency"}.get(key)
            if field and attributes.get("content"):
                self.price_meta[field] = str(attributes["content"])
        marker = " ".join(str(attributes.get(key) or "") for key in ("class", "id", "role"))
        region = " ".join(value for _, value in self.regions) + " " + marker
        excluded = any(t in {"header", "nav", "footer", "aside"} for t, _ in self.regions) or bool(
            re.search(r"recommend|related.product|upsell|complementary|recently.viewed|account|cookie|newsletter|dialog", region, re.IGNORECASE)
        )
        if tag == "meta" and attributes.get("property") == "og:image" and attributes.get("content"):
            self.og_images.append(str(attributes["content"]))
        if tag == "img" and not excluded:
            image = attributes.get("src") or attributes.get("data-src")
            if image:
                self.images.append(str(image))
                if any(t == "main" for t, _ in self.regions):
                    self.main_images.append(str(image))
                if re.search(r"product[_-]+(?:media|image|gallery)|media-gallery|product-gallery", region, re.IGNORECASE):
                    self.gallery_images.append(str(image))
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(tag)
            self.regions.append((tag, marker))
        if tag == "a" and attributes.get("href"):
            self.links.append(str(attributes["href"]))
        if (
            tag == "script"
            and str(attributes.get("type") or "").lower() == "application/ld+json"
        ):
            self._is_json_script = True
            self._script = []
        if tag == "p":
            self._paragraph = []
            self._paragraph_allowed = not excluded
        if tag in {"button", "a"}:
            self._button = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._is_json_script:
            self.json_scripts.append("".join(self._script))
            self._is_json_script = False
        if tag == "p" and self._paragraph and self._paragraph_allowed:
            self.paragraphs.append(" ".join(self._paragraph))
        if tag in {"button", "a"} and self._button:
            self.buttons.append(" ".join(self._button))
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index] == tag:
                del self.stack[index:]
                del self.regions[index:]
                break

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if not text:
            return
        if self._is_json_script:
            self._script.append(data)
            return
        if any(
            tag in self.stack for tag in ("script", "style", "template", "noscript")
        ):
            return
        self.text_parts.append(text)
        if "title" in self.stack and "svg" not in self.stack:
            self.title_parts.append(text)
        if "p" in self.stack:
            self._paragraph.append(text)
        if "button" in self.stack or "a" in self.stack:
            self._button.append(text)


@dataclass(frozen=True, slots=True)
class BrowserRenderResult:
    html: str | bytes
    final_url: str
    status_code: int | None


_BrowserFetcher = Callable[
    [SafeUrlClient, str],
    str | bytes | BrowserRenderResult | Awaitable[str | bytes | BrowserRenderResult],
]


class _BrowserNetworkGuard:
    """CDP request validation plus aggregate encoded/decoded byte accounting."""

    popup_sandbox = (
        "sandbox allow-forms allow-modals allow-orientation-lock allow-pointer-lock "
        "allow-presentation allow-same-origin allow-scripts"
    )

    def __init__(self, session: Any, client: SafeUrlClient) -> None:
        self._session = session
        self._client = client
        self._failure: asyncio.Future[BaseException] = (
            asyncio.get_running_loop().create_future()
        )
        self._redirects: dict[str, int] = {}
        self._pending_lengths: dict[str, int] = {}
        self._encoded_bytes = 0
        self._decoded_bytes = 0

    @property
    def failure(self) -> asyncio.Future[BaseException]:
        return self._failure

    async def install(self) -> None:
        self._session.on("Fetch.requestPaused", self._request_paused)
        self._session.on("Network.requestWillBeSent", self._request_will_be_sent)
        self._session.on("Network.responseReceived", self._response_received)
        self._session.on("Network.dataReceived", self._data_received)
        self._session.on("Network.loadingFinished", self._loading_finished)
        self._session.on("Network.loadingFailed", self._loading_failed)
        await self._session.send("Network.enable")
        await self._session.send(
            "Fetch.enable",
            {
                "patterns": [
                    {"urlPattern": "*", "requestStage": "Request"},
                    {"urlPattern": "*", "requestStage": "Response"},
                ]
            },
        )

    async def _request_paused(self, event: dict[str, Any]) -> None:
        request_id = str(event["requestId"])
        if self._failure.done():
            await self._fail_request(request_id)
            return
        try:
            if "responseStatusCode" in event:
                headers = [dict(item) for item in event.get("responseHeaders", [])]
                network_id = str(event.get("networkId", request_id))
                self._record_content_length(network_id, headers)
                if self._failure.done():
                    await self._fail_request(request_id)
                    return
                response: dict[str, Any] = {"requestId": request_id}
                if event.get("resourceType") == "Document":
                    headers.append(
                        {"name": "Content-Security-Policy", "value": self.popup_sandbox}
                    )
                    response.update(
                        responseCode=int(event["responseStatusCode"]),
                        responsePhrase=str(event.get("responseStatusText", "")),
                        responseHeaders=headers,
                    )
                await self._session.send("Fetch.continueResponse", response)
                return
            await self._client.pinned_address(str(event["request"]["url"]))
            if self._failure.done():
                await self._fail_request(request_id)
                return
            await self._session.send("Fetch.continueRequest", {"requestId": request_id})
        except (UnsafeUrl, RedirectLimitExceeded, ResponseTooLarge) as exc:
            self._record_failure(exc)
            await self._fail_request(request_id)
        except Exception as exc:  # noqa: BLE001 -- CDP callback errors must reach collector boundary
            self._record_failure(exc)
            await self._fail_request(request_id)

    def _request_will_be_sent(self, event: dict[str, Any]) -> None:
        request_id = str(event["requestId"])
        redirect = event.get("redirectResponse")
        if not isinstance(redirect, dict):
            return
        self._pending_lengths.pop(request_id, None)
        self._encoded_bytes += max(0, int(float(redirect.get("encodedDataLength", 0))))
        count = self._redirects.get(request_id, 0) + 1
        self._redirects[request_id] = count
        if count > SafeUrlClient.max_redirects:
            self._record_failure(
                RedirectLimitExceeded("browser response exceeded five redirects")
            )
        self._check_encoded_budget()

    def _response_received(self, event: dict[str, Any]) -> None:
        request_id = str(event["requestId"])
        response = event.get("response", {})
        headers = response.get("headers", {}) if isinstance(response, dict) else {}
        if isinstance(headers, dict):
            self._record_content_length(
                request_id,
                [
                    {"name": str(name), "value": str(value)}
                    for name, value in headers.items()
                ],
            )

    def _record_content_length(
        self, request_id: str, headers: list[dict[str, Any]]
    ) -> None:
        content_length = next(
            (
                item.get("value")
                for item in headers
                if str(item.get("name", "")).lower() == "content-length"
            ),
            None,
        )
        if content_length is None:
            return
        try:
            length = int(str(content_length).strip())
        except ValueError:
            return
        if length < 0:
            return
        self._pending_lengths[request_id] = length
        self._check_encoded_budget()

    def _data_received(self, event: dict[str, Any]) -> None:
        self._decoded_bytes += max(0, int(event.get("dataLength", 0)))
        if self._decoded_bytes > SafeUrlClient.max_body_bytes:
            self._record_failure(
                ResponseTooLarge("browser decoded responses exceed 10 MiB aggregate")
            )

    def _loading_finished(self, event: dict[str, Any]) -> None:
        request_id = str(event["requestId"])
        self._pending_lengths.pop(request_id, None)
        self._encoded_bytes += max(0, int(float(event.get("encodedDataLength", 0))))
        self._check_encoded_budget()

    def _loading_failed(self, event: dict[str, Any]) -> None:
        self._pending_lengths.pop(str(event["requestId"]), None)

    def _check_encoded_budget(self) -> None:
        projected = self._encoded_bytes + sum(self._pending_lengths.values())
        if projected > SafeUrlClient.max_body_bytes:
            self._record_failure(
                ResponseTooLarge("browser encoded responses exceed 10 MiB aggregate")
            )

    def _record_failure(self, exc: BaseException) -> None:
        if not self._failure.done():
            self._failure.set_result(exc)

    async def _fail_request(self, request_id: str) -> None:
        try:
            await self._session.send(
                "Fetch.failRequest",
                {"requestId": request_id, "errorReason": "BlockedByClient"},
            )
        except Exception:  # noqa: BLE001,S110 -- page may close while an event callback is unwinding
            pass

    async def stop_loading(self) -> None:
        try:
            await self._session.send("Page.stopLoading")
        except Exception:  # noqa: BLE001,S110 -- browser may already have stopped the target
            pass


async def _render_with_playwright(
    client: SafeUrlClient, url: str
) -> BrowserRenderResult:
    """Render behind a pinned proxy while CDP validates every requested URL."""
    from playwright.async_api import async_playwright

    await client.pinned_address(url)
    async with (
        BrowserValidationProxy(client) as proxy,
        async_playwright() as playwright,
    ):
        browser = await playwright.chromium.launch(
            proxy={"server": proxy.url},
            args=["--proxy-bypass-list=<-loopback>"],
        )
        try:
            context = await browser.new_context(service_workers="block")
            await context.add_init_script(
                "Object.defineProperty(window, 'open', {value: () => null, configurable: false});"
            )
            page = await context.new_page()
            session = await context.new_cdp_session(page)
            guard = _BrowserNetworkGuard(session, client)
            await guard.install()
            navigation = asyncio.create_task(
                page.goto(url, wait_until="networkidle", timeout=30_000)
            )
            waiters: set[asyncio.Future[Any]] = {navigation, guard.failure}
            done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            if guard.failure in done:
                await guard.stop_loading()
                navigation.cancel()
                await asyncio.gather(navigation, return_exceptions=True)
                raise guard.failure.result()
            try:
                navigation_response = await navigation
            except Exception:
                if guard.failure.done():
                    raise guard.failure.result()
                raise
            await asyncio.sleep(0)
            if guard.failure.done():
                raise guard.failure.result()
            html = await page.content()
            final_url = page.url
            status_code = (
                int(navigation_response.status)
                if navigation_response is not None
                else None
            )
            await context.close()
            if len(html.encode("utf-8")) > SafeUrlClient.max_body_bytes:
                raise ResponseTooLarge("rendered body exceeds 10 MiB")
            return BrowserRenderResult(html, final_url, status_code)
        finally:
            await browser.close()


class LandingCollector:
    def __init__(
        self,
        client: SafeUrlClient,
        *,
        timeout_seconds: float = 30.0,
    ) -> None:
        self._client = client
        self._timeout_seconds = timeout_seconds

    async def collect(self, url: str) -> CollectorResult[LandingSnapshot]:
        try:
            async with asyncio.timeout(self._timeout_seconds):
                requested_url = canonical_research_url(url)
                response = await self._client.get(url)
                raw = response.content
                http_final_url = canonical_research_url(
                    str(response.extensions.get("safe_final_url", requested_url))
                )
                final_url = http_final_url
                browser_final_url = None
                browser_status_code = None
                rendering_mode = "http"
                if self._needs_client_rendering(raw):
                    raw, browser_final_url, browser_status_code = await self._render(
                        _render_with_playwright, self._client, final_url
                    )
                    rendering_mode = "browser"
                    if browser_final_url:
                        await self._client.pinned_address(browser_final_url)
                        final_url = canonical_research_url(browser_final_url)
                if response.status_code >= 400 or (
                    browser_status_code is not None and browser_status_code >= 400
                ):
                    status = (
                        browser_status_code
                        if browser_status_code is not None
                        and browser_status_code >= 400
                        else response.status_code
                    )
                    return CollectorResult.failure(
                        CollectorError(
                            code="http_status",
                            detail=f"landing page returned HTTP {status}",
                            source=self._safe_source(final_url),
                        )
                    )
                return CollectorResult.success(
                    self._snapshot(
                        raw,
                        final_url,
                        requested_url=requested_url,
                        http_final_url=http_final_url,
                        http_status_code=response.status_code,
                        browser_final_url=browser_final_url,
                        browser_status_code=browser_status_code,
                        rendering_mode=rendering_mode,
                        redirect_chain=tuple(
                            dict.fromkeys(
                                list(
                                    response.extensions.get(
                                        "safe_redirect_chain",
                                        (requested_url, http_final_url),
                                    )
                                )
                                + ([final_url] if final_url != http_final_url else [])
                            )
                        ),
                    )
                )
        except ResponseTooLarge as exc:
            return CollectorResult.failure(
                CollectorError(
                    code="body_too_large",
                    detail=str(exc),
                    source=self._safe_source(url),
                )
            )
        except RedirectLimitExceeded as exc:
            return CollectorResult.failure(
                CollectorError(
                    code="redirect_limit",
                    detail=str(exc),
                    retriable=False,
                    source=self._safe_source(url),
                )
            )
        except httpx.TimeoutException as exc:
            return CollectorResult.failure(
                CollectorError(
                    code="timeout", detail=str(exc), source=self._safe_source(url)
                )
            )
        except TimeoutError:
            return CollectorResult.failure(
                CollectorError(
                    code="timeout",
                    detail="collection exceeded 30 second deadline",
                    source=self._safe_source(url),
                )
            )
        except UnsafeUrl as exc:
            return CollectorResult.failure(
                CollectorError(
                    code="unsafe_url",
                    detail=str(exc),
                    retriable=False,
                    source=self._safe_source(url),
                )
            )
        except (UnicodeDecodeError, ValueError) as exc:
            return CollectorResult.failure(
                CollectorError(
                    code="parse_error",
                    detail=str(exc),
                    retriable=False,
                    source=self._safe_source(url),
                )
            )
        except Exception as exc:  # noqa: BLE001 -- collector boundary must type third-party browser failures
            return CollectorResult.failure(
                CollectorError(
                    code="network_error",
                    detail=type(exc).__name__,
                    source=self._safe_source(url),
                )
            )

    @staticmethod
    def _needs_client_rendering(raw: bytes) -> bool:
        text = raw.decode("utf-8", errors="ignore").lower()
        visible = re.sub(
            r"<(script|style)\b[^>]*>.*?</\1\s*>", "", text, flags=re.DOTALL
        )
        return "<script" in text and len(re.sub(r"<[^>]+>", "", visible).strip()) < 80

    @staticmethod
    async def _render(
        renderer: _BrowserFetcher, client: SafeUrlClient, url: str
    ) -> tuple[bytes, str | None, int | None]:
        rendered = renderer(client, url)
        if inspect.isawaitable(rendered):
            rendered = await rendered
        final_url: str | None = None
        status_code: int | None = None
        if isinstance(rendered, BrowserRenderResult):
            final_url, status_code = rendered.final_url, rendered.status_code
            rendered = rendered.html
        raw = rendered.encode() if isinstance(rendered, str) else rendered
        if len(raw) > SafeUrlClient.max_body_bytes:
            raise ResponseTooLarge("rendered body exceeds 10 MiB")
        return raw, final_url, status_code

    @staticmethod
    def _safe_source(url: str) -> str:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            return "invalid-url"
        return f"{parsed.scheme}://{parsed.hostname or ''}{(':' + str(port)) if port else ''}{parsed.path}"

    @classmethod
    def _snapshot(
        cls,
        raw: bytes,
        final_url: str,
        *,
        requested_url: str | None = None,
        http_final_url: str | None = None,
        http_status_code: int | None = None,
        browser_final_url: str | None = None,
        browser_status_code: int | None = None,
        rendering_mode: str = "http",
        redirect_chain: tuple[str, ...] = (),
    ) -> LandingSnapshot:
        text = raw.decode("utf-8", errors="strict")
        parser = _PageParser()
        parser.feed(text)
        body_text = " ".join(parser.text_parts)
        json_ld = cls._json_ld(parser.json_scripts)
        products = [item for item in json_ld if "product" in (
            [str(t).lower() for t in item.get("@type", [])] if isinstance(item.get("@type"), list)
            else [str(item.get("@type", "")).lower()])]
        matching = [item for item in products if any(
            isinstance(item.get(key), str) and urljoin(final_url, item[key]).split("#")[0].rstrip("/") == final_url.split("#")[0].rstrip("/")
            for key in ("url", "@id")
        )]
        selected = matching or (products if len(products) == 1 else [])
        product_images: list[str] = []
        for item in selected:
            images = item.get("image", [])
            for image in images if isinstance(images, list) else [images]:
                candidate = image.get("contentUrl") or image.get("url") if isinstance(image, dict) else image
                if isinstance(candidate, str):
                    product_images.append(candidate)
        # When product evidence exists, page-wide recommendation images must
        # never become the primary product gallery.
        images = product_images or parser.gallery_images
        if not images:
            images = parser.og_images or parser.main_images or ([] if products else parser.images)
        from .landing_price import observe_price
        price_evidence = observe_price(json_ld, body_text, final_url, parser.price_meta)
        price = price_evidence["amount"] if price_evidence else None
        page_type = cls._page_type(selected if products else json_ld, price, parser.links, final_url)
        funnel = cls._funnel(parser, body_text)
        return LandingSnapshot(
            title=" ".join(parser.title_parts) or None,
            price=price,
            price_currency=price_evidence.get("currency") if price_evidence else None,
            price_source=price_evidence.get("source") if price_evidence else None,
            body_text=body_text,
            json_ld=tuple(json_ld),
            images=tuple(
                dict.fromkeys(urljoin(final_url, image) for image in images)
            ),
            final_url=final_url,
            requested_url=requested_url,
            http_final_url=http_final_url,
            http_status_code=http_status_code,
            browser_final_url=browser_final_url,
            browser_status_code=browser_status_code,
            rendering_mode=rendering_mode,
            redirect_chain=redirect_chain,
            page_type=page_type,
            content_hash=sha256(raw).hexdigest(),
            funnel=funnel,
            needs_product_resolution=page_type == "category",
        )

    @staticmethod
    def _json_ld(scripts: list[str]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for script in scripts:
            try:
                parsed = json.loads(script)
            except json.JSONDecodeError:
                continue
            items = parsed if isinstance(parsed, list) else [parsed]
            result.extend(item for item in items if isinstance(item, dict))
            for item in items:
                if isinstance(item, dict) and isinstance(item.get("@graph"), list):
                    result.extend(node for node in item["@graph"][:400] if isinstance(node, dict))
        return result

    @staticmethod
    def _page_type(
        json_ld: list[dict[str, Any]], price: str | None, links: list[str], url: str
    ) -> str:
        types = {str(item.get("@type", "")).lower() for item in json_ld}
        if "/collection" in urlsplit(url).path:
            return "category"
        if "product" in types:
            return "product"
        if sum("/product" in link for link in links) > 1:
            return "category"
        if "product" in types or price is not None:
            return "product"
        return "other"

    @staticmethod
    def _funnel(parser: _PageParser, body_text: str) -> FunnelEvidence:
        normalized = body_text.lower()
        hook = next(
            (item for item in parser.paragraphs if "$" not in item and len(item) > 8
             and not re.search(r"have an account|log ?in|sign ?in|cookie|privacy policy", item, re.IGNORECASE)),
            None,
        )
        cta = next(
            (
                item
                for item in parser.buttons
                if re.search(r"add to cart|buy now|shop now", item, re.IGNORECASE)
            ),
            None,
        )
        return FunnelEvidence(
            first_screen_hook=hook,
            cta=cta,
            reviews_or_ugc=bool(
                re.search(r"review|stars?|testimonial|ugc", normalized)
            ),
            trust_badges=bool(re.search(r"secure|trusted|guarantee|badge", normalized)),
            faq="faq" in normalized,
            shipping_quality_returns=bool(
                re.search(r"shipping|returns?|quality", normalized)
            ),
            bundles=bool(re.search(r"bundle|buy \d+", normalized)),
            strike_through_price=bool(
                parser.has_strike or re.search(r"\$\d+(?:\.\d{2})?\s+\$\d+", body_text)
            ),
            quantity_discount=bool(
                re.search(r"buy \d+|\d+%\s*(off|save)|quantity", normalized)
            ),
        )
