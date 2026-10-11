"""Durable SSE log cursors must resume without inventing evidence."""
import json

import httpx
import pytest

from rabbit_hole.runtime.server import create_app


async def test_log_stream_validates_project_and_resume_cursor(db_engine):
    from uuid import uuid4

    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    app = create_app(checks={})
    app.state.workbench_store = store
    project = await store.create("SSE isolated", "test", "US", str(uuid4()))
    base = "/workbench/api/projects/" + project["id"] + "/log-stream"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1") as client:
        assert (await client.get(base + "?after=-1")).status_code == 422
        assert (await client.get(base, headers={"Last-Event-ID": "not-an-id"})).status_code == 422
        assert (await client.get("/workbench/api/projects/" + str(uuid4()) + "/log-stream")).status_code == 404
        assert (await client.get(base, headers={"Origin": "https://other.test"})).status_code == 403


async def test_sse_generator_resumes_and_closes_on_disconnect():
    from rabbit_hole.api.log_stream import stream_logs

    class Request:
        disconnected = False
        async def is_disconnected(self):
            return self.disconnected

    request = Request()
    calls = []
    async def reader(after):
        calls.append(after)
        return [{"id": after + 1, "message": "observed progress"}]

    stream = stream_logs(request, reader, after=10, pause=0)
    assert "retry:" in await anext(stream)
    event = await anext(stream)
    assert "id: 11" in event and "event: logs" in event
    data = json.loads(event.split("data: ", 1)[1])
    assert data["cursor"] == 11 and data["logs"][0]["message"] == "observed progress"
    event = await anext(stream)
    assert "id: 12" in event and calls == [10, 11]
    request.disconnected = True
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


async def test_sse_source_failure_is_generic_and_preserves_cursor():
    from rabbit_hole.api.log_stream import stream_logs

    class Request:
        async def is_disconnected(self):
            return False

    async def reader(after):
        raise RuntimeError("provider_key=secret")
    stream = stream_logs(Request(), reader, after=8, pause=0)
    await anext(stream)
    event = await anext(stream)
    assert "event: unavailable" in event
    assert "secret" not in event
    with pytest.raises(StopAsyncIteration):
        await anext(stream)

async def test_sse_duration_is_bounded():
    from rabbit_hole.api.log_stream import stream_logs
    class Request:
        async def is_disconnected(self):
            return False
    async def reader(after):
        pytest.fail("Expired stream must not query the database")
    stream = stream_logs(Request(), reader, after=0, duration=0)
    await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


async def test_sse_connection_limit_is_released_when_stream_closes(db_engine):
    from uuid import uuid4

    from fastapi import HTTPException
    from starlette.requests import Request

    from rabbit_hole.persistence.projects import WorkbenchStore

    app = create_app(checks={})
    store = WorkbenchStore(db_engine)
    app.state.workbench_store = store
    project = await store.create("stream capacity isolated", "test", "US", str(uuid4()))
    from rabbit_hole.api.workbench import create_workbench_router
    router = create_workbench_router()
    endpoint = next(route.endpoint for route in router.routes if getattr(route, "name", "") == "log_stream")
    scope = {"type": "http", "method": "GET", "path": "/", "scheme": "http",
        "headers": [(b"host", b"127.0.0.1")], "server": ("127.0.0.1", 80), "app": app}
    responses = []
    try:
        for _ in range(4):
            response = await endpoint(Request(scope), project["id"], after=0)
            assert response.media_type == "text/event-stream"
            await anext(response.body_iterator)
            responses.append(response)
        with pytest.raises(HTTPException) as caught:
            await endpoint(Request(scope), project["id"], after=0)
        assert caught.value.status_code == 429
        await responses.pop().body_iterator.aclose()
        reopened = await endpoint(Request(scope), project["id"], after=0)
        await anext(reopened.body_iterator)
        await reopened.body_iterator.aclose()
    finally:
        for response in responses:
            await response.body_iterator.aclose()
