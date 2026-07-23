"""In-memory structured application logs with sensitive-value redaction."""

import asyncio
import datetime
import re
from collections import deque


class AppLogService:
    """Keep a bounded stream of safe log entries for application consumers."""

    def __init__(self, capacity: int = 200):
        self._entries = deque(maxlen=capacity)
        self._subscribers: set[asyncio.Queue] = set()

    @staticmethod
    def _redact(value: str) -> str:
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
            r"data:image/[^;,\s]+;base64,[A-Za-z0-9+/=]+",
            "[IMAGE REDACTED]",
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
    def _redact_optional(cls, value: str | None) -> str | None:
        return cls._redact(value) if isinstance(value, str) else value

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
        entry = {
            "timestamp": datetime.datetime.now(datetime.UTC).isoformat(),
            "level": self._redact(str(level)),
            "source": self._redact(str(source)),
            "message": self._redact(str(message)),
            "capability": self._redact_optional(capability),
            "provider": self._redact_optional(provider),
            "model": self._redact_optional(model),
            "duration_ms": self._coerce_int(duration_ms),
            "retry": self._coerce_int(retry),
        }
        self._entries.append(dict(entry))
        for queue in tuple(self._subscribers):
            try:
                queue.put_nowait(dict(entry))
            except asyncio.QueueFull:
                continue
        return dict(entry)

    def recent(self) -> list[dict]:
        return [dict(entry) for entry in self._entries]

    def subscribe(self) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=200)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)


app_logs = AppLogService()
