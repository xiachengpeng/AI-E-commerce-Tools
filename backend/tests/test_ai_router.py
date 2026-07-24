import asyncio
import traceback
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from services.ai_config_service import ProviderSnapshot
from services.app_log_service import AppLogService
from services.ai_router import (
    AIProviderRequestError,
    AIRouter,
    diagnose_provider_error,
    map_provider_error,
)


def snapshot(*, id=1, max_retries=0, protocol="gemini"):
    return ProviderSnapshot(
        id=id,
        incarnation_id=f"provider-incarnation-{id}",
        capability="text",
        name=f"Provider {id}",
        protocol=protocol,
        base_url=None,
        api_key="secret-key",
        vertex_project_id=None,
        vertex_location=None,
        vertex_key_path=None,
        model=f"model-{id}",
        timeout_seconds=30,
        max_retries=max_retries,
        config_version=1,
    )


@pytest.mark.asyncio
async def test_next_request_uses_new_binding(monkeypatch):
    snapshots = [snapshot(id=1), snapshot(id=2)]
    get_snapshot = MagicMock(side_effect=snapshots)
    monkeypatch.setattr("services.ai_router.get_snapshot", get_snapshot)
    adapter = AsyncMock()
    adapter.generate.return_value = {"candidates": []}
    monkeypatch.setattr(
        "services.ai_router.get_adapter", lambda protocol: adapter
    )

    router = AIRouter()
    await router.generate("text", {"contents": []}, db=object())
    await router.generate("text", {"contents": []}, db=object())

    assert get_snapshot.call_count == 2
    assert [call.args[0].id for call in adapter.generate.await_args_list] == [
        1,
        2,
    ]


@pytest.mark.asyncio
async def test_ai_request_emits_start_before_success(monkeypatch):
    selected = snapshot(id=3)
    monkeypatch.setattr(
        "services.ai_router.get_snapshot",
        lambda db, capability: selected,
    )
    adapter = AsyncMock(return_value={"candidates": []})
    provider_adapter = MagicMock()
    provider_adapter.generate = adapter
    monkeypatch.setattr(
        "services.ai_router.get_adapter",
        lambda protocol: provider_adapter,
    )
    emit = MagicMock()
    monkeypatch.setattr("services.ai_router.app_logs.emit", emit)

    await AIRouter().generate("text", {}, db=object())

    assert [call.kwargs["message"] for call in emit.call_args_list] == [
        "AI 请求开始",
        "AI 请求完成",
    ]
    assert all(
        call.kwargs["provider"] == "Provider 3"
        and call.kwargs["model"] == "model-3"
        for call in emit.call_args_list
    )


@pytest.mark.asyncio
async def test_retry_does_not_change_provider(monkeypatch):
    selected = snapshot(id=9, max_retries=2)
    get_snapshot = MagicMock(return_value=selected)
    monkeypatch.setattr("services.ai_router.get_snapshot", get_snapshot)
    adapter = AsyncMock()
    adapter.generate.side_effect = [
        RuntimeError("rate limit"),
        {"candidates": []},
    ]
    monkeypatch.setattr(
        "services.ai_router.get_adapter", lambda protocol: adapter
    )

    await AIRouter(base_delay=0).generate("text", {}, db=object())

    get_snapshot.assert_called_once()
    assert adapter.generate.await_count == 2
    assert all(
        call.args[0].id == 9 for call in adapter.generate.await_args_list
    )


@pytest.mark.asyncio
async def test_retry_uses_async_exponential_sleep(monkeypatch):
    selected = snapshot(max_retries=2)
    monkeypatch.setattr(
        "services.ai_router.get_snapshot", lambda db, cap: selected
    )
    adapter = AsyncMock()
    adapter.generate.side_effect = [
        RuntimeError("first"),
        RuntimeError("second"),
        {"candidates": []},
    ]
    monkeypatch.setattr(
        "services.ai_router.get_adapter", lambda protocol: adapter
    )
    sleep = AsyncMock()
    monkeypatch.setattr("services.ai_router.asyncio.sleep", sleep)

    await AIRouter(base_delay=2).generate("text", {}, db=object())

    assert [call.args[0] for call in sleep.await_args_list] == [2, 4]


@pytest.mark.asyncio
async def test_owned_db_closes_before_network_request(monkeypatch):
    events = []
    db = MagicMock()
    db.close.side_effect = lambda: events.append("close")
    monkeypatch.setattr("services.ai_router.SessionLocal", lambda: db)
    monkeypatch.setattr(
        "services.ai_router.get_snapshot",
        lambda current_db, cap: snapshot(),
    )
    adapter = AsyncMock()

    async def generate(*args):
        events.append("network")
        return {"candidates": []}

    adapter.generate.side_effect = generate
    monkeypatch.setattr(
        "services.ai_router.get_adapter", lambda protocol: adapter
    )

    await AIRouter().generate("text", {})

    assert events == ["close", "network"]


@pytest.mark.asyncio
async def test_exhausted_retry_raises_and_logs_safe_domain_error(
    monkeypatch,
):
    selected = snapshot(id=7, max_retries=1)
    get_snapshot = MagicMock(return_value=selected)
    monkeypatch.setattr("services.ai_router.get_snapshot", get_snapshot)
    adapter = AsyncMock()
    request = httpx.Request(
        "POST",
        "https://provider.invalid/generate?key=query-secret",
    )
    response = httpx.Response(
        401,
        text="body-secret",
        request=request,
    )
    adapter.generate.side_effect = httpx.HTTPStatusError(
        "Authorization: Bearer header-secret",
        request=request,
        response=response,
    )
    get_adapter = MagicMock(return_value=adapter)
    monkeypatch.setattr("services.ai_router.get_adapter", get_adapter)
    monkeypatch.setattr(
        "services.ai_router.asyncio.sleep", AsyncMock()
    )
    emit = MagicMock()
    monkeypatch.setattr("services.ai_router.app_logs.emit", emit)

    with pytest.raises(AIProviderRequestError) as raised:
        await AIRouter(base_delay=0).generate("text", {}, db=object())

    get_snapshot.assert_called_once()
    get_adapter.assert_called_once_with("gemini")
    assert adapter.generate.await_count == 2
    assert raised.value.category == "authentication"
    assert str(raised.value) == "AI 提供商认证失败"
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    rendered_error = "".join(
        traceback.format_exception(raised.value)
    )
    assert "query-secret" not in rendered_error
    assert "body-secret" not in rendered_error
    assert "header-secret" not in rendered_error
    error_log = emit.call_args_list[-1].kwargs
    assert error_log["level"] == "error"
    assert error_log["message"]["summary"] == "AI 提供商认证失败"
    assert error_log["message"]["diagnostic"]["category"] == "authentication"
    assert "query-secret" not in error_log["message"]["summary"]
    assert "body-secret" not in error_log["message"]["summary"]
    assert "header-secret" not in error_log["message"]["summary"]


@pytest.mark.asyncio
async def test_raised_provider_diagnostic_is_sanitized_before_attachment(
    monkeypatch,
):
    selected = snapshot(max_retries=0)
    monkeypatch.setattr(
        "services.ai_router.get_snapshot", lambda db, cap: selected
    )
    request = httpx.Request("POST", "https://provider.invalid/generate")
    response = httpx.Response(
        401,
        json={
            "api_key": "body-api-key-secret",
            "access_token": "body-token-secret",
            "vertex_key_path": "/private/body-key.json",
            "prompt": "body-prompt-secret",
            "image_base64": "body-image-secret",
            "safe_detail": "retry after 10 seconds",
        },
        request=request,
    )
    error = httpx.HTTPStatusError(
        (
            "Authorization: Bearer message-token-secret "
            "api_key=message-api-key-secret "
            "vertex_key_path=/private/message-key.json "
            "prompt: message-prompt-secret "
            "image_data=message-image-secret status=retryable"
        ),
        request=request,
        response=response,
    )
    adapter = AsyncMock()
    adapter.generate.side_effect = error
    monkeypatch.setattr(
        "services.ai_router.get_adapter", lambda protocol: adapter
    )

    with pytest.raises(AIProviderRequestError) as raised:
        await AIRouter(base_delay=0).generate("text", {}, db=object())

    diagnostic = raised.value.diagnostic
    rendered = str(diagnostic)
    for secret in (
        "message-token-secret",
        "message-api-key-secret",
        "/private/message-key.json",
        "message-prompt-secret",
        "message-image-secret",
        "body-api-key-secret",
        "body-token-secret",
        "/private/body-key.json",
        "body-prompt-secret",
        "body-image-secret",
    ):
        assert secret not in rendered
    assert "status=retryable" in diagnostic.upstream_message
    assert diagnostic.response_body["safe_detail"] == "retry after 10 seconds"


@pytest.mark.asyncio
async def test_terminal_log_preserves_zero_based_retry_semantics(monkeypatch):
    selected = snapshot(max_retries=0)
    monkeypatch.setattr(
        "services.ai_router.get_snapshot", lambda db, cap: selected
    )
    adapter = AsyncMock()
    adapter.generate.side_effect = RuntimeError("provider unavailable")
    monkeypatch.setattr(
        "services.ai_router.get_adapter", lambda protocol: adapter
    )
    emit = MagicMock()
    monkeypatch.setattr("services.ai_router.app_logs.emit", emit)

    with pytest.raises(AIProviderRequestError):
        await AIRouter(base_delay=0).generate("text", {}, db=object())

    terminal_log = emit.call_args_list[-1].kwargs
    assert terminal_log["retry"] == 0
    assert terminal_log["message"]["attempt"] == 1
    assert terminal_log["message"]["max_attempts"] == 1


class ProviderError(RuntimeError):
    def __init__(self, raw_message, *, status_code=None, code=None):
        super().__init__(raw_message)
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code


@pytest.mark.parametrize(
    ("error", "category", "message"),
    [
        (
            ProviderError("secret", status_code=403),
            "authentication",
            "AI 提供商认证失败",
        ),
        (
            ProviderError("secret", code="UNAUTHENTICATED"),
            "authentication",
            "AI 提供商认证失败",
        ),
        (
            ProviderError("secret", code=404),
            "model_not_found",
            "AI 模型不存在或不可用",
        ),
        (
            ProviderError("secret", code="MODEL_NOT_FOUND"),
            "model_not_found",
            "AI 模型不存在或不可用",
        ),
        (
            ProviderError("secret", status_code=429),
            "rate_limit",
            "AI 提供商请求频率受限",
        ),
        (
            ProviderError("secret", code="RESOURCE_EXHAUSTED"),
            "rate_limit",
            "AI 提供商请求频率受限",
        ),
        (
            TimeoutError("secret"),
            "timeout",
            "AI 提供商请求超时",
        ),
        (
            asyncio.TimeoutError("secret"),
            "timeout",
            "AI 提供商请求超时",
        ),
        (
            httpx.ReadTimeout("secret"),
            "timeout",
            "AI 提供商请求超时",
        ),
        (
            ProviderError("secret", status_code=405),
            "protocol_incompatible",
            "AI 提供商协议不兼容",
        ),
        (
            ProviderError("secret", code="UNIMPLEMENTED"),
            "protocol_incompatible",
            "AI 提供商协议不兼容",
        ),
        (
            KeyError("missing provider response field: secret"),
            "protocol_incompatible",
            "AI 提供商协议不兼容",
        ),
        (
            RuntimeError("upstream response secret"),
            "upstream_failure",
            "AI 提供商请求失败",
        ),
    ],
)
def test_provider_errors_map_to_safe_categories(error, category, message):
    mapped = map_provider_error(error)

    assert isinstance(mapped, AIProviderRequestError)
    assert mapped.category == category
    assert str(mapped) == message
    assert "secret" not in str(mapped)


def test_diagnose_provider_error_normalizes_http_response_details():
    request = httpx.Request("POST", "https://provider.invalid/generate")
    response = httpx.Response(
        429,
        headers={"x-request-id": "request-429"},
        json={
            "error": {
                "code": "RATE_LIMITED",
                "message": "retry later",
            }
        },
        request=request,
    )
    error = httpx.HTTPStatusError(
        "provider returned 429",
        request=request,
        response=response,
    )

    diagnostic = diagnose_provider_error(error)

    assert diagnostic.category == "rate_limit"
    assert diagnostic.http_status == 429
    assert diagnostic.provider_code == "RATE_LIMITED"
    assert diagnostic.request_id == "request-429"
    assert diagnostic.exception_type == "HTTPStatusError"
    assert diagnostic.upstream_message == "provider returned 429"
    assert diagnostic.response_body == {
        "error": {"code": "RATE_LIMITED", "message": "retry later"}
    }
    assert map_provider_error(error).diagnostic == diagnostic


def test_diagnose_provider_error_reads_provider_code_attribute():
    diagnostic = diagnose_provider_error(
        ProviderError("rate limited", code="RATE_LIMITED")
    )

    assert diagnostic.category == "rate_limit"
    assert diagnostic.provider_code == "RATE_LIMITED"


@pytest.mark.asyncio
async def test_detailed_retry_and_terminal_logs_include_diagnostics(
    monkeypatch,
):
    selected = snapshot(max_retries=1)
    monkeypatch.setattr(
        "services.ai_router.get_snapshot", lambda db, cap: selected
    )
    request = httpx.Request("POST", "https://provider.invalid/generate")
    response = httpx.Response(
        429,
        headers={"x-goog-request-id": "google-request-429"},
        json={
            "error": {"code": "RATE_LIMITED", "message": "retry later"},
            "api_key": "body-api-secret",
        },
        request=request,
    )
    error = httpx.HTTPStatusError(
        "Authorization: Bearer message-secret",
        request=request,
        response=response,
    )
    adapter = AsyncMock()
    adapter.generate.side_effect = error
    monkeypatch.setattr(
        "services.ai_router.get_adapter", lambda protocol: adapter
    )
    monkeypatch.setattr("services.ai_router.asyncio.sleep", AsyncMock())
    logs = AppLogService()
    monkeypatch.setattr("services.ai_router.app_logs", logs)

    with pytest.raises(AIProviderRequestError):
        await AIRouter(base_delay=0).generate("text", {}, db=object())

    retry_log, terminal_log = [
        entry
        for entry in logs.recent()
        if entry["level"] in {"warning", "error"}
    ]
    for log in (retry_log, terminal_log):
        assert log["duration_ms"] >= 0
        diagnostic = log["message"]["diagnostic"]
        assert diagnostic["category"] == "rate_limit"
        assert diagnostic["http_status"] == 429
        assert diagnostic["provider_code"] == "RATE_LIMITED"
        assert diagnostic["request_id"] == "google-request-429"
        assert diagnostic["exception_type"] == "HTTPStatusError"
        assert diagnostic["response_body"]["error"] == {
            "code": "RATE_LIMITED",
            "message": "retry later",
        }
        assert "message-secret" not in str(log)
        assert "body-api-secret" not in str(log)
    assert retry_log["message"]["summary"] == "AI 请求重试"
    assert retry_log["retry"] == 1
    assert retry_log["message"]["attempt"] == 1
    assert retry_log["message"]["max_attempts"] == 2
    assert terminal_log["message"]["summary"] == "AI 提供商请求频率受限"
    assert terminal_log["retry"] == 1
    assert terminal_log["message"]["attempt"] == 2
    assert terminal_log["message"]["max_attempts"] == 2
