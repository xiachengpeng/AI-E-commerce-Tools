import requests
import json
import logging
import time
# from config import GEMINI_API_URL, GEMINI_API_KEY

logger = logging.getLogger(__name__)

PROMPT_TEMPLATE_SCORE = """你是一名资深跨境电商投资评估专家。
请根据以下产品的核心特征，对其进行深度的机会与难度评估。

【评估规则】
1. 必须输出严格的 JSON 格式。
2. 所有的文本内容（除 JSON 键名外），必须严格采用 "中文内容 ||| 英文内容" 的特定格式输出。
3. 你需要为以下两个大维度下的细分项打分：

   A. 机会评分 (Opportunity Score) - 总分 100:
      - demand: 市场需求 (0-25)
      - profit: 利润空间 (0-25)
      - differentiation: 差异化空间 (0-25)
      - marketing: 产品可营销性 (0-25)

   B. 进入难度 (Difficulty Score) - 总分 100:
      - competition: 竞争强度 (0-30)
      - brand: 品牌垄断 (0-25)
      - ads_cost: 流量成本 (0-25)
      - barrier: 用户壁垒 (0-20)

4. evaluation_details 必须包含 4 个核心维度的简短评估。

输出结构：
{
  "product": "产品名称 ||| Product Name",
  "opportunity_score": 85,
  "difficulty_score": 40,
  "final_decision": "投资结论（如：强烈建议/谨慎进入/不建议） ||| Final Decision",
  "decision_details": {
    "confidence": "high / medium / low",
    "reason": "核心评估结论 ||| Core conclusion"
  },
  "sub_scores": {
    "opportunity": {
      "demand": 20,
      "profit": 18,
      "differentiation": 15,
      "marketing": 22
    },
    "difficulty": {
      "competition": 25,
      "brand": 15,
      "ads_cost": 20,
      "barrier": 10
    }
  },
  "evaluation_details": [
    {
      "dimension": "维度名称 ||| Dimension Name",
      "detail": "评估细节 ||| Evaluation detail"
    }
  ]
}

产品数据：
{product}
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

def calculate_score(product_data: dict, provider: str = None) -> dict:
    prompt = PROMPT_TEMPLATE_SCORE.replace(
        "{product}", json.dumps(product_data, ensure_ascii=False, indent=2)
    )
    try:
        json_str = AIService.call_ai(prompt, provider=provider)
        parsed = json.loads(_extract_json(json_str))
        if isinstance(parsed, list):
            return {}
        return parsed
    except Exception as e:
        logger.error(f"Failed to calculate score: {str(e)}")
        raise e
