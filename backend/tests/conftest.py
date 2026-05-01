"""
共享测试夹具 (fixtures) 和工具函数
"""
import sys
import os

# 确保 backend 目录在 sys.path 中
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import httpx
from unittest.mock import AsyncMock, MagicMock, patch


# ---------- AI 响应模板 ----------

def make_ai_response(text: str) -> dict:
    """构造 Gemini / Vertex 标准 JSON 响应"""
    return {
        "candidates": [{
            "content": {
                "parts": [{"text": text}],
            },
        }],
    }


def make_ai_image_response(mime_type: str = "image/png", data: str = "aaaa") -> dict:
    """构造 Gemini 多模态图片响应"""
    return {
        "candidates": [{
            "content": {
                "parts": [{"inlineData": {"mimeType": mime_type, "data": data}}],
            },
        }],
    }


def make_http_response(status: int = 200, json_data: dict = None):
    """构造 httpx.Response mock"""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.json.return_value = json_data or {}
    resp.raise_for_status = MagicMock()
    if status >= 400:
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            "error", request=MagicMock(), response=resp
        )
    return resp


# ---------- 常用夹具 ----------

@pytest.fixture
def sample_product_data():
    return {
        "product_name": "测试产品 ||| Test Product",
        "price": "$19.99",
        "reviews_count": "120",
        "core_selling_points": ["卖点1 ||| Point1", "卖点2 ||| Point2"],
        "target_audience": ["受众1 ||| Audience1"],
        "use_scenarios": ["场景1 ||| Scenario1"],
        "strengths": "优势 ||| Strengths",
        "weaknesses": "劣势 ||| Weaknesses",
        "voc_analysis": None,
    }


@pytest.fixture
def sample_structured_data():
    return {
        "product_data": {
            "title": "Test Product Title",
            "price": "$29.99",
            "bullets": ["bullet1", "bullet2"],
            "description": "A great product",
        },
        "market_data": {
            "reviews": ["Great!", "Love it"],
            "qa": ["Q: Is it good? A: Yes"],
        },
    }
