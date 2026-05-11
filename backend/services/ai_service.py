import json
import logging
import asyncio
import time
import random
import os
import base64
from google import genai
from google.genai import types
from config import (
    GEMINI_API_KEY, GEMINI_MODEL_ID,
    AI_PROVIDER, VERTEX_PROJECT_ID, VERTEX_LOCATION, VERTEX_KEY_PATH
)

logger = logging.getLogger(__name__)


class AIService:
    _clients = {}

    # Retry config
    _MAX_RETRIES = 7
    _BASE_DELAY = 2
    _BACKOFF_FACTOR = 2

    @classmethod
    def _get_client(cls, provider: str):
        """获取 google-genai 客户端，调用方式参考 debug 目录测试脚本。"""
        provider = (provider or AI_PROVIDER).lower()
        if provider in cls._clients:
            return cls._clients[provider]

        if provider == "vertex":
            if VERTEX_KEY_PATH and os.path.exists(VERTEX_KEY_PATH):
                os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", VERTEX_KEY_PATH)
            client = genai.Client(
                vertexai=True,
                project=VERTEX_PROJECT_ID,
                location=VERTEX_LOCATION,
            )
        else:
            client = genai.Client(api_key=GEMINI_API_KEY)

        cls._clients[provider] = client
        return client

    @classmethod
    async def call_ai(cls, prompt: str, provider: str = None, model_id: str = None,
                      response_mime_type: str = "application/json") -> str:
        """
        统一异步调用入口
        :param prompt: 提示词
        :param provider: "gemini" 或 "vertex"，默认为 None (使用配置值)
        :param model_id: 模型 ID，默认为 None (使用配置值)
        :param response_mime_type: 响应格式，默认为 "application/json"
        """
        provider = (provider or AI_PROVIDER).lower()
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": response_mime_type},
        }
        response = await cls.generate_content(
            model_id=model_id or GEMINI_MODEL_ID,
            payload=payload,
            provider=provider,
        )
        candidates = response.get("candidates", [])
        if not candidates:
            raise ValueError(f"No candidates in AI response: {response}")
        parts = candidates[0].get("content", {}).get("parts", [])
        if not parts:
            raise ValueError(f"No parts in AI candidate: {response}")
        return parts[0].get("text", "")

    @classmethod
    async def generate_content(cls, model_id: str, payload: dict, provider: str = None) -> dict:
        """通用 generate_content 入口，返回兼容前端旧 REST 结构的字典。"""
        provider = (provider or AI_PROVIDER).lower()
        model_id = model_id or GEMINI_MODEL_ID
        logger.info(f"📡 [AI调用] 发送 SDK 请求 (provider={provider}, model={model_id})")

        response = await asyncio.to_thread(
            cls._generate_content_sync,
            provider,
            model_id,
            cls._convert_contents(payload.get("contents", [])),
            cls._convert_generation_config(payload.get("generationConfig") or payload.get("config") or {}),
        )
        return cls._response_to_dict(response)

    @classmethod
    def _generate_content_sync(cls, provider: str, model_id: str, contents, config):
        client = cls._get_client(provider)
        last_error = None
        for attempt in range(cls._MAX_RETRIES):
            try:
                return client.models.generate_content(
                    model=model_id,
                    contents=contents,
                    config=config,
                )
            except Exception as e:
                last_error = e
                if attempt == cls._MAX_RETRIES - 1:
                    logger.error(f"❌ [AI调用] 连续 {cls._MAX_RETRIES} 次请求失败: {e}")
                    raise
                delay = cls._BASE_DELAY * (cls._BACKOFF_FACTOR ** attempt) + random.uniform(0, 1)
                logger.warning(
                    f"⏳ [AI调用] 请求失败，{delay:.2f}s 后重试 "
                    f"({attempt + 1}/{cls._MAX_RETRIES - 1}): {e}"
                )
                time.sleep(delay)
        raise last_error or RuntimeError("AI调用失败：重试耗尽")

    @staticmethod
    def _convert_contents(contents):
        if isinstance(contents, str):
            return contents
        converted = []
        for content in contents or []:
            if isinstance(content, str):
                converted.append(content)
                continue
            parts = []
            for part in content.get("parts", []):
                if "text" in part:
                    parts.append(part["text"])
                    continue
                inline_data = part.get("inlineData") or part.get("inline_data")
                if inline_data:
                    data = inline_data.get("data", "")
                    if isinstance(data, str):
                        data = base64.b64decode(data)
                    parts.append(types.Part.from_bytes(
                        data=data,
                        mime_type=inline_data.get("mimeType") or inline_data.get("mime_type"),
                    ))
            converted.append(types.Content(
                role=content.get("role", "user"),
                parts=[p if isinstance(p, types.Part) else types.Part(text=p) for p in parts],
            ))
        return converted

    @staticmethod
    def _convert_generation_config(config: dict):
        if not config:
            return None

        image_config = config.get("imageConfig") or config.get("image_config")
        converted_image_config = None
        if image_config:
            converted_image_config = types.ImageConfig(
                aspect_ratio=image_config.get("aspectRatio") or image_config.get("aspect_ratio"),
                image_size=image_config.get("imageSize") or image_config.get("image_size"),
            )

        return types.GenerateContentConfig(
            response_mime_type=config.get("responseMimeType") or config.get("response_mime_type"),
            response_modalities=config.get("responseModalities") or config.get("response_modalities"),
            image_config=converted_image_config,
        )

    @staticmethod
    def _response_to_dict(response) -> dict:
        result = {"candidates": []}
        for candidate in response.candidates or []:
            parts = []
            for part in candidate.content.parts or []:
                if getattr(part, "thought", False):
                    continue
                if getattr(part, "text", None):
                    parts.append({"text": part.text})
                inline_data = getattr(part, "inline_data", None)
                if inline_data:
                    data = inline_data.data
                    if isinstance(data, bytes):
                        data = base64.b64encode(data).decode("utf-8")
                    parts.append({
                        "inlineData": {
                            "mimeType": inline_data.mime_type,
                            "data": data,
                        }
                    })
            result["candidates"].append({
                "content": {
                    "role": getattr(candidate.content, "role", "model"),
                    "parts": parts,
                }
            })
        return result

    @classmethod
    async def translate_text_batch(cls, text: str, target_langs: list, provider: str = None) -> dict:
        """
        批量语境翻译：一次性请求多个语言，利用 AI 的 JSON 输出能力
        """
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
            logger.info(f"🚀 [AI批量翻译] 正在请求语言: {langs_str}")
            response_text = await cls.call_ai(prompt, provider=provider, response_mime_type="application/json")

            # 清理 Markdown 代码块
            clean_json = response_text.replace("```json", "").replace("```", "").strip()
            result = json.loads(clean_json)
            logger.info(f"✅ [AI批量翻译] 成功获取 {len(result)} 种语言结果")
            return result
        except Exception as e:
            logger.error(f"❌ [AI批量翻译] 失败: {e}")
            return {lang: f"翻译失败: {str(e)}" for lang in target_langs}
