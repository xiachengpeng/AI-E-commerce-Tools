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
               new=AsyncMock(return_value=COMPARE_JSON)) as mocked:
        from services.ai_compare import compare_products
        result = await compare_products(products)
        assert result["market_position"] == "蓝海市场 ||| Blue ocean market"
        assert result["winner_product"] == "产品A ||| Product A"
        assert len(result["comprehensive_evaluation"]) == 1
        assert mocked.await_args.kwargs["capability"] == "text"


@pytest.mark.asyncio
async def test_compare_ai_log_contains_only_parsed_metadata(caplog):
    secret = "RAW-COMPARE-MODEL-OUTPUT"
    response = json.dumps(
        {
            "market_position": secret,
            "competition_level": "low",
            "winner_product": "A",
        }
    )

    with caplog.at_level("INFO"), patch(
        "services.ai_compare.AIService.call_ai",
        new=AsyncMock(return_value=response),
    ):
        from services.ai_compare import compare_products

        await compare_products([{"product_name": "A"}])

    assert secret not in caplog.text
    assert "keys=" in caplog.text


@pytest.mark.asyncio
async def test_compare_products_handles_list_response(sample_product_data):
    """AI 错误返回数组 → 返回空字典"""
    with patch("services.ai_compare.AIService.call_ai",
               new=AsyncMock(return_value="[]")):
        from services.ai_compare import compare_products
        result = await compare_products([sample_product_data])
        assert result == {}


@pytest.mark.asyncio
async def test_compare_products_raises_on_ai_error(sample_product_data):
    """AI 异常 → 向上传播"""
    with patch("services.ai_compare.AIService.call_ai",
               new=AsyncMock(side_effect=Exception("AI error"))):
        from services.ai_compare import compare_products
        with pytest.raises(Exception, match="AI error"):
            await compare_products([sample_product_data])


@pytest.mark.asyncio
async def test_compare_products_with_strategic_insights():
    """多产品对比：验证战略破局与 Winner 深度剖析字段"""
    rich_compare_json = json.dumps({
        "market_position": "质价比破局区 ||| Value breakthrough",
        "competition_level": "中 ||| Medium",
        "winner_product": "竞品1 ||| Competitor 1",
        "market_landscape": "现有头部垄断低端，存在中高端空白 ||| Market landscape",
        "pricing_tier_analysis": "主力在 $20-$30，我方可打 $35 质价比 ||| Pricing tiers",
        "winner_analysis": {
            "key_advantages": "低价走量与大评论基数 ||| High volume low price",
            "fatal_vulnerability": "塑料机身发热严重、寿命短 ||| Severe overheating and fragile"
        },
        "breakthrough_strategy": {
            "product_innovation": "铝合金双涡轮散热降温 ||| Dual-turbine cooling",
            "pricing_entry": "$32.99 质价比卡位 ||| $32.99 sweet spot",
            "marketing_playbook": "主打竞品发热对比视频 ||| Compare against competitor heating"
        },
        "comprehensive_evaluation": [
            {"dimension": "痛点 ||| Pain points", "detail": "发热 ||| Heat"},
        ],
        "recommendation_list": [
            {"action": "避开低价 ||| Avoid low price", "content": "做差异化 ||| Differentiate"},
        ],
    }, ensure_ascii=False)

    products = [
        {"product_name": "竞品1", "price": "$19.99"},
        {"product_name": "竞品2", "price": "$29.99"},
    ]
    with patch("services.ai_compare.AIService.call_ai",
               new=AsyncMock(return_value=rich_compare_json)):
        from services.ai_compare import compare_products
        result = await compare_products(products)
        assert result["winner_product"] == "竞品1 ||| Competitor 1"
        assert result["winner_analysis"]["key_advantages"] == "低价走量与大评论基数 ||| High volume low price"
        assert result["breakthrough_strategy"]["product_innovation"] == "铝合金双涡轮散热降温 ||| Dual-turbine cooling"
        assert "发热严重" in result["winner_analysis"]["fatal_vulnerability"]


@pytest.mark.asyncio
async def test_compare_products_extracts_competitive_battle_card():
    battle_card_json = json.dumps({
        "market_position": "红海市场 ||| Red ocean",
        "competition_level": "高 ||| High",
        "winner_product": "头部老品 ||| Legacy Leader",
        "battle_card": {
            "why_switch": [
                {
                    "trigger": "老品塑料齿轮易打滑断裂 ||| Plastic gears slip and snap",
                    "our_counter": "全金属精密航空齿轮，终身质保 ||| All-metal precision gear with lifetime guarantee"
                }
            ],
            "who_it_is_for": "高频使用的重度咖啡玩家 ||| Heavy daily espresso lovers",
            "who_it_is_not_for": "仅偶尔喝速溶咖啡的轻度用户 ||| Casual instant coffee drinkers",
            "tactical_counter_attacks": [
                {
                    "angle": "Listing Bullet 1 破局点 ||| Bullet 1 hook",
                    "action": "直击齿轮材质痛点，展示金属切削工艺与承重测试 ||| Highlight metal craftsmanship"
                }
            ]
        }
    }, ensure_ascii=False)

    products = [{"product_name": "A"}, {"product_name": "B"}]
    with patch("services.ai_compare.AIService.call_ai", new=AsyncMock(return_value=battle_card_json)):
        from services.ai_compare import compare_products
        result = await compare_products(products)
        assert "battle_card" in result
        card = result["battle_card"]
        assert len(card["why_switch"]) == 1
        assert "塑料齿轮" in card["why_switch"][0]["trigger"]
        assert "全金属" in card["why_switch"][0]["our_counter"]
        assert "高频使用" in card["who_it_is_for"]
        assert "偶尔喝速溶" in card["who_it_is_not_for"]
        assert len(card["tactical_counter_attacks"]) == 1
        assert "Listing Bullet 1" in card["tactical_counter_attacks"][0]["angle"]
