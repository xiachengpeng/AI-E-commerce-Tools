import base64
import json
import os
import re
from typing import Any

from config import GEMINI_MODEL_ID
from services.ai_service import AIService
from services.listing_service import parse_ai_json_object, first_text_from_response


AD_STYLE_DEFINITIONS = [
    ("problem_solution", "Problem/Solution", "痛点解决型", "放大痛点，引入产品作为解决方案，展示轻松状态。"),
    ("feature_benefit", "Feature & Benefit", "卖点直击型", "直接展示核心功能、材质、设计差异与用户收益。"),
    ("emotional_appeal", "Emotional Appeal", "情感共鸣型", "弱化产品参数，突出生活状态、情绪价值和品牌认同。"),
    ("social_proof", "Social Proof / UGC", "社会认同 / 背书型", "用评价、UGC、口碑和真实反馈建立信任。"),
    ("us_vs_them", "Us vs. Them", "对比竞争型", "将产品与传统方案或劣质竞品对比，制造清晰优势。"),
    ("how_to_demo", "How-to / Demonstration", "教程 / 场景演示型", "展示安装、使用过程、前后对比和最终效果。"),
    ("offer_promotion", "Offer / Promotion Driven", "利益 / 促销驱动型", "用折扣、免邮、买赠等利益点推动行动。"),
    ("scarcity_urgency", "Scarcity / Urgency", "稀缺 / 紧迫感型", "制造合理的限量、限时、补货或库存紧迫感。"),
    ("curiosity_entertainment", "Curiosity / Entertainment", "猎奇 / 趣味型", "用反常识、测试、幽默或反转吸引冷流量。"),
]


def _ads_model_id() -> str:
    return (
        os.getenv("FRONTEND_VISION_MODEL")
        or os.getenv("FRONTEND_IMAGE_MODEL")
        or os.getenv("FRONTEND_TEXT_MODEL")
        or "gemini-3.1-flash-image-preview"
        or GEMINI_MODEL_ID
    )


def _text_pair(value: Any) -> dict:
    if isinstance(value, str):
        return {"target": value, "zh": ""}
    if isinstance(value, dict):
        target = (
            value.get("target")
            or value.get("English")
            or value.get("english")
            or value.get("text")
            or value.get("copy")
            or value.get("headline")
            or value.get("keyword")
            or ""
        )
        zh = (
            value.get("zh")
            or value.get("Chinese")
            or value.get("chinese")
            or value.get("cn")
            or value.get("translation")
            or value.get("translation_zh")
            or ""
        )
        return {"target": str(target), "zh": str(zh)}
    return {"target": "", "zh": ""}


def _text_pair_list(value: Any) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]
    pairs = [_text_pair(item) for item in value]
    return [pair for pair in pairs if pair["target"] or pair["zh"]]


def _facebook_block(value: Any) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "primaryText": _text_pair(data.get("primaryText") or data.get("primary_text")),
        "headline": _text_pair(data.get("headline")),
        "description": _text_pair(data.get("description")),
        "cta": _text_pair(data.get("cta")),
        "creativeDirection": _text_pair(data.get("creativeDirection") or data.get("creative_direction")),
    }


def _google_block(value: Any) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "headlines": _text_pair_list(data.get("headlines")),
        "descriptions": _text_pair_list(data.get("descriptions")),
        "keywords": _text_pair_list(data.get("keywords")),
        "sitelinks": _text_pair_list(data.get("sitelinks") or data.get("sitelinkIdeas")),
    }


def normalize_ad_copy_result(data: Any, platforms: list[str]) -> dict:
    data = data if isinstance(data, dict) else {}
    platform_set = set(platforms)
    incoming_styles = {
        str(item.get("id") or "").strip(): item
        for item in data.get("styles", [])
        if isinstance(item, dict)
    }

    styles = []
    for style_id, target_name, zh_name, zh_logic in AD_STYLE_DEFINITIONS:
        raw = incoming_styles.get(style_id, {})
        style = {
            "id": style_id,
            "name": _text_pair(raw.get("name")) if raw.get("name") else {"target": target_name, "zh": zh_name},
            "logic": _text_pair(raw.get("logic")) if raw.get("logic") else {"target": "", "zh": zh_logic},
        }
        if "facebook" in platform_set:
            style["facebook"] = _facebook_block(raw.get("facebook"))
        if "google" in platform_set:
            style["google"] = _google_block(raw.get("google"))
        styles.append(style)

    product = data.get("product") if isinstance(data.get("product"), dict) else {}
    return {
        "product": {
            "name": _text_pair(product.get("name")),
            "summary": _text_pair(product.get("summary")),
        },
        "styles": styles,
    }


def _validate_image_data(image_data: str) -> tuple[str, str]:
    if not image_data.startswith("data:image") or "," not in image_data:
        raise ValueError("图片格式无效")

    header, encoded = image_data.split(",", 1)
    if len(encoded) > 8_000_000:
        raise ValueError("图片过大，请压缩后再上传")

    mime_match = re.search(r"data:([^;]+);base64", header)
    if not mime_match:
        raise ValueError("图片 MIME 类型无效")

    base64.b64decode(encoded, validate=True)
    return mime_match.group(1), encoded


def _ads_prompt(request) -> str:
    selected_platforms = ", ".join(request.platforms)
    theme = ""
    if request.marketing_theme and request.marketing_theme != "none":
        theme = f"Campaign theme: {request.marketing_theme_label or request.marketing_theme}"

    style_schema = [
        {"id": style_id, "target_name": target, "zh_name": zh, "logic_zh": logic}
        for style_id, target, zh, logic in AD_STYLE_DEFINITIONS
    ]

    return f"""You are a senior cross-border performance marketing strategist.

Analyze the product image and generate bilingual ad copy for the selected platforms.

Selected platforms: {selected_platforms}
Target market: {request.region}
Target language: {request.target_language or "English"}
{theme}

Creative styles to generate exactly once:
{json.dumps(style_schema, ensure_ascii=False)}

Rules:
1. Return pure JSON only, no markdown fences.
2. Generate all 9 style objects in the same order as provided.
3. Only include selected platform keys.
4. Every copy field must include target-language text and Chinese back-translation.
5. Keep claims specific and defensible. Avoid medical claims, safety guarantees, unverifiable superlatives, and false urgency.
6. Facebook copy should fit feed/social ads and include primary text, headline, description, CTA, and creative direction.
7. Google copy should fit search ads and include 5 concise headlines, 3 descriptions, 8 keywords, and 4 sitelink ideas.

JSON schema:
{{
  "product": {{
    "name": {{"target": "Product name", "zh": "中文产品名"}},
    "summary": {{"target": "Short positioning", "zh": "中文定位"}}
  }},
  "styles": [
    {{
      "id": "problem_solution",
      "name": {{"target": "Problem/Solution", "zh": "痛点解决型"}},
      "logic": {{"target": "Creative logic", "zh": "中文创意逻辑"}},
      "facebook": {{
        "primaryText": {{"target": "Primary text", "zh": "中文对照"}},
        "headline": {{"target": "Headline", "zh": "中文对照"}},
        "description": {{"target": "Description", "zh": "中文对照"}},
        "cta": {{"target": "CTA", "zh": "中文对照"}},
        "creativeDirection": {{"target": "Creative direction", "zh": "中文对照"}}
      }},
      "google": {{
        "headlines": [{{"target": "Headline", "zh": "中文对照"}}],
        "descriptions": [{{"target": "Description", "zh": "中文对照"}}],
        "keywords": [{{"target": "Keyword", "zh": "中文对照"}}],
        "sitelinks": [{{"target": "Sitelink", "zh": "中文对照"}}]
      }}
    }}
  ]
}}
"""


async def generate_ad_copy(request) -> dict:
    mime_type, encoded = _validate_image_data(request.image_data)
    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": _ads_prompt(request)},
                {"inlineData": {"mimeType": mime_type, "data": encoded}},
            ],
        }],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    response = await AIService.generate_content(
        model_id=_ads_model_id(),
        payload=payload,
        provider=request.ai_provider,
    )
    text = first_text_from_response(response)
    return normalize_ad_copy_result(parse_ai_json_object(text), request.platforms)
