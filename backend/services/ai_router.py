import asyncio
import time

import httpx

from db import SessionLocal
from services.ai_adapters import get_adapter
from services.ai_config_service import get_snapshot
from services.app_log_service import app_logs


_ERROR_MESSAGES = {
    "authentication": "AI 提供商认证失败",
    "model_not_found": "AI 模型不存在或不可用",
    "rate_limit": "AI 提供商请求频率受限",
    "timeout": "AI 提供商请求超时",
    "protocol_incompatible": "AI 提供商协议不兼容",
    "upstream_failure": "AI 提供商请求失败",
}

_AUTH_CODES = {
    "UNAUTHENTICATED",
    "PERMISSION_DENIED",
    "AUTHENTICATION_ERROR",
}
_MODEL_CODES = {
    "NOT_FOUND",
    "MODEL_NOT_FOUND",
}
_RATE_LIMIT_CODES = {
    "RESOURCE_EXHAUSTED",
    "RATE_LIMITED",
    "TOO_MANY_REQUESTS",
}
_TIMEOUT_CODES = {
    "DEADLINE_EXCEEDED",
    "TIMEOUT",
    "TIMED_OUT",
}
_PROTOCOL_CODES = {
    "INVALID_ARGUMENT",
    "METHOD_NOT_ALLOWED",
    "NOT_IMPLEMENTED",
    "UNIMPLEMENTED",
    "UNSUPPORTED",
}


class AIProviderRequestError(RuntimeError):
    def __init__(self, category: str):
        self.category = category
        super().__init__(_ERROR_MESSAGES[category])


def _safe_error_codes(exc: Exception) -> tuple[set[int], set[str]]:
    numeric_codes = set()
    named_codes = set()
    owners = [exc]
    try:
        response = getattr(exc, "response", None)
    except Exception:
        response = None
    if response is not None:
        owners.append(response)

    for owner in owners:
        for attribute in ("status_code", "code", "status"):
            try:
                value = getattr(owner, attribute, None)
            except Exception:
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                numeric_codes.add(value)
                continue
            if isinstance(value, str) and len(value) <= 64:
                normalized = value.strip().upper().replace("-", "_")
                if normalized.isdigit():
                    numeric_codes.add(int(normalized))
                elif normalized:
                    named_codes.add(normalized)
    return numeric_codes, named_codes


def map_provider_error(exc: Exception) -> AIProviderRequestError:
    if isinstance(
        exc,
        (TimeoutError, asyncio.TimeoutError, httpx.TimeoutException),
    ):
        return AIProviderRequestError("timeout")

    numeric_codes, named_codes = _safe_error_codes(exc)
    if numeric_codes & {401, 403} or named_codes & _AUTH_CODES:
        return AIProviderRequestError("authentication")
    if 404 in numeric_codes or named_codes & _MODEL_CODES:
        return AIProviderRequestError("model_not_found")
    if 429 in numeric_codes or named_codes & _RATE_LIMIT_CODES:
        return AIProviderRequestError("rate_limit")
    if named_codes & _TIMEOUT_CODES:
        return AIProviderRequestError("timeout")
    if (
        numeric_codes & {400, 405, 501}
        or named_codes & _PROTOCOL_CODES
        or isinstance(
            exc,
            (
                AttributeError,
                KeyError,
                IndexError,
                TypeError,
                ValueError,
                httpx.DecodingError,
                httpx.UnsupportedProtocol,
            ),
        )
    ):
        return AIProviderRequestError("protocol_incompatible")
    return AIProviderRequestError("upstream_failure")


class AIRouter:
    def __init__(self, base_delay: float = 2):
        self.base_delay = base_delay

    async def generate(
        self,
        capability: str,
        payload: dict,
        db=None,
    ) -> dict:
        owns_db = db is None
        current_db = SessionLocal() if owns_db else db
        try:
            snapshot = get_snapshot(current_db, capability)
        finally:
            if owns_db:
                current_db.close()

        adapter = get_adapter(snapshot.protocol)
        started = time.monotonic()
        app_logs.emit(
            level="info",
            source="ai",
            message="AI 请求开始",
            capability=capability,
            provider=snapshot.name,
            model=snapshot.model,
            retry=0,
        )
        terminal_error = None
        for attempt in range(snapshot.max_retries + 1):
            try:
                result = await adapter.generate(snapshot, payload)
                app_logs.emit(
                    level="success",
                    source="ai",
                    message="AI 请求完成",
                    capability=capability,
                    provider=snapshot.name,
                    model=snapshot.model,
                    duration_ms=round(
                        (time.monotonic() - started) * 1000
                    ),
                    retry=attempt,
                )
                return result
            except Exception as exc:
                if attempt >= snapshot.max_retries:
                    terminal_error = map_provider_error(exc)
                    app_logs.emit(
                        level="error",
                        source="ai",
                        message=str(terminal_error),
                        capability=capability,
                        provider=snapshot.name,
                        model=snapshot.model,
                        retry=attempt,
                    )
                    break
                app_logs.emit(
                    level="warning",
                    source="ai",
                    message="AI 请求重试",
                    capability=capability,
                    provider=snapshot.name,
                    model=snapshot.model,
                    retry=attempt + 1,
                )
                await asyncio.sleep(self.base_delay * (2**attempt))

        raise terminal_error from None
