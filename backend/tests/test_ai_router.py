from unittest.mock import AsyncMock, MagicMock

import pytest

from services.ai_config_service import ProviderSnapshot
from services.ai_router import AIRouter


def snapshot(*, id=1, max_retries=0, protocol="gemini"):
    return ProviderSnapshot(
        id=id,
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
async def test_exhausted_retry_logs_safe_summary_and_does_not_fail_over(
    monkeypatch,
):
    selected = snapshot(id=7, max_retries=1)
    get_snapshot = MagicMock(return_value=selected)
    monkeypatch.setattr("services.ai_router.get_snapshot", get_snapshot)
    adapter = AsyncMock()
    adapter.generate.side_effect = RuntimeError(
        "Authorization: Bearer super-secret"
    )
    get_adapter = MagicMock(return_value=adapter)
    monkeypatch.setattr("services.ai_router.get_adapter", get_adapter)
    monkeypatch.setattr(
        "services.ai_router.asyncio.sleep", AsyncMock()
    )
    emit = MagicMock()
    monkeypatch.setattr("services.ai_router.app_logs.emit", emit)

    with pytest.raises(RuntimeError, match="super-secret"):
        await AIRouter(base_delay=0).generate("text", {}, db=object())

    get_snapshot.assert_called_once()
    get_adapter.assert_called_once_with("gemini")
    assert adapter.generate.await_count == 2
    error_log = emit.call_args_list[-1].kwargs
    assert error_log["level"] == "error"
    assert error_log["message"] == "AI 提供商请求失败"
    assert "super-secret" not in repr(error_log)
