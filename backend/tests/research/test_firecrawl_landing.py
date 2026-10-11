"""External reader must preserve source evidence and never hide paid failures."""
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest

from rabbit_hole.domain.project import WorkbenchError
from rabbit_hole.integrations.collectors.provider_api import ProviderError
from rabbit_hole.integrations.provider_settings import ProviderSecrets
from rabbit_hole.security import SafeUrlClient


def test_firecrawl_secret_preserves_other_provider_keys(tmp_path):
    vault = ProviderSecrets(tmp_path / "keys.json")
    vault.update({"apify": "private-apify", "serpapi": "private-serp"})
    vault.update({"firecrawl": "private-firecrawl"})
    assert vault.get("apify") == "private-apify"
    assert vault.get("firecrawl") == "private-firecrawl"
    assert vault.status()["firecrawl"] is True
    assert "private-firecrawl" not in json.dumps(vault.status())


def resolve_public(host, port):
    return ["93.184.216.34"]


def response_payload(status=200, html='<title>Folding Cart</title><p>A folding cart for travel. $79.00</p>'):
    return {"success": True, "data": {"rawHtml": html, "metadata": {
        "statusCode": status, "sourceURL": "https://example.com/products/cart"}}}


async def test_firecrawl_reads_original_html_with_fresh_request():
    from rabbit_hole.integrations.collectors.firecrawl import scrape_landing
    requests = []
    def transport(request):
        requests.append(request)
        return httpx.Response(200, json=response_payload())
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        snapshot = await scrape_landing(client, "private-key", "https://example.com/products/cart",
                                        SafeUrlClient(resolver=resolve_public))
    assert snapshot.title == "Folding Cart"
    assert snapshot.price == "79.00"
    assert snapshot.rendering_mode == "firecrawl"
    assert snapshot.http_status_code == 200
    assert snapshot.final_url == "https://example.com/products/cart"
    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body["maxAge"] == 0
    assert "json" not in body["formats"]
    assert requests[0].headers["Authorization"] == "Bearer private-key"


@pytest.mark.parametrize("api_status,payload,code", [
    (200, response_payload(status=403), "source_error"),
    (200, response_payload(html=""), "schema_drift"),
    (200, {"success": False, "error": "private-key"}, "source_error"),
    (401, {"error": "private-key"}, "access_restricted"),
    (402, {"error": "private-key"}, "budget"),
    (429, {"error": "private-key"}, "access_restricted"),
])
async def test_firecrawl_failure_does_not_retry_or_leak_secret(api_status, payload, code):
    from rabbit_hole.integrations.collectors.firecrawl import scrape_landing
    calls = []
    def transport(request):
        calls.append(request)
        return httpx.Response(api_status, json=payload)
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        with pytest.raises(ProviderError) as caught:
            await scrape_landing(client, "private-key", "https://example.com/products/cart",
                                 SafeUrlClient(resolver=resolve_public))
    assert caught.value.code == code
    assert "private-key" not in str(caught.value)
    assert len(calls) == 1


async def test_private_url_never_sent_to_firecrawl():
    from rabbit_hole.integrations.collectors.firecrawl import scrape_landing
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: calls.append(r))) as client:
        with pytest.raises(ProviderError):
            await scrape_landing(client, "key", "http://127.0.0.1/admin", SafeUrlClient())
    assert not calls


async def test_reader_is_frozen_and_cannot_switch_while_running(db_engine):
    from rabbit_hole.application.actions import (
        enqueue_action,
        list_actions,
        stop_action,
    )
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    project = await store.create("Reader", "test", "US", str(uuid4()))
    project = await store.command(project["id"], project["version"], str(uuid4()), "add_product",
                                 {"name": "Cart", "url": "https://example.com/products/cart"})
    pid = project["products"][0]["id"]
    data = {"kind": "landing", "product_id": pid, "version": project["version"]}
    first = await enqueue_action(store, project["id"], {**data, "landing_mode": "firecrawl"})
    try:
        page = await list_actions(db_engine, project["id"])
        assert page["product_actions"][pid]["landing_mode"] == "firecrawl"
        with pytest.raises(WorkbenchError):
            await enqueue_action(store, project["id"], {**data, "landing_mode": "local"})
        with pytest.raises(WorkbenchError):
            await enqueue_action(store, project["id"], {**data, "landing_mode": "unknown"})
    finally:
        await stop_action(store, project["id"], first["id"], 0)
    second = await enqueue_action(store, project["id"], {**data, "landing_mode": "local"})
    assert first["id"] != second["id"]
    await stop_action(store, project["id"], second["id"], 0)


async def test_firecrawl_runner_saves_unconfirmed_snapshot_and_fences_repeat(db_engine, tmp_path, monkeypatch):
    from types import SimpleNamespace
    from uuid import UUID

    import respx
    from sqlalchemy import select, update

    from rabbit_hole import security
    from rabbit_hole.application.actions import actions, enqueue_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.persistence.projects import WorkbenchStore
    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    ProviderSecrets().update({"firecrawl": "private-key"})
    monkeypatch.setattr(security, "google_public_dns", resolve_public)
    store = WorkbenchStore(db_engine)
    project = await store.create("Firecrawl save", "test", "US", str(uuid4()))
    project = await store.command(project["id"], project["version"], str(uuid4()), "add_product",
                                 {"name": "Cart", "url": "https://example.com/products/cart"})
    pid = project["products"][0]["id"]
    queued = await enqueue_action(store, project["id"], {
        "kind": "landing", "version": project["version"], "product_id": pid, "landing_mode": "firecrawl"})
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(queued["id"])).values(status="running", attempt=1, lease_until=datetime.now(UTC) + timedelta(minutes=5)))
        action = dict((await c.execute(select(actions).where(actions.c.id == UUID(queued["id"])))).mappings().one())
    runner = WorkbenchRunner(store, SimpleNamespace(public_dns="google"), None)
    with respx.mock:
        route = respx.post("https://api.firecrawl.dev/v2/scrape").mock(return_value=httpx.Response(200, json=response_payload()))
        result = await runner.execute(action, project)
        assert result["title"] == "Folding Cart"
        saved = await store.get(project["id"])
        snapshot = saved["products"][0]["landing_snapshot"]
        assert snapshot["rendering_mode"] == "firecrawl"
        assert snapshot["confirmed"] is False
        assert not saved["products"][0]["identification"].get("relevance_confirmed", False)
        with pytest.raises(ProviderError):
            await runner.execute(action, saved)
        assert route.call_count == 1
    async with db_engine.begin() as c:
        row = (await c.execute(select(actions).where(actions.c.id == UUID(queued["id"])))).mappings().one()
        assert len(row["payload"]["provider_reservations"]) == 1
        await c.execute(update(actions).where(actions.c.id == UUID(queued["id"])).values(status="complete", result=result))


async def test_same_source_does_not_fail_on_unneeded_second_dns_lookup():
    from rabbit_hole.integrations.collectors.firecrawl import scrape_landing
    from rabbit_hole.security import UnsafeUrl
    calls = []
    def resolver(host, port):
        calls.append(host)
        if len(calls) > 1:
            raise UnsafeUrl("public DNS resolution failed")
        return ["93.184.216.34"]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=response_payload()))) as client:
        result = await scrape_landing(client, "key", "https://example.com/products/cart", SafeUrlClient(resolver=resolver))
    assert result.title == "Folding Cart"


async def test_changed_source_is_validated_before_saving():
    from rabbit_hole.integrations.collectors.firecrawl import scrape_landing
    payload = response_payload()
    payload["data"]["metadata"]["url"] = "http://127.0.0.1/admin"
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))) as client:
        with pytest.raises(ProviderError) as caught:
            await scrape_landing(client, "key", "https://example.com/products/cart", SafeUrlClient(resolver=resolve_public))
    assert caught.value.code == "unsafe_url"


async def test_page_title_does_not_include_embedded_app_titles():
    from rabbit_hole.integrations.collectors.firecrawl import scrape_landing
    payload = response_payload(html="<title>Cart</title><p>A folding cart. $79</p><title>Support chat</title>")
    payload["data"]["metadata"]["title"] = "Cart"
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))) as client:
        snapshot = await scrape_landing(client, "key", "https://example.com/products/cart", SafeUrlClient(resolver=resolve_public))
    assert snapshot.title == "Cart"
