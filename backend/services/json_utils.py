"""Robust JSON extraction and parsing utilities for AI model responses."""

import ast
import json
import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)


def strip_json_fences(text: str) -> str:
    """Remove markdown code block fences (```json ... ``` or ``` ... ```)."""
    if not text:
        return ""
    stripped = text.strip()
    fenced_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", stripped, re.IGNORECASE)
    if fenced_match:
        return fenced_match.group(1).strip()
    return stripped


def extract_first_json_payload(text: str) -> str:
    """
    Extract the first well-formed JSON object `{...}` or array `[...]` from text,
    properly respecting nested braces, brackets, and quotes.
    Handles models outputting conversational prefixes or suffixes.
    """
    cleaned = strip_json_fences(text)
    if not cleaned:
        return ""

    start = -1
    opening = ""
    closing = ""
    for idx, char in enumerate(cleaned):
        if char in "{[":
            start = idx
            opening = char
            closing = "}" if char == "{" else "]"
            break

    if start == -1:
        # If stripped didn't find braces, search original text in case fences were malformed
        for idx, char in enumerate(text):
            if char in "{[":
                start = idx
                opening = char
                closing = "}" if char == "{" else "]"
                cleaned = text
                break

    if start == -1:
        return cleaned

    depth = 0
    in_string = False
    escaped = False
    for idx in range(start, len(cleaned)):
        char = cleaned[idx]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return cleaned[start : idx + 1]

    return cleaned[start:]


def escape_control_chars_in_json_strings(text: str) -> str:
    """Escape raw unescaped newlines, tabs, and carriage returns inside JSON strings."""
    result = []
    in_string = False
    escaped = False
    for char in text:
        if in_string:
            if escaped:
                result.append(char)
                escaped = False
                continue
            if char == "\\":
                result.append(char)
                escaped = True
                continue
            if char == '"':
                result.append(char)
                in_string = False
                continue
            if char == "\n":
                result.append("\\n")
                continue
            if char == "\r":
                result.append("\\r")
                continue
            if char == "\t":
                result.append("\\t")
                continue
            result.append(char)
            continue

        result.append(char)
        if char == '"':
            in_string = True

    return "".join(result)


def remove_trailing_json_commas(text: str) -> str:
    """Remove trailing commas before closing braces or brackets (e.g. `[1, 2, ]` -> `[1, 2]`)."""
    return re.sub(r",\s*([}\]])", r"\1", text)


def sanitize_invalid_escapes(text: str) -> str:
    r"""
    Sanitize invalid escape sequences in JSON strings.
    RFC 8259 allows: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX.
    Any other backslash sequence (e.g. \+, \*, \%, \ , \', \-) is escaped with a second backslash
    so standard json.loads parses it as a literal backslash + character.
    """
    result = []
    i = 0
    n = len(text)
    in_string = False
    while i < n:
        char = text[i]
        if not in_string:
            result.append(char)
            if char == '"':
                in_string = True
            i += 1
            continue

        if char == '"':
            result.append(char)
            in_string = False
            i += 1
            continue

        if char == "\\":
            slash_count = 0
            while i < n and text[i] == "\\":
                slash_count += 1
                i += 1
            if slash_count % 2 == 0:
                result.append("\\" * slash_count)
            else:
                next_char = text[i] if i < n else ""
                is_valid = False
                if next_char in ('"', "\\", "/", "b", "f", "n", "r", "t"):
                    is_valid = True
                elif next_char == "u" and i + 4 < n:
                    if all(c in "0123456789abcdefABCDEF" for c in text[i + 1 : i + 5]):
                        is_valid = True

                if is_valid:
                    result.append("\\" * slash_count)
                else:
                    result.append("\\" * (slash_count + 1))
            continue

        result.append(char)
        i += 1
    return "".join(result)


def repair_unescaped_quotes(text: str, max_attempts: int = 30) -> Optional[str]:
    """
    Repair unescaped double quotes inside JSON string values.
    Uses JSONDecodeError error position to iteratively find and escape offending quotes.
    """
    curr = text
    for _ in range(max_attempts):
        try:
            json.loads(curr)
            return curr
        except json.JSONDecodeError as exc:
            if any(k in exc.msg.lower() for k in ("delimiter", "char", "value", "string")):
                pos = exc.pos
                q_pos = curr.rfind('"', 0, pos)
                if q_pos != -1 and (q_pos == 0 or curr[q_pos - 1] != "\\"):
                    curr = curr[:q_pos] + '\\"' + curr[q_pos + 1 :]
                    continue
            break
        except Exception:
            break
    return None


def close_truncated_json(text: str) -> str:
    """
    Auto-close truncated JSON responses where generation stopped mid-output.
    Balances unclosed strings, objects, and arrays.
    """
    s = text.strip()
    if not s:
        return s

    start = -1
    for i, c in enumerate(s):
        if c in "{[":
            start = i
            break
    if start != -1:
        s = s[start:]

    in_string = False
    escaped = False
    stack = []
    for c in s:
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
            continue
        if c == '"':
            in_string = True
        elif c in "{[":
            stack.append("}" if c == "{" else "]")
        elif c in "}]":
            if stack and stack[-1] == c:
                stack.pop()

    if in_string:
        s += '"'

    # Trailing dangling colon: "key": -> "key": null
    s = re.sub(r':\s*"?[^",:{}[\]]*$', ": null", s)
    # Trailing incomplete key or property: ,"incomplete_key -> remove
    s = re.sub(r',\s*"[^\":,]*$', "", s)
    # Trailing comma before closing
    s = re.sub(r",\s*$", "", s)

    # Re-calculate open brackets on cleaned text
    in_string = False
    escaped = False
    stack = []
    for c in s:
        if in_string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
            continue
        if c == '"':
            in_string = True
        elif c in "{[":
            stack.append("}" if c == "{" else "]")
        elif c in "}]":
            if stack and stack[-1] == c:
                stack.pop()

    if in_string:
        s += '"'
    s = re.sub(r",\s*$", "", s)
    s += "".join(reversed(stack))
    return s


def parse_lenient_json(text: str) -> Any:
    """
    Multi-stage resilient JSON parser.
    Recovers from trailing commas, unescaped control chars, invalid backslash escapes,
    unescaped interior double quotes, truncated outputs, and Python literal formatting.
    """
    # Stage 1: Fast direct parse
    try:
        return json.loads(text)
    except Exception:
        pass

    # Stage 2: Remove trailing commas
    no_commas = remove_trailing_json_commas(text)
    try:
        return json.loads(no_commas)
    except Exception:
        pass

    # Stage 3: Repair unescaped interior quotes before control-char escaping
    q_repaired = repair_unescaped_quotes(no_commas)
    if q_repaired is not None:
        try:
            return json.loads(q_repaired)
        except Exception:
            pass

    # Stage 4: Sanitize invalid backslash escapes (e.g. \+, \*, \%, \ , \')
    base_text = q_repaired or no_commas
    escapes_fixed = sanitize_invalid_escapes(base_text)
    try:
        return json.loads(escapes_fixed)
    except Exception:
        pass
    q_after_escapes = repair_unescaped_quotes(escapes_fixed)
    if q_after_escapes is not None:
        try:
            return json.loads(q_after_escapes)
        except Exception:
            pass

    # Stage 5: Escape raw control characters
    cleaned = escape_control_chars_in_json_strings(q_after_escapes or escapes_fixed)
    cleaned = remove_trailing_json_commas(cleaned)
    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # Stage 6: Truncated JSON recovery (for substantial text >= 120 chars)
    if len(cleaned) >= 120:
        truncated_closed = close_truncated_json(cleaned)
        truncated_cleaned = remove_trailing_json_commas(truncated_closed)
        try:
            return json.loads(truncated_cleaned)
        except Exception:
            pass
        q_trunc = repair_unescaped_quotes(truncated_cleaned)
        if q_trunc is not None:
            try:
                return json.loads(q_trunc)
            except Exception:
                pass

    # Stage 7: Python literal / single quote fallback
    try:
        py_str = re.sub(r"\btrue\b", "True", text)
        py_str = re.sub(r"\bfalse\b", "False", py_str)
        py_str = re.sub(r"\bnull\b", "None", py_str)
        return ast.literal_eval(py_str)
    except Exception:
        pass

    # Final attempt: re-raise standard error
    return json.loads(cleaned)


def safe_extract_and_parse_json(text: str, default: Optional[Any] = None) -> Any:
    """
    End-to-end safe JSON extractor and parser.
    Extracts JSON payload from arbitrary AI text and parses it with error recovery.
    """
    if not text or not text.strip():
        if default is not None:
            return default
        raise ValueError("输入内容为空，无法提取 JSON")

    payload = extract_first_json_payload(text)
    try:
        return parse_lenient_json(payload)
    except Exception as exc:
        logger.warning(
            "解析 JSON 失败: %s, payload_len=%s",
            exc,
            len(payload or ""),
        )
        if default is not None:
            return default
        raise


def extract_json_string(text: str) -> str:
    """
    Extract the clean JSON substring from an AI response.
    Drop-in replacement for legacy `_extract_json(text)` helpers.
    """
    return extract_first_json_payload(text)
