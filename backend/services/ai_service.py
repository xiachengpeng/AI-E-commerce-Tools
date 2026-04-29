import json
import logging
import asyncio
import time
import httpx
from google.oauth2 import service_account
from google.auth.transport.requests import Request
from config import (
    GEMINI_API_KEY, GEMINI_MODEL_ID,
    AI_PROVIDER, VERTEX_PROJECT_ID, VERTEX_LOCATION, VERTEX_KEY_PATH
)

logger = logging.getLogger(__name__)


class AIService:
    _vertex_token = None
    _token_expiry = 0
    _client: httpx.AsyncClient | None = None

    # Retry config
    _MAX_RETRIES = 10
    _BACKOFF_FACTOR = 2
    _RETRY_STATUSES = {429, 500, 502, 503, 504}

    @classmethod
    def _get_client(cls) -> httpx.AsyncClient:
        """获取可复用的异步 HTTP 客户端（连接池）"""
        if cls._client is None:
            cls._client = httpx.AsyncClient(
                timeout=httpx.Timeout(180.0, connect=30.0),
                limits=httpx.Limits(
                    max_connections=20,
                    max_keepalive_connections=10,
                    keepalive_expiry=120,
                ),
            )
        return cls._client

    @classmethod
    def _get_vertex_token(cls, force_refresh=False):
        """获取并自动刷新 Vertex AI 的鉴权 Token（同步，调用频率极低）"""
        if not force_refresh and cls._vertex_token and time.time() < cls._token_expiry:
            return cls._vertex_token

        try:
            logger.info(f"🔑 [Vertex] 正在{'强制' if force_refresh else ''}刷新访问令牌...")
            credentials = service_account.Credentials.from_service_account_file(
                VERTEX_KEY_PATH,
                scopes=['https://www.googleapis.com/auth/cloud-platform']
            )
            auth_request = Request()
            credentials.refresh(auth_request)
            cls._vertex_token = credentials.token
            # Token 通常有效期为 1 小时，提前 5 分钟刷新
            cls._token_expiry = time.time() + 3300
            return cls._vertex_token
        except Exception as e:
            logger.error(f"❌ [Vertex] 获取鉴权令牌失败: {e}")
            raise

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

        if provider == "vertex":
            return await cls._call_vertex(prompt, model_id or GEMINI_MODEL_ID, response_mime_type)
        else:
            return await cls._call_gemini(prompt, model_id or GEMINI_MODEL_ID, response_mime_type)

    @classmethod
    async def _call_gemini(cls, prompt: str, model_id: str, response_mime_type: str) -> str:
        """异步调用 Google AI Studio (Gemini API)"""
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
        params = {"key": GEMINI_API_KEY}
        headers = {"Content-Type": "application/json"}

        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": response_mime_type}
        }

        return await cls._send_request(url, headers, payload, params=params)

    @classmethod
    async def _call_vertex(cls, prompt: str, model_id: str, response_mime_type: str) -> str:
        """异步调用 Google Cloud Vertex AI"""
        token = cls._get_vertex_token()
        url = (f"https://aiplatform.googleapis.com/v1/projects/{VERTEX_PROJECT_ID}"
               f"/locations/{VERTEX_LOCATION}/publishers/google/models/{model_id}:generateContent")

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": response_mime_type}
        }

        return await cls._send_request(url, headers, payload)

    @classmethod
    async def _send_request(cls, url: str, headers: dict, payload: dict,
                            params: dict = None) -> str:
        """
        异步发送请求，带指数退避重试
        """
        client = cls._get_client()
        model_name = url.split('/')[-1].split(':')[0]
        logger.info(f"📡 [AI调用] 发送 API 请求 (模型: {model_name})...")

        last_exception = None
        for attempt in range(cls._MAX_RETRIES):
            try:
                response = await client.post(url, headers=headers, params=params, json=payload)

                # 401 → Token 失效，强制刷新后重试一次（仅 Vertex）
                if response.status_code == 401 and "aiplatform.googleapis.com" in url:
                    logger.warning("🔑 [Vertex] Token 失效 (401)，正在强制刷新并重试...")
                    new_token = cls._get_vertex_token(force_refresh=True)
                    headers["Authorization"] = f"Bearer {new_token}"
                    return await cls._send_request(url, headers, payload, params)

                response.raise_for_status()
                data = response.json()

                candidates = data.get("candidates", [])
                if not candidates:
                    raise ValueError(f"No candidates in AI response: {data}")

                content = candidates[0].get("content", {})
                parts = content.get("parts", [])
                if not parts:
                    raise ValueError(f"No parts in AI candidate: {data}")

                return parts[0].get("text", "")

            except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.RequestError) as e:
                last_exception = e
                status = getattr(e, 'response', None)
                status_code = status.status_code if status else 0

                # 只有可重试的状态码才继续
                if status_code in cls._RETRY_STATUSES or isinstance(e, (httpx.TimeoutException, httpx.RequestError)):
                    if attempt < cls._MAX_RETRIES - 1:
                        sleep_time = min(cls._BACKOFF_FACTOR * (2 ** attempt), 120)
                        logger.warning(
                            f"⏳ [AI调用] 请求失败 (HTTP {status_code or 'connection error'}), "
                            f"{sleep_time}s 后重试 ({attempt + 1}/{cls._MAX_RETRIES})..."
                        )
                        await asyncio.sleep(sleep_time)
                        continue

                # 非可重试错误立即抛出
                if status_code == 401:
                    logger.error(f"❌ [AI调用] 鉴权失败 (401): {response.text}")
                else:
                    logger.error(f"❌ [AI调用] HTTP 错误: {e}")
                raise

            except Exception as e:
                last_exception = e
                logger.error(f"❌ [AI调用] 意外错误: {e}")
                raise

        # 所有重试耗尽
        raise last_exception or RuntimeError("AI调用失败：重试耗尽")

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
