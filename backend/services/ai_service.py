import json
import logging

from services.ai_router import AIRouter


logger = logging.getLogger(__name__)
ai_router = AIRouter()


def first_text_from_normalized_response(response: dict) -> str:
    candidates = response.get("candidates", [])
    if not candidates:
        raise ValueError("AI 响应中没有候选结果")
    parts = candidates[0].get("content", {}).get("parts", [])
    if not parts:
        raise ValueError("AI 响应候选结果中没有内容")
    return parts[0].get("text", "")


class AIService:
    @classmethod
    async def call_ai(
        cls,
        prompt: str,
        capability: str = "text",
        response_mime_type: str = "application/json",
    ) -> str:
        """Route a prompt by capability and return its first text part."""
        response = await ai_router.generate(
            capability,
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": prompt}],
                    }
                ],
                "generationConfig": {
                    "responseMimeType": response_mime_type
                },
            },
        )
        return first_text_from_normalized_response(response)

    @classmethod
    async def generate_content(
        cls,
        payload: dict,
        capability: str,
    ) -> dict:
        """Route a normalized payload by capability."""
        return await ai_router.generate(capability, payload)

    @classmethod
    async def translate_text_batch(
        cls,
        text: str,
        target_langs: list,
    ) -> dict:
        """Translate text into multiple languages with one text request."""
        langs_str = ", ".join(target_langs)
        prompt = f"""
        你是一位精通多国语言且深谙全球电商文化的营销专家。

        请将以下内容翻译成以下目标语言：{langs_str}。

        【原始文本】：
        {text}

        【应用场景】：电商产品描述/Listing (Amazon, TikTok Shop等)

        【翻译要求】：
        1. **本地化语境**：不要进行生硬的字面翻译，要符合目标语言母语使用者的表达习惯。
        2. **电商优化**：使用该语言在电商平台中常用的高转化词汇。
        3. **格式要求**：必须严格按照以下 JSON 格式返回，不要包含任何多余的解释：
        {{
            "语言名称1": "翻译结果1",
            "语言名称2": "翻译结果2"
        }}

        注意：JSON 的 Key 必须严格使用我给出的语言名称列表：{langs_str}。
        """

        try:
            logger.info("🚀 [AI批量翻译] 正在请求语言: %s", langs_str)
            response_text = await cls.call_ai(
                prompt,
                capability="text",
                response_mime_type="application/json",
            )
            clean_json = (
                response_text.replace("```json", "")
                .replace("```", "")
                .strip()
            )
            result = json.loads(clean_json)
            logger.info(
                "✅ [AI批量翻译] 成功获取 %s 种语言结果",
                len(result),
            )
            return result
        except Exception:
            logger.error("❌ [AI批量翻译] 请求或解析失败")
            return {lang: "翻译失败" for lang in target_langs}
