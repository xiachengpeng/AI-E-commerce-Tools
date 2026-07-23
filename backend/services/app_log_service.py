"""In-memory structured application logs with sensitive-value redaction."""

import asyncio
import ast
import copy
import datetime
import json
import re
import threading
import uuid
from collections import deque


APP_LOG_OVERFLOW = object()


class _LogSubscriber:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.overflowed = False


class AppLogService:
    """Keep a bounded stream of safe log entries for application consumers."""

    _SENSITIVE_KEYS = {
        "apikey",
        "authorization",
        "base64image",
        "clientemail",
        "clientid",
        "clientx509certurl",
        "imagebase64",
        "imagedata",
        "privatekey",
        "privatekeyid",
        "prompt",
        "providerresponse",
        "response",
        "tokenuri",
        "universedomain",
        "vertexkeypath",
        "xapikey",
        "authuri",
    }
    _INLINE_CONTAINER_KEYS = {"inlinedata"}

    def __init__(
        self,
        capacity: int = 200,
        session_id: str | None = None,
    ):
        self._capacity = capacity
        self._entries = deque(maxlen=capacity)
        self._subscribers: dict[
            asyncio.Queue,
            _LogSubscriber,
        ] = {}
        self.session_id = session_id or uuid.uuid4().hex
        self._next_id = 1
        self._lock = threading.RLock()

    @staticmethod
    def _normalized_key(value) -> str:
        return re.sub(r"[^a-z0-9]", "", str(value).lower())

    @classmethod
    def _sanitize_structured(cls, value, parent_key: str | None = None):
        if isinstance(value, dict):
            sanitized = {}
            parent_normalized = cls._normalized_key(parent_key or "")
            for key, item in value.items():
                normalized = cls._normalized_key(key)
                if (
                    normalized in cls._SENSITIVE_KEYS
                    or (
                        parent_normalized in cls._INLINE_CONTAINER_KEYS
                        and normalized == "data"
                    )
                ):
                    sanitized[key] = "[REDACTED]"
                else:
                    sanitized[key] = cls._sanitize_structured(item, str(key))
            return sanitized
        if isinstance(value, list):
            return [
                cls._sanitize_structured(item, parent_key)
                for item in value
            ]
        if isinstance(value, tuple):
            return tuple(
                cls._sanitize_structured(item, parent_key)
                for item in value
            )
        if isinstance(value, str):
            return cls._redact_string(value)
        return value

    @classmethod
    def _redact(cls, value):
        if isinstance(value, (dict, list, tuple)):
            return cls._sanitize_structured(value)
        if not isinstance(value, str):
            value = str(value)

        stripped = value.strip()
        if (
            len(stripped) >= 2
            and stripped[0] in "[{"
            and stripped[-1] in "]}"
        ):
            for parser, serializer in (
                (
                    json.loads,
                    lambda item: json.dumps(
                        item,
                        ensure_ascii=False,
                    ),
                ),
                (ast.literal_eval, repr),
            ):
                try:
                    parsed = parser(stripped)
                except (ValueError, SyntaxError, TypeError, json.JSONDecodeError):
                    continue
                if isinstance(parsed, (dict, list, tuple)):
                    return serializer(cls._sanitize_structured(parsed))[:1000]
        return cls._redact_string(value)

    @staticmethod
    def _redact_string(value: str) -> str:
        value = re.sub(
            r"(?i)((?:[\"']authorization[\"'])\s*[:=]\s*)[\"'](?:[^\s,;\"']+\s+)?[^\s,;\"']+[\"']",
            r'\1"[REDACTED]"',
            value,
        )
        value = re.sub(
            r"(?i)(\bauthorization\b\s*[:=]\s*)(?:[^\s,;]+\s+)?[^\s,;]+",
            "Authorization: [REDACTED]",
            value,
        )
        value = re.sub(
            r"(?i)data:image/[^,\s]+;base64,[A-Za-z0-9+/=_-]+",
            "[IMAGE REDACTED]",
            value,
        )
        value = re.sub(
            (
                r"(?is)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----"
                r".*?"
                r"-----END(?: [A-Z0-9]+)* PRIVATE KEY-----"
            ),
            "[REDACTED PEM]",
            value,
        )
        nested_inline_prefix = (
            r"(?is)("
            r"(?:[\"']?inline(?:data|_data)[\"']?)"
            r"\s*:\s*\{[^{}]{0,500}?"
            r"(?:[\"']?data[\"']?)\s*:\s*"
            r")"
        )
        value = re.sub(
            nested_inline_prefix + r'"(?:\\.|[^"\\])*"',
            r'\1"[REDACTED]"',
            value,
        )
        value = re.sub(
            nested_inline_prefix + r"'(?:\\.|[^'\\])*'",
            r'\1"[REDACTED]"',
            value,
        )
        value = re.sub(
            nested_inline_prefix + r"(?![\"'])[^\s,;}}\]]+",
            r"\1[REDACTED]",
            value,
        )
        sensitive_label = (
            r"(?:vertex[_ -]?key[_ -]?path"
            r"|image[_ -]?data"
            r"|image[_ -]?base64"
            r"|base64[_ -]?image"
            r"|private[_ -]?key(?:[_ -]?id)?"
            r"|client[_ -]?email"
            r"|client[_ -]?id"
            r"|client[_ -]?x509[_ -]?cert[_ -]?url"
            r"|auth[_ -]?uri"
            r"|token[_ -]?uri"
            r"|universe[_ -]?domain"
            r"|inline(?:data|_data)\.data)"
        )
        value = re.sub(
            rf"(?i)((?:[\"']?){sensitive_label}(?:[\"']?)"
            r'\s*[:=]\s*)"(?:\\.|[^"\\])*"',
            r'\1"[REDACTED]"',
            value,
        )
        value = re.sub(
            rf"(?i)((?:[\"']?){sensitive_label}(?:[\"']?)"
            r"\s*[:=]\s*)'(?:\\.|[^'\\])*'",
            r'\1"[REDACTED]"',
            value,
        )
        value = re.sub(
            rf"(?i)((?:[\"']?){sensitive_label}(?:[\"']?)"
            r"\s*[:=]\s*)(?![\"'])[^\s,;}}\]]+",
            r"\1[REDACTED]",
            value,
        )
        value = re.sub(
            r"(?i)(([\"']?)(?:x[-_ ]?)?api(?:[_ -]?key|key)\2(?:\s*[:=]\s*|\s+(?![:=])))([\"'])[^\"']*\3",
            r"\1\3[REDACTED]\3",
            value,
        )
        value = re.sub(
            r"(?i)(([\"']?)(?:x[-_ ]?)?api(?:[_ -]?key|key)\2(?:\s*[:=]\s*|\s+(?![:=])))(?![\"'])[^\s,;}\]]+",
            r"\1[REDACTED]",
            value,
        )
        value = re.sub(
            r"(?im)(\b(?:prompt|response|provider[_ -]?response|providerresponse)\s*[:=]\s*)[^\r\n]*",
            r"\1[REDACTED]",
            value,
        )
        value = re.sub(
            r"(?i)([\"'](?:prompt|response|provider[_-]?response|providerresponse)[\"']\s*:\s*)(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^,}\]\r\n]+)",
            r'\1"[REDACTED]"',
            value,
        )
        return value[:1000]

    @classmethod
    def _redact_optional(cls, value):
        return cls._redact(value) if value is not None else None

    @staticmethod
    def _coerce_int(value: int | str | None) -> int | None:
        if value is None or isinstance(value, bool):
            return None
        try:
            return int(value)
        except (TypeError, ValueError, OverflowError):
            return None

    def emit(
        self,
        *,
        level: str,
        source: str,
        message: str,
        capability: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        duration_ms: int | str | None = None,
        retry: int | str | None = None,
    ) -> dict:
        with self._lock:
            entry_id = self._next_id
            self._next_id += 1
            entry = {
                "session_id": self.session_id,
                "id": entry_id,
                "timestamp": datetime.datetime.now(
                    datetime.UTC
                ).isoformat(),
                "level": self._redact(level),
                "source": self._redact(source),
                "message": self._redact(message),
                "capability": self._redact_optional(capability),
                "provider": self._redact_optional(provider),
                "model": self._redact_optional(model),
                "duration_ms": self._coerce_int(duration_ms),
                "retry": self._coerce_int(retry),
            }
            self._entries.append(copy.deepcopy(entry))
            for queue, subscriber in tuple(self._subscribers.items()):
                try:
                    subscriber.loop.call_soon_threadsafe(
                        self._publish_to_subscriber,
                        queue,
                        copy.deepcopy(entry),
                    )
                except RuntimeError:
                    self._subscribers.pop(queue, None)
            return copy.deepcopy(entry)

    def _publish_to_subscriber(
        self,
        queue: asyncio.Queue,
        entry: dict,
    ) -> None:
        with self._lock:
            subscriber = self._subscribers.get(queue)
            if subscriber is None or subscriber.overflowed:
                return
            try:
                queue.put_nowait(entry)
            except asyncio.QueueFull:
                while True:
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                queue.put_nowait(APP_LOG_OVERFLOW)
                subscriber.overflowed = True

    def recent(self) -> list[dict]:
        with self._lock:
            return [copy.deepcopy(entry) for entry in self._entries]

    def normalize_cursor(
        self,
        session_id: str | None,
        sequence_id: int,
    ) -> tuple[str, int]:
        with self._lock:
            high_water = self._next_id - 1
            if (
                session_id != self.session_id
                or sequence_id < 0
                or sequence_id > high_water
            ):
                return self.session_id, 0
            return self.session_id, sequence_id

    def recent_after(
        self,
        session_id: str | None,
        sequence_id: int,
        subscriber_queue: asyncio.Queue | None = None,
    ) -> list[dict]:
        with self._lock:
            normalized_session, normalized_sequence = (
                self.normalize_cursor(
                    session_id,
                    sequence_id,
                )
            )
            entries = [
                copy.deepcopy(entry)
                for entry in self._entries
                if (
                    entry["session_id"] == normalized_session
                    and entry["id"] > normalized_sequence
                )
            ]
            if subscriber_queue is not None:
                subscriber = self._subscribers.get(subscriber_queue)
                if subscriber is not None:
                    subscriber.overflowed = False
            return entries

    def subscribe(self) -> asyncio.Queue:
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue(maxsize=self._capacity)
        with self._lock:
            self._subscribers[queue] = _LogSubscriber(loop)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.pop(queue, None)


app_logs = AppLogService()
