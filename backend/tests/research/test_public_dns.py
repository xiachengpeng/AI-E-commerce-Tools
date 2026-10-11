import httpx
import pytest
import respx

from rabbit_hole.security import SafeUrlClient, UnsafeUrl


@pytest.mark.asyncio
@respx.mock
async def test_public_dns_still_pins_transport_to_validated_ip():
    from rabbit_hole.security import google_public_dns

    respx.get("https://dns.google/resolve").mock(
        return_value=httpx.Response(
            200,
            json={
                "Status": 0,
                "Answer": [
                    {"type": 5, "data": "shop.example"},
                    {"type": 1, "data": "23.227.38.65"},
                ],
            },
        )
    )

    def transport(request):
        assert request.url.host == "23.227.38.65"
        assert request.headers["host"] == "public.example"
        return httpx.Response(200, text="product")

    client = SafeUrlClient(
        resolver=google_public_dns, transport=httpx.MockTransport(transport)
    )
    assert (await client.get("https://public.example/product")).text == "product"


@pytest.mark.asyncio
@respx.mock
async def test_public_dns_cannot_allow_a_mixed_private_answer():
    from rabbit_hole.security import google_public_dns

    respx.get("https://dns.google/resolve").mock(
        return_value=httpx.Response(
            200,
            json={
                "Status": 0,
                "Answer": [
                    {"type": 1, "data": "23.227.38.65"},
                    {"type": 1, "data": "127.0.0.1"},
                ],
            },
        )
    )
    with pytest.raises(UnsafeUrl, match="not publicly routable"):
        await SafeUrlClient(resolver=google_public_dns).pinned_address(
            "https://public.example"
        )
