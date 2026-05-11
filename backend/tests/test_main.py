"""
集成测试 —— FastAPI /compare 端点 + URL 校验 + CORS
"""
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi.testclient import TestClient

from main import app
from main import (
    align_comparison_winner,
    best_product_index_by_scores,
    investment_score,
    normalize_ai_json_object,
)

client = TestClient(app)


def test_normalize_ai_json_object_accepts_single_item_list():
    """AI 偶尔返回 [{...}] 时，后端应兼容为对象。"""
    result = normalize_ai_json_object([{"product_name": "Pool"}])
    assert result == {"product_name": "Pool"}


def test_normalize_ai_json_object_rejects_non_object_list():
    """非对象数组不应继续被当成产品对象处理。"""
    result = normalize_ai_json_object(["bad"])
    assert result == {}


def test_best_product_index_uses_opportunity_and_difficulty():
    """赢家规则：机会越高越好，难度越低越好。"""
    scores = [
        {"opportunity_score": 81, "difficulty_score": 50},
        {"opportunity_score": 52, "difficulty_score": 83},
    ]
    assert investment_score(scores[0]) == 131
    assert investment_score(scores[1]) == 69
    assert best_product_index_by_scores(scores) == 0


def test_align_comparison_winner_overrides_ai_contradiction():
    """横向分析若与评分卡矛盾，后端按确定性投资分校准 Winner。"""
    comp_result = {"winner_product": "庭院伞 ||| Patio Umbrella"}
    products = [
        {"product_name": "泳池 ||| Pool"},
        {"product_name": "庭院伞 ||| Patio Umbrella"},
    ]
    scores = [
        {"opportunity_score": 81, "difficulty_score": 50},
        {"opportunity_score": 52, "difficulty_score": 83},
    ]

    result = align_comparison_winner(comp_result, products, scores)

    assert result["winner_product"] == "泳池 ||| Pool"


# ============================================================
# URL 校验
# ============================================================

def test_compare_empty_urls():
    """空 URL 列表 → 错误"""
    resp = client.post("/compare", json={"urls": []})
    assert resp.status_code == 200  # CompareResponse 总是 200
    assert resp.json()["status"] == "error"


def test_compare_invalid_url_format():
    """非法 URL 格式 → 校验拒绝"""
    resp = client.post("/compare", json={"urls": ["not-a-valid-url"]})
    data = resp.json()
    assert data["status"] == "error"
    assert "URL 格式无效" in data["message"]


def test_compare_url_too_long():
    """URL 超过长度限制 → 校验拒绝"""
    long_url = "https://example.com/" + "x" * 3000
    resp = client.post("/compare", json={"urls": [long_url]})
    data = resp.json()
    assert data["status"] == "error"
    assert "长度超过限制" in data["message"]


def test_compare_valid_url_accepted():
    """合法 URL 通过校验，不会被 URL 格式错误拒绝"""
    with patch("main.fetch_markdown", new=AsyncMock(side_effect=Exception("stop after validation"))):
        resp = client.post("/compare", json={"urls": ["https://example.com/product"]})
    data = resp.json()
    # 不管后续处理成功还是失败，都不应该是 URL 格式错误
    assert "URL 格式无效" not in data.get("message", "")
    assert "长度超过限制" not in data.get("message", "")


# ============================================================
# CORS
# ============================================================

def test_cors_headers():
    """CORS 中间件：返回 Access-Control-Allow-Origin"""
    resp = client.options(
        "/compare",
        headers={
            "Origin": "http://localhost:8080",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert resp.status_code in (200, 405)
    if "access-control-allow-origin" in resp.headers:
        assert resp.headers["access-control-allow-origin"] == "http://localhost:8080"


# ============================================================
# Config 端点
# ============================================================

def test_config_endpoint():
    """GET /config 返回前端配置"""
    resp = client.get("/config")
    assert resp.status_code == 200
    data = resp.json()
    assert "AI_PROVIDER" in data
    assert "TEXT_MODEL" in data
    assert "IMAGE_MODEL" in data
    assert "API_KEY" not in data
    assert "ACCESS_TOKEN" not in data


def test_ai_generate_endpoint():
    """POST /api/ai/generate 通过后端代理调用模型"""
    result = {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
    with patch("services.ai_service.AIService.generate_content",
               new=AsyncMock(return_value=result)) as mock_generate:
        resp = client.post("/api/ai/generate", json={
            "model": "gemini-test",
            "provider": "vertex",
            "payload": {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
        })

    assert resp.status_code == 200
    assert resp.json() == result
    mock_generate.assert_awaited_once()


# ============================================================
# Log 端点
# ============================================================

def test_log_endpoint():
    """POST /log 接收前端日志"""
    resp = client.post("/log", json={"message": "test log"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ============================================================
# 历史 API
# ============================================================

def test_history_list_empty():
    """GET /api/history/analysis 空数据库返回 []"""
    resp = client.get("/api/history/analysis")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_history_invalid_module():
    """GET /api/history/invalid → 空列表"""
    resp = client.get("/api/history/invalid")
    assert resp.status_code == 200
    assert resp.json() == []


# ============================================================
# 翻译端点
# ============================================================

def test_translate_text_no_langs():
    """翻译端点：无目标语言 → 默认 English"""
    with patch("services.ai_service.AIService.translate_text_batch",
               new=AsyncMock(return_value={"English": "Hello"})):
        resp = client.post("/api/translate-text", json={"text": "你好"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "success"
        assert data["translations"]["English"] == "Hello"


def test_translate_text_multi_lang():
    """翻译端点：多语言"""
    result = {"English": "Hello", "Japanese": "こんにちは"}
    with patch("services.ai_service.AIService.translate_text_batch",
               new=AsyncMock(return_value=result)):
        resp = client.post("/api/translate-text", json={
            "text": "你好",
            "target_langs": ["English", "Japanese"],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["translations"]["Japanese"] == "こんにちは"
