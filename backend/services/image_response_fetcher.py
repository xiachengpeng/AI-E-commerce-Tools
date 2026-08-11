"""Safely download provider-returned images from public HTTP(S) URLs."""

import asyncio
import inspect
import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import httpx

from services.image_validation import MAX_IMAGE_BYTES, validate_image_payload


_REDIRECT_STATUSES = {301, 302, 303, 307, 308}


async def resolve_host_addresses(host: str) -> list[str]:
    def resolve():
        return socket.getaddrinfo(
            host,
            None,
            type=socket.SOCK_STREAM,
        )

    try:
        entries = await asyncio.to_thread(resolve)
    except OSError as exc:
        raise ValueError("图片地址无法解析") from exc
    return list({entry[4][0] for entry in entries})


async def _resolved_addresses(host: str, resolver) -> list[str]:
    result = resolver(host)
    if inspect.isawaitable(result):
        result = await result
    if not isinstance(result, (list, tuple, set)) or not result:
        raise ValueError("图片地址无法解析")
    return [str(value) for value in result]


async def _validate_public_url(url: str, resolver) -> None:
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("图片地址必须是公网 HTTP/HTTPS 地址") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise ValueError("图片地址必须是公网 HTTP/HTTPS 地址")

    try:
        literal = ipaddress.ip_address(parsed.hostname)
        addresses = [literal]
    except ValueError:
        addresses = []
        for value in await _resolved_addresses(parsed.hostname, resolver):
            try:
                addresses.append(ipaddress.ip_address(value))
            except ValueError as exc:
                raise ValueError("图片地址无法解析") from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("图片地址必须是公网地址")


async def fetch_public_image(
    url: str,
    client,
    *,
    timeout_seconds: int,
    max_redirects: int = 3,
    max_bytes: int = MAX_IMAGE_BYTES,
    resolver=resolve_host_addresses,
):
    current_url = str(url or "")
    redirects = 0

    while True:
        await _validate_public_url(current_url, resolver)
        try:
            async with client.stream(
                "GET",
                current_url,
                follow_redirects=False,
                timeout=timeout_seconds,
            ) as response:
                if response.status_code in _REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("图片响应重定向无效")
                    if redirects >= max_redirects:
                        raise ValueError("图片响应重定向次数过多")
                    current_url = urljoin(current_url, location)
                    redirects += 1
                    continue

                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    raise ValueError("图片下载请求失败") from exc

                content_type = response.headers.get(
                    "content-type", ""
                ).split(";", 1)[0].strip().lower()
                if not content_type.startswith("image/"):
                    raise ValueError("图片响应类型无效")

                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        declared_size = int(content_length)
                    except ValueError as exc:
                        raise ValueError("图片响应大小无效") from exc
                    if declared_size < 0 or declared_size > max_bytes:
                        raise ValueError("图片响应超过大小限制")

                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > max_bytes:
                        raise ValueError("图片响应超过大小限制")
        except (httpx.TimeoutException, asyncio.TimeoutError) as exc:
            raise ValueError("图片下载超时") from exc
        except httpx.RequestError as exc:
            raise ValueError("图片下载请求失败") from exc

        try:
            return validate_image_payload(
                bytes(chunks),
                content_type,
                max_bytes=max_bytes,
            )
        except ValueError as exc:
            raise ValueError("图片响应内容无效") from exc
