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

    _STRUCTURED_CHARACTER_BUDGET = 12_000
    _STRUCTURED_ITEM_BUDGET = 100
    _STRUCTURED_MAX_DEPTH = 12
    _TRUNCATED = "[TRUNCATED]"
    _SENSITIVE_KEYS = {
        "accesstoken",
        "apikey",
        "auth",
        "authproviderx509certurl",
        "authentication",
        "authorization",
        "authtoken",
        "b64json",
        "base64",
        "base64image",
        "certificate",
        "clientsecret",
        "clientemail",
        "clientid",
        "clientx509certurl",
        "credential",
        "credentials",
        "googcredentials",
        "googlecredentials",
        "idtoken",
        "image",
        "imagebase64",
        "imageb64",
        "imagedata",
        "images",
        "inlinedatadata",
        "password",
        "passwd",
        "privatekey",
        "privatekeyid",
        "projectid",
        "prompt",
        "proxyauthorization",
        "providerresponse",
        "refreshtoken",
        "response",
        "serviceaccount",
        "serviceaccountcredentials",
        "token",
        "tokenuri",
        "universedomain",
        "vertexlocation",
        "vertexprojectid",
        "vertexkeypath",
        "xapikey",
        "xauthtoken",
        "xgoogapikey",
        "authuri",
    }
    _SENSITIVE_CONTAINER_KEYS = {
        "client",
        "clientcredential",
        "clientcredentials",
        "credential",
        "credentials",
        "googlecredential",
        "googlecredentials",
        "oauth",
        "oauthcredential",
        "oauthcredentials",
        "serviceaccount",
        "serviceaccountcredential",
        "serviceaccountcredentials",
    }
    _SAFE_METADATA_KEYS = {
        "capability",
        "configversion",
        "count",
        "duration",
        "durationms",
        "imagemodel",
        "imageendpoint",
        "imagegenerationmode",
        "mime",
        "mimetype",
        "model",
        "provider",
        "retry",
        "status",
        "textmodel",
    }
    _INLINE_CONTAINER_KEYS = {"inlinedata"}
    _LABELED_VALUE_RE = re.compile(
        r"""(?ix)
        (?<![A-Za-z0-9])
        (?:
            (?:\\?["'])
            (?P<quoted_label>[^"'\\\r\n]{1,80})
            (?:\\?["'])
          |
            (?P<bare_label>
                [A-Za-z][A-Za-z0-9_.-]*
                (?:[ \t]+(?:key|response|credentials?))?
            )
        )
        \s*[:=]\s*
        """
    )
    _FIELD_START_RE = re.compile(
        r"""(?ix)
        (?:\\?["'])?
        [A-Za-z][A-Za-z0-9_.-]*
        (?:[ \t]+(?:key|response|credentials?))?
        (?:\\?["'])?
        \s*[:=]
        """
    )
    _CREDENTIAL_PATH_RE = re.compile(
        r"""(?ix)
        (?<![A-Za-z0-9:/.\\])
        (?P<path>
            (?:[A-Z]:[\\/]|/)
            [^\s"'<>|,;]+?
            \.(?P<extension>json|pem|key|p12|pfx)
        )
        (?![A-Za-z0-9])
        """
    )
    _QUOTED_CREDENTIAL_PATH_RE = re.compile(
        r"""(?ix)
        (?P<quote>["'])
        (?P<path>
            (?:
                file:///
              |
                [A-Z]:[\\/]
              |
                /
            )
            [^"'<>|\r\n]+?
            \.(?P<extension>json|pem|key|p12|pfx)
        )
        (?P=quote)
        """
    )
    _FILE_CREDENTIAL_URI_RE = re.compile(
        r"""(?ix)
        (?<![A-Za-z0-9:/.\\])
        (?P<path>
            file:///
            [^\s"'<>|,;]+?
            \.(?P<extension>json|pem|key|p12|pfx)
        )
        (?![A-Za-z0-9])
        """
    )
    _CREDENTIAL_PATH_SEGMENTS = {
        "credential",
        "credentials",
        "key",
        "keys",
        "private",
        "secret",
        "secrets",
        "vertex",
    }
    _CREDENTIAL_JSON_MARKERS = {
        "credential",
        "key",
        "secret",
        "serviceaccount",
        "vertex",
    }

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
    def _is_sensitive_key(cls, value) -> bool:
        normalized = cls._normalized_key(value)
        if normalized in cls._SAFE_METADATA_KEYS:
            return False
        if (
            normalized in cls._SENSITIVE_KEYS
            or normalized in cls._SENSITIVE_CONTAINER_KEYS
        ):
            return True
        if (
            "base64" in normalized
            or normalized == "b64"
            or normalized.startswith("b64")
            or normalized.endswith("b64")
        ):
            return True
        if (
            "credential" in normalized
            or "privatekey" in normalized
            or "x509cert" in normalized
            or normalized.endswith("password")
            or normalized.endswith("certificate")
            or normalized.endswith("apikey")
        ):
            return True
        return (
            normalized.startswith("image")
            and normalized.removeprefix("image")
            in {"", "content", "data", "bytes", "payload", "source"}
        )

    @classmethod
    def _loc_targets_sensitive_input(cls, value: dict) -> bool:
        loc = value.get("loc")
        if not isinstance(loc, (list, tuple)):
            return False
        for segment in loc:
            normalized = cls._normalized_key(segment)
            if cls._is_sensitive_key(normalized):
                return True
            if (
                normalized.startswith("input")
                and cls._is_sensitive_key(normalized.removeprefix("input"))
            ):
                return True
        return False

    @classmethod
    def _bounded_safe_string(cls, value: str, budget: dict) -> str:
        safe = cls._redact_string(value)
        encoded_length = len(json.dumps(safe, ensure_ascii=False))
        remaining = budget["characters"]
        if encoded_length <= remaining:
            budget["characters"] -= encoded_length
            return safe

        marker = cls._TRUNCATED
        if remaining <= len(json.dumps(marker, ensure_ascii=False)):
            budget["characters"] = 0
            return marker
        low = 0
        high = len(safe)
        while low < high:
            midpoint = (low + high + 1) // 2
            candidate = safe[:midpoint] + marker
            if len(json.dumps(candidate, ensure_ascii=False)) <= remaining:
                low = midpoint
            else:
                high = midpoint - 1
        budget["characters"] = 0
        return safe[:low] + marker

    @classmethod
    def _sanitize_structured(
        cls,
        value,
        parent_key: str | None = None,
        *,
        _budget: dict | None = None,
        _depth: int = 0,
    ):
        if _budget is None:
            _budget = {
                "characters": cls._STRUCTURED_CHARACTER_BUDGET,
                "items": cls._STRUCTURED_ITEM_BUDGET,
            }
        if _depth >= cls._STRUCTURED_MAX_DEPTH:
            return cls._TRUNCATED
        if isinstance(value, dict):
            if value and _budget["items"] <= 0:
                return cls._TRUNCATED
            sanitized = {}
            parent_normalized = cls._normalized_key(parent_key or "")
            sensitive_loc_input = cls._loc_targets_sensitive_input(value)
            items = list(value.items())
            if _depth == 0:
                core_order = {
                    "summary": 0,
                    "attempt": 1,
                    "maxattempts": 2,
                }
                items.sort(
                    key=lambda pair: core_order.get(
                        cls._normalized_key(pair[0]),
                        len(core_order),
                    )
                )
            for index, (key, item) in enumerate(items):
                if _budget["items"] <= 0:
                    break
                if (
                    _budget["items"] == 1
                    and len(items) - index > 1
                ):
                    sanitized["_truncated"] = cls._TRUNCATED
                    _budget["items"] -= 1
                    break
                _budget["items"] -= 1
                safe_key = cls._bounded_safe_string(str(key), _budget)
                normalized = cls._normalized_key(key)
                if (
                    cls._is_sensitive_key(normalized)
                    or (sensitive_loc_input and normalized == "input")
                    or (
                        parent_normalized in cls._INLINE_CONTAINER_KEYS
                        and normalized == "data"
                    )
                ):
                    sanitized[safe_key] = "[REDACTED]"
                else:
                    sanitized[safe_key] = cls._sanitize_structured(
                        item,
                        str(key),
                        _budget=_budget,
                        _depth=_depth + 1,
                    )
            return sanitized
        if isinstance(value, list):
            if value and _budget["items"] <= 0:
                return cls._TRUNCATED
            sanitized = []
            for index, item in enumerate(value):
                if _budget["items"] <= 0:
                    break
                if (
                    _budget["items"] == 1
                    and len(value) - index > 1
                ):
                    sanitized.append(cls._TRUNCATED)
                    _budget["items"] -= 1
                    break
                _budget["items"] -= 1
                sanitized.append(
                    cls._sanitize_structured(
                        item,
                        parent_key,
                        _budget=_budget,
                        _depth=_depth + 1,
                    )
                )
            return sanitized
        if isinstance(value, tuple):
            if value and _budget["items"] <= 0:
                return cls._TRUNCATED
            sanitized = []
            for index, item in enumerate(value):
                if _budget["items"] <= 0:
                    break
                if (
                    _budget["items"] == 1
                    and len(value) - index > 1
                ):
                    sanitized.append(cls._TRUNCATED)
                    _budget["items"] -= 1
                    break
                _budget["items"] -= 1
                sanitized.append(
                    cls._sanitize_structured(
                        item,
                        parent_key,
                        _budget=_budget,
                        _depth=_depth + 1,
                    )
                )
            return tuple(sanitized)
        if isinstance(value, str):
            return cls._bounded_safe_string(value, _budget)
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

    @classmethod
    def sanitize(cls, value):
        """Return a log-safe copy for diagnostics exposed outside emit()."""
        return cls._redact(value)

    @classmethod
    def _redact_string(cls, value: str) -> str:
        value = cls._redact_credential_paths(value)
        value = re.sub(
            (
                r"(?is)data:image/[^\r\n,]*?;\s*base64\s*,[ \t]*"
                r"[A-Za-z0-9+/_-]+={0,2}"
                r"(?:(?:[ \t]*(?:\r?\n|\\r\\n|\\n)[ \t]*)"
                r"[A-Za-z0-9+/_-]+={0,2})*"
            ),
            "[IMAGE REDACTED]",
            value,
        )
        value = re.sub(
            (
                r"(?is)-----BEGIN [A-Z0-9 ]+-----.*?"
                r"(?:-----END [A-Z0-9 ]+-----|$)"
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
        return cls._redact_labeled_values(value)[:1000]

    @classmethod
    def _redact_credential_paths(cls, value: str) -> str:
        def replacement(path: str, extension: str) -> str:
            if extension != "json":
                return "[REDACTED PATH]"

            normalized_path = re.sub(r"(?i)^file://", "", path)
            segments = [
                cls._normalized_key(segment)
                for segment in re.split(r"[\\/]", normalized_path)
                if segment
            ]
            filename = segments[-1] if segments else ""
            if (
                any(
                    segment in cls._CREDENTIAL_PATH_SEGMENTS
                    for segment in segments[:-1]
                )
                or any(
                    marker in filename
                    for marker in cls._CREDENTIAL_JSON_MARKERS
                )
            ):
                return "[REDACTED PATH]"
            return path

        def replace(match: re.Match) -> str:
            return replacement(
                match.group("path"),
                match.group("extension").lower(),
            )

        def replace_quoted(match: re.Match) -> str:
            quote = match.group("quote")
            redacted = replacement(
                match.group("path"),
                match.group("extension").lower(),
            )
            return f"{quote}{redacted}{quote}"

        value = cls._QUOTED_CREDENTIAL_PATH_RE.sub(
            replace_quoted,
            value,
        )
        value = cls._FILE_CREDENTIAL_URI_RE.sub(replace, value)
        return cls._CREDENTIAL_PATH_RE.sub(replace, value)

    @classmethod
    def _redact_labeled_values(cls, value: str) -> str:
        output = []
        cursor = 0
        search_from = 0
        while True:
            match = cls._LABELED_VALUE_RE.search(value, search_from)
            if match is None:
                output.append(value[cursor:])
                return "".join(output)
            label = (
                match.group("quoted_label")
                or match.group("bare_label")
                or ""
            )
            if not cls._is_sensitive_key(label):
                search_from = match.end()
                continue
            start = match.end()
            end, replacement = cls._sensitive_value_span(
                value,
                start,
                cls._normalized_key(label),
            )
            output.append(value[cursor:start])
            output.append(replacement)
            cursor = end
            search_from = end

    @classmethod
    def _sensitive_value_span(
        cls,
        value: str,
        start: int,
        normalized_label: str,
    ) -> tuple[int, str]:
        if start >= len(value):
            return start, "[REDACTED]"
        for quote in ('\\"', "\\'", '"', "'"):
            if not value.startswith(quote, start):
                continue
            closing = cls._find_closing_quote(
                value,
                start + len(quote),
                quote,
            )
            if closing is not None:
                return (
                    closing + len(quote),
                    f"{quote}[REDACTED]{quote}",
                )
            end = cls._find_safe_value_end(
                value,
                start + len(quote),
                normalized_label,
            )
            return end, f"{quote}[REDACTED]"

        if value[start] in "[{":
            balanced_end = cls._find_balanced_end(value, start)
            if balanced_end is not None:
                return balanced_end, "[REDACTED]"
            return (
                cls._find_container_fallback_end(value, start),
                "[REDACTED]",
            )

        return (
            cls._find_safe_value_end(
                value,
                start,
                normalized_label,
            ),
            "[REDACTED]",
        )

    @staticmethod
    def _find_closing_quote(
        value: str,
        start: int,
        quote: str,
    ) -> int | None:
        cursor = start
        while cursor < len(value):
            found = value.find(quote, cursor)
            if found < 0:
                return None
            if quote.startswith("\\"):
                return found
            backslashes = 0
            index = found - 1
            while index >= 0 and value[index] == "\\":
                backslashes += 1
                index -= 1
            if backslashes % 2 == 0:
                return found
            cursor = found + 1
        return None

    @staticmethod
    def _find_balanced_end(value: str, start: int) -> int | None:
        pairs = {"[": "]", "{": "}"}
        stack = []
        quote = None
        cursor = start
        while cursor < len(value):
            char = value[cursor]
            if quote is not None:
                if char == "\\":
                    cursor += 2
                    continue
                if char == quote:
                    quote = None
                cursor += 1
                continue
            if char in "\"'":
                quote = char
            elif char in pairs:
                stack.append(pairs[char])
            elif stack and char == stack[-1]:
                stack.pop()
                if not stack:
                    return cursor + 1
            cursor += 1
        return None

    @classmethod
    def _find_container_fallback_end(
        cls,
        value: str,
        start: int,
    ) -> int:
        cursor = start
        while cursor < len(value):
            if value[cursor].isspace():
                next_field = cursor
                while (
                    next_field < len(value)
                    and value[next_field].isspace()
                ):
                    next_field += 1
                if cls._FIELD_START_RE.match(value, next_field):
                    return cursor
            cursor += 1
        return len(value)

    @classmethod
    def _find_safe_value_end(
        cls,
        value: str,
        start: int,
        normalized_label: str,
    ) -> int:
        base64_value = (
            "base64" in normalized_label
            or normalized_label.startswith("b64")
            or normalized_label.endswith("b64")
            or normalized_label.startswith("image")
        )
        cursor = start
        while cursor < len(value):
            char = value[cursor]
            if char in ",;}]" or (
                char in "\r\n" and not base64_value
            ):
                return cursor
            if char.isspace():
                next_field = cursor
                while (
                    next_field < len(value)
                    and value[next_field].isspace()
                ):
                    next_field += 1
                if base64_value:
                    continuation = re.match(
                        r"[A-Za-z0-9+/_-]+={0,2}(?=$|[\s,;}\]])",
                        value[next_field:],
                    )
                    if continuation is not None:
                        cursor = next_field + continuation.end()
                        continue
                if cls._FIELD_START_RE.match(value, next_field):
                    return cursor
            cursor += 1
        return len(value)

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
        image_generation_mode: str | None = None,
        image_endpoint: str | None = None,
    ) -> dict:
        with self._lock:
            entry_id = self._next_id
            self._next_id += 1
            entry = {
                "session_id": self.session_id,
                "id": entry_id,
                "timestamp": datetime.datetime.now(
                    datetime.timezone.utc
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
            if image_generation_mode is not None:
                entry["image_generation_mode"] = self._redact_optional(
                    image_generation_mode
                )
            if image_endpoint is not None:
                entry["image_endpoint"] = self._redact_optional(image_endpoint)
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
