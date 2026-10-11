from __future__ import annotations

import gzip
import inspect
import socket

import httpx
import pytest

from rabbit_hole.input_urls import canonical_research_url
from rabbit_hole.security import BrowserValidationProxy, SafeUrlClient, UnsafeUrl


def public_resolver(host: str, port: int) -> list[str]:
    assert host in {"public.example", "redirect.example"}
    assert port in {80, 443}
    return ["93.184.216.34"]


def test_research_url_preserves_product_identity_but_removes_credentials() -> None:
    assert (
        canonical_research_url(
            "https://shop.example/?p=123&utm_source=meta&token=SYNTHETIC_BEARER"
            "&X-Amz-Signature=SYNTHETIC_SIGNATURE"
        )
        == "https://shop.example/?p=123"
    )


@pytest.fixture
def safe_client() -> SafeUrlClient:
    return SafeUrlClient(resolver=public_resolver)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/x",
        "http://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
    ],
)
async def test_private_and_non_http_urls_are_blocked(
    url: str, safe_client: SafeUrlClient
) -> None:
    with pytest.raises(UnsafeUrl):
        await safe_client.get(url)


async def test_redirect_target_is_revalidated(safe_client: SafeUrlClient) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "93.184.216.34":
            return httpx.Response(302, headers={"Location": "http://10.0.0.1/x"})
        raise AssertionError(f"unexpected request: {request.url}")

    client = SafeUrlClient(
        resolver=public_resolver,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(UnsafeUrl):
        await client.get("https://public.example/start")


async def test_request_is_connected_to_a_resolved_public_ip() -> None:
    connected_to: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        connected_to.append(request.url.host)
        assert request.headers["host"] == "public.example"
        return httpx.Response(200, text="ok")

    client = SafeUrlClient(
        resolver=public_resolver,
        transport=httpx.MockTransport(handler),
    )
    response = await client.get("https://public.example/product")
    assert response.text == "ok"
    assert connected_to == ["93.184.216.34"]


async def test_redirect_hosts_with_the_same_ip_use_separate_transport_pools() -> None:
    created_for: list[str] = []

    def transport_factory(host: str) -> httpx.AsyncBaseTransport:
        created_for.append(host)

        def handler(request: httpx.Request) -> httpx.Response:
            if request.headers["host"] == "public.example":
                return httpx.Response(
                    302, headers={"Location": "https://redirect.example/final"}
                )
            return httpx.Response(200, text="ok")

        return httpx.MockTransport(handler)

    client = SafeUrlClient(
        resolver=public_resolver, transport_factory=transport_factory
    )
    response = await client.get("https://public.example/start")

    assert response.text == "ok"
    assert created_for == ["public.example", "redirect.example"]


def test_production_browser_proxy_connector_cannot_be_replaced() -> None:
    assert set(inspect.signature(BrowserValidationProxy).parameters) == {"client"}
    with pytest.raises(TypeError):
        BrowserValidationProxy(SafeUrlClient(), connector=object())  # type: ignore[call-arg]


def test_resolver_adapter_filters_socket_records() -> None:
    records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
    assert SafeUrlClient.addresses_from_getaddrinfo(records) == ["93.184.216.34"]


@pytest.mark.parametrize("address", ["::ffff:127.0.0.1", "224.0.0.1", "0.0.0.0", "::"])
def test_mapped_multicast_and_non_unicast_addresses_are_blocked(address: str) -> None:
    with pytest.raises(UnsafeUrl):
        SafeUrlClient._validate_address(address)


async def test_compressed_response_is_limited_after_decoding() -> None:
    compressed = gzip.compress(b"x" * (10 * 1024 * 1024 + 1))
    client = SafeUrlClient(
        resolver=public_resolver,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, content=compressed, headers={"Content-Encoding": "gzip"}
            )
        ),
    )
    with pytest.raises(Exception, match="10 MiB"):
        await client.get("https://public.example/compressed")
