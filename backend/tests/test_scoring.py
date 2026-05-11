"""
测试 scoring.calculate_score —— AI 机会/难度打分
"""
import json
import pytest
from unittest.mock import AsyncMock, patch

from tests.conftest import sample_product_data


@pytest.mark.asyncio
async def test_calculate_score_success(sample_product_data):
    """正常打分：AI 返回完整 JSON"""
    score_json = {
        "product": "测试产品 ||| Test Product",
        "opportunity_score": 78,
        "difficulty_score": 42,
        "final_decision": "强烈建议 ||| Strongly Recommend",
        "decision_details": {
            "confidence": "high",
            "reason": "市场机会大 ||| Big opportunity",
        },
        "sub_scores": {
            "opportunity": {"demand": 20, "profit": 18, "differentiation": 18, "marketing": 22},
            "difficulty": {"competition": 15, "brand": 10, "ads_cost": 10, "barrier": 7},
        },
        "evaluation_details": [
            {"dimension": "需求 ||| Demand", "detail": "强烈 ||| Strong"},
        ],
    }

    with patch("services.scoring.AIService.call_ai", new=AsyncMock(
        return_value=json.dumps(score_json, ensure_ascii=False)
    )):
        result = await __import__("services.scoring", fromlist=["calculate_score"])\
            .calculate_score(sample_product_data, provider="gemini")
        assert result["opportunity_score"] == 78
        assert result["difficulty_score"] == 42
        assert "强烈建议" in result["final_decision"]


@pytest.mark.asyncio
async def test_calculate_score_handles_list_response(sample_product_data):
    """AI 错误返回数组 → 返回空字典"""
    with patch("services.scoring.AIService.call_ai", new=AsyncMock(return_value="[]")):
        from services.scoring import calculate_score
        result = await calculate_score(sample_product_data, provider="gemini")
        assert result == {}


@pytest.mark.asyncio
async def test_calculate_score_raises_on_ai_error(sample_product_data):
    """AI 调用异常 → 向上传播"""
    with patch("services.scoring.AIService.call_ai",
               new=AsyncMock(side_effect=RuntimeError("AI down"))):
        from services.scoring import calculate_score
        with pytest.raises(RuntimeError, match="AI down"):
            await calculate_score(sample_product_data, provider="gemini")
