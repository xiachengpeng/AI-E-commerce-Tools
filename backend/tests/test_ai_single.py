"""
测试 ai_single — 单品提取与深度分析
"""
import json
import pytest
from unittest.mock import AsyncMock, patch

from tests.conftest import sample_structured_data


EXTRACT_JSON = json.dumps({
    "product_name": "测试产品 ||| Test Product",
    "price": "$29.99",
    "reviews_count": "120",
    "core_selling_points": ["环保材质 ||| Eco-friendly"],
    "target_audience": ["年轻女性 ||| Young women"],
    "use_scenarios": ["在家使用 ||| At home"],
    "strengths": "耐用 ||| Durable",
    "weaknesses": "重 ||| Heavy",
    "voc_analysis": {
        "pros": ["好用 ||| Good"],
        "cons": ["贵 ||| Expensive"],
        "sentiment": "正面 ||| Positive",
    },
}, ensure_ascii=False)

DEEP_JSON = json.dumps({
    "product_name": "深度测试 ||| Deep Test",
    "price": "$49.99",
    "age_range": "25-35",
    "target_countries": ["US", "UK", "Japan", "Germany", "France"],
    "target_audience": ["专业人士 ||| Professionals"],
    "use_scenarios": ["办公 ||| Office"],
    "core_selling_points": [{"point": "p1", "confidence": "high"}],
    "voc_analysis": {"pros": ["p"], "cons": ["c"], "sentiment": "90%"},
    "traffic_strategy": [{"channel": "TikTok", "detail": "videos"}],
    "ad_angles": ["angle1"],
    "user_pain_points": [{"pain": "pain1", "confidence": "high"}],
    "strengths": [{"point": "s1", "detail": "d1"}],
    "weaknesses": [{"risk": "r1", "detail": "d1"}],
    "differentiation_opportunities": [{"opportunity": "o1", "confidence": "medium"}],
    "entry_recommendation": "推荐进入",
}, ensure_ascii=False)


@pytest.mark.asyncio
async def test_analyze_single_extract(sample_structured_data):
    """单品提取：正常返回 JSON"""
    with patch("services.ai_single.AIService.call_ai",
               new=AsyncMock(return_value=EXTRACT_JSON)):
        from services.ai_single import analyze_single_extract
        result = await analyze_single_extract(sample_structured_data, provider="gemini")
        parsed = json.loads(result)
        assert parsed["product_name"] == "测试产品 ||| Test Product"
        assert parsed["price"] == "$29.99"


@pytest.mark.asyncio
async def test_analyze_single_deep(sample_structured_data):
    """深度分析：正常返回 JSON"""
    with patch("services.ai_single.AIService.call_ai",
               new=AsyncMock(return_value=DEEP_JSON)):
        from services.ai_single import analyze_single_deep
        result = await analyze_single_deep(sample_structured_data, provider="gemini")
        parsed = json.loads(result)
        assert parsed["product_name"] == "深度测试 ||| Deep Test"
        assert len(parsed["target_countries"]) == 5


@pytest.mark.asyncio
async def test_extract_json_removes_markdown_fence():
    """_extract_json 能清理 ```json``` 包裹"""
    from services.ai_single import _extract_json
    wrapped = '```json\n{"key": "val"}\n```'
    assert _extract_json(wrapped) == '{"key": "val"}'


def test_extract_json_no_fence():
    """_extract_json 对无包裹文本不做修改"""
    from services.ai_single import _extract_json
    plain = '{"key": "val"}'
    assert _extract_json(plain) == plain
