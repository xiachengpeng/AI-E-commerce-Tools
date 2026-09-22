import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import httpx
import pytest

from backend.services.ai_config_service import ProviderSnapshot
from backend.services.ai_router import (
    AIRouter,
    AIProviderRequestError,
    ExecutionTracker,
)
from backend.services.retry_service import (
    AmbiguousOutcomeError,
    ErrorCategory,
    ExecutionState,
    PolicyResolver,
)


def make_test_snapshot(capability="image", **overrides):
    values = {
        "id": 1,
        "incarnation_id": "incarnation-1",
        "capability": capability,
        "name": "test-provider",
        "protocol": "openai_compatible",
        "base_url": "https://api.example.com",
        "api_key": "sk-secret-12345",
        "vertex_project_id": None,
        "vertex_location": None,
        "vertex_key_path": None,
        "model": "test-model",
        "timeout_seconds": 30,
        "max_retries": 3,
        "config_version": 1,
    }
    values.update(overrides)
    return ProviderSnapshot(**values)


@pytest.mark.asyncio
async def test_ai_router_retries_transient_503_for_text(monkeypatch):
    router = AIRouter(base_delay=0.01)
    snapshot = make_test_snapshot(capability="text")
    monkeypatch.setattr("backend.services.ai_router.get_snapshot", lambda db, cap: snapshot)

    calls = 0
    mock_adapter = MagicMock()

    async def mock_generate(s, p):
        nonlocal calls
        calls += 1
        if calls < 3:
            req = httpx.Request("POST", "https://api.example.com")
            resp = httpx.Response(503, request=req)
            raise httpx.HTTPStatusError("503 Service Unavailable", request=req, response=resp)
        return {"candidates": [{"content": {"parts": [{"text": "Hello world"}]}}]}

    mock_adapter.generate = AsyncMock(side_effect=mock_generate)
    monkeypatch.setattr("backend.services.ai_router.get_adapter", lambda proto: mock_adapter)

    result = await router.generate(
        capability="text",
        payload={"contents": [{"parts": [{"text": "hi"}]}], "operation_id": "op_test_1"},
    )

    assert calls == 3
    assert result["candidates"][0]["content"]["parts"][0]["text"] == "Hello world"


@pytest.mark.asyncio
async def test_ai_router_image_read_timeout_blocks_retry_and_stops_fallback(monkeypatch):
    router = AIRouter(base_delay=0.01)
    snapshot = make_test_snapshot(capability="image")
    monkeypatch.setattr("backend.services.ai_router.get_snapshot", lambda db, cap: snapshot)

    calls = 0
    mock_adapter = MagicMock()

    async def mock_generate(s, p):
        nonlocal calls
        calls += 1
        # Read timeout on non-idempotent image generation
        raise httpx.ReadTimeout("Server processing image timed out after 30s")

    mock_adapter.generate = AsyncMock(side_effect=mock_generate)
    monkeypatch.setattr("backend.services.ai_router.get_adapter", lambda proto: mock_adapter)

    with pytest.raises(AIProviderRequestError) as exc_info:
        await router.generate(
            capability="image",
            payload={"contents": [{"parts": [{"text": "draw a cat"}]}], "operation_id": "op_img_ambiguous"},
        )

    # CRITICAL: Image generation MUST NOT be retried after ReadTimeout!
    assert calls == 1
    err = exc_info.value
    assert err.category in ("ambiguous_outcome", "timeout")
    if err.diagnostic:
        assert err.diagnostic.category in ("ambiguous_outcome", "timeout")


@pytest.mark.asyncio
async def test_ai_router_auth_error_fails_immediately_without_retry(monkeypatch):
    router = AIRouter(base_delay=0.01)
    snapshot = make_test_snapshot(capability="text")
    monkeypatch.setattr("backend.services.ai_router.get_snapshot", lambda db, cap: snapshot)

    calls = 0
    mock_adapter = MagicMock()

    async def mock_generate(s, p):
        nonlocal calls
        calls += 1
        req = httpx.Request("POST", "https://api.example.com")
        resp = httpx.Response(401, request=req, text="Unauthorized: invalid api key sk-secret-12345")
        raise httpx.HTTPStatusError("401 Unauthorized", request=req, response=resp)

    mock_adapter.generate = AsyncMock(side_effect=mock_generate)
    monkeypatch.setattr("backend.services.ai_router.get_adapter", lambda proto: mock_adapter)

    with pytest.raises(AIProviderRequestError) as exc_info:
        await router.generate(
            capability="text",
            payload={"contents": [{"parts": [{"text": "hi"}]}]},
        )

    # Auth error should never retry
    assert calls == 1
    err = exc_info.value
    assert err.category == "authentication"
    # Secret must be redacted
    if err.diagnostic:
        assert "sk-secret-12345" not in err.diagnostic.upstream_message


@pytest.mark.asyncio
async def test_ai_router_execution_state_tracking(monkeypatch):
    router = AIRouter(base_delay=0.01)
    snapshot = make_test_snapshot(capability="text")
    monkeypatch.setattr("backend.services.ai_router.get_snapshot", lambda db, cap: snapshot)

    mock_adapter = MagicMock()
    mock_adapter.generate = AsyncMock(return_value={"candidates": []})
    monkeypatch.setattr("backend.services.ai_router.get_adapter", lambda proto: mock_adapter)

    exec_id = "exec_track_123"
    op_id = "op_track_456"
    await router.generate(
        capability="text",
        payload={"contents": [{"parts": [{"text": "hi"}]}], "execution_id": exec_id, "operation_id": op_id},
    )

    state = ExecutionTracker.get_state(exec_id)
    assert state is not None
    assert state.execution_id == exec_id
    assert state.operation_id == op_id
    assert state.state == "succeeded"
