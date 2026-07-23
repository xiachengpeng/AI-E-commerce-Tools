"""Tests for the capability-routed AIService compatibility facade."""

import inspect
import json
from unittest.mock import AsyncMock, patch

import pytest

from services.ai_service import AIService


def normalized_text_response(text):
    return {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [{"text": text}],
                }
            }
        ]
    }


@pytest.mark.asyncio
async def test_call_ai_routes_prompt_by_capability():
    response = normalized_text_response("Hello, World")
    with patch(
        "services.ai_service.ai_router.generate",
        new=AsyncMock(return_value=response),
    ) as generate:
        result = await AIService.call_ai(
            "test prompt",
            capability="image",
            response_mime_type="text/plain",
        )

    assert result == "Hello, World"
    generate.assert_awaited_once_with(
        "image",
        {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": "test prompt"}],
                }
            ],
            "generationConfig": {"responseMimeType": "text/plain"},
        },
    )


@pytest.mark.asyncio
async def test_call_ai_defaults_to_text_capability_and_json_response():
    with patch(
        "services.ai_service.ai_router.generate",
        new=AsyncMock(return_value=normalized_text_response('{"ok": true}')),
    ) as generate:
        result = await AIService.call_ai("json prompt")

    assert result == '{"ok": true}'
    assert generate.await_args.args[0] == "text"
    assert generate.await_args.args[1]["generationConfig"] == {
        "responseMimeType": "application/json"
    }


@pytest.mark.asyncio
async def test_generate_content_routes_payload_by_capability():
    payload = {"contents": [{"parts": [{"text": "draw"}]}]}
    response = {"candidates": []}
    with patch(
        "services.ai_service.ai_router.generate",
        new=AsyncMock(return_value=response),
    ) as generate:
        result = await AIService.generate_content(
            payload=payload,
            capability="image",
        )

    assert result is response
    generate.assert_awaited_once_with("image", payload)


def test_facade_does_not_accept_provider_or_model_selection():
    call_ai_parameters = inspect.signature(AIService.call_ai).parameters
    generate_parameters = inspect.signature(
        AIService.generate_content
    ).parameters

    assert "provider" not in call_ai_parameters
    assert "model_id" not in call_ai_parameters
    assert "provider" not in generate_parameters
    assert "model_id" not in generate_parameters


@pytest.mark.asyncio
async def test_call_ai_empty_candidates_raises_safe_error():
    with patch(
        "services.ai_service.ai_router.generate",
        new=AsyncMock(return_value={"candidates": []}),
    ):
        with pytest.raises(ValueError) as error:
            await AIService.call_ai("test")

    assert str(error.value) == "AI 响应中没有候选结果"


@pytest.mark.asyncio
async def test_call_ai_empty_parts_raises_safe_error():
    response = {"candidates": [{"content": {"parts": []}}]}
    with patch(
        "services.ai_service.ai_router.generate",
        new=AsyncMock(return_value=response),
    ):
        with pytest.raises(ValueError) as error:
            await AIService.call_ai("test")

    assert str(error.value) == "AI 响应候选结果中没有内容"


@pytest.mark.asyncio
async def test_translate_text_batch_success():
    lang_map = {
        "English": "Hello",
        "Japanese": "こんにちは",
        "French": "Bonjour",
    }
    json_str = json.dumps(lang_map, ensure_ascii=False)

    with patch.object(
        AIService,
        "call_ai",
        new=AsyncMock(return_value=json_str),
    ) as call_ai:
        result = await AIService.translate_text_batch(
            "你好",
            ["English", "Japanese", "French"],
        )

    assert result == lang_map
    assert call_ai.await_args.kwargs == {
        "capability": "text",
        "response_mime_type": "application/json",
    }


@pytest.mark.asyncio
async def test_translate_text_batch_json_with_markdown():
    lang_map = {"English": "Hello", "German": "Hallo"}
    md_json = f"```json\n{json.dumps(lang_map, ensure_ascii=False)}\n```"

    with patch.object(
        AIService,
        "call_ai",
        new=AsyncMock(return_value=md_json),
    ):
        result = await AIService.translate_text_batch(
            "你好",
            ["English", "German"],
        )

    assert result["English"] == "Hello"
    assert result["German"] == "Hallo"


@pytest.mark.asyncio
async def test_translate_text_batch_parse_failure():
    with patch.object(
        AIService,
        "call_ai",
        new=AsyncMock(return_value="not valid json"),
    ):
        result = await AIService.translate_text_batch(
            "你好",
            ["English"],
        )

    assert "English" in result
    assert "翻译失败" in result["English"]
