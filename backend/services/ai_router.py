import asyncio
import dataclasses
import time

import httpx

from db import SessionLocal
from services.ai_adapters import get_adapter
from services.ai_config_service import get_snapshot
from services.app_log_service import AppLogService, app_logs


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
_DIAGNOSTIC_TEXT_LIMIT = 1000


@dataclasses.dataclass(frozen=True)
class ProviderErrorDiagnostic:
    category: str
    http_status: int | None
    provider_code: str | None
    request_id: str | None
    exception_type: str
    upstream_message: str
    response_body: object | None

    def as_log_dict(self) -> dict:
        return dataclasses.asdict(self)


class AIProviderRequestError(RuntimeError):
    def __init__(
        self,
        category: str,
        diagnostic: ProviderErrorDiagnostic | None = None,
        *,
        provider: str | None = None,
        model: str | None = None,
        capability: str | None = None,
        retry: int | None = None,
    ):
        self.category = category
        self.diagnostic = diagnostic
        self.provider = _sanitize_diagnostic_value(provider)
        self.model = _sanitize_diagnostic_value(model)
        self.capability = _sanitize_diagnostic_value(capability)
        self.retry = (
            retry
            if isinstance(retry, int) and not isinstance(retry, bool)
            else None
        )
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


def _safe_rendered_text(value) -> str | None:
    if value is None:
        return None
    try:
        return str(value)
    except Exception:
        return None


def _safe_text(value) -> str | None:
    rendered = _safe_rendered_text(value)
    if rendered is None:
        return None
    return rendered[:_DIAGNOSTIC_TEXT_LIMIT]


def _safe_attribute(owner, attribute: str):
    try:
        return getattr(owner, attribute, None)
    except Exception:
        return None


def _safe_http_status(response, numeric_codes: set[int]) -> int | None:
    for owner in (response,):
        for attribute in ("status_code", "status", "code"):
            value = _safe_attribute(owner, attribute)
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.strip().isdigit():
                return int(value.strip())
    return next(iter(numeric_codes), None)


def _safe_response_headers(response) -> object | None:
    return _safe_attribute(response, "headers")


def _safe_request_id(response) -> str | None:
    headers = _safe_response_headers(response)
    if headers is None:
        return None
    for name in ("x-request-id", "x-goog-request-id"):
        try:
            value = headers.get(name)
        except Exception:
            value = None
        if value is not None:
            return _safe_text(value)
    try:
        items = headers.items()
    except Exception:
        return None
    try:
        for name, value in items:
            if str(name).lower() in {"x-request-id", "x-goog-request-id"}:
                return _safe_text(value)
    except Exception:
        return None
    return None


def _sanitize_diagnostic_value(value):
    if value is None:
        return None
    return AppLogService.sanitize(value)


def _raw_response_body(response) -> object | None:
    if response is None:
        return None
    try:
        body = response.json()
    except Exception:
        body = _safe_attribute(response, "text")
    if body in (None, ""):
        return None
    return body


def _collect_loc_sensitive_values(
    value,
) -> tuple[tuple[str, ...], bool]:
    found = []
    remaining = 100
    complete = True

    def visit(item, depth=0, collect_strings=False):
        nonlocal complete, remaining
        if remaining <= 0 or depth >= 12:
            complete = False
            return
        remaining -= 1
        if isinstance(item, str):
            if collect_strings and item:
                found.append(item)
            return
        if isinstance(item, dict):
            sensitive_loc = AppLogService._loc_targets_sensitive_input(
                item
            )
            for key, nested in item.items():
                collect_nested = (
                    collect_strings
                    or (
                        sensitive_loc
                        and AppLogService._normalized_key(key) == "input"
                    )
                )
                visit(nested, depth + 1, collect_nested)
        elif isinstance(item, (list, tuple)):
            for nested in item:
                visit(nested, depth + 1, collect_strings)

    visit(value)
    return (
        tuple(sorted(set(found), key=len, reverse=True)),
        complete,
    )


def _scrub_exact_text(value: str | None, sensitive_values) -> str | None:
    if value is None:
        return None
    for sensitive in _normalized_sensitive_strings(sensitive_values):
        value = value.replace(sensitive, "[REDACTED]")
    return value


def _normalized_sensitive_strings(sensitive_values) -> tuple[str, ...]:
    return tuple(sorted({
        value
        for value in sensitive_values
        if isinstance(value, str) and value
    }, key=len, reverse=True))


def _scrub_exact_value(value, sensitive_values):
    normalized = _normalized_sensitive_strings(sensitive_values)
    if isinstance(value, str):
        return _scrub_exact_text(value, normalized)
    if isinstance(value, dict):
        return {
            _scrub_exact_text(str(key), normalized): _scrub_exact_value(
                item,
                normalized,
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            _scrub_exact_value(item, normalized)
            for item in value
        ]
    if isinstance(value, tuple):
        return tuple(
            _scrub_exact_value(item, normalized)
            for item in value
        )
    return value


def _find_provider_code(value) -> str | None:
    if not isinstance(value, dict):
        return None
    candidates = (value, value.get("error"))
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        code = candidate.get("code")
        if code is not None:
            return _safe_text(code)
    return None


def _safe_provider_code(exc: Exception, response, response_body) -> str | None:
    for owner in (exc, response):
        for attribute in ("code", "status"):
            value = _safe_attribute(owner, attribute)
            if isinstance(value, bool) or value is None:
                continue
            code = _safe_text(value)
            if code and not code.strip().isdigit():
                return code
    return _find_provider_code(response_body)


def _classify_provider_error(
    exc: Exception,
    numeric_codes: set[int],
    named_codes: set[str],
) -> str:
    if isinstance(
        exc,
        (TimeoutError, asyncio.TimeoutError, httpx.TimeoutException),
    ):
        return "timeout"
    if numeric_codes & {401, 403} or named_codes & _AUTH_CODES:
        return "authentication"
    if numeric_codes & {408, 504}:
        return "timeout"
    if 404 in numeric_codes or named_codes & _MODEL_CODES:
        return "model_not_found"
    if 429 in numeric_codes or named_codes & _RATE_LIMIT_CODES:
        return "rate_limit"
    if named_codes & _TIMEOUT_CODES:
        return "timeout"
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
        return "protocol_incompatible"
    return "upstream_failure"


def diagnose_provider_error(
    exc: Exception,
    *,
    sensitive_values=(),
) -> ProviderErrorDiagnostic:
    numeric_codes, named_codes = _safe_error_codes(exc)
    response = _safe_attribute(exc, "response")
    raw_response_body = _raw_response_body(response)
    if raw_response_body is None:
        raw_response_body = _safe_attribute(exc, "details")
    loc_sensitive_values, loc_scan_complete = (
        _collect_loc_sensitive_values(raw_response_body)
    )
    exact_sensitive_values = (
        *loc_sensitive_values,
        *_normalized_sensitive_strings(sensitive_values),
    )
    response_body = _scrub_exact_value(
        _sanitize_diagnostic_value(raw_response_body),
        exact_sensitive_values,
    )
    provider_code = _safe_provider_code(exc, response, response_body)
    if provider_code:
        named_codes.add(provider_code.strip().upper().replace("-", "_"))
    category = _classify_provider_error(exc, numeric_codes, named_codes)
    if (
        isinstance(raw_response_body, (dict, list, tuple))
        and not loc_scan_complete
    ):
        upstream_message = (
            f"{type(exc).__name__}: structured upstream response omitted"
        )
    else:
        upstream_message = _scrub_exact_text(
            _safe_rendered_text(exc),
            exact_sensitive_values,
        )
        if upstream_message is not None:
            upstream_message = upstream_message[:_DIAGNOSTIC_TEXT_LIMIT]
    return ProviderErrorDiagnostic(
        category=category,
        http_status=_safe_http_status(response, numeric_codes),
        provider_code=_sanitize_diagnostic_value(
            _scrub_exact_text(provider_code, exact_sensitive_values)
        ),
        request_id=_sanitize_diagnostic_value(
            _scrub_exact_text(
                _safe_request_id(response),
                exact_sensitive_values,
            )
        ),
        exception_type=type(exc).__name__,
        upstream_message=_sanitize_diagnostic_value(
            upstream_message
        ) or "",
        response_body=response_body,
    )


def map_provider_error(
    exc: Exception,
    *,
    provider: str | None = None,
    model: str | None = None,
    capability: str | None = None,
    retry: int | None = None,
    sensitive_values=(),
) -> AIProviderRequestError:
    diagnostic = diagnose_provider_error(
        exc,
        sensitive_values=sensitive_values,
    )
    return AIProviderRequestError(
        diagnostic.category,
        diagnostic,
        provider=provider,
        model=model,
        capability=capability,
        retry=retry,
    )


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
                mapped = map_provider_error(
                    exc,
                    provider=snapshot.name,
                    model=snapshot.model,
                    capability=capability,
                    retry=attempt,
                    sensitive_values=(
                        snapshot.api_key,
                        snapshot.vertex_key_path,
                    ),
                )
                diagnostic = mapped.diagnostic
                duration_ms = round((time.monotonic() - started) * 1000)
                if attempt >= snapshot.max_retries:
                    terminal_error = mapped
                    app_logs.emit(
                        level="error",
                        source="ai",
                        message={
                            "summary": str(mapped),
                            "diagnostic": diagnostic.as_log_dict(),
                            "attempt": attempt + 1,
                            "max_attempts": snapshot.max_retries + 1,
                        },
                        capability=capability,
                        provider=snapshot.name,
                        model=snapshot.model,
                        duration_ms=duration_ms,
                        retry=attempt,
                    )
                    break
                app_logs.emit(
                    level="warning",
                    source="ai",
                    message={
                        "summary": "AI 请求重试",
                        "diagnostic": diagnostic.as_log_dict(),
                        "attempt": attempt + 1,
                        "max_attempts": snapshot.max_retries + 1,
                    },
                    capability=capability,
                    provider=snapshot.name,
                    model=snapshot.model,
                    duration_ms=duration_ms,
                    retry=attempt + 1,
                )
                await asyncio.sleep(self.base_delay * (2**attempt))

        raise terminal_error from None
