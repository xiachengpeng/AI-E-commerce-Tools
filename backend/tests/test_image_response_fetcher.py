import base64

import httpx
import pytest

from services.image_response_fetcher import fetch_public_image


TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe"
    "AAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/image.png",
        "http://10.0.0.8/image.png",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/image.png",
        "file:///tmp/image.png",
        "https://user:pass@example.com/image.png",
    ],
)
async def test_fetch_public_image_rejects_non_public_targets_before_request(
    url,
):
    calls = []

    async def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=TINY_PNG)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(ValueError, match="公网"):
            await fetch_public_image(url, client, timeout_seconds=5)

    assert calls == []


@pytest.mark.asyncio
async def test_fetch_public_image_validates_each_redirect_target():
    resolved = []

    async def resolver(host):
        resolved.append(host)
        return ["93.184.216.34"]

    async def handler(request):
        if request.url.host == "images.example.com":
            return httpx.Response(
                302,
                headers={"location": "https://cdn.example.com/final.png"},
            )
        return httpx.Response(
            200,
            headers={"content-type": "image/png"},
            content=TINY_PNG,
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        image = await fetch_public_image(
            "https://images.example.com/start.png",
            client,
            timeout_seconds=5,
            resolver=resolver,
        )

    assert resolved == ["images.example.com", "cdn.example.com"]
    assert image.data == TINY_PNG
    assert image.mime_type == "image/png"


@pytest.mark.asyncio
async def test_fetch_public_image_rejects_private_redirect():
    async def resolver(host):
        return ["93.184.216.34"]

    async def handler(request):
        return httpx.Response(
            302,
            headers={"location": "http://127.0.0.1/private.png"},
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(ValueError, match="公网"):
            await fetch_public_image(
                "https://images.example.com/start.png",
                client,
                timeout_seconds=5,
                resolver=resolver,
            )


@pytest.mark.asyncio
async def test_fetch_public_image_limits_redirects():
    async def resolver(host):
        return ["93.184.216.34"]

    async def handler(request):
        return httpx.Response(302, headers={"location": "/again.png"})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(ValueError, match="重定向"):
            await fetch_public_image(
                "https://images.example.com/start.png",
                client,
                timeout_seconds=5,
                max_redirects=1,
                resolver=resolver,
            )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("headers", "body", "message"),
    [
        ({"content-type": "text/html"}, TINY_PNG, "图片"),
        ({"content-type": "image/png"}, b"not-an-image", "图片"),
        (
            {"content-type": "image/png", "content-length": "1000"},
            TINY_PNG,
            "大小",
        ),
        ({"content-type": "image/png"}, TINY_PNG + b"overflow", "大小"),
    ],
)
async def test_fetch_public_image_rejects_invalid_or_oversized_response(
    headers,
    body,
    message,
):
    async def resolver(host):
        return ["93.184.216.34"]

    async def handler(request):
        return httpx.Response(200, headers=headers, content=body)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(ValueError, match=message):
            await fetch_public_image(
                "https://images.example.com/image.png",
                client,
                timeout_seconds=5,
                max_bytes=len(TINY_PNG),
                resolver=resolver,
            )


@pytest.mark.asyncio
async def test_fetch_public_image_maps_network_timeout_without_url_leak():
    async def resolver(host):
        return ["93.184.216.34"]

    async def handler(request):
        raise httpx.ReadTimeout(
            "secret query https://images.example.com/a.png?token=secret",
            request=request,
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        with pytest.raises(ValueError, match="下载超时") as caught:
            await fetch_public_image(
                "https://images.example.com/a.png?token=secret",
                client,
                timeout_seconds=5,
                resolver=resolver,
            )

    assert "secret" not in str(caught.value)
