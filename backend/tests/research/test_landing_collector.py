from __future__ import annotations

import asyncio
import inspect
import io
import json
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from hashlib import sha256
from pathlib import Path

import httpx
import pytest

from rabbit_hole import security
from rabbit_hole.integrations.collectors import landing as landing_module
from rabbit_hole.integrations.collectors.landing import (
    LandingCollector,
    LandingSnapshot,
)
from rabbit_hole.persistence import evidence_store as storage
from rabbit_hole.persistence.evidence_store import EvidenceConflict, EvidenceStore
from rabbit_hole.security import SafeUrlClient

FIXTURES = Path(__file__).parent / "fixtures" / "landing"
PUBLIC_IP = "93.184.216.34"


HttpResponder = Callable[[str], tuple[int, dict[str, str], bytes]]


async def start_http_server(
    responder: HttpResponder,
) -> tuple[asyncio.Server, int, list[str]]:
    hits: list[str] = []

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_head = await reader.readuntil(b"\r\n\r\n")
            path = request_head.split(b" ", 2)[1].decode("ascii")
            hits.append(path)
            status, headers, body = responder(path)
            reason = {200: "OK", 302: "Found"}[status]
            response_headers = {
                "Content-Length": str(len(body)),
                "Connection": "close",
                **headers,
            }
            head = (
                f"HTTP/1.1 {status} {reason}\r\n"
                + "".join(
                    f"{name}: {value}\r\n" for name, value in response_headers.items()
                )
                + "\r\n"
            )
            writer.write(head.encode("ascii"))
            await writer.drain()
            for offset in range(0, len(body), 64 * 1024):
                writer.write(body[offset : offset + 64 * 1024])
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = int(server.sockets[0].getsockname()[1])
    return server, port, hits


def browser_client() -> SafeUrlClient:
    def browser_resolver(host: str, port: int) -> list[str]:
        if host == "public.example":
            return [PUBLIC_IP]
        if host == "localhost":
            return ["127.0.0.1"]
        return []

    return SafeUrlClient(
        resolver=browser_resolver,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, content=b"<script src='app.js'></script>"
            )
        ),
    )


def map_public_server(monkeypatch: pytest.MonkeyPatch, public_port: int) -> None:
    async def connect(
        address: str, port: int
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        assert address == PUBLIC_IP
        assert port == public_port
        return await asyncio.open_connection("127.0.0.1", public_port)

    monkeypatch.setattr(security, "_open_browser_connection", connect)


def resolver(host: str, port: int) -> list[str]:
    return ["93.184.216.34"]


def landing_client(body: bytes, *, status: int = 200) -> SafeUrlClient:
    return SafeUrlClient(
        resolver=resolver,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(status, content=body)
        ),
    )


async def test_product_page_extracts_observable_landing_evidence() -> None:
    result = await LandingCollector(
        landing_client((FIXTURES / "product.html").read_bytes())
    ).collect("https://shop.example/products/glow-lamp")
    assert result.ok
    assert isinstance(result.value, LandingSnapshot)
    page = result.value
    assert page.title == "Glow Lamp | Acme"
    assert page.price == "49.00"
    assert "Transform your desk" in page.body_text
    assert page.json_ld[0]["@type"] == "Product"
    assert "https://shop.example/hero.jpg" in page.images
    assert page.final_url == "https://shop.example/products/glow-lamp"
    assert page.page_type == "product"
    assert len(page.content_hash) == 64
    assert page.funnel.first_screen_hook == "Transform your desk in seconds."
    assert page.funnel.cta == "Add to cart"
    assert page.funnel.reviews_or_ugc is True
    assert page.funnel.faq is True
    assert page.funnel.shipping_quality_returns is True
    assert page.funnel.bundles is True
    assert page.funnel.strike_through_price is True
    assert page.funnel.quantity_discount is True
    assert page.funnel.email_capture is None
    assert page.funnel.abandoned_cart is None
    assert page.funnel.remarketing is None


async def test_category_page_requires_product_resolution() -> None:
    result = await LandingCollector(
        landing_client((FIXTURES / "category.html").read_bytes())
    ).collect("https://shop.example/collections/lamps")
    assert result.ok and result.value is not None
    assert result.value.page_type == "category"
    assert result.value.needs_product_resolution is True


async def test_priced_collection_still_requires_product_resolution() -> None:
    result = await LandingCollector(
        landing_client(
            b"<html><body><h1>Lamps</h1><p>$49.00</p><a href='/products/a'>A</a><a href='/products/b'>B</a></body></html>"
        )
    ).collect("https://shop.example/collections/lamps")
    assert result.ok and result.value is not None
    assert result.value.page_type == "category"
    assert result.value.needs_product_resolution is True


def test_landing_collector_has_no_public_browser_fetcher_escape_hatch() -> None:
    assert set(inspect.signature(LandingCollector).parameters) == {
        "client",
        "timeout_seconds",
    }
    with pytest.raises(TypeError):
        LandingCollector(landing_client(b"ok"), browser_fetcher=lambda _: b"unsafe")  # type: ignore[call-arg]


async def test_renderer_size_limit_and_unexpected_errors_are_typed_and_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def oversized(_: SafeUrlClient, __: str) -> bytes:
        return b"x" * (10 * 1024 * 1024 + 1)

    monkeypatch.setattr(
        landing_module, "_render_with_playwright", oversized, raising=False
    )
    result = await LandingCollector(
        landing_client(b"<script src='app.js'></script>")
    ).collect("https://shop.example/products/one?token=secret")
    assert result.error is not None
    assert result.error.code == "body_too_large"
    assert "secret" not in (result.error.source or "")


async def test_http_status_error_redacts_final_url_query_and_fragment() -> None:
    result = await LandingCollector(landing_client(b"missing", status=404)).collect(
        "https://shop.example/missing?token=secret#private-fragment"
    )

    assert result.error is not None
    assert result.error.code == "http_status"
    assert result.error.source == "https://shop.example/missing"
    assert "secret" not in result.model_dump_json()


async def test_client_rendering_fallback_is_used_only_for_script_shells(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def render(_: SafeUrlClient, url: str) -> str:
        calls.append(url)
        return (FIXTURES / "product.html").read_text()

    monkeypatch.setattr(
        landing_module, "_render_with_playwright", render, raising=False
    )
    result = await LandingCollector(
        landing_client(b"<html><body><script src='/app.js'></script></body></html>")
    ).collect("https://shop.example/products/glow-lamp")
    assert result.ok and result.value is not None
    assert result.value.page_type == "product"
    assert calls == ["https://shop.example/products/glow-lamp"]


async def test_script_shell_uses_module_private_renderer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def render(_: SafeUrlClient, url: str) -> bytes:
        calls.append(url)
        return (FIXTURES / "product.html").read_bytes()

    monkeypatch.setattr(
        landing_module, "_render_with_playwright", render, raising=False
    )
    result = await LandingCollector(
        landing_client(b"<html><body><script src='/app.js'></script></body></html>")
    ).collect("https://shop.example/products/glow-lamp")
    assert result.ok
    assert calls == ["https://shop.example/products/glow-lamp"]


async def test_browser_render_records_final_url_status_and_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def render(_: SafeUrlClient, __: str):
        return landing_module.BrowserRenderResult(
            (FIXTURES / "product.html").read_bytes(),
            "https://shop.example/products/final",
            200,
        )

    monkeypatch.setattr(
        landing_module, "_render_with_playwright", render, raising=False
    )
    result = await LandingCollector(
        landing_client(b"<html><body><script src='/app.js'></script></body></html>")
    ).collect("https://shop.example/products/start")
    assert result.ok and result.value is not None
    assert result.value.requested_url == "https://shop.example/products/start"
    assert result.value.http_final_url == "https://shop.example/products/start"
    assert result.value.http_status_code == 200
    assert result.value.browser_final_url == "https://shop.example/products/final"
    assert result.value.browser_status_code == 200
    assert result.value.final_url == "https://shop.example/products/final"
    assert result.value.rendering_mode == "browser"
    assert result.value.redirect_chain == (
        "https://shop.example/products/start",
        "https://shop.example/products/final",
    )


async def test_real_chromium_cdp_guard_blocks_private_redirect_before_server_hit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_server, private_port, private_hits = await start_http_server(
        lambda path: (
            200,
            {"Content-Type": "text/html"},
            b"<html><body>secret</body></html>",
        )
    )
    public_server, public_port, public_hits = await start_http_server(
        lambda path: (302, {"Location": f"http://localhost:{private_port}/secret"}, b"")
    )
    collector = LandingCollector(browser_client())
    map_public_server(monkeypatch, public_port)
    try:
        result = await collector.collect(f"http://public.example:{public_port}/start")
    finally:
        public_server.close()
        private_server.close()
        await public_server.wait_closed()
        await private_server.wait_closed()

    assert result.error is not None
    assert result.error.code == "unsafe_url"
    assert public_hits == ["/start"]
    assert private_hits == []
    assert "secret" not in result.model_dump_json()


async def test_real_chromium_rejects_more_than_five_redirects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def redirect_chain(path: str) -> tuple[int, dict[str, str], bytes]:
        step = int(path.removeprefix("/"))
        if step < 6:
            return 302, {"Location": f"/{step + 1}"}, b""
        return 200, {"Content-Type": "text/html"}, b"<html><body>too far</body></html>"

    server, port, hits = await start_http_server(redirect_chain)
    collector = LandingCollector(browser_client())
    map_public_server(monkeypatch, port)
    try:
        result = await collector.collect(f"http://public.example:{port}/0")
    finally:
        server.close()
        await server.wait_closed()

    assert result.error is not None
    assert result.error.code == "redirect_limit"
    assert hits == ["/0", "/1", "/2", "/3", "/4", "/5"]


async def test_real_chromium_caps_aggregate_encoded_subresource_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def assets(path: str) -> tuple[int, dict[str, str], bytes]:
        if path == "/page":
            return (
                200,
                {"Content-Type": "text/html"},
                b"<html><script src='/one'></script><script src='/two'></script></html>",
            )
        return (
            200,
            {
                "Content-Type": "application/javascript",
                "Content-Length": str(6 * 1024 * 1024),
            },
            b"",
        )

    server, port, hits = await start_http_server(assets)
    collector = LandingCollector(browser_client())
    map_public_server(monkeypatch, port)
    try:
        result = await collector.collect(f"http://public.example:{port}/page")
    finally:
        server.close()
        await server.wait_closed()

    assert result.error is not None
    assert result.error.code == "body_too_large"
    assert "/page" in hits and "/one" in hits and "/two" in hits


async def test_real_chromium_caps_one_large_document_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, port, _ = await start_http_server(
        lambda path: (
            200,
            {"Content-Type": "text/html", "Content-Length": str(10 * 1024 * 1024 + 1)},
            b"",
        )
    )
    collector = LandingCollector(browser_client())
    map_public_server(monkeypatch, port)
    try:
        result = await collector.collect(f"http://public.example:{port}/large")
    finally:
        server.close()
        await server.wait_closed()

    assert result.error is not None
    assert result.error.code == "body_too_large"


async def test_real_chromium_disables_popup_before_private_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_server, private_port, private_hits = await start_http_server(
        lambda path: (
            200,
            {"Content-Type": "text/html"},
            b"<html><body>PRIVATE_MARKER</body></html>",
        )
    )
    page = (
        "<html><body><p>Rendered public landing page content.</p>"
        f"<script>window.open('http://localhost:{private_port}/sensitive')</script></body></html>"
    ).encode()
    public_server, public_port, _ = await start_http_server(
        lambda path: (200, {"Content-Type": "text/html"}, page)
    )
    collector = LandingCollector(browser_client())
    map_public_server(monkeypatch, public_port)
    try:
        result = await collector.collect(f"http://public.example:{public_port}/page")
    finally:
        public_server.close()
        private_server.close()
        await public_server.wait_closed()
        await private_server.wait_closed()

    assert result.ok and result.value is not None
    assert private_hits == []
    assert "PRIVATE_MARKER" not in result.value.body_text


async def test_oversized_response_is_a_typed_collector_error() -> None:
    result = await LandingCollector(
        landing_client(b"x" * (10 * 1024 * 1024 + 1))
    ).collect("https://shop.example/products/large")
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "body_too_large"


async def test_timeout_is_a_typed_collector_error() -> None:
    def timeout(_: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("slow")

    client = SafeUrlClient(resolver=resolver, transport=httpx.MockTransport(timeout))
    result = await LandingCollector(client).collect(
        "https://shop.example/products/slow"
    )
    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "timeout"
    assert result.error.retriable is True


class FakePreconditionFailed(RuntimeError):
    def __init__(self) -> None:
        super().__init__("S3 precondition failed")
        self.response = {"ResponseMetadata": {"HTTPStatusCode": 412}}


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, object]] = {}
        self.versions: dict[str, dict[str, dict[str, object]]] = {}
        self.deleted: list[str] = []
        self.last_modified: datetime | None = None
        self.server_now: datetime | None = None
        self.versioning_status = "Enabled"
        self._lock = threading.RLock()
        self._version = 0

    def get_bucket_versioning(self, *, Bucket: str) -> dict[str, object]:
        assert Bucket == "evidence"
        return {"Status": self.versioning_status}

    def _response_metadata(self) -> dict[str, object]:
        now = (self.server_now or storage._utc_now()).astimezone(UTC)
        return {"HTTPHeaders": {"date": format_datetime(now, usegmt=True)}}

    def put_object(self, **kwargs: object) -> dict[str, str]:
        key = str(kwargs["Key"])
        with self._lock:
            existing = self.objects.get(key)
            if kwargs.get("IfNoneMatch") == "*" and existing is not None:
                raise FakePreconditionFailed()
            if "IfMatch" in kwargs and (
                existing is None or existing.get("ETag") != kwargs["IfMatch"]
            ):
                raise FakePreconditionFailed()
            self._version += 1
            etag = f'"fake-version-{self._version}"'
            version_id = f"fake-object-version-{self._version}"
            stored = {
                **kwargs,
                "ETag": etag,
                "VersionId": version_id,
                "LastModified": self.last_modified or storage._utc_now(),
            }
            self.objects[key] = stored
            self.versions.setdefault(key, {})[version_id] = stored
            return {"ETag": etag, "VersionId": version_id}

    def generate_presigned_url(
        self, operation: str, Params: dict[str, str], ExpiresIn: int
    ) -> str:
        assert operation == "get_object"
        assert ExpiresIn == 24 * 60 * 60
        return f"https://minio.test/{Params['Bucket']}/{Params['Key']}?signed=1"

    def delete_object(
        self,
        *,
        Bucket: str,
        Key: str,
        VersionId: str | None = None,
        IfMatch: str | None = None,
    ) -> None:
        assert Bucket == "evidence"
        with self._lock:
            existing = (
                self.versions.get(Key, {}).get(VersionId)
                if VersionId is not None
                else self.objects.get(Key)
            )
            if IfMatch is not None and (
                existing is None or existing.get("ETag") != IfMatch
            ):
                raise FakePreconditionFailed()
            self.deleted.append(Key)
            if VersionId is None:
                self.objects.pop(Key, None)
                self.versions.pop(Key, None)
                return
            versions = self.versions.get(Key, {})
            versions.pop(VersionId, None)
            if self.objects.get(Key) is existing:
                if versions:
                    self.objects[Key] = next(reversed(versions.values()))
                else:
                    self.objects.pop(Key, None)
                    self.versions.pop(Key, None)

    def get_object(
        self, *, Bucket: str, Key: str, VersionId: str | None = None
    ) -> dict[str, object]:
        assert Bucket == "evidence"
        with self._lock:
            stored = (
                self.versions[Key][VersionId]
                if VersionId is not None
                else self.objects[Key]
            )
            response: dict[str, object] = {"Body": io.BytesIO(stored["Body"])}
            if "ETag" in stored:
                response["ETag"] = stored["ETag"]
            if "VersionId" in stored:
                response["VersionId"] = stored["VersionId"]
            response["ResponseMetadata"] = self._response_metadata()
            return response

    def head_object(
        self, *, Bucket: str, Key: str, VersionId: str | None = None
    ) -> dict[str, object]:
        assert Bucket == "evidence"
        with self._lock:
            stored = (
                self.versions[Key][VersionId]
                if VersionId is not None
                else self.objects[Key]
            )
            return {**stored, "ResponseMetadata": self._response_metadata()}

    def list_objects_v2(
        self, *, Bucket: str, Prefix: str, ContinuationToken: str | None = None
    ) -> dict[str, object]:
        assert Bucket == "evidence"
        with self._lock:
            keys = sorted(key for key in self.objects if key.startswith(Prefix))
        start = int(ContinuationToken or "0")
        page = keys[start : start + 1]
        next_token = str(start + 1) if start + 1 < len(keys) else None
        result: dict[str, object] = {
            "Contents": [{"Key": key} for key in page],
            "IsTruncated": next_token is not None,
        }
        if next_token is not None:
            result["NextContinuationToken"] = next_token
        return result


def put_legacy_pending(
    s3: FakeS3, *, record_id: str, last_modified: datetime
) -> tuple[str, str, dict[str, object]]:
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    raw = f"legacy pending {record_id}".encode()
    digest = sha256(raw).hexdigest()
    object_id = f"evidence/US/{record_id}/20260101T000000Z/{digest}"
    manifest_key = EvidenceStore.manifest_key(object_id)
    record: dict[str, object] = {
        "object_id": object_id,
        "sha256": digest,
        "source_url": f"https://shop.example/{record_id}",
        "content_type": "text/html",
        "collected_at": collected.isoformat(),
        "retention_date": (collected + timedelta(days=180)).isoformat(),
        "collector_version": "landing-v1",
        "trust": "verified",
        "raw_deleted": False,
        "state": "pending",
    }
    s3.put_object(
        Bucket="evidence",
        Key=object_id,
        Body=raw,
        Metadata={"sha256": digest},
    )
    s3.last_modified = last_modified
    try:
        s3.put_object(
            Bucket="evidence",
            Key=manifest_key,
            Body=json.dumps(record).encode(),
            ContentType="application/json",
            ACL="private",
            Metadata={"sha256": digest, "raw-object-id": object_id},
        )
    finally:
        s3.last_modified = None
    return object_id, manifest_key, record


def test_evidence_store_is_private_and_purges_only_expired_raw_objects() -> None:
    s3 = FakeS3()
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    saved = store.put(
        market="US",
        record_id="rec_123",
        collected_at=collected,
        raw=b"<html>proof</html>",
        source_url="https://shop.example/item",
        content_type="text/html",
    )
    assert (
        saved.object_id == "evidence/US/rec_123/20260101T000000.000000Z/" + saved.sha256
    )
    stored = s3.objects[saved.object_id]
    assert stored["ACL"] == "private"
    assert stored["Metadata"] == {
        "source-url": "https://shop.example/item",
        "content-type": "text/html",
        "sha256": saved.sha256,
        "collector-version": "landing-v1",
        "retention-date": "2026-06-30T00:00:00+00:00",
        "operation-token": store.structured_evidence(saved.object_id)[
            "operation_token"
        ],
    }
    assert store.signed_read_link(saved.object_id).endswith("?signed=1")
    assert store.purge_expired(collected + timedelta(days=179), dry_run=False) == []
    assert store.purge_expired(collected + timedelta(days=181), dry_run=True) == [
        saved.object_id
    ]
    assert saved.object_id in s3.objects
    assert store.purge_expired(collected + timedelta(days=181), dry_run=False) == [
        saved.object_id
    ]
    assert s3.deleted == [saved.object_id]
    assert store.structured_evidence(saved.object_id)["sha256"] == saved.sha256


def test_evidence_manifest_survives_restart_pagination_and_partial_raw_delete() -> None:
    s3 = FakeS3()
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    first = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    old = first.put(
        market="US",
        record_id="old",
        collected_at=collected,
        raw=b"old",
        source_url="https://shop.example/old",
        content_type="text/html",
    )
    active = first.put(
        market="US",
        record_id="active",
        collected_at=collected + timedelta(days=2),
        raw=b"active",
        source_url="https://shop.example/active",
        content_type="text/html",
    )
    restarted = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    assert restarted.structured_evidence(old.object_id)["sha256"] == old.sha256
    assert restarted.signed_read_link(active.object_id).endswith("?signed=1")
    original_delete = s3.delete_object

    def delete_with_one_failure(*, Bucket: str, Key: str) -> None:
        if Key == old.object_id:
            raise RuntimeError("minio temporary failure")
        original_delete(Bucket=Bucket, Key=Key)

    s3.delete_object = delete_with_one_failure  # type: ignore[method-assign]
    assert restarted.purge_expired(collected + timedelta(days=181), dry_run=False) == []
    assert old.object_id in s3.objects
    s3.delete_object = original_delete  # type: ignore[method-assign]
    assert restarted.purge_expired(collected + timedelta(days=181), dry_run=False) == [
        old.object_id
    ]
    assert old.object_id not in s3.objects
    assert restarted.structured_evidence(old.object_id)["raw_deleted"] is True
    assert (
        json.loads(s3.objects[EvidenceStore.manifest_key(old.object_id)]["Body"])[
            "sha256"
        ]
        == old.sha256
    )


def test_legacy_committed_manifest_without_pending_lease_remains_signable() -> None:
    s3 = FakeS3()
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    raw = b"legacy raw"
    digest = sha256(raw).hexdigest()
    object_id = f"evidence/US/legacy/20260101T000000Z/{digest}"
    record = {
        "object_id": object_id,
        "sha256": digest,
        "source_url": "https://shop.example/legacy",
        "content_type": "text/html",
        "collected_at": collected.isoformat(),
        "retention_date": (collected + timedelta(days=180)).isoformat(),
        "collector_version": "landing-v1",
        "trust": "verified",
        "raw_deleted": False,
        "state": "committed",
    }
    s3.put_object(
        Bucket="evidence",
        Key=object_id,
        Body=raw,
        Metadata={"sha256": digest},
    )
    s3.put_object(
        Bucket="evidence",
        Key=EvidenceStore.manifest_key(object_id),
        Body=json.dumps(record).encode(),
    )
    restarted = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")

    assert restarted.signed_read_link(object_id).endswith("?signed=1")
    assert restarted.purge_expired(collected + timedelta(days=181), dry_run=True) == [
        object_id
    ]


def test_old_legacy_pending_manifest_is_claimed_and_cleaned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    now = datetime(2026, 9, 5, tzinfo=UTC)
    object_id, manifest_key, original = put_legacy_pending(
        s3,
        record_id="old-legacy-pending",
        last_modified=now - timedelta(hours=25),
    )
    monkeypatch.setattr(storage, "_utc_now", lambda: now)

    assert EvidenceStore(
        s3, bucket="evidence", collector_version="landing-v1"
    ).repair_pending() == [object_id]
    assert object_id not in s3.objects
    repaired = json.loads(s3.objects[manifest_key]["Body"])
    assert repaired["state"] == "aborted"
    assert repaired["raw_deleted"] is True
    assert repaired["sha256"] == original["sha256"]
    assert repaired["source_url"] == original["source_url"]


def test_fresh_legacy_pending_manifest_is_left_untouched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    now = datetime(2026, 9, 5, tzinfo=UTC)
    object_id, manifest_key, _ = put_legacy_pending(
        s3,
        record_id="fresh-legacy-pending",
        last_modified=now - timedelta(hours=23),
    )
    monkeypatch.setattr(storage, "_utc_now", lambda: now)

    assert (
        EvidenceStore(
            s3, bucket="evidence", collector_version="landing-v1"
        ).repair_pending()
        == []
    )
    assert object_id in s3.objects
    assert s3.deleted == []
    assert json.loads(s3.objects[manifest_key]["Body"])["state"] == "pending"


def test_legacy_pending_abort_cas_loser_preserves_committed_winner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    now = datetime(2026, 9, 5, tzinfo=UTC)
    object_id, manifest_key, original = put_legacy_pending(
        s3,
        record_id="legacy-cas-loser",
        last_modified=now - timedelta(hours=25),
    )
    monkeypatch.setattr(storage, "_utc_now", lambda: now)

    class CommitBeforeLegacyAbort:
        triggered = False

        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            if (
                not self.triggered
                and str(kwargs["Key"]) == manifest_key
                and "IfMatch" in kwargs
            ):
                self.triggered = True
                committed = {**original, "state": "committed"}
                s3.put_object(
                    Bucket="evidence",
                    Key=manifest_key,
                    Body=json.dumps(committed).encode(),
                    ContentType="application/json",
                    ACL="private",
                    Metadata=s3.objects[manifest_key]["Metadata"],
                    IfMatch=kwargs["IfMatch"],
                )
            return s3.put_object(**kwargs)

    racing_client = CommitBeforeLegacyAbort()
    assert (
        EvidenceStore(
            racing_client, bucket="evidence", collector_version="landing-v1"
        ).repair_pending()
        == []
    )
    assert racing_client.triggered is True
    assert object_id in s3.objects
    assert s3.deleted == []
    assert json.loads(s3.objects[manifest_key]["Body"])["state"] == "committed"


def test_stale_pending_manifest_recovers_raw_after_commit_manifest_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    clock = [collected]
    monkeypatch.setattr(storage, "_utc_now", lambda: clock[0])

    class FailCommitManifest:
        def __init__(self) -> None:
            self.manifest_writes = 0

        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            if str(kwargs["Key"]).startswith(EvidenceStore.manifest_prefix):
                self.manifest_writes += 1
                if self.manifest_writes == 2:
                    raise OSError("commit manifest failed")
            return s3.put_object(**kwargs)

    broken = EvidenceStore(
        FailCommitManifest(), bucket="evidence", collector_version="landing-v1"
    )
    with pytest.raises(OSError, match="commit manifest failed"):
        broken.put(
            market="US",
            record_id="orphan",
            collected_at=collected,
            raw=b"orphan raw",
            source_url="https://shop.example/orphan",
            content_type="text/html",
        )

    raw_keys = [key for key in s3.objects if key.startswith("evidence/US/")]
    assert len(raw_keys) == 1
    restarted = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    pending = restarted.structured_evidence(raw_keys[0])
    clock[0] = datetime.fromisoformat(pending["lease_until"]) + timedelta(seconds=1)
    assert restarted.repair_pending() == raw_keys
    assert raw_keys[0] not in s3.objects
    record = restarted.structured_evidence(raw_keys[0])
    assert record["state"] == "aborted"
    assert record["raw_deleted"] is True
    assert record["sha256"] == raw_keys[0].rsplit("/", 1)[-1]


def test_retry_of_committed_evidence_is_idempotent_even_if_raw_put_would_fail() -> None:
    s3 = FakeS3()
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    first = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    saved = first.put(
        market="US",
        record_id="same",
        collected_at=collected,
        raw=b"same raw",
        source_url="https://shop.example/same",
        content_type="text/html",
    )

    class FailRawPut:
        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> None:
            if str(kwargs["Key"]).startswith("evidence/US/"):
                raise OSError("raw retry must not run")
            s3.put_object(**kwargs)

    retried = EvidenceStore(
        FailRawPut(), bucket="evidence", collector_version="landing-v1"
    ).put(
        market="US",
        record_id="same",
        collected_at=collected,
        raw=b"same raw",
        source_url="https://shop.example/same",
        content_type="text/html",
    )

    assert retried == saved
    restarted = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    assert restarted.structured_evidence(saved.object_id)["state"] == "committed"
    assert saved.object_id in s3.objects


def test_retry_rejects_metadata_conflict_without_overwriting_committed_manifest() -> (
    None
):
    s3 = FakeS3()
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    saved = store.put(
        market="US",
        record_id="same",
        collected_at=collected,
        raw=b"same raw",
        source_url="https://shop.example/original",
        content_type="text/html",
    )

    with pytest.raises(RuntimeError, match="conflict"):
        store.put(
            market="US",
            record_id="same",
            collected_at=collected,
            raw=b"same raw",
            source_url="https://shop.example/different",
            content_type="text/html",
        )

    assert (
        store.structured_evidence(saved.object_id)["source_url"]
        == "https://shop.example/original"
    )


def test_pending_manifest_uses_conditional_create_and_loses_race_safely() -> None:
    s3 = FakeS3()
    protected = b'{"state":"committed"}'

    class PreconditionFailed(RuntimeError):
        def __init__(self) -> None:
            super().__init__("another writer won")
            self.response = {"ResponseMetadata": {"HTTPStatusCode": 412}}

    class LoseCreateRace:
        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> None:
            key = str(kwargs["Key"])
            if key.startswith(EvidenceStore.manifest_prefix):
                assert kwargs["IfNoneMatch"] == "*"
                s3.objects[key] = {"Key": key, "Body": protected}
                raise PreconditionFailed()
            raise AssertionError("raw must not be written after losing manifest CAS")

    store = EvidenceStore(
        LoseCreateRace(), bucket="evidence", collector_version="landing-v1"
    )
    with pytest.raises(RuntimeError, match="conflict"):
        store.put(
            market="US",
            record_id="same",
            collected_at=datetime(2026, 1, 1, tzinfo=UTC),
            raw=b"same raw",
            source_url="https://shop.example/same",
            content_type="text/html",
        )

    manifest_bodies = [
        item["Body"]
        for key, item in s3.objects.items()
        if key.startswith("evidence-manifests/")
    ]
    assert manifest_bodies == [protected]


def test_active_pending_lease_prevents_repair_from_deleting_writer_raw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    monkeypatch.setattr(storage, "_utc_now", lambda: now, raising=False)
    raw_written = threading.Event()
    release_writer = threading.Event()

    class PauseAfterRawWrite:
        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            response = s3.put_object(**kwargs)
            if str(kwargs["Key"]).startswith("evidence/US/"):
                raw_written.set()
                if not release_writer.wait(timeout=5):
                    raise TimeoutError("test did not release evidence writer")
            return response

    outcomes: list[object] = []
    errors: list[BaseException] = []

    def write() -> None:
        try:
            outcomes.append(
                EvidenceStore(
                    PauseAfterRawWrite(),
                    bucket="evidence",
                    collector_version="landing-v1",
                ).put(
                    market="US",
                    record_id="active-race",
                    collected_at=now,
                    raw=b"active raw",
                    source_url="https://shop.example/active-race",
                    content_type="text/html",
                )
            )
        except BaseException as exc:  # noqa: BLE001 -- surfaced in the test thread
            errors.append(exc)

    writer = threading.Thread(target=write)
    writer.start()
    started = raw_written.wait(timeout=5)
    repaired: list[str] = []
    try:
        if started:
            repaired = EvidenceStore(
                s3, bucket="evidence", collector_version="landing-v1"
            ).repair_pending()
    finally:
        release_writer.set()
        writer.join(timeout=5)

    assert started is True
    assert writer.is_alive() is False
    assert errors == []
    assert repaired == []
    assert len(outcomes) == 1
    raw_keys = [key for key in s3.objects if key.startswith("evidence/US/")]
    assert len(raw_keys) == 1
    assert (
        EvidenceStore(
            s3, bucket="evidence", collector_version="landing-v1"
        ).structured_evidence(raw_keys[0])["state"]
        == "committed"
    )


def test_repair_requires_manifest_last_modified_age_before_claiming_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    now = datetime(2026, 1, 1, 1, 0, tzinfo=UTC)
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    raw = b"clock-skew raw"
    digest = sha256(raw).hexdigest()
    object_id = f"evidence/US/clock-skew/20260101T000000Z/{digest}"
    manifest_key = EvidenceStore.manifest_key(object_id)
    operation_token = "1" * 32
    record = {
        "object_id": object_id,
        "sha256": digest,
        "source_url": "https://shop.example/clock-skew",
        "content_type": "text/html",
        "collected_at": collected.isoformat(),
        "retention_date": (collected + timedelta(days=180)).isoformat(),
        "collector_version": "landing-v1",
        "trust": "verified",
        "raw_deleted": False,
        "state": "pending",
        "operation_token": operation_token,
        "created_at": collected.isoformat(),
        "lease_until": (collected + timedelta(minutes=5)).isoformat(),
    }
    s3.put_object(
        Bucket="evidence",
        Key=object_id,
        Body=raw,
        Metadata={"sha256": digest, "operation-token": operation_token},
    )
    s3.last_modified = now - timedelta(minutes=1)
    s3.put_object(
        Bucket="evidence",
        Key=manifest_key,
        Body=json.dumps(record).encode(),
        Metadata={"sha256": digest, "raw-object-id": object_id},
    )
    s3.last_modified = None
    monkeypatch.setattr(storage, "_utc_now", lambda: now)

    assert (
        EvidenceStore(
            s3, bucket="evidence", collector_version="landing-v1"
        ).repair_pending()
        == []
    )
    assert object_id in s3.objects
    assert s3.deleted == []
    assert json.loads(s3.objects[manifest_key]["Body"])["state"] == "pending"


def test_late_raw_writer_compensates_after_repair_aborts_missing_raw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    clock = [now]
    monkeypatch.setattr(storage, "_utc_now", lambda: clock[0])
    raw_put_started = threading.Event()
    release_raw_put = threading.Event()

    class PauseRawBeforeCompletion:
        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            if str(kwargs["Key"]).startswith("evidence/US/"):
                raw_put_started.set()
                if not release_raw_put.wait(timeout=5):
                    raise TimeoutError("test did not release late raw put")
            return s3.put_object(**kwargs)

    errors: list[BaseException] = []

    def write() -> None:
        try:
            EvidenceStore(
                PauseRawBeforeCompletion(),
                bucket="evidence",
                collector_version="landing-v1",
            ).put(
                market="US",
                record_id="late-raw",
                collected_at=now,
                raw=b"late raw",
                source_url="https://shop.example/late-raw",
                content_type="text/html",
            )
        except BaseException as exc:  # noqa: BLE001 -- surfaced in the test thread
            errors.append(exc)

    writer = threading.Thread(target=write)
    writer.start()
    try:
        assert raw_put_started.wait(timeout=5) is True
        manifest_key = next(
            key for key in s3.objects if key.startswith(EvidenceStore.manifest_prefix)
        )
        pending = json.loads(s3.objects[manifest_key]["Body"])
        object_id = str(pending["object_id"])
        clock[0] = datetime.fromisoformat(pending["lease_until"]) + timedelta(seconds=1)
        assert EvidenceStore(
            s3, bucket="evidence", collector_version="landing-v1"
        ).repair_pending() == [object_id]
        assert json.loads(s3.objects[manifest_key]["Body"])["raw_deleted"] is True
    finally:
        release_raw_put.set()
        writer.join(timeout=5)

    assert writer.is_alive() is False
    assert len(errors) == 1 and isinstance(errors[0], EvidenceConflict)
    assert object_id not in s3.objects
    repaired = json.loads(s3.objects[manifest_key]["Body"])
    assert repaired["state"] == "aborted"
    assert repaired["raw_deleted"] is True


def test_late_raw_delete_failure_is_marked_for_next_repair(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    clock = [now]
    monkeypatch.setattr(storage, "_utc_now", lambda: clock[0])
    raw_put_started = threading.Event()
    release_raw_put = threading.Event()

    class PauseRawAndFailCompensationDelete:
        delete_failed = False

        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            if str(kwargs["Key"]).startswith("evidence/US/"):
                raw_put_started.set()
                if not release_raw_put.wait(timeout=5):
                    raise TimeoutError("test did not release late raw put")
            return s3.put_object(**kwargs)

        def delete_object(
            self,
            *,
            Bucket: str,
            Key: str,
            VersionId: str | None = None,
            IfMatch: str | None = None,
        ) -> None:
            if Key in s3.objects and not self.delete_failed:
                self.delete_failed = True
                raise OSError("late raw delete failed")
            s3.delete_object(
                Bucket=Bucket,
                Key=Key,
                VersionId=VersionId,
                IfMatch=IfMatch,
            )

    client = PauseRawAndFailCompensationDelete()
    errors: list[BaseException] = []

    def write() -> None:
        try:
            EvidenceStore(
                client, bucket="evidence", collector_version="landing-v1"
            ).put(
                market="US",
                record_id="late-raw-delete-failure",
                collected_at=now,
                raw=b"late raw delete failure",
                source_url="https://shop.example/late-raw-delete-failure",
                content_type="text/html",
            )
        except BaseException as exc:  # noqa: BLE001 -- surfaced in the test thread
            errors.append(exc)

    writer = threading.Thread(target=write)
    writer.start()
    try:
        assert raw_put_started.wait(timeout=5) is True
        manifest_key = next(
            key for key in s3.objects if key.startswith(EvidenceStore.manifest_prefix)
        )
        pending = json.loads(s3.objects[manifest_key]["Body"])
        object_id = str(pending["object_id"])
        clock[0] = datetime.fromisoformat(pending["lease_until"]) + timedelta(seconds=1)
        assert EvidenceStore(
            s3, bucket="evidence", collector_version="landing-v1"
        ).repair_pending() == [object_id]
    finally:
        release_raw_put.set()
        writer.join(timeout=5)

    assert writer.is_alive() is False
    assert len(errors) == 1 and isinstance(errors[0], EvidenceConflict)
    assert client.delete_failed is True
    needs_cleanup = json.loads(s3.objects[manifest_key]["Body"])
    assert needs_cleanup["state"] == "aborted"
    assert needs_cleanup["raw_deleted"] is False
    assert needs_cleanup["needs_cleanup"] is True
    assert object_id in s3.objects

    assert EvidenceStore(
        s3, bucket="evidence", collector_version="landing-v1"
    ).repair_pending() == [object_id]
    assert object_id not in s3.objects
    repaired = json.loads(s3.objects[manifest_key]["Body"])
    assert repaired["raw_deleted"] is True
    assert repaired["needs_cleanup"] is False


def test_writer_commit_cas_cleans_own_raw_after_abort() -> None:
    s3 = FakeS3()

    class AbortPendingAfterRawWrite:
        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            response = s3.put_object(**kwargs)
            if str(kwargs["Key"]).startswith("evidence/US/"):
                manifest_key = next(
                    key
                    for key in s3.objects
                    if key.startswith(EvidenceStore.manifest_prefix)
                )
                pending = s3.objects[manifest_key]
                aborted = json.loads(pending["Body"])
                aborted["state"] = "aborted"
                s3.put_object(
                    Bucket="evidence",
                    Key=manifest_key,
                    Body=json.dumps(aborted).encode(),
                    ContentType="application/json",
                    ACL="private",
                    Metadata=pending["Metadata"],
                    IfMatch=pending["ETag"],
                )
            return response

    store = EvidenceStore(
        AbortPendingAfterRawWrite(),
        bucket="evidence",
        collector_version="landing-v1",
    )
    with pytest.raises(EvidenceConflict, match="conflict"):
        store.put(
            market="US",
            record_id="commit-race",
            collected_at=datetime(2026, 1, 1, tzinfo=UTC),
            raw=b"race raw",
            source_url="https://shop.example/commit-race",
            content_type="text/html",
        )

    manifest_key = next(
        key for key in s3.objects if key.startswith(EvidenceStore.manifest_prefix)
    )
    raw_key = str(json.loads(s3.objects[manifest_key]["Body"])["object_id"])
    assert raw_key not in s3.objects
    assert store.structured_evidence(raw_key)["state"] == "aborted"


def test_writer_commit_cas_never_deletes_committed_winner_raw() -> None:
    s3 = FakeS3()
    winner_token = "f" * 32

    class CommitWinnerAfterRawWrite:
        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            response = s3.put_object(**kwargs)
            key = str(kwargs["Key"])
            if key.startswith("evidence/US/"):
                metadata = dict(kwargs["Metadata"])  # type: ignore[arg-type]
                assert metadata["operation-token"] != winner_token
                metadata["operation-token"] = winner_token
                s3.put_object(
                    Bucket="evidence",
                    Key=key,
                    Body=kwargs["Body"],
                    ContentType=kwargs["ContentType"],
                    ACL="private",
                    Metadata=metadata,
                )
                manifest_key = EvidenceStore.manifest_key(key)
                pending_object = s3.objects[manifest_key]
                pending = json.loads(pending_object["Body"])
                committed = {
                    **pending,
                    "state": "committed",
                    "operation_token": winner_token,
                }
                s3.put_object(
                    Bucket="evidence",
                    Key=manifest_key,
                    Body=json.dumps(committed).encode(),
                    ContentType="application/json",
                    ACL="private",
                    Metadata=pending_object["Metadata"],
                    IfMatch=pending_object["ETag"],
                )
            return response

    saved = EvidenceStore(
        CommitWinnerAfterRawWrite(),
        bucket="evidence",
        collector_version="landing-v1",
    ).put(
        market="US",
        record_id="committed-winner",
        collected_at=datetime(2026, 1, 1, tzinfo=UTC),
        raw=b"winner raw",
        source_url="https://shop.example/committed-winner",
        content_type="text/html",
    )

    assert saved.object_id in s3.objects
    assert s3.deleted == []
    assert (
        s3.head_object(Bucket="evidence", Key=saved.object_id)["Metadata"][
            "operation-token"
        ]
        == winner_token
    )
    manifest = EvidenceStore(
        s3, bucket="evidence", collector_version="landing-v1"
    ).structured_evidence(saved.object_id)
    assert manifest["state"] == "committed"
    assert manifest["operation_token"] == winner_token


def test_writer_compensation_delete_is_bound_to_raw_version() -> None:
    s3 = FakeS3()
    winner_token = "e" * 32

    class ReplaceRawBeforeCompensationDelete:
        delete_triggered = False

        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            response = s3.put_object(**kwargs)
            key = str(kwargs["Key"])
            if key.startswith("evidence/US/"):
                manifest_key = EvidenceStore.manifest_key(key)
                pending_object = s3.objects[manifest_key]
                aborted = {**json.loads(pending_object["Body"]), "state": "aborted"}
                s3.put_object(
                    Bucket="evidence",
                    Key=manifest_key,
                    Body=json.dumps(aborted).encode(),
                    ContentType="application/json",
                    ACL="private",
                    Metadata=pending_object["Metadata"],
                    IfMatch=pending_object["ETag"],
                )
            return response

        def delete_object(self, **kwargs: object) -> None:
            self.delete_triggered = True
            key = str(kwargs["Key"])
            manifest_key = EvidenceStore.manifest_key(key)
            aborted_object = s3.objects[manifest_key]
            raw_object = s3.objects[key]
            raw_metadata = dict(raw_object["Metadata"])  # type: ignore[arg-type]
            raw_metadata["operation-token"] = winner_token
            winner = s3.put_object(
                Bucket="evidence",
                Key=key,
                Body=raw_object["Body"],
                ContentType=raw_object["ContentType"],
                ACL="private",
                Metadata=raw_metadata,
            )
            committed = {
                **json.loads(aborted_object["Body"]),
                "state": "committed",
                "operation_token": winner_token,
                "raw_version_id": winner["VersionId"],
                "raw_deleted": False,
                "needs_cleanup": False,
            }
            s3.put_object(
                Bucket="evidence",
                Key=manifest_key,
                Body=json.dumps(committed).encode(),
                ContentType="application/json",
                ACL="private",
                Metadata=aborted_object["Metadata"],
                IfMatch=aborted_object["ETag"],
            )
            s3.delete_object(**kwargs)  # type: ignore[arg-type]

    client = ReplaceRawBeforeCompensationDelete()
    with pytest.raises(EvidenceConflict, match="conflict"):
        EvidenceStore(client, bucket="evidence", collector_version="landing-v1").put(
            market="US",
            record_id="raw-version-race",
            collected_at=datetime(2026, 1, 1, tzinfo=UTC),
            raw=b"same raw bytes",
            source_url="https://shop.example/raw-version-race",
            content_type="text/html",
        )

    assert client.delete_triggered is True
    manifest_key = next(
        key for key in s3.objects if key.startswith(EvidenceStore.manifest_prefix)
    )
    manifest = json.loads(s3.objects[manifest_key]["Body"])
    object_id = str(manifest["object_id"])
    assert manifest["state"] == "committed"
    assert manifest["operation_token"] == winner_token
    assert object_id in s3.objects
    assert s3.objects[object_id]["Metadata"]["operation-token"] == winner_token
    assert s3.deleted == [object_id]
    assert len(s3.versions[object_id]) == 1


def test_repair_losing_abort_cas_rereads_without_deleting_committed_raw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    digest = "0" * 64
    object_id = f"evidence/US/repair-race/20260101T000000Z/{digest}"
    manifest_key = EvidenceStore.manifest_key(object_id)
    record = {
        "object_id": object_id,
        "sha256": digest,
        "source_url": "https://shop.example/repair-race",
        "content_type": "text/html",
        "collected_at": "2026-01-01T00:00:00+00:00",
        "retention_date": "2026-06-30T00:00:00+00:00",
        "collector_version": "landing-v1",
        "trust": "verified",
        "raw_deleted": False,
        "state": "pending",
        "operation_token": "1" * 32,
        "created_at": "2026-01-01T00:00:00+00:00",
        "lease_until": "2026-01-01T00:05:00+00:00",
    }
    s3.put_object(
        Bucket="evidence",
        Key=object_id,
        Body=b"keep",
        Metadata={"sha256": digest},
    )
    s3.last_modified = datetime(2026, 1, 1, tzinfo=UTC)
    s3.put_object(
        Bucket="evidence",
        Key=manifest_key,
        Body=json.dumps(record).encode(),
        ContentType="application/json",
        ACL="private",
        Metadata={"sha256": digest, "raw-object-id": object_id},
    )
    s3.last_modified = None
    monkeypatch.setattr(
        storage,
        "_utc_now",
        lambda: datetime(2026, 1, 1, 0, 5, 1, tzinfo=UTC),
        raising=False,
    )

    class WriterWinsAbortRace:
        triggered = False

        def __getattr__(self, name: str):
            return getattr(s3, name)

        def put_object(self, **kwargs: object) -> object:
            if (
                not self.triggered
                and str(kwargs["Key"]) == manifest_key
                and "IfMatch" in kwargs
            ):
                self.triggered = True
                committed = {**record, "state": "committed"}
                s3.put_object(
                    Bucket="evidence",
                    Key=manifest_key,
                    Body=json.dumps(committed).encode(),
                    ContentType="application/json",
                    ACL="private",
                    Metadata={"sha256": digest, "raw-object-id": object_id},
                    IfMatch=kwargs["IfMatch"],
                )
            return s3.put_object(**kwargs)

    racing_client = WriterWinsAbortRace()
    store = EvidenceStore(
        racing_client, bucket="evidence", collector_version="landing-v1"
    )

    assert store.repair_pending() == []
    assert racing_client.triggered is True
    assert object_id in s3.objects
    assert s3.deleted == []
    assert store.structured_evidence(object_id)["state"] == "committed"


def test_repair_and_purge_skip_forged_manifests_without_deleting_targets() -> None:
    s3 = FakeS3()
    unrelated_key = "unrelated/private-object"
    forged_manifest_key = EvidenceStore.manifest_key(unrelated_key)
    s3.put_object(Bucket="evidence", Key=unrelated_key, Body=b"keep")
    s3.put_object(
        Bucket="evidence",
        Key=forged_manifest_key,
        Body=json.dumps(
            {
                "object_id": unrelated_key,
                "sha256": "0" * 64,
                "state": "pending",
                "raw_deleted": False,
                "retention_date": "2026-01-01T00:00:00+00:00",
            }
        ).encode(),
    )
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")

    repaired = store.repair_pending()
    purged = store.purge_expired(datetime(2027, 1, 1, tzinfo=UTC), dry_run=False)

    assert repaired == []
    assert purged == []
    assert unrelated_key in s3.objects
    assert s3.deleted == []


def test_repair_and_purge_skip_temporally_unbound_manifests_without_deletion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    digest = "0" * 64
    corruptions = {
        "short-key-timestamp": (
            "202611T000000Z",
            "2026-01-01T00:00:00+00:00",
            "2026-06-30T00:00:00+00:00",
        ),
        "overflowing-collected-offset": (
            "20260101T000000Z",
            "0001-01-01T00:00:00+23:59",
            "2026-06-30T00:00:00+00:00",
        ),
        "mismatched-collected-at": (
            "20260101T000000Z",
            "2026-01-02T00:00:00+00:00",
            "2026-07-01T00:00:00+00:00",
        ),
        "forged-retention": (
            "20260101T000000Z",
            "2026-01-01T00:00:00+00:00",
            "2026-06-29T00:00:00+00:00",
        ),
    }
    raw_keys: list[str] = []
    for name, (timestamp, collected_at, retention_date) in corruptions.items():
        for state in ("pending", "committed"):
            object_id = f"evidence/US/{name}-{state}/{timestamp}/{digest}"
            raw_keys.append(object_id)
            s3.put_object(Bucket="evidence", Key=object_id, Body=b"keep")
            record = {
                "object_id": object_id,
                "sha256": digest,
                "source_url": "https://shop.example/item",
                "content_type": "text/html",
                "collected_at": collected_at,
                "retention_date": retention_date,
                "collector_version": "landing-v1",
                "trust": "verified",
                "raw_deleted": False,
                "state": state,
                "operation_token": "1" * 32,
                "created_at": "2026-01-01T00:00:00+00:00",
                "lease_until": "2026-01-01T00:05:00+00:00",
            }
            manifest_key = EvidenceStore.manifest_key(object_id)
            s3.put_object(
                Bucket="evidence",
                Key=manifest_key,
                Body=json.dumps(record).encode(),
            )

    monkeypatch.setattr(
        storage,
        "_utc_now",
        lambda: datetime(2027, 1, 1, tzinfo=UTC),
        raising=False,
    )
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")

    repaired = store.repair_pending()
    purged = store.purge_expired(datetime(2027, 1, 1, tzinfo=UTC), dry_run=False)

    assert repaired == []
    assert purged == []
    assert s3.deleted == []
    assert all(key in s3.objects for key in raw_keys)


def put_tokenized_pending_without_raw(
    s3: FakeS3,
    *,
    record_id: str,
    raw: bytes,
    server_now: datetime,
) -> tuple[str, str, dict[str, object]]:
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    digest = sha256(raw).hexdigest()
    object_id = f"evidence/US/{record_id}/20260101T000000Z/{digest}"
    manifest_key = EvidenceStore.manifest_key(object_id)
    operation_token = "a" * 32
    record: dict[str, object] = {
        "object_id": object_id,
        "sha256": digest,
        "source_url": f"https://shop.example/{record_id}",
        "content_type": "text/html",
        "collected_at": collected.isoformat(),
        "retention_date": (collected + timedelta(days=180)).isoformat(),
        "collector_version": "landing-v1",
        "trust": "verified",
        "raw_deleted": False,
        "state": "pending",
        "operation_token": operation_token,
        "created_at": collected.isoformat(),
        "lease_until": (collected + EvidenceStore.pending_lease).isoformat(),
    }
    s3.server_now = server_now
    s3.last_modified = server_now - EvidenceStore.pending_lease - timedelta(seconds=1)
    try:
        s3.put_object(
            Bucket="evidence",
            Key=manifest_key,
            Body=json.dumps(record).encode(),
            ContentType="application/json",
            ACL="private",
            Metadata={"sha256": digest, "raw-object-id": object_id},
        )
    finally:
        s3.last_modified = None
    return object_id, manifest_key, record


def test_evidence_store_requires_enabled_bucket_versioning() -> None:
    s3 = FakeS3()
    s3.versioning_status = "Suspended"

    with pytest.raises(RuntimeError, match="versioning.*Enabled"):
        EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")


def test_evidence_store_fails_startup_when_client_cannot_check_versioning() -> None:
    class ClientWithoutVersioningApi:
        pass

    with pytest.raises(RuntimeError, match="versioning check failed"):
        EvidenceStore(
            ClientWithoutVersioningApi(),  # type: ignore[arg-type]
            bucket="evidence",
            collector_version="landing-v1",
        )


def test_put_records_the_actual_raw_version_id_in_manifest() -> None:
    s3 = FakeS3()
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")

    saved = store.put(
        market="US",
        record_id="versioned",
        collected_at=datetime(2026, 1, 1, tzinfo=UTC),
        raw=b"versioned raw",
        source_url="https://shop.example/versioned",
        content_type="text/html",
    )

    raw_head = s3.head_object(Bucket="evidence", Key=saved.object_id)
    assert (
        store.structured_evidence(saved.object_id)["raw_version_id"]
        == raw_head["VersionId"]
    )


def test_pending_staleness_uses_s3_date_not_the_client_clock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    server_now = datetime(2026, 1, 1, 0, 4, tzinfo=UTC)
    object_id, manifest_key, _ = put_tokenized_pending_without_raw(
        s3,
        record_id="server-clock",
        raw=b"server clock raw",
        server_now=server_now,
    )
    # Make the manifest fresh according to the server while the client is years ahead.
    s3.objects[manifest_key]["LastModified"] = server_now - timedelta(minutes=1)
    monkeypatch.setattr(storage, "_utc_now", lambda: datetime(2036, 1, 1, tzinfo=UTC))

    assert (
        EvidenceStore(
            s3, bucket="evidence", collector_version="landing-v1"
        ).repair_pending()
        == []
    )
    assert object_id not in s3.objects
    assert json.loads(s3.objects[manifest_key]["Body"])["state"] == "pending"


@pytest.mark.parametrize("date_value", [None, "not-an-http-date"])
def test_pending_repair_fails_closed_without_valid_s3_date(
    monkeypatch: pytest.MonkeyPatch, date_value: str | None
) -> None:
    s3 = FakeS3()
    object_id, manifest_key, _ = put_tokenized_pending_without_raw(
        s3,
        record_id="missing-server-date",
        raw=b"missing server date raw",
        server_now=datetime(2026, 1, 2, tzinfo=UTC),
    )
    monkeypatch.setattr(storage, "_utc_now", lambda: datetime(2036, 1, 1, tzinfo=UTC))

    class MissingOrInvalidDate:
        def __getattr__(self, name: str) -> object:
            return getattr(s3, name)

        def head_object(self, **kwargs: object) -> dict[str, object]:
            response = s3.head_object(**kwargs)  # type: ignore[arg-type]
            if date_value is None:
                response.pop("ResponseMetadata", None)
            else:
                response["ResponseMetadata"] = {"HTTPHeaders": {"date": date_value}}
            return response

    assert (
        EvidenceStore(
            MissingOrInvalidDate(),
            bucket="evidence",
            collector_version="landing-v1",
        ).repair_pending()
        == []
    )
    assert object_id not in s3.objects
    assert json.loads(s3.objects[manifest_key]["Body"])["state"] == "pending"


def test_aborted_manifest_reconciles_a_late_raw_even_when_marked_deleted() -> None:
    s3 = FakeS3()
    raw = b"late raw after writer crash"
    object_id, manifest_key, pending = put_tokenized_pending_without_raw(
        s3,
        record_id="late-after-abort",
        raw=raw,
        server_now=datetime(2026, 1, 2, tzinfo=UTC),
    )
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    assert store.repair_pending() == [object_id]
    assert json.loads(s3.objects[manifest_key]["Body"])["raw_deleted"] is True

    late_put = s3.put_object(
        Bucket="evidence",
        Key=object_id,
        Body=raw,
        ContentType="text/html",
        ACL="private",
        Metadata={
            "sha256": pending["sha256"],
            "operation-token": pending["operation_token"],
        },
    )

    assert store.repair_pending() == [object_id]
    assert late_put["VersionId"] not in s3.versions.get(object_id, {})
    repaired = json.loads(s3.objects[manifest_key]["Body"])
    assert repaired["state"] == "aborted"
    assert repaired["raw_deleted"] is True


def test_aborted_late_raw_head_failure_remains_retryable() -> None:
    s3 = FakeS3()
    raw = b"retry late raw"
    object_id, manifest_key, pending = put_tokenized_pending_without_raw(
        s3,
        record_id="late-head-retry",
        raw=raw,
        server_now=datetime(2026, 1, 2, tzinfo=UTC),
    )
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    assert store.repair_pending() == [object_id]
    late_put = s3.put_object(
        Bucket="evidence",
        Key=object_id,
        Body=raw,
        Metadata={
            "sha256": pending["sha256"],
            "operation-token": pending["operation_token"],
        },
    )

    class FailHeadOnce:
        failed = False

        def __getattr__(self, name: str) -> object:
            return getattr(s3, name)

        def head_object(self, **kwargs: object) -> dict[str, object]:
            if kwargs["Key"] == object_id and not self.failed:
                self.failed = True
                raise OSError("temporary HEAD failure")
            return s3.head_object(**kwargs)  # type: ignore[arg-type]

    flaky = EvidenceStore(
        FailHeadOnce(), bucket="evidence", collector_version="landing-v1"
    )
    assert flaky.repair_pending() == []
    assert late_put["VersionId"] in s3.versions[object_id]
    assert json.loads(s3.objects[manifest_key]["Body"])["state"] == "aborted"
    assert store.repair_pending() == [object_id]
    assert late_put["VersionId"] not in s3.versions.get(object_id, {})


def test_expiry_purge_deletes_only_the_manifest_raw_version() -> None:
    s3 = FakeS3()
    store = EvidenceStore(s3, bucket="evidence", collector_version="landing-v1")
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    saved = store.put(
        market="US",
        record_id="purge-version",
        collected_at=collected,
        raw=b"same bytes",
        source_url="https://shop.example/purge-version",
        content_type="text/html",
    )
    original_version = s3.head_object(Bucket="evidence", Key=saved.object_id)[
        "VersionId"
    ]
    replacement = s3.put_object(
        Bucket="evidence",
        Key=saved.object_id,
        Body=b"same bytes",
        Metadata={"sha256": saved.sha256, "operation-token": "f" * 32},
    )

    assert store.purge_expired(collected + timedelta(days=181), dry_run=False) == [
        saved.object_id
    ]
    assert original_version not in s3.versions[saved.object_id]
    assert replacement["VersionId"] in s3.versions[saved.object_id]
    assert (
        s3.head_object(Bucket="evidence", Key=saved.object_id)["VersionId"]
        == (replacement["VersionId"])
    )
