import requests
import json
import logging
import time
import base64
from google.oauth2 import service_account
from google.auth.transport.requests import Request
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
from config import (
    GEMINI_API_KEY, GEMINI_MODEL_ID, GEMINI_API_URL,
    AI_PROVIDER, VERTEX_PROJECT_ID, VERTEX_LOCATION, VERTEX_KEY_PATH
)

logger = logging.getLogger(__name__)

class AIService:
    _vertex_token = None
    _token_expiry = 0
    _session = None

    @classmethod
    def _get_session(cls):
        """获取支持重试的 Session"""
        if cls._session is None:
            cls._session = requests.Session()
            retry_strategy = Retry(
                total=5,
                backoff_factor=2,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=["POST"]
            )
            adapter = HTTPAdapter(
                max_retries=retry_strategy,
                pool_connections=10,
                pool_maxsize=10
            )
            cls._session.mount("https://", adapter)
        return cls._session

    @classmethod
    def _get_vertex_token(cls):
        """获取并自动刷新 Vertex AI 的鉴权 Token"""
        if cls._vertex_token and time.time() < cls._token_expiry:
            return cls._vertex_token
        
        try:
            logger.info(f"Refreshing Vertex AI access token from {VERTEX_KEY_PATH}...")
            credentials = service_account.Credentials.from_service_account_file(
                VERTEX_KEY_PATH, 
                scopes=['https://www.googleapis.com/auth/cloud-platform']
            )
            auth_request = Request()
            credentials.refresh(auth_request)
            cls._vertex_token = credentials.token
            # Token 通常有效期为 1 小时，设置提前 5 分钟刷新
            cls._token_expiry = time.time() + 3300 
            return cls._vertex_token
        except Exception as e:
            logger.error(f"Failed to get Vertex AI token: {e}")
            raise e

    @classmethod
    def call_ai(cls, prompt: str, provider: str = None, model_id: str = None, response_mime_type: str = "application/json") -> str:
        """
        统一调用入口
        :param prompt: 提示词
        :param provider: "gemini" 或 "vertex"，默认为 None (使用配置值)
        :param model_id: 模型 ID，默认为 None (使用配置值)
        :param response_mime_type: 响应格式，默认为 "application/json"
        """
        provider = (provider or AI_PROVIDER).lower()
        
        if provider == "vertex":
            return cls._call_vertex(prompt, model_id or GEMINI_MODEL_ID, response_mime_type)
        else:
            return cls._call_gemini(prompt, model_id or GEMINI_MODEL_ID, response_mime_type)

    @classmethod
    def _call_gemini(cls, prompt: str, model_id: str, response_mime_type: str) -> str:
        """调用 Google AI Studio (Gemini API)"""
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
        params = {"key": GEMINI_API_KEY}
        headers = {"Content-Type": "application/json"}
        
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": response_mime_type}
        }
        
        return cls._send_request(url, headers, payload, params=params)

    @classmethod
    def _call_vertex(cls, prompt: str, model_id: str, response_mime_type: str) -> str:
        """调用 Google Cloud Vertex AI"""
        token = cls._get_vertex_token()
        url = f"https://aiplatform.googleapis.com/v1/projects/{VERTEX_PROJECT_ID}/locations/{VERTEX_LOCATION}/publishers/google/models/{model_id}:generateContent"
        
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": response_mime_type}
        }
        
        return cls._send_request(url, headers, payload)

    @classmethod
    def _send_request(cls, url: str, headers: dict, payload: dict, params: dict = None) -> str:
        session = cls._get_session()
        try:
            response = session.post(url, headers=headers, params=params, json=payload, timeout=180)
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
        except requests.exceptions.HTTPError as e:
            logger.error(f"AI Request Failed: {e.response.text}")
            raise e
        except Exception as e:
            logger.error(f"Unexpected error in AI request: {e}")
            raise e
