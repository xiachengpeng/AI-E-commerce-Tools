from dataclasses import replace
import asyncio
from enum import Enum
from types import SimpleNamespace
import threading
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

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
    response.json.return_value = {"data": [{"b64_json": "AAAA"}]}
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    result = await adapter.generate(
        snapshot=make_snapshot(capability="image"),
        payload={"contents": [{"parts": [{"text": "Draw a mug"}]}]},
    )

    request = transport.post.await_args
    assert request.args[0] == "https://api.example.com/v1/images/generations"
    assert request.kwargs["json"] == {
        "model": "test-model",
        "prompt": "Draw a mug",
        "response_format": "b64_json",
    }
    assert request.kwargs["timeout"] == 30
    response.raise_for_status.assert_called_once_with()
    assert (
        result["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        == "AAAA"
    )


@pytest.mark.asyncio
async def test_openai_image_forwards_inline_images_and_image_extensions():
    response = MagicMock()
    response.json.return_value = {"data": [{"b64_json": "RESULT"}]}
    transport = MagicMock()
    transport.post = AsyncMock(return_value=response)
    adapter = OpenAICompatibleAdapter(client=transport)

    await adapter.generate(
        make_snapshot(capability="image"),
        {
            "contents": [
                {
                    "parts": [
                        {"text": "Redraw"},
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": "SOURCE",
                            }
                        },
                    ]
                }
            ],
            "generationConfig": {
                "imageConfig": {
                    "aspectRatio": "1:1",
                    "imageSize": "2K",
                }
            },
        },
    )

    body = transport.post.await_args.kwargs["json"]
    assert body["input_images"] == [
        {"url": "data:image/png;base64,SOURCE"}
    ]
    assert body["aspect_ratio"] == "1:1"
    assert body["image_size"] == "2K"


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
    client_factory.assert_any_call(api_key="gemini-key")


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
    factory.assert_called_once_with(
        vertexai=True,
        project="project-id",
        location="us-central1",
        credentials=credentials,
    )
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

    client_factory.assert_called_once_with(
        vertexai=True,
        project="project-id",
        location="us-central1",
    )


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
