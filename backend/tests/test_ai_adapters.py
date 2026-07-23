from dataclasses import replace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.ai_adapters import (
    GeminiAdapter,
    OpenAICompatibleAdapter,
    VertexAdapter,
    convert_openai_messages,
    get_adapter,
)
from services.ai_config_service import ProviderSnapshot


def make_snapshot(capability="text", **overrides):
    values = {
        "id": 1,
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


def test_vertex_client_uses_snapshot_credentials_and_versioned_cache(
    monkeypatch,
):
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
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

    with patch("services.ai_adapters.genai.Client", return_value=client) as factory:
        assert adapter._client(snapshot) is client
        assert adapter._client(snapshot) is client

    factory.assert_called_once_with(
        vertexai=True,
        project="project-id",
        location="us-central1",
    )
    assert (
        __import__("os").environ["GOOGLE_APPLICATION_CREDENTIALS"]
        == "/tmp/vertex-key.json"
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


def test_openai_messages_map_google_model_role_to_assistant():
    messages = convert_openai_messages(
        [{"role": "model", "parts": [{"text": "Previous answer"}]}]
    )

    assert messages[0]["role"] == "assistant"
