import requests
import json
import logging
import time
import time
# from config import GEMINI_API_URL, GEMINI_API_KEY

logger = logging.getLogger(__name__)

PROMPT_TEMPLATE_EXTRACT = """你是一名选品专家，请从提供的内容中提取产品核心信息。

要求：
1. 所有的分析内容文本（包括 product_name 字段）必须严格采用 "中文内容 ||| English content" 格式输出
2. 即使数据不完整，也要基于现有信息给出最合理的描述
3. age_range 必须仅展示年龄区间（如：25-45岁），禁止多余描述
4. target_countries 必须推荐不少于 5 个具体的适合投放的国家
5. target_audience 描述必须极其精准，禁止泛泛而谈

输出结构：
{
  "product_name": "",
  "price": "",
  "reviews_count": "",
  "core_selling_points": [],
  "target_audience": [],
  "use_scenarios": ["建议年龄段、国家及场景 ||| Age, Countries & Scenarios"],
  "strengths": "产品优势 ||| Strengths",
  "weaknesses": "产品劣势 ||| Weaknesses",
  "voc_analysis": {
    "pros": ["好评点1 ||| Pro 1", "好评点2 ||| Pro 2"],
    "cons": ["差评点1 ||| Con 1", "差评点2 ||| Con 2"],
    "sentiment": "正面/中立/负面 ||| Positive/Neutral/Negative"
  }
}
内容：
产品基础数据: {product_data}
市场反馈数据: {market_data}
"""

PROMPT_TEMPLATE_DEEP = """你是一名顶级跨境电商产品分析师，专注于对单一产品进行纵向深度透视。

【核心约束】
1. 严禁使用"竞品对比"、"胜出者"、"两者相比"、"Winner"等任何相对比较性词汇
2. 聚焦于对这一个产品本身的深层逻辑进行解剖
3. 可以基于已有信息进行合理的商业推断，但禁止捏造事实
4. 每个分析项必须附带置信度（high / medium / low）
5. 所有文本内容（包括 product_name 字段）必须严格采用 "中文内容 ||| English content" 双语格式输出
6. ad_angles 必须输出 3-5 个可以直接用于拍视频或写广告文案的具体切入角度
7. age_range 必须仅展示年龄区间（如：18-35岁），禁止任何额外解释
8. target_countries 必须基于产品调性给出不少于 5 个具体的投放国家
9. target_audience 必须画像精准，通过具体职业、生活习惯或需求痛点来描述，禁止使用"大众"、"所有人"等宽泛词汇

【输出结构】严格按此 JSON 格式输出，确保 JSON 语法完全正确：
{
  "product_name": "",
  "price": "",
  "reviews_count": "",
  "voc_analysis": {
    "pros": ["好评1 ||| Pro 1", "好评2 ||| Pro 2"],
    "cons": ["差评1 ||| Con 1", "差评2 ||| Con 2"],
    "sentiment": "85%"
  },
  "core_selling_points": [
    { "point": "", "confidence": "high" }
  ],
  "target_audience": ["描述1 ||| Audience 1", "描述2 ||| Audience 2"],
  "age_range": "建议年龄段 ||| Suggested Age Range",
  "target_countries": ["建议投放国家1 ||| Target Country 1", "建议投放国家2 ||| Target Country 2"],
  "use_scenarios": ["场景1 ||| Scenario 1", "场景2 ||| Scenario 2"],
  "traffic_strategy": [
    { "channel": "TikTok ||| TikTok", "detail": "主要通过短视频带货 ||| Mainly via short video sales" }
  ],
  "ad_angles": [],
  "user_pain_points": [
    { "pain": "", "confidence": "high" }
  ],
  "strengths": [
    { "point": "价格极具竞争力 ||| Highly competitive price", "detail": "远低于同类产品平均价 ||| Much lower than average market price" }
  ],
  "weaknesses": [
    { "risk": "物流周期长 ||| Long shipping time", "detail": "可能导致客户满意度下降 ||| May lead to lower customer satisfaction" }
  ],
  "differentiation_opportunities": [
    { "opportunity": "", "confidence": "high" }
  ],
  "entry_recommendation": ""
}

注意：所有的文本内容必须采用 "中文内容 ||| English content" 格式。

产品数据：
产品基础数据: {product_data}
市场反馈数据: {market_data}
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

def _call_ai_service(prompt: str, provider: str = None) -> str:
    """封装调用 AIService 的逻辑"""
    raw_text = AIService.call_ai(prompt, provider=provider)
    logger.info(f"AI Result: {raw_text[:200]}...")
    return _extract_json(raw_text)

def analyze_single_extract(structured_data: dict, provider: str = None) -> str:
    product_data = json.dumps(structured_data.get("product_data", {}), ensure_ascii=False)
    market_data = json.dumps(structured_data.get("market_data", {}), ensure_ascii=False)
    prompt = PROMPT_TEMPLATE_EXTRACT.replace("{product_data}", product_data).replace("{market_data}", market_data)
    return _call_ai_service(prompt, provider=provider)

def analyze_single_deep(structured_data: dict, provider: str = None) -> str:
    product_data = json.dumps(structured_data.get("product_data", {}), ensure_ascii=False)
    market_data = json.dumps(structured_data.get("market_data", {}), ensure_ascii=False)
    prompt = PROMPT_TEMPLATE_DEEP.replace("{product_data}", product_data).replace("{market_data}", market_data)
    return _call_ai_service(prompt, provider=provider)
