"""SSRF-safe HTTP fetching for collector boundaries."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Callable, Sequence
from typing import Any, Self
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx


class UnsafeUrl(ValueError):
    """A URL cannot be fetched from a collector worker safely."""


class ResponseTooLarge(ValueError):
    """The remote response exceeded the collector safety limit."""


class RedirectLimitExceeded(ValueError):
    """The remote server used more redirects than the collector permits."""


Resolver = Callable[[str, int], Sequence[str]]
TransportFactory = Callable[[str], httpx.AsyncBaseTransport]


async def _open_browser_connection(
    address: str, port: int
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Open the proxy's validated upstream (private seam for process-local tests)."""
    return await asyncio.open_connection(address, port)


def google_public_dns(host: str, port: int) -> list[str]:
    """Opt-in HTTPS DNS for hosts whose system resolver returns proxy fake IPs.

    Returned addresses still traverse all SafeUrlClient address checks and
    numeric connection pinning. No private/fake-IP exceptions are introduced.
    """
    try:
        response = httpx.get(
            "https://dns.google/resolve",
            params={"name": host, "type": "A"},
            timeout=10,
            follow_redirects=False,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict) or data.get("Status") != 0:
            raise ValueError("DNS query failed")
        records = data.get("Answer", [])
        if not isinstance(records, list) or any(
            not isinstance(item, dict) for item in records
        ):
            raise ValueError("invalid DNS answers")
        answers = [str(item["data"]) for item in records if item.get("type") == 1]
        if not answers:
            raise ValueError("DNS returned no IPv4 addresses")
        return answers
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        raise UnsafeUrl("public DNS resolution failed") from exc


class SafeUrlClient:
    """Fetch HTTP URLs after pinning each hop to a validated DNS address.

    A request is sent to the resolved numeric address rather than the hostname.
    This prevents a second DNS lookup by the connection transport from being
    redirected to a rebinding address.  The original ``Host`` and SNI name are
    preserved for virtual-hosted HTTPS services.
    """

    max_redirects = 5
    max_body_bytes = 10 * 1024 * 1024
    total_timeout_seconds = 30.0

    def __init__(
        self,
        *,
        resolver: Resolver | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        transport_factory: TransportFactory | None = None,
        timeout_seconds: float = total_timeout_seconds,
    ) -> None:
        if transport is not None and transport_factory is not None:
            raise ValueError("pass transport or transport_factory, not both")
        if transport is not None and not isinstance(transport, httpx.MockTransport):
            raise ValueError(
                "network transports must be supplied by per-host transport_factory"
            )
        self._resolver = resolver or self._resolve_hostname
        self._transport = transport
        self._transport_factory = transport_factory
        self._timeout_seconds = timeout_seconds

    @staticmethod
    def addresses_from_getaddrinfo(records: Sequence[tuple[Any, ...]]) -> list[str]:
        """Extract unique numeric addresses from ``socket.getaddrinfo`` records."""
        return list(
            dict.fromkeys(str(record[4][0]) for record in records if len(record) >= 5)
        )

    @classmethod
    def _resolve_hostname(cls, host: str, port: int) -> list[str]:
        try:
            records = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise UnsafeUrl(f"unable to resolve {host!r}") from exc
        return cls.addresses_from_getaddrinfo(records)

    @staticmethod
    def _validate_address(address: str) -> None:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError as exc:
            raise UnsafeUrl("DNS resolution returned a non-IP address") from exc
        mapped = (
            isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None
        )
        if (
            mapped
            or parsed.is_multicast
            or parsed.is_unspecified
            or not parsed.is_global
        ):
            raise UnsafeUrl(f"address {address!r} is not publicly routable")

    @classmethod
    def _validate_url(cls, raw_url: str) -> tuple[str, str, int]:
        parsed = urlsplit(raw_url)
        if parsed.scheme.lower() not in {"http", "https"}:
            raise UnsafeUrl("only HTTP and HTTPS URLs are permitted")
        if not parsed.hostname or parsed.username or parsed.password:
            raise UnsafeUrl("URL must contain a plain hostname")
        try:
            port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        except ValueError as exc:
            raise UnsafeUrl("URL has an invalid port") from exc
        if port < 1 or port > 65535:
            raise UnsafeUrl("URL has an invalid port")
        return parsed.scheme.lower(), parsed.hostname, port

    async def _pinned_url(self, raw_url: str) -> tuple[str, str]:
        scheme, host, port = self._validate_url(raw_url)
        try:
            ipaddress.ip_address(host)
            addresses = [host]
        except ValueError:
            addresses = list(await asyncio.to_thread(self._resolver, host, port))
        if not addresses:
            raise UnsafeUrl(f"no address returned for {host!r}")
        # Reject an answer set containing private records too: selecting the
        # first public answer would make routing dependent on resolver order.
        for address in addresses:
            self._validate_address(address)
        address = addresses[0]
        parsed = urlsplit(raw_url)
        netloc = f"[{address}]" if ":" in address else address
        if parsed.port is not None:
            netloc = f"{netloc}:{parsed.port}"
        return urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, "")), host

    async def pinned_address(self, url: str) -> str:
        """Return a freshly resolved, validated address for a browser fallback."""
        pinned_url, _ = await self._pinned_url(url)
        address = urlsplit(pinned_url).hostname
        if address is None:  # pragma: no cover - guarded by _pinned_url
            raise UnsafeUrl("pinned URL has no address")
        return address

    async def validated_addresses(self, url: str) -> tuple[str, int, tuple[str, ...]]:
        """Resolve a URL once and return only globally routable connection targets."""
        _, host, port = self._validate_url(url)
        try:
            ipaddress.ip_address(host)
            addresses = [host]
        except ValueError:
            addresses = list(await asyncio.to_thread(self._resolver, host, port))
        if not addresses:
            raise UnsafeUrl(f"no address returned for {host!r}")
        for address in addresses:
            self._validate_address(address)
        return host, port, tuple(addresses)

    async def get(self, url: str) -> httpx.Response:
        """Fetch a URL, safely validating and pinning every redirect hop."""
        current_url = url
        redirect_chain = [url]
        redirects = 0
        timeout = httpx.Timeout(self._timeout_seconds)
        clients: dict[tuple[str, str, int], httpx.AsyncClient] = {}
        transport_hosts: dict[int, str] = {}
        try:
            async with asyncio.timeout(self._timeout_seconds):
                while True:
                    pinned_url, original_host = await self._pinned_url(current_url)
                    scheme, _, port = self._validate_url(current_url)
                    pool_key = (scheme, original_host, port)
                    client = clients.get(pool_key)
                    if client is None:
                        if self._transport_factory is not None:
                            transport = self._transport_factory(original_host)
                            owner = transport_hosts.get(id(transport))
                            if owner is not None and owner != original_host:
                                raise ValueError(
                                    "transport_factory must return a distinct transport for each hostname"
                                )
                            transport_hosts[id(transport)] = original_host
                        else:
                            transport = self._transport or httpx.AsyncHTTPTransport()
                        client = httpx.AsyncClient(
                            transport=transport, follow_redirects=False, timeout=timeout
                        )
                        clients[pool_key] = client
                    parsed = urlsplit(current_url)
                    host_header = original_host
                    if parsed.port is not None:
                        host_header = f"{host_header}:{parsed.port}"
                    request = client.build_request(
                        "GET",
                        pinned_url,
                        headers={
                            "Host": host_header,
                            "Accept": "text/html,application/xhtml+xml",
                        },
                        extensions={"sni_hostname": original_host},
                    )
                    response = await client.send(request, stream=True)
                    content_length = response.headers.get("content-length")
                    if (
                        content_length is not None
                        and int(content_length) > self.max_body_bytes
                    ):
                        await response.aclose()
                        raise ResponseTooLarge("response body exceeds 10 MiB")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(body) + len(chunk) > self.max_body_bytes:
                            await response.aclose()
                            raise ResponseTooLarge("response body exceeds 10 MiB")
                        body.extend(chunk)
                    headers = response.headers
                    status = response.status_code
                    await response.aclose()
                    if status in {301, 302, 303, 307, 308} and "location" in headers:
                        if redirects >= self.max_redirects:
                            raise RedirectLimitExceeded(
                                "response exceeded five redirects"
                            )
                        redirects += 1
                        current_url = urljoin(current_url, headers["location"])
                        redirect_chain.append(current_url)
                        continue
                    result_headers = headers.copy()
                    result_headers.pop("content-encoding", None)
                    result_headers.pop("content-length", None)
                    result = httpx.Response(
                        status,
                        headers=result_headers,
                        content=bytes(body),
                        request=request,
                    )
                    result.extensions["safe_final_url"] = current_url
                    result.extensions["safe_redirect_chain"] = tuple(redirect_chain)
                    return result
        except TimeoutError as exc:
            raise httpx.TimeoutException(
                "request exceeded 30 second total timeout"
            ) from exc
        finally:
            await asyncio.gather(*(client.aclose() for client in clients.values()))


class BrowserValidationProxy:
    """Loopback forward proxy that validates DNS and pins browser connections.

    Chromium sends cleartext HTTP requests and HTTPS ``CONNECT`` authorities
    through this proxy. Every upstream socket is opened to the exact public IP
    returned by :class:`SafeUrlClient`; HTTPS remains end-to-end, so Chromium
    still verifies the original hostname certificate and sends its SNI name.
    """

    max_header_bytes = 64 * 1024

    def __init__(self, client: SafeUrlClient) -> None:
        self._client = client
        self._server: asyncio.Server | None = None

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(
            self._handle, "127.0.0.1", 0, limit=self.max_header_bytes
        )
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    @property
    def url(self) -> str:
        if self._server is None or not self._server.sockets:
            raise RuntimeError("browser validation proxy is not running")
        port = int(self._server.sockets[0].getsockname()[1])
        return f"http://127.0.0.1:{port}"

    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        response_started = False
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            if len(head) > self.max_header_bytes:
                raise UnsafeUrl("browser request headers are too large")
            request_line, *header_lines = head[:-4].split(b"\r\n")
            parts = request_line.decode("ascii").split(" ")
            if len(parts) != 3:
                raise UnsafeUrl("browser proxy received a malformed request line")
            method, target, version = parts
            if method.upper() == "CONNECT":
                upstream_reader, upstream_writer = await self._connect_authority(target)
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
                response_started = True
                await self._tunnel(reader, writer, upstream_reader, upstream_writer)
                return
            if method.upper() != "GET":
                raise UnsafeUrl("browser proxy permits only GET requests")
            upstream_reader, upstream_writer, origin_target = await self._connect_url(
                target
            )
            filtered_headers = [
                line
                for line in header_lines
                if not line.lower().startswith((b"proxy-connection:", b"connection:"))
            ]
            upstream_writer.write(
                f"GET {origin_target} {version}\r\n".encode("ascii")
                + b"\r\n".join(filtered_headers)
                + b"\r\nConnection: close\r\n\r\n"
            )
            await upstream_writer.drain()
            response_started = True
            await self._copy(upstream_reader, writer)
            upstream_writer.close()
            await upstream_writer.wait_closed()
        except UnsafeUrl:
            if not response_started:
                await self._error_response(writer, 403, "Forbidden")
        except (asyncio.IncompleteReadError, ConnectionError, OSError, ValueError):
            if not response_started:
                await self._error_response(writer, 502, "Bad Gateway")
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass

    async def _connect_authority(
        self, authority: str
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        parsed = urlsplit(f"//{authority}")
        if not parsed.hostname or parsed.username or parsed.password or parsed.path:
            raise UnsafeUrl("browser proxy received an invalid CONNECT authority")
        try:
            _ = parsed.port or 443
        except ValueError as exc:
            raise UnsafeUrl("browser proxy received an invalid CONNECT port") from exc
        url = f"https://{authority}/"
        _, validated_port, addresses = await self._client.validated_addresses(url)
        return await _open_browser_connection(addresses[0], validated_port)

    async def _connect_url(
        self, target: str
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter, str]:
        parsed = urlsplit(target)
        if parsed.scheme.lower() != "http" or not parsed.hostname:
            raise UnsafeUrl("browser proxy received a non-HTTP forward request")
        _, port, addresses = await self._client.validated_addresses(target)
        upstream_reader, upstream_writer = await _open_browser_connection(
            addresses[0], port
        )
        origin_target = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        return upstream_reader, upstream_writer, origin_target

    @staticmethod
    async def _copy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while chunk := await reader.read(64 * 1024):
            writer.write(chunk)
            await writer.drain()

    @classmethod
    async def _tunnel(
        cls,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        upstream_reader: asyncio.StreamReader,
        upstream_writer: asyncio.StreamWriter,
    ) -> None:
        upstream_task = asyncio.create_task(cls._copy(client_reader, upstream_writer))
        downstream_task = asyncio.create_task(cls._copy(upstream_reader, client_writer))
        _, pending = await asyncio.wait(
            {upstream_task, downstream_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(upstream_task, downstream_task, return_exceptions=True)
        upstream_writer.close()
        await upstream_writer.wait_closed()

    @staticmethod
    async def _error_response(
        writer: asyncio.StreamWriter, status: int, reason: str
    ) -> None:
        body = reason.encode("ascii")
        writer.write(
            f"HTTP/1.1 {status} {reason}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode(
                "ascii"
            )
            + body
        )
        try:
            await writer.drain()
        except ConnectionError:
            pass
