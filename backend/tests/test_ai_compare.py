"""
测试 ai_compare.compare_products —— 多产品横向对比
"""
import json
import pytest
from unittest.mock import AsyncMock, patch


COMPARE_JSON = json.dumps({
    "market_position": "蓝海市场 ||| Blue ocean market",
    "competition_level": "低 ||| Low",
    "winner_product": "产品A ||| Product A",
    "comprehensive_evaluation": [
        {"dimension": "需求 ||| Demand", "detail": "旺盛 ||| Strong"},
    ],
    "recommendation_list": [
        {"action": "主推 ||| Primary", "content": "推广 ||| Promote"},
    ],
}, ensure_ascii=False)


@pytest.mark.asyncio
async def test_compare_products_success():
    """多产品对比：正常返回"""
    products = [
        {"product_name": "产品A ||| Product A", "price": "$10"},
        {"product_name": "产品B ||| Product B", "price": "$20"},
    ]
    with patch("services.ai_compare.AIService.call_ai",
               new=AsyncMock(return_value=COMPARE_JSON)):
        from services.ai_compare import compare_products
        result = await compare_products(products, provider="gemini")
        assert result["market_position"] == "蓝海市场 ||| Blue ocean market"
        assert result["winner_product"] == "产品A ||| Product A"
        assert len(result["comprehensive_evaluation"]) == 1


@pytest.mark.asyncio
async def test_compare_products_handles_list_response(sample_product_data):
    """AI 错误返回数组 → 返回空字典"""
    with patch("services.ai_compare.AIService.call_ai",
               new=AsyncMock(return_value="[]")):
        from services.ai_compare import compare_products
        result = await compare_products([sample_product_data], provider="gemini")
        assert result == {}


@pytest.mark.asyncio
async def test_compare_products_raises_on_ai_error(sample_product_data):
    """AI 异常 → 向上传播"""
    with patch("services.ai_compare.AIService.call_ai",
               new=AsyncMock(side_effect=Exception("AI error"))):
        from services.ai_compare import compare_products
        with pytest.raises(Exception, match="AI error"):
            await compare_products([sample_product_data], provider="gemini")
