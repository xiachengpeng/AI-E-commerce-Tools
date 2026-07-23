import asyncio
import base64
from dataclasses import dataclass
import inspect
import threading
from abc import ABC, abstractmethod

import httpx
from google import genai
from google.genai import types
from google.oauth2 import service_account

from services.ai_config_service import ProviderSnapshot


class AIAdapter(ABC):
    @abstractmethod
    async def generate(self, snapshot: ProviderSnapshot, payload: dict) -> dict:
        """Generate content using a provider snapshot."""

    async def close(self) -> None:
        """Release resources owned by this adapter."""


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
        self._clients: dict[tuple[int, int], _GoogleClientEntry] = {}
        self._retired_clients: list[_GoogleClientEntry] = []
        self._client_lock = threading.RLock()

    def _build_client(self, snapshot: ProviderSnapshot):
        return genai.Client(api_key=snapshot.api_key)

    @staticmethod
    def _close_client(entry):
        if entry.closed:
            return
        close = getattr(entry.client, "close", None)
        if callable(close):
            close()
        entry.closed = True

    def _retire_superseded_clients(
        self,
        snapshot: ProviderSnapshot,
        current_key: tuple[int, int],
    ) -> None:
        for key, entry in tuple(self._clients.items()):
            if key[0] != snapshot.id or key == current_key:
                continue
            self._clients.pop(key, None)
            entry.stale = True
            if entry.active == 0:
                self._close_client(entry)
            else:
                self._retired_clients.append(entry)

    def _entry(self, snapshot: ProviderSnapshot) -> "_GoogleClientEntry":
        if snapshot.id <= 0:
            return _GoogleClientEntry(
                client=self._build_client(snapshot),
                stale=True,
            )
        key = (snapshot.id, snapshot.config_version)
        with self._client_lock:
            self._retire_superseded_clients(snapshot, key)
            entry = self._clients.get(key)
            if entry is None:
                entry = _GoogleClientEntry(
                    client=self._build_client(snapshot)
                )
                self._clients[key] = entry
            return entry

    def _client(self, snapshot: ProviderSnapshot):
        if self._fixed_client is not None:
            return self._fixed_client
        return self._entry(snapshot).client

    def invalidate_provider(self, provider_id: int) -> None:
        if self._fixed_client is not None:
            return
        with self._client_lock:
            for key, entry in tuple(self._clients.items()):
                if key[0] != provider_id:
                    continue
                self._clients.pop(key, None)
                entry.stale = True
                if entry.active == 0:
                    self._close_client(entry)
                elif entry not in self._retired_clients:
                    self._retired_clients.append(entry)

    def _acquire_client(
        self,
        snapshot: ProviderSnapshot,
    ) -> tuple[object, "_GoogleClientEntry | None"]:
        if self._fixed_client is not None:
            return self._fixed_client, None
        with self._client_lock:
            entry = self._entry(snapshot)
            entry.active += 1
            return entry.client, entry

    def _release_client(self, entry: "_GoogleClientEntry | None") -> None:
        if entry is None:
            return
        with self._client_lock:
            entry.active = max(0, entry.active - 1)
            if entry.stale and entry.active == 0:
                self._close_client(entry)
                if entry in self._retired_clients:
                    self._retired_clients.remove(entry)

    async def generate(self, snapshot: ProviderSnapshot, payload: dict) -> dict:
        client, entry = self._acquire_client(snapshot)
        task = asyncio.create_task(
            asyncio.to_thread(
                client.models.generate_content,
                model=snapshot.model,
                contents=convert_google_contents(
                    payload.get("contents", [])
                ),
                config=convert_google_config(
                    payload.get("generationConfig")
                    or payload.get("config")
                    or {}
                ),
            )
        )
        release_on_exit = True
        try:
            response = await asyncio.wait_for(
                asyncio.shield(task),
                timeout=snapshot.timeout_seconds,
            )
            return google_response_to_dict(response)
        except BaseException:
            if not task.done():
                release_on_exit = False

                def release_when_done(completed_task):
                    try:
                        completed_task.exception()
                    except (asyncio.CancelledError, Exception):
                        pass
                    self._release_client(entry)

                task.add_done_callback(release_when_done)
            raise
        finally:
            if release_on_exit:
                self._release_client(entry)

    async def close(self) -> None:
        if self._fixed_client is not None:
            return
        with self._client_lock:
            entries = list(self._clients.values())
            self._clients.clear()
            for entry in entries:
                entry.stale = True
                if entry.active == 0:
                    self._close_client(entry)
                elif entry not in self._retired_clients:
                    self._retired_clients.append(entry)


@dataclass
class _GoogleClientEntry:
    client: object
    active: int = 0
    stale: bool = False
    closed: bool = False


class VertexAdapter(GeminiAdapter):
    def _build_client(self, snapshot: ProviderSnapshot):
        client_options = {
            "vertexai": True,
            "project": snapshot.vertex_project_id,
            "location": snapshot.vertex_location,
        }
        if snapshot.vertex_key_path:
            client_options["credentials"] = (
                service_account.Credentials.from_service_account_file(
                    snapshot.vertex_key_path
                )
            )
        return genai.Client(**client_options)


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


def extract_inline_image_urls(payload):
    images = []
    for content in payload.get("contents", []) or []:
        if isinstance(content, str):
            continue
        for part in content.get("parts", []):
            inline_data = part.get("inlineData") or part.get("inline_data")
            if not inline_data:
                continue
            mime_type = (
                inline_data.get("mimeType")
                or inline_data.get("mime_type")
                or "application/octet-stream"
            )
            images.append(
                {
                    "url": (
                        f"data:{mime_type};base64,"
                        f"{inline_data.get('data', '')}"
                    )
                }
            )
    return images


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
        headers = {}
        if snapshot.api_key:
            headers["Authorization"] = f"Bearer {snapshot.api_key}"
        base_url = (snapshot.base_url or "").rstrip("/")

        if snapshot.capability == "image":
            body = {
                "model": snapshot.model,
                "prompt": extract_text_prompt(payload),
                "response_format": "b64_json",
            }
            input_images = extract_inline_image_urls(payload)
            if input_images:
                body["input_images"] = input_images
            generation_config = (
                payload.get("generationConfig")
                or payload.get("config")
                or {}
            )
            image_config = (
                generation_config.get("imageConfig")
                or generation_config.get("image_config")
                or {}
            )
            aspect_ratio = (
                image_config.get("aspectRatio")
                or image_config.get("aspect_ratio")
            )
            image_size = (
                image_config.get("imageSize")
                or image_config.get("image_size")
            )
            if aspect_ratio:
                body["aspect_ratio"] = aspect_ratio
            if image_size:
                body["image_size"] = image_size
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
        generation_config = (
            payload.get("generationConfig")
            or payload.get("config")
            or {}
        )
        response_mime_type = (
            generation_config.get("responseMimeType")
            or generation_config.get("response_mime_type")
        )
        if response_mime_type == "application/json":
            body["response_format"] = {"type": "json_object"}
        response = await self.client.post(
            f"{base_url}/v1/chat/completions",
            headers=headers,
            json=body,
            timeout=snapshot.timeout_seconds,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return normalized_text_response(content)

    async def close(self) -> None:
        close = getattr(self.client, "aclose", None)
        if callable(close):
            result = close()
            if inspect.isawaitable(result):
                await result


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


def invalidate_provider_clients(provider_id: int) -> None:
    for adapter in tuple(dict.fromkeys(_ADAPTERS.values())):
        invalidate = getattr(adapter, "invalidate_provider", None)
        if callable(invalidate):
            invalidate(provider_id)


async def close_adapters() -> None:
    for adapter in tuple(dict.fromkeys(_ADAPTERS.values())):
        close = getattr(adapter, "close", None)
        if not callable(close):
            continue
        result = close()
        if inspect.isawaitable(result):
            await result
