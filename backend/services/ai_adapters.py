import asyncio
import base64
import os
from abc import ABC, abstractmethod

import httpx
from google import genai
from google.genai import types

from services.ai_config_service import ProviderSnapshot


class AIAdapter(ABC):
    @abstractmethod
    async def generate(self, snapshot: ProviderSnapshot, payload: dict) -> dict:
        """Generate content using a provider snapshot."""


def convert_google_contents(contents):
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
                parts.append(types.Part(text=part["text"]))
                continue
            inline_data = part.get("inlineData") or part.get("inline_data")
            if inline_data:
                data = inline_data.get("data", "")
                if isinstance(data, str):
                    data = base64.b64decode(data)
                parts.append(
                    types.Part.from_bytes(
                        data=data,
                        mime_type=(
                            inline_data.get("mimeType")
                            or inline_data.get("mime_type")
                        ),
                    )
                )
        converted.append(
            types.Content(role=content.get("role", "user"), parts=parts)
        )
    return converted


def convert_google_config(config: dict):
    if not config:
        return None

    image_config = config.get("imageConfig") or config.get("image_config")
    converted_image_config = None
    if image_config:
        converted_image_config = types.ImageConfig(
            aspect_ratio=(
                image_config.get("aspectRatio")
                or image_config.get("aspect_ratio")
            ),
            image_size=(
                image_config.get("imageSize") or image_config.get("image_size")
            ),
        )

    return types.GenerateContentConfig(
        response_mime_type=(
            config.get("responseMimeType") or config.get("response_mime_type")
        ),
        response_modalities=(
            config.get("responseModalities")
            or config.get("response_modalities")
        ),
        image_config=converted_image_config,
    )


def google_response_to_dict(response) -> dict:
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
                parts.append(
                    {
                        "inlineData": {
                            "mimeType": inline_data.mime_type,
                            "data": data,
                        }
                    }
                )
        result["candidates"].append(
            {
                "content": {
                    "role": getattr(candidate.content, "role", "model"),
                    "parts": parts,
                }
            }
        )
    return result


class GeminiAdapter(AIAdapter):
    def __init__(self, client=None):
        self._fixed_client = client
        self._clients = {}

    def _build_client(self, snapshot: ProviderSnapshot):
        return genai.Client(api_key=snapshot.api_key)

    def _client(self, snapshot: ProviderSnapshot):
        if self._fixed_client is not None:
            return self._fixed_client
        key = (snapshot.id, snapshot.config_version)
        if key not in self._clients:
            self._clients[key] = self._build_client(snapshot)
        return self._clients[key]

    async def generate(self, snapshot: ProviderSnapshot, payload: dict) -> dict:
        client = self._client(snapshot)
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=snapshot.model,
            contents=convert_google_contents(payload.get("contents", [])),
            config=convert_google_config(
                payload.get("generationConfig")
                or payload.get("config")
                or {}
            ),
        )
        return google_response_to_dict(response)


class VertexAdapter(GeminiAdapter):
    def _build_client(self, snapshot: ProviderSnapshot):
        if snapshot.vertex_key_path:
            os.environ.setdefault(
                "GOOGLE_APPLICATION_CREDENTIALS", snapshot.vertex_key_path
            )
        return genai.Client(
            vertexai=True,
            project=snapshot.vertex_project_id,
            location=snapshot.vertex_location,
        )


def convert_openai_messages(contents):
    messages = []
    for content in contents or []:
        if isinstance(content, str):
            messages.append(
                {
                    "role": "user",
                    "content": [{"type": "text", "text": content}],
                }
            )
            continue

        converted_parts = []
        for part in content.get("parts", []):
            if "text" in part:
                converted_parts.append({"type": "text", "text": part["text"]})
                continue
            inline_data = part.get("inlineData") or part.get("inline_data")
            if inline_data:
                mime_type = (
                    inline_data.get("mimeType")
                    or inline_data.get("mime_type")
                    or "application/octet-stream"
                )
                converted_parts.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": (
                                f"data:{mime_type};base64,"
                                f"{inline_data.get('data', '')}"
                            )
                        },
                    }
                )
        messages.append(
            {
                "role": (
                    "assistant"
                    if content.get("role") == "model"
                    else content.get("role", "user")
                ),
                "content": converted_parts,
            }
        )
    return messages


def extract_text_prompt(payload):
    texts = []
    for content in payload.get("contents", []) or []:
        if isinstance(content, str):
            texts.append(content)
            continue
        for part in content.get("parts", []):
            if "text" in part:
                texts.append(part["text"])
    return "\n".join(texts)


def normalized_text_response(text):
    return {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [{"text": text}],
                }
            }
        ]
    }


def normalized_image_response(data, mime_type):
    return {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": data,
                            }
                        }
                    ],
                }
            }
        ]
    }


class OpenAICompatibleAdapter(AIAdapter):
    def __init__(self, client=None):
        self.client = client or httpx.AsyncClient()

    async def generate(self, snapshot: ProviderSnapshot, payload: dict) -> dict:
        headers = {"Authorization": f"Bearer {snapshot.api_key}"}
        base_url = (snapshot.base_url or "").rstrip("/")

        if snapshot.capability == "image":
            body = {
                "model": snapshot.model,
                "prompt": extract_text_prompt(payload),
                "response_format": "b64_json",
            }
            response = await self.client.post(
                f"{base_url}/v1/images/generations",
                headers=headers,
                json=body,
                timeout=snapshot.timeout_seconds,
            )
            response.raise_for_status()
            item = response.json()["data"][0]
            return normalized_image_response(item["b64_json"], "image/png")

        body = {
            "model": snapshot.model,
            "messages": convert_openai_messages(payload.get("contents", [])),
        }
        response = await self.client.post(
            f"{base_url}/v1/chat/completions",
            headers=headers,
            json=body,
            timeout=snapshot.timeout_seconds,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return normalized_text_response(content)


_ADAPTERS = {
    "gemini": GeminiAdapter(),
    "vertex": VertexAdapter(),
    "openai_compatible": OpenAICompatibleAdapter(),
}


def get_adapter(protocol: str) -> AIAdapter:
    try:
        return _ADAPTERS[protocol.lower()]
    except (AttributeError, KeyError) as exc:
        raise ValueError(f"Unsupported AI protocol: {protocol}") from exc
