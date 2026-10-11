"""Private AI relay configuration and runtime resolution."""
import json
import stat
from types import SimpleNamespace

import httpx
import pytest


def test_saved_relay_overrides_environment_and_blank_key_preserves_secret(tmp_path):
    from rabbit_hole.integrations.ai_settings import AISettings

    vault = AISettings(tmp_path / "ai.json")
    fallback = SimpleNamespace(openai_api_key="env-secret", openai_base_url="https://old.example/v1", openai_model="old-model")
    assert vault.resolve(fallback).model == "old-model"
    vault.update({"api_key": "relay-secret", "base_url": "https://relay.example/v1/", "model": "new-model"})
    vault.update({"api_key": "", "base_url": "https://other.example/v1", "model": "next-model"})
    effective = vault.resolve(fallback)
    assert effective.api_key == "relay-secret"
    assert effective.base_url == "https://other.example/v1"
    assert effective.model == "next-model"
    assert stat.S_IMODE(vault.path.stat().st_mode) == 0o600
    assert "relay-secret" not in json.dumps(vault.public(fallback))
    vault.reset()
    assert vault.resolve(fallback).api_key == "env-secret"


@pytest.mark.parametrize("url", ["ftp://relay.example", "https://user:secret@relay.example/v1", "https://relay.example/v1?key=secret", "https://relay.example/v1#secret"])
def test_invalid_or_secret_bearing_urls_are_rejected(tmp_path, url):
    from rabbit_hole.integrations.ai_settings import AISettings

    with pytest.raises(ValueError):
        AISettings(tmp_path / "ai.json").update({"api_key": "key", "base_url": url, "model": "model"})
    assert not (tmp_path / "ai.json").exists()


async def test_api_requires_session_and_never_echoes_keys(tmp_path, monkeypatch):
    from rabbit_hole.runtime.server import create_app

    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    monkeypatch.setenv("RABBIT_HOLE_OPENAI_API_KEY", "environment-secret")
    monkeypatch.setenv("RABBIT_HOLE_OPENAI_MODEL", "environment-model")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(checks={})), base_url="http://localhost:8000") as client:
        url = "/workbench/api/ai-settings"
        assert (await client.post(url, json={"model": "m"})).status_code == 403
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        result = await client.post(url, headers={"X-Workbench-Token": token}, json={"api_key": "private-relay-key", "base_url": "https://relay.example/v1", "model": "relay-model"})
        assert result.status_code == 200
        assert result.json()["configured"] is True
        read = await client.get(url)
        assert read.json()["model"] == "relay-model"
        assert read.json()["source"] == "saved"
        assert "private-relay-key" not in read.text + result.text
        assert "environment-secret" not in read.text
        reset = await client.post(url, headers={"X-Workbench-Token": token}, json={"reset": True})
        assert reset.json()["source"] == "environment"


@pytest.mark.parametrize('market,language,country', [('US','English','United States'), ('GB','English','United Kingdom'), ('CA','English','Canada'), ('AU','English','Australia'), ('DE','German','Germany'), ('FR','French','France'), ('JP','Japanese','Japan')])
async def test_runner_uses_saved_relay_for_next_ai_request(tmp_path, monkeypatch, market, language, country):
    from unittest.mock import AsyncMock

    import openai

    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.integrations.ai_settings import AISettings

    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    AISettings().update({"api_key": "runtime-private-key", "base_url": "https://new-relay.example/v1", "model": "runtime-model"})
    calls = {}
    async def create(**kwargs):
        calls.update(kwargs)
        raise RuntimeError("isolated-stop-before-network")
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), close=AsyncMock())
    def factory(**kwargs):
        calls.update(kwargs)
        return client
    monkeypatch.setattr(openai, "AsyncOpenAI", factory)
    runner = WorkbenchRunner(None, SimpleNamespace(openai_api_key="old-key", openai_base_url="https://old.example/v1", openai_model="old-model"), None)
    monkeypatch.setattr(runner, "_reserve_ai", AsyncMock())
    with pytest.raises(RuntimeError, match="isolated-stop-before-network"):
        await runner.suggest({"kind": "keywords", "payload": {}}, {"direction": "travel", "market": market, "rules": {}, "limits": {}})
    assert f"Use {language} search phrases for {country}" in calls["messages"][0]["content"]
    assert calls["api_key"] == "runtime-private-key"
    assert calls["base_url"] == "https://new-relay.example/v1"
    assert calls["model"] == "runtime-model"
    client.close.assert_awaited_once()
