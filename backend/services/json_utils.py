"""Robust JSON extraction and parsing utilities for AI model responses."""

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


def parse_lenient_json(text: str) -> Any:
    """Parse JSON with automatic recovery for trailing commas and unescaped control chars."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        repaired = remove_trailing_json_commas(escape_control_chars_in_json_strings(text))
        return json.loads(repaired)


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
        logger.warning("解析 JSON 失败: %s, payload 摘要: %.200s", exc, payload)
        if default is not None:
            return default
        raise


def extract_json_string(text: str) -> str:
    """
    Extract the clean JSON substring from an AI response.
    Drop-in replacement for legacy `_extract_json(text)` helpers.
    """
    return extract_first_json_payload(text)
