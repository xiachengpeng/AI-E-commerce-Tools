from dataclasses import replace
import asyncio
import base64
from enum import Enum
from types import SimpleNamespace
import threading
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from google.genai import types as genai_types

from services.ai_adapters import (
    GeminiAdapter,
    OpenAICompatibleAdapter,
    VertexAdapter,
    convert_openai_messages,
    google_response_to_dict,
    get_adapter,
    close_adapters,
)
from services.ai_config_service import ProviderSnapshot
from services.image_validation import ValidatedImage


TINY_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe"
    "AAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)
TINY_PNG_BYTES = base64.b64decode(TINY_PNG_BASE64)


def make_snapshot(capability="text", **overrides):
    values = {
        "id": 1,
        "incarnation_id": "provider-incarnation-1",
        "capability": capability,
        "name": "Test provider",
        "protocol": "openai_compatible",
        "base_url": "https://api.example.com",
        "api_key": "secret-key",
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


def test_google_response_preserves_image_recitation_finish_metadata():
    class FinishReason(Enum):
        IMAGE_RECITATION = "IMAGE_RECITATION"

    response = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(role="model", parts=[]),
                finish_reason=FinishReason.IMAGE_RECITATION,
                finish_message="The model could not generate the image.",
            )
        ]
    )

    result = google_response_to_dict(response)

    assert result["candidates"][0]["finishReason"] == "IMAGE_RECITATION"
    assert result["candidates"][0]["finishMessage"] == (
        "The model could not generate the image."
    )


@pytest.mark.asyncio
async def test_openai_text_path_and_normalized_response():
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {
        "choices": [{"message": {"content": "hello"}}]
    }
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    result = await adapter.generate(
        snapshot=make_snapshot(capability="text"),
        payload={
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": "Hi"},
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": "AAAA",
                            }
                        },
                    ],
                }
            ]
        },
    )

    request = transport.post.await_args
    assert request.args[0] == "https://api.example.com/v1/chat/completions"
    assert request.kwargs["headers"] == {"Authorization": "Bearer secret-key"}
    assert request.kwargs["timeout"] == 30
    assert request.kwargs["json"] == {
        "model": "test-model",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Hi"},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/jpeg;base64,AAAA",
                        },
                    },
                ],
            }
        ],
    }
    response.raise_for_status.assert_called_once_with()
    assert result["candidates"][0]["content"]["parts"][0]["text"] == "hello"


@pytest.mark.asyncio
async def test_openai_text_json_mime_type_requests_json_object_response():
    response = MagicMock()
    response.json.return_value = {
        "choices": [{"message": {"content": "{}"}}]
    }
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    await adapter.generate(
        make_snapshot(capability="text"),
        {
            "contents": [{"parts": [{"text": "Return JSON"}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
            },
        },
    )

    assert transport.post.await_args.kwargs["json"]["response_format"] == {
        "type": "json_object"
    }


@pytest.mark.asyncio
async def test_openai_image_path_and_normalized_response():
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {
        "data": [{"b64_json": TINY_PNG_BASE64}]
    }
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    result = await adapter.generate(
        snapshot=make_snapshot(
            capability="image",
            image_generation_mode="text_to_image",
        ),
        payload={
            "contents": [
                {
                    "parts": [
                        {"text": "Draw a mug"},
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": TINY_PNG_BASE64,
                            }
                        },
                    ]
                }
            ]
        },
    )

    request = transport.post.await_args
    assert request.args[0] == "https://api.example.com/v1/images/generations"
    assert request.kwargs["json"] == {
        "model": "test-model",
        "prompt": "Draw a mug",
        "response_format": "b64_json",
    }
    assert request.kwargs["timeout"] == 30
    assert "files" not in request.kwargs
    response.raise_for_status.assert_called_once_with()
    assert (
        result["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        == TINY_PNG_BASE64
    )


@pytest.mark.asyncio
async def test_openai_image_forwards_inline_images_and_image_extensions():
    response = MagicMock()
    response.json.return_value = {
        "data": [{"b64_json": TINY_PNG_BASE64}]
    }
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    await adapter.generate(
        make_snapshot(
            capability="image",
            image_generation_mode="image_to_image",
        ),
        {
            "contents": [
                {
                    "parts": [
                        {"text": "Redraw"},
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": TINY_PNG_BASE64,
                            }
                        },
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": TINY_PNG_BASE64,
                            }
                        },
                    ]
                }
            ],
            "generationConfig": {
                "imageConfig": {
                    "aspectRatio": "1:1",
                }
            },
        },
    )

    request = transport.post.await_args
    assert request.args[0] == "https://api.example.com/v1/images/edits"
    assert request.kwargs["data"] == {
        "model": "test-model",
        "prompt": "Redraw",
        "response_format": "b64_json",
        "size": "1024x1024",
    }
    assert request.kwargs["files"] == [
        (
            "image[]",
            ("reference-1.png", TINY_PNG_BYTES, "image/png"),
        ),
        (
            "image[]",
            ("reference-2.png", TINY_PNG_BYTES, "image/png"),
        ),
    ]


@pytest.mark.asyncio
async def test_openai_image_edit_sends_mask_as_dedicated_field():
    response = MagicMock()
    response.json.return_value = {"data": [{"b64_json": TINY_PNG_BASE64}]}
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    await adapter.generate(
        make_snapshot(capability="image", image_generation_mode="image_to_image"),
        {
            "contents": [{"parts": [
                {"text": "Remove the mark"},
                {"inlineData": {"mimeType": "image/png", "data": TINY_PNG_BASE64}},
                {"inlineData": {"mimeType": "image/png", "data": TINY_PNG_BASE64}},
            ]}],
            "imageEdit": {"maskIndex": 1},
        },
    )

    files = transport.post.await_args.kwargs["files"]
    assert [field for field, _ in files] == ["image", "mask"]



@pytest.mark.asyncio
async def test_openai_image_to_image_missing_reference_makes_no_request():
    transport = MagicMock()
    transport.post = AsyncMock()
    adapter = OpenAICompatibleAdapter(client=transport)

    with pytest.raises(ValueError, match="缺少参考图"):
        await adapter.generate(
            make_snapshot(
                capability="image",
                image_generation_mode="image_to_image",
            ),
            {"contents": [{"parts": [{"text": "Redraw"}]}]},
        )

    transport.post.assert_not_awaited()


@pytest.mark.asyncio
async def test_openai_image_normalizes_safe_url_response(monkeypatch):
    response = MagicMock()
    response.json.return_value = {
        "data": [{"url": "https://cdn.example.com/result.png"}]
    }
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    fetched = AsyncMock(
        return_value=ValidatedImage(
            data=TINY_PNG_BYTES,
            mime_type="image/png",
            image_format="PNG",
            width=1,
            height=1,
        )
    )
    monkeypatch.setattr(
        "services.ai_adapters.fetch_public_image",
        fetched,
    )
    adapter = OpenAICompatibleAdapter(client=transport)

    result = await adapter.generate(
        make_snapshot(
            capability="image",
            image_generation_mode="text_to_image",
        ),
        {"contents": [{"parts": [{"text": "Draw"}]}]},
    )

    assert result["candidates"][0]["content"]["parts"][0][
        "inlineData"
    ] == {
        "mimeType": "image/png",
        "data": TINY_PNG_BASE64,
    }
    fetched.assert_awaited_once_with(
        "https://cdn.example.com/result.png",
        transport,
        timeout_seconds=30,
    )


@pytest.mark.asyncio
async def test_google_adapter_enforces_timeout_without_blocking_event_loop():
    started = threading.Event()
    release = threading.Event()
    client = MagicMock()

    def blocking_generate(**_kwargs):
        started.set()
        release.wait(1)
        return MagicMock(candidates=[])

    client.models.generate_content.side_effect = blocking_generate
    adapter = GeminiAdapter(client=client)
    snapshot = make_snapshot(
        protocol="gemini",
        base_url=None,
        timeout_seconds=0.01,
    )

    heartbeat = asyncio.create_task(asyncio.sleep(0))
    try:
        with pytest.raises(asyncio.TimeoutError):
            await adapter.generate(snapshot, {"contents": []})
        await heartbeat
        assert started.is_set()
    finally:
        release.set()


@pytest.mark.asyncio
async def test_gemini_converts_payload_and_normalizes_response():
    response_part = MagicMock(thought=False, text="hello", inline_data=None)
    response_content = MagicMock(role="model", parts=[response_part])
    sdk_response = MagicMock(
        candidates=[MagicMock(content=response_content)]
    )
    client = MagicMock()
    client.models.generate_content.return_value = sdk_response
    adapter = GeminiAdapter(client=client)
    snapshot = make_snapshot(
        protocol="gemini",
        api_key="gemini-key",
        base_url=None,
    )

    result = await adapter.generate(
        snapshot,
        {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": "Describe this"},
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": "YWFhYQ==",
                            }
                        },
                    ],
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseModalities": ["TEXT"],
            },
        },
    )

    call = client.models.generate_content.call_args
    assert call.kwargs["model"] == "test-model"
    assert call.kwargs["contents"][0].role == "user"
    assert call.kwargs["contents"][0].parts[0].text == "Describe this"
    assert call.kwargs["contents"][0].parts[1].inline_data.data == b"aaaa"
    assert call.kwargs["config"].response_mime_type == "application/json"
    assert result["candidates"][0]["content"]["parts"] == [{"text": "hello"}]


def test_gemini_client_cache_is_versioned_by_snapshot():
    adapter = GeminiAdapter()
    first_snapshot = make_snapshot(
        protocol="gemini",
        api_key="gemini-key",
        base_url=None,
    )
    first_client = MagicMock()
    second_client = MagicMock()

    with patch(
        "services.ai_adapters.genai.Client",
        side_effect=[first_client, second_client],
    ) as client_factory:
        assert adapter._client(first_snapshot) is first_client
        assert adapter._client(first_snapshot) is first_client
        assert (
            adapter._client(replace(first_snapshot, config_version=2))
            is second_client
        )

    assert client_factory.call_count == 2
    assert client_factory.call_args_list[0].kwargs["api_key"] == "gemini-key"
    assert client_factory.call_args_list[0].kwargs["http_options"].retry_options.attempts == 1


def test_gemini_client_cache_isolated_by_provider_incarnation():
    adapter = GeminiAdapter()
    first = make_snapshot(
        protocol="gemini",
        api_key="first-key",
        base_url=None,
    )
    replacement = replace(
        first,
        incarnation_id="replacement-incarnation",
        api_key="replacement-key",
    )
    first_client = MagicMock()
    replacement_client = MagicMock()

    with patch(
        "services.ai_adapters.genai.Client",
        side_effect=[first_client, replacement_client],
    ):
        assert adapter._client(first) is first_client
        assert adapter._client(replacement) is replacement_client

    first_client.close.assert_called_once_with()


def test_consecutive_draft_google_credentials_never_share_cached_client():
    adapter = GeminiAdapter()
    first = make_snapshot(
        id=0,
        protocol="gemini",
        api_key="first-draft-key",
        base_url=None,
    )
    second = replace(first, api_key="second-draft-key")
    clients = [MagicMock(), MagicMock()]

    with patch(
        "services.ai_adapters.genai.Client",
        side_effect=clients,
    ) as factory:
        assert adapter._client(first) is clients[0]
        assert adapter._client(second) is clients[1]

    assert factory.call_args_list[0].kwargs["api_key"] == "first-draft-key"
    assert factory.call_args_list[1].kwargs["api_key"] == "second-draft-key"


def test_superseded_google_client_is_evicted_and_closed():
    adapter = GeminiAdapter()
    first = make_snapshot(protocol="gemini", base_url=None)
    old_client = MagicMock()
    new_client = MagicMock()

    with patch(
        "services.ai_adapters.genai.Client",
        side_effect=[old_client, new_client],
    ):
        assert adapter._client(first) is old_client
        assert adapter._client(
            replace(first, config_version=2)
        ) is new_client

    old_client.close.assert_called_once_with()


def test_provider_invalidation_evicts_cached_google_clients(monkeypatch):
    import services.ai_adapters as adapter_module

    adapter = GeminiAdapter()
    current = make_snapshot(protocol="gemini", base_url=None)
    client = MagicMock()
    monkeypatch.setattr(
        adapter_module,
        "_ADAPTERS",
        {"gemini": adapter},
    )

    with patch("services.ai_adapters.genai.Client", return_value=client):
        adapter._client(current)
        adapter_module.invalidate_provider_clients(current.id)

    client.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_inflight_google_client_is_closed_only_after_request_finishes():
    adapter = GeminiAdapter()
    first = make_snapshot(
        protocol="gemini",
        base_url=None,
        timeout_seconds=2,
    )
    second = replace(first, config_version=2)
    started = threading.Event()
    release = threading.Event()
    old_client = MagicMock()
    new_client = MagicMock()

    def old_generate(**_kwargs):
        started.set()
        release.wait(1)
        return MagicMock(candidates=[])

    old_client.models.generate_content.side_effect = old_generate
    new_client.models.generate_content.return_value = MagicMock(candidates=[])

    with patch(
        "services.ai_adapters.genai.Client",
        side_effect=[old_client, new_client],
    ):
        old_request = asyncio.create_task(
            adapter.generate(first, {"contents": []})
        )
        assert await asyncio.to_thread(started.wait, 0.5)
        await adapter.generate(second, {"contents": []})
        old_client.close.assert_not_called()
        release.set()
        await old_request

    old_client.close.assert_called_once_with()


def test_vertex_uses_explicit_credentials_without_mutating_environment(
    monkeypatch,
):
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/existing/adc.json")
    adapter = VertexAdapter()
    snapshot = make_snapshot(
        protocol="vertex",
        api_key=None,
        base_url=None,
        vertex_project_id="project-id",
        vertex_location="us-central1",
        vertex_key_path="/tmp/vertex-key.json",
    )
    client = MagicMock()
    credentials = MagicMock(name="credentials")

    with patch(
        "google.oauth2.service_account.Credentials.from_service_account_file",
        return_value=credentials,
    ) as load_credentials:
        with patch(
            "services.ai_adapters.genai.Client", return_value=client
        ) as factory:
            assert adapter._client(snapshot) is client

    load_credentials.assert_called_once_with("/tmp/vertex-key.json")
    assert factory.call_args.kwargs["vertexai"] is True
    assert factory.call_args.kwargs["project"] == "project-id"
    assert factory.call_args.kwargs["location"] == "us-central1"
    assert factory.call_args.kwargs["credentials"] is credentials
    assert factory.call_args.kwargs["http_options"].retry_options.attempts == 1
    assert (
        __import__("os").environ["GOOGLE_APPLICATION_CREDENTIALS"]
        == "/existing/adc.json"
    )


def test_vertex_credentials_are_isolated_by_provider_and_config_version():
    adapter = VertexAdapter()
    provider_a_v1 = make_snapshot(
        id=10,
        protocol="vertex",
        api_key=None,
        base_url=None,
        vertex_project_id="project-a",
        vertex_location="us-central1",
        vertex_key_path="/keys/a-v1.json",
        config_version=1,
    )
    provider_b_v1 = replace(
        provider_a_v1,
        id=20,
        vertex_project_id="project-b",
        vertex_key_path="/keys/b-v1.json",
    )
    provider_a_v2 = replace(
        provider_a_v1,
        vertex_key_path="/keys/a-v2.json",
        config_version=2,
    )
    credentials = [MagicMock(name=f"credentials-{i}") for i in range(3)]
    clients = [MagicMock(name=f"client-{i}") for i in range(3)]

    with patch(
        "google.oauth2.service_account.Credentials.from_service_account_file",
        side_effect=credentials,
    ) as load_credentials:
        with patch(
            "services.ai_adapters.genai.Client",
            side_effect=clients,
        ) as client_factory:
            assert adapter._client(provider_a_v1) is clients[0]
            assert adapter._client(provider_a_v1) is clients[0]
            assert adapter._client(provider_b_v1) is clients[1]
            assert adapter._client(provider_a_v2) is clients[2]

    assert [
        item.args[0] for item in load_credentials.call_args_list
    ] == ["/keys/a-v1.json", "/keys/b-v1.json", "/keys/a-v2.json"]
    assert [
        item.kwargs["credentials"]
        for item in client_factory.call_args_list
    ] == credentials


def test_vertex_without_key_path_uses_application_default_credentials():
    adapter = VertexAdapter()
    snapshot = make_snapshot(
        protocol="vertex",
        api_key=None,
        base_url=None,
        vertex_project_id="project-id",
        vertex_location="us-central1",
        vertex_key_path=None,
    )

    with patch("services.ai_adapters.genai.Client") as client_factory:
        adapter._client(snapshot)

    assert client_factory.call_args.kwargs["vertexai"] is True
    assert client_factory.call_args.kwargs["project"] == "project-id"
    assert client_factory.call_args.kwargs["location"] == "us-central1"
    assert client_factory.call_args.kwargs["http_options"].retry_options.attempts == 1


@pytest.mark.parametrize(
    ("protocol", "adapter_type"),
    [
        ("gemini", GeminiAdapter),
        ("vertex", VertexAdapter),
        ("openai_compatible", OpenAICompatibleAdapter),
    ],
)
def test_get_adapter_returns_protocol_adapter(protocol, adapter_type):
    assert isinstance(get_adapter(protocol), adapter_type)


def test_get_adapter_rejects_unknown_protocol():
    with pytest.raises(ValueError, match="Unsupported AI protocol"):
        get_adapter("unknown")


@pytest.mark.asyncio
async def test_openai_adapter_closes_owned_async_client():
    client = MagicMock()
    client.aclose = AsyncMock()
    adapter = OpenAICompatibleAdapter(client=client)

    await adapter.close()

    client.aclose.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_close_adapters_closes_global_openai_client(monkeypatch):
    first = MagicMock()
    first.close = AsyncMock()
    second = MagicMock()
    second.close = AsyncMock()
    monkeypatch.setattr(
        "services.ai_adapters._ADAPTERS",
        {"first": first, "second": second},
    )

    await close_adapters()

    first.close.assert_awaited_once_with()
    second.close.assert_awaited_once_with()


def test_openai_messages_map_google_model_role_to_assistant():
    messages = convert_openai_messages(
        [{"role": "model", "parts": [{"text": "Previous answer"}]}]
    )

    assert messages[0]["role"] == "assistant"


@pytest.mark.asyncio
async def test_openai_image_to_image_retries_with_url_format_when_b64_rejected(monkeypatch):
    first_response = MagicMock()
    first_response.status_code = 400
    first_response.json.return_value = {
        "error": {"message": "站点用户 API 目前仅支持 response_format=url", "code": "bad_request"}
    }
    first_response.text = '{"error": {"message": "站点用户 API 目前仅支持 response_format=url"}}'

    second_response = MagicMock()
    second_response.status_code = 200
    second_response.raise_for_status = MagicMock()
    second_response.json.return_value = {"data": [{"url": "https://cdn.example.com/result.png"}]}

    transport = MagicMock()
    transport.post = AsyncMock(side_effect=[first_response, second_response])

    fetched = AsyncMock(
        return_value=ValidatedImage(
            data=TINY_PNG_BYTES,
            mime_type="image/png",
            image_format="PNG",
            width=1,
            height=1,
        )
    )
    monkeypatch.setattr("services.ai_adapters.fetch_public_image", fetched)
    adapter = OpenAICompatibleAdapter(client=transport)

    result = await adapter.generate(
        make_snapshot(
            capability="image",
            image_generation_mode="image_to_image",
        ),
        {
            "contents": [
                {
                    "parts": [
                        {"text": "Refine image"},
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": TINY_PNG_BASE64,
                            }
                        },
                    ]
                }
            ]
        },
    )

    assert transport.post.await_count == 2
    first_call_data = transport.post.await_args_list[0].kwargs["data"]
    second_call_data = transport.post.await_args_list[1].kwargs["data"]
    assert first_call_data["response_format"] == "b64_json"
    assert second_call_data["response_format"] == "url"
    assert result["candidates"][0]["content"]["parts"][0]["inlineData"]["data"] == TINY_PNG_BASE64


@pytest.mark.asyncio
async def test_openai_text_to_image_retries_with_url_format_when_b64_rejected(monkeypatch):
    first_response = MagicMock()
    first_response.status_code = 400
    first_response.json.return_value = {
        "error": {"message": "站点用户 API 目前仅支持 response_format=url", "code": "bad_request"}
    }
    first_response.text = '{"error": {"message": "站点用户 API 目前仅支持 response_format=url"}}'

    second_response = MagicMock()
    second_response.status_code = 200
    second_response.raise_for_status = MagicMock()
    second_response.json.return_value = {"data": [{"url": "https://cdn.example.com/result.png"}]}

    transport = MagicMock()
    transport.post = AsyncMock(side_effect=[first_response, second_response])

    fetched = AsyncMock(
        return_value=ValidatedImage(
            data=TINY_PNG_BYTES,
            mime_type="image/png",
            image_format="PNG",
            width=1,
            height=1,
        )
    )
    monkeypatch.setattr("services.ai_adapters.fetch_public_image", fetched)
    adapter = OpenAICompatibleAdapter(client=transport)

    result = await adapter.generate(
        make_snapshot(
            capability="image",
            image_generation_mode="text_to_image",
        ),
        {
            "contents": [
                {
                    "parts": [
                        {"text": "Draw a cat"},
                    ]
                }
            ]
        },
    )

    assert transport.post.await_count == 2
    first_call_json = transport.post.await_args_list[0].kwargs["json"]
    second_call_json = transport.post.await_args_list[1].kwargs["json"]
    assert first_call_json["response_format"] == "b64_json"
    assert second_call_json["response_format"] == "url"
    assert result["candidates"][0]["content"]["parts"][0]["inlineData"]["data"] == TINY_PNG_BASE64


@pytest.mark.asyncio
async def test_google_sdk_locked_to_single_attempt_on_transport(monkeypatch):
    calls = 0

    def handler(request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(503, text="Service Unavailable", request=request)

    mock_transport = httpx.MockTransport(handler)
    mock_http_client = httpx.Client(transport=mock_transport)

    adapter = GeminiAdapter()

    # Monkeypatch _build_client to inject mock transport client while retaining HttpRetryOptions(attempts=1)
    original_build = adapter._build_client

    def mocked_build(snapshot):
        # 1. Verify default build locks to single attempt
        default_client = original_build(snapshot)
        http_opts = getattr(default_client._api_client, "_http_options", None)
        assert http_opts is not None
        assert http_opts.retry_options.attempts == 1

        # 2. Return client configured with attempts=1 and mock transport
        custom_opts = genai_types.HttpOptions(
            retry_options=genai_types.HttpRetryOptions(attempts=1),
            httpx_client=mock_http_client,
        )
        return original_build(snapshot, http_options=custom_opts)

    monkeypatch.setattr(adapter, "_build_client", mocked_build)

    with pytest.raises(Exception):
        await adapter.generate(
            snapshot=make_snapshot(protocol="gemini", capability="text", model="gemini-2.5-flash"),
            payload={"contents": [{"parts": [{"text": "hello"}]}]},
        )

    # Crucial assertion: SDK must attempt exactly 1 HTTP call, not retry silently on 503
    assert calls == 1


@pytest.mark.asyncio
async def test_openai_headers_governed_by_capability():
    # 1. Official OpenAI sends X-Client-Request-Id when client_request_id is provided
    response_openai = MagicMock()
    response_openai.status_code = 200
    response_openai.headers = {"x-request-id": "req-upstream-999"}
    response_openai.json.return_value = {
        "choices": [{"message": {"content": "ok"}}]
    }
    client_openai = MagicMock()
    client_openai.post = AsyncMock(return_value=response_openai)

    adapter_openai = OpenAICompatibleAdapter(client=client_openai)
    res_openai = await adapter_openai.generate(
        snapshot=make_snapshot(name="openai", protocol="openai_compatible", capability="text"),
        payload={"contents": [{"parts": [{"text": "hi"}]}], "client_request_id": "client-uuid-1"},
    )
    sent_headers_openai = client_openai.post.await_args.kwargs["headers"]
    assert sent_headers_openai.get("X-Client-Request-Id") == "client-uuid-1"
    assert "Idempotency-Key" not in sent_headers_openai
    assert res_openai.get("requestId") == "req-upstream-999"

    # 2. Third-party provider (e.g. deepseek / generic) must NOT send X-Client-Request-Id or Idempotency-Key
    response_tp = MagicMock()
    response_tp.status_code = 200
    response_tp.headers = {}
    response_tp.json.return_value = {
        "choices": [{"message": {"content": "ok"}}]
    }
    client_tp = MagicMock()
    client_tp.post = AsyncMock(return_value=response_tp)

    adapter_tp = OpenAICompatibleAdapter(client=client_tp)
    await adapter_tp.generate(
        snapshot=make_snapshot(name="deepseek", protocol="openai_compatible", capability="text"),
        payload={"contents": [{"parts": [{"text": "hi"}]}], "client_request_id": "client-uuid-2"},
    )
    sent_headers_tp = client_tp.post.await_args.kwargs["headers"]
    assert "X-Client-Request-Id" not in sent_headers_tp
    assert "Idempotency-Key" not in sent_headers_tp



@pytest.mark.asyncio
async def test_openai_binary_edit_mask_converts_white_to_transparent():
    import io
    from PIL import Image

    mask = Image.new("L", (2, 2), 0)
    mask.putpixel((1, 1), 255)
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    response = MagicMock()
    response.json.return_value = {"data": [{"b64_json": TINY_PNG_BASE64}]}
    transport = MagicMock(post=AsyncMock(return_value=response))
    adapter = OpenAICompatibleAdapter(client=transport)
    payload = {
        "contents": [{"parts": [
            {"text": "Remove overlay"},
            {"inlineData": {"mimeType": "image/png", "data": encoded}},
            {"inlineData": {"mimeType": "image/png", "data": encoded}},
        ]}],
        "imageEdit": {"maskIndex": 1},
    }
    await adapter.generate(make_snapshot(capability="image", image_generation_mode="image_to_image"), payload)
    files = dict(transport.post.await_args.kwargs["files"])
    with Image.open(io.BytesIO(files["mask"][1])) as sent:
        assert sent.mode == "RGBA"
        assert sent.getpixel((1, 1))[3] == 0
        assert sent.getpixel((0, 0))[3] == 255
    assert files["image"][1] == buffer.getvalue()


@pytest.mark.asyncio
async def test_openai_masked_edit_rejects_text_to_image_before_network():
    transport = MagicMock(post=AsyncMock())
    adapter = OpenAICompatibleAdapter(client=transport)
    with pytest.raises(ValueError, match="图生图"):
        await adapter.generate(
            make_snapshot(capability="image", image_generation_mode="text_to_image"),
            {"contents": [{"parts": [{"text": "repair"}]}], "imageEdit": {"maskIndex": 1}},
        )
    transport.post.assert_not_awaited()
