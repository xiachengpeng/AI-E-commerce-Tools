"""
测试 AIService —— 核心 AI 调用与重试逻辑
"""
import json
import pytest
import httpx
from unittest.mock import AsyncMock, MagicMock, patch

from services.ai_service import AIService
from tests.conftest import make_ai_response, make_http_response


# 每次测试前重置客户端单例，避免测试间污染
@pytest.fixture(autouse=True)
def reset_client():
    AIService._client = None
    AIService._vertex_token = None
    AIService._token_expiry = 0
    yield
    AIService._client = None


# ============================================================
# call_ai — 正常路径
# ============================================================

@pytest.mark.asyncio
async def test_call_ai_gemini_success():
    """Gemini 正常调用：返回 AI 文本"""
    mock_resp = make_http_response(200, make_ai_response("Hello, World"))

    with patch.object(AIService, "_get_client") as mock_get:
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_get.return_value = mock_client

        result = await AIService.call_ai("test prompt", provider="gemini")
        assert result == "Hello, World"
        mock_client.post.assert_called_once()


@pytest.mark.asyncio
async def test_call_ai_json_output():
    """Gemini 调用：返回 JSON 字符串"""
    json_str = '{"key": "value"}'
    mock_resp = make_http_response(200, make_ai_response(json_str))

    with patch.object(AIService, "_get_client") as mock_get:
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_get.return_value = mock_client

        result = await AIService.call_ai("json prompt", provider="gemini",
                                         response_mime_type="application/json")
        assert result == json_str


# ============================================================
# call_ai — 重试逻辑
# ============================================================

@pytest.mark.asyncio
async def test_call_ai_retry_on_429():
    """HTTP 429 → 自动重试后成功"""
    fail_resp = make_http_response(429)
    ok_resp = make_http_response(200, make_ai_response("recovered"))

    with patch.object(AIService, "_get_client") as mock_get:
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(side_effect=[fail_resp, ok_resp])
        mock_get.return_value = mock_client

        # 临时缩短重试等待时间
        with patch.object(AIService, "_MAX_RETRIES", 3):
            result = await AIService.call_ai("test", provider="gemini")
            assert result == "recovered"
            assert mock_client.post.call_count == 2


@pytest.mark.asyncio
async def test_call_ai_retry_exhausted():
    """所有重试都失败 → 抛出异常"""
    fail_resp = make_http_response(500)

    with patch.object(AIService, "_get_client") as mock_get:
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=fail_resp)
        mock_get.return_value = mock_client

        with patch.object(AIService, "_MAX_RETRIES", 2):
            with pytest.raises(httpx.HTTPStatusError):
                await AIService.call_ai("test", provider="gemini")


@pytest.mark.asyncio
async def test_call_ai_no_retry_on_401_gemini():
    """Gemini 401 不应重试（只有 Vertex 才重试 401）"""
    fail_resp = make_http_response(401)

    with patch.object(AIService, "_get_client") as mock_get:
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=fail_resp)
        mock_get.return_value = mock_client

        with patch.object(AIService, "_MAX_RETRIES", 2):
            with pytest.raises(httpx.HTTPStatusError):
                await AIService.call_ai("test", provider="gemini")
            # 不重试 401，只调一次
            assert mock_client.post.call_count == 1


# ============================================================
# call_ai — 错误响应
# ============================================================

@pytest.mark.asyncio
async def test_call_ai_empty_candidates():
    """响应无 candidates → ValueError"""
    empty_resp = make_http_response(200, {"candidates": []})

    with patch.object(AIService, "_get_client") as mock_get:
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=empty_resp)
        mock_get.return_value = mock_client

        with patch.object(AIService, "_MAX_RETRIES", 1):
            with pytest.raises(ValueError):
                await AIService.call_ai("test", provider="gemini")


# ============================================================
# translate_text_batch
# ============================================================

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
        assert result["English"] == "Hello"


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
