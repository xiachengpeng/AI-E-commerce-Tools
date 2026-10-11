"""Reading-only translation: source binding, privacy, deduplication and failures."""
import asyncio
import copy
from uuid import uuid4

import httpx
import pytest

from rabbit_hole.runtime.server import create_app


@pytest.fixture
def saved_ads():
    return {"id": str(uuid4()), "version": 7, "keywords": [{
        "id": "word", "ads": [{"id": "ad", "primary_text": "Travel with your pet."}],
    }]}


async def test_translation_requires_csrf_and_exact_saved_source(saved_ads, monkeypatch, tmp_path):
    from rabbit_hole.integrations.ad_translation import TranslationService
    calls = []

    async def translate(self, text):
        calls.append(text)
        return {"translated": "带宠物一起旅行。", "cached": False}

    monkeypatch.setattr(TranslationService, "translate", translate)
    app = create_app(checks={})

    class Store:
        async def get(self, project_id):
            assert project_id == saved_ads["id"]
            return copy.deepcopy(saved_ads)

    app.state.workbench_store = Store()
    before = copy.deepcopy(saved_ads)
    url = f"/workbench/api/projects/{saved_ads['id']}/ads/translate"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        payload = {"keyword_id": "word", "ad_id": "ad", "expected_text": "Travel with your pet."}
        assert (await client.post(url, json=payload)).status_code == 403
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        headers = {"X-Workbench-Token": token}
        assert (await client.post(url, json=payload, headers={**headers, "Origin": "https://evil.example"})).status_code == 403
        assert (await client.post(url, json={**payload, "ad_id": "missing"}, headers=headers)).status_code == 404
        assert (await client.post(url, json={**payload, "expected_text": "arbitrary text"}, headers=headers)).status_code == 409
        response = await client.post(url, json=payload, headers=headers)
        assert response.status_code == 200
        assert response.json()["translated"] == "带宠物一起旅行。"
    assert calls == ["Travel with your pet."]
    assert saved_ads == before


async def test_success_cached_durably_and_concurrent_clicks_deduplicated(tmp_path, monkeypatch):
    from rabbit_hole.integrations.ad_translation import TranslationService
    count = 0

    async def provider(text):
        nonlocal count
        count += 1
        await asyncio.sleep(0.01)
        return {"translated": "中文：" + text, "detected_language": "en"}

    service = TranslationService(tmp_path / "cache.sqlite3")
    monkeypatch.setattr(service, "_request", provider)
    first, second = await asyncio.gather(service.translate("Travel"), service.translate("Travel"))
    assert first["translated"] == second["translated"] == "中文：Travel"
    assert count == 1
    restarted = TranslationService(tmp_path / "cache.sqlite3")
    monkeypatch.setattr(restarted, "_request", provider)
    assert (await restarted.translate("Travel"))["cached"] is True
    await restarted.translate("New text")
    assert count == 2
    assert (tmp_path / "cache.sqlite3").stat().st_mode & 0o777 == 0o600


async def test_failed_translation_is_retryable_and_not_cached(tmp_path, monkeypatch):
    from rabbit_hole.integrations.ad_translation import (
        TranslationError,
        TranslationService,
    )
    service = TranslationService(tmp_path / "cache.sqlite3")

    async def failure(text):
        raise TranslationError("翻译服务暂不可用，请重试")

    monkeypatch.setattr(service, "_request", failure)
    with pytest.raises(TranslationError):
        await service.translate("Original")
    async def success(text):
        return {"translated": "原文", "detected_language": "en"}
    monkeypatch.setattr(service, "_request", success)
    assert (await service.translate("Original"))["cached"] is False


async def test_long_ads_preserved_without_truncation(tmp_path, monkeypatch):
    from rabbit_hole.integrations.ad_translation import TranslationService
    service = TranslationService(tmp_path / "cache.sqlite3")
    sizes = []
    async def provider(text):
        sizes.append(len(text))
        return {"translated": text, "detected_language": "en"}
    monkeypatch.setattr(service, "_request", provider)
    source = "a" * 5001
    assert (await service.translate(source))["translated"] == source
    assert max(sizes) <= 5000


def test_credentials_private_and_never_public(tmp_path):
    from rabbit_hole.integrations.ad_translation import TranslationSettings
    settings = TranslationSettings(tmp_path / "translation.json")
    result = settings.update({"access_key_id": "test-id", "access_key_secret": "test-secret"})
    assert result == {"configured": True}
    assert "test-secret" not in repr(settings.resolve())
    assert settings.path.stat().st_mode & 0o777 == 0o600


async def test_sdk_uses_auto_detection_and_hides_raw_errors(tmp_path, monkeypatch):
    from alibabacloud_alimt20181012.client import Client

    from rabbit_hole.integrations.ad_translation import (
        TranslationError,
        TranslationService,
        TranslationSettings,
    )
    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    TranslationSettings().update({"access_key_id": "test-id", "access_key_secret": "test-secret"})
    async def bad_response(self, request, runtime):
        assert request.source_language == "auto"
        assert request.target_language == "zh"
        assert request.source_text == "Original"
        assert runtime.autoretry is False
        raise RuntimeError("test-secret RAW SENSITIVE REQUEST")
    monkeypatch.setattr(Client, "translate_general_with_options_async", bad_response)
    with pytest.raises(TranslationError) as error:
        await TranslationService().translate("Original")
    assert "test-secret" not in str(error.value)
    assert "RAW" not in str(error.value)

async def test_tls_failure_explains_network_without_exposing_sdk_request(tmp_path, monkeypatch):
    from alibabacloud_alimt20181012.client import Client
    from Tea.exceptions import RetryError, UnretryableException
    from Tea.request import TeaRequest

    from rabbit_hole.integrations.ad_translation import (
        TranslationError,
        TranslationService,
        TranslationSettings,
    )

    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    TranslationSettings().update({"access_key_id": "test-id", "access_key_secret": "test-secret"})
    async def tls_failure(self, request, runtime):
        raw = TeaRequest()
        raw.headers = {"SECRET": "test-secret"}
        raise UnretryableException(raw, RetryError("SSL: UNEXPECTED_EOF_WHILE_READING"))
    monkeypatch.setattr(Client, "translate_general_with_options_async", tls_failure)
    with pytest.raises(TranslationError, match="HTTPS 连接失败") as error:
        await TranslationService().translate("Original")
    assert "test-secret" not in str(error.value)

@pytest.mark.parametrize("code", [200, "200", "10010"])
async def test_sdk_accepts_real_string_success_code_and_reports_activation(tmp_path, monkeypatch, code):
    from alibabacloud_alimt20181012.client import Client
    from alibabacloud_alimt20181012.models import TranslateGeneralResponse

    from rabbit_hole.integrations.ad_translation import (
        TranslationError,
        TranslationService,
        TranslationSettings,
    )

    monkeypatch.setenv("RABBIT_HOLE_PROVIDER_SECRETS_PATH", str(tmp_path / "keys.json"))
    TranslationSettings().update({"access_key_id": "test-id", "access_key_secret": "test-secret"})
    async def response(self, request, runtime):
        return TranslateGeneralResponse().from_map({
            "body": {"Code": code, "Data": {"Translated": "带宠物一起旅行。", "DetectedLanguage": "en"}},
        })
    monkeypatch.setattr(Client, "translate_general_with_options_async", response)
    if str(code) == "200":
        result = await TranslationService().translate("Travel with your pet.")
        assert result["translated"] == "带宠物一起旅行。"
        assert result["detected_language"] == "en"
    else:
        with pytest.raises(TranslationError, match="开通机器翻译"):
            await TranslationService().translate("Travel with your pet.")


@pytest.mark.parametrize("text", ["{{product.brand}}", "Buy {{product.name}} today", ""])
async def test_unavailable_saved_copy_rejected_without_provider_call(saved_ads, monkeypatch, text):
    from rabbit_hole.integrations.ad_translation import TranslationService
    saved_ads["keywords"][0]["ads"][0]["primary_text"] = text
    async def unexpected(self, source):
        pytest.fail("Unresolved copy must not call the paid translator")
    monkeypatch.setattr(TranslationService, "translate", unexpected)
    app = create_app(checks={})
    class Store:
        async def get(self, project_id):
            return copy.deepcopy(saved_ads)
    app.state.workbench_store = Store()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost:8000") as client:
        token = (await client.get("/workbench/api/session")).json()["csrf_token"]
        response = await client.post(
            f"/workbench/api/projects/{saved_ads['id']}/ads/translate",
            json={"keyword_id": "word", "ad_id": "ad", "expected_text": text},
            headers={"X-Workbench-Token": token},
        )
    assert response.status_code == 422
    assert "正文" in response.json()["detail"]
