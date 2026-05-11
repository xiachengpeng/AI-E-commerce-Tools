import json
import logging

logger = logging.getLogger(__name__)

PROMPT_TEMPLATE_COMPARE = """你是一名资深跨境电商选品专家。

请对以下多个产品进行横向对比分析，并基于产品数据和投资评分给出明确建议。

规则：
1. 必须输出严格的 JSON 格式。
2. 不可编造数据，可基于已有信息进行合理推断。
3. winner_product 必须严格选择 investment_score 最高的产品。
4. investment_score = opportunity_score + (100 - difficulty_score)，机会分越高越好，进入难度越低越好。
5. recommendation_list 必须与 winner_product 保持一致，不能推荐低分高难度产品作为主推。
6. 所有文本内容（除 JSON 键名外），必须严格采用 "中文内容 ||| 英文内容" 格式。
7. 每个维度的 detail 要简洁精准，不超过 30 字（中文部分）。

输出结构（严格遵守，comprehensive_evaluation 和 recommendation_list 必须是数组）：
{
  "market_position": "整体市场定位描述（不能为空） ||| Market position description (cannot be empty)",
  "competition_level": "高/中/低（不能为空） ||| High/Medium/Low",
  "winner_product": "具体的胜出产品名称（不能为空） ||| Specific winner product name",
  "comprehensive_evaluation": [
    {
      "dimension": "市场需求 ||| Market Demand",
      "detail": "切中女性出差免托运痛点 ||| Targets women's carry-on travel pain point"
    }
  ],
  "recommendation_list": [
    {
      "action": "主推建议 ||| Primary",
      "content": "将Winner产品作为主力款推广 ||| Promote the winner as the primary product"
    }
  ]
}

产品数据：
{products}
"""


def _extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


from .ai_service import AIService


async def compare_products(products_data: list, provider: str = None) -> dict:
    prompt = PROMPT_TEMPLATE_COMPARE.replace(
        "{products}", json.dumps(products_data, ensure_ascii=False, indent=2)
    )

    try:
        json_str = await AIService.call_ai(prompt, provider=provider)
        parsed = json.loads(_extract_json(json_str))
        logger.info(f"AI Compare Result Parsed: {parsed}")
        if isinstance(parsed, list):
            return {}
        return parsed
    except Exception as e:
        logger.error(f"Failed to compare products: {str(e)}")
        raise
