"""
测试 AIService —— google-genai SDK 调用封装
"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from services.ai_service import AIService


@pytest.fixture(autouse=True)
def reset_client():
    AIService._clients = {}
    yield
    AIService._clients = {}


def make_sdk_response(parts):
    content = MagicMock()
    content.role = "model"
    content.parts = parts

    candidate = MagicMock()
    candidate.content = content

    response = MagicMock()
    response.candidates = [candidate]
    return response


def make_text_part(text):
    part = MagicMock()
    part.thought = False
    part.text = text
    part.inline_data = None
    return part


def make_image_part(mime_type="image/png", data=b"aaaa"):
    inline_data = MagicMock()
    inline_data.mime_type = mime_type
    inline_data.data = data

    part = MagicMock()
    part.thought = False
    part.text = None
    part.inline_data = inline_data
    return part


@pytest.mark.asyncio
async def test_call_ai_success():
    """文本调用：返回第一段文本"""
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = make_sdk_response([
        make_text_part("Hello, World")
    ])

    with patch.object(AIService, "_get_client", return_value=mock_client):
        result = await AIService.call_ai("test prompt", provider="gemini")

    assert result == "Hello, World"
    mock_client.models.generate_content.assert_called_once()


@pytest.mark.asyncio
async def test_call_ai_json_output():
    """JSON 调用：保留 JSON 字符串"""
    json_str = '{"key": "value"}'
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = make_sdk_response([
        make_text_part(json_str)
    ])

    with patch.object(AIService, "_get_client", return_value=mock_client):
        result = await AIService.call_ai(
            "json prompt",
            provider="gemini",
            response_mime_type="application/json",
        )

    assert result == json_str


@pytest.mark.asyncio
async def test_generate_content_image_response_shape():
    """图片响应：转换成前端兼容的 inlineData 结构"""
    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = make_sdk_response([
        make_image_part(data=b"image-bytes")
    ])

    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": "generate image"},
                {"inlineData": {"mimeType": "image/jpeg", "data": "YWFhYQ=="}},
            ],
        }],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }

    with patch.object(AIService, "_get_client", return_value=mock_client):
        result = await AIService.generate_content("gemini-test", payload, provider="vertex")

    inline_data = result["candidates"][0]["content"]["parts"][0]["inlineData"]
    assert inline_data["mimeType"] == "image/png"
    assert inline_data["data"] == "aW1hZ2UtYnl0ZXM="


@pytest.mark.asyncio
async def test_call_ai_retries_then_success():
    """SDK 异常 → 指数退避后重试成功"""
    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = [
        RuntimeError("rate limited"),
        make_sdk_response([make_text_part("recovered")]),
    ]

    with patch.object(AIService, "_get_client", return_value=mock_client):
        with patch.object(AIService, "_MAX_RETRIES", 2):
            with patch("services.ai_service.time.sleep", return_value=None):
                result = await AIService.call_ai("test", provider="gemini")

    assert result == "recovered"
    assert mock_client.models.generate_content.call_count == 2


@pytest.mark.asyncio
async def test_call_ai_retry_exhausted():
    """所有 SDK 调用失败 → 抛出最后异常"""
    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = RuntimeError("boom")

    with patch.object(AIService, "_get_client", return_value=mock_client):
        with patch.object(AIService, "_MAX_RETRIES", 2):
            with patch("services.ai_service.time.sleep", return_value=None):
                with pytest.raises(RuntimeError):
                    await AIService.call_ai("test", provider="gemini")


@pytest.mark.asyncio
async def test_call_ai_empty_candidates():
    """响应无 candidates → ValueError"""
    response = MagicMock()
    response.candidates = []

    mock_client = MagicMock()
    mock_client.models.generate_content.return_value = response

    with patch.object(AIService, "_get_client", return_value=mock_client):
        with pytest.raises(ValueError):
            await AIService.call_ai("test", provider="gemini")


@pytest.mark.asyncio
async def test_translate_text_batch_success():
    """批量翻译：返回多语言字典"""
    lang_map = {"English": "Hello", "Japanese": "こんにちは", "French": "Bonjour"}
    json_str = json.dumps(lang_map, ensure_ascii=False)

    with patch.object(AIService, "call_ai", new=AsyncMock(return_value=json_str)):
        result = await AIService.translate_text_batch(
            "你好", ["English", "Japanese", "French"], provider="gemini"
        )

    assert result == lang_map


@pytest.mark.asyncio
async def test_translate_text_batch_json_with_markdown():
    """批量翻译：AI 返回包裹了 ```json``` 的响应"""
    lang_map = {"English": "Hello", "German": "Hallo"}
    md_json = f"```json\n{json.dumps(lang_map, ensure_ascii=False)}\n```"

    with patch.object(AIService, "call_ai", new=AsyncMock(return_value=md_json)):
        result = await AIService.translate_text_batch(
            "你好", ["English", "German"], provider="gemini"
        )

    assert result["English"] == "Hello"
    assert result["German"] == "Hallo"


@pytest.mark.asyncio
async def test_translate_text_batch_parse_failure():
    """批量翻译：JSON 解析失败 → 返回错误占位字典"""
    with patch.object(AIService, "call_ai", new=AsyncMock(return_value="not valid json")):
        result = await AIService.translate_text_batch(
            "你好", ["English"], provider="gemini"
        )

    assert "English" in result
    assert "翻译失败" in result["English"]
