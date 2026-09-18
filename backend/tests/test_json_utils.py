"""Tests for robust AI JSON parsing and extraction in services/json_utils.py."""

import pytest
from services.json_utils import (
    escape_control_chars_in_json_strings,
    extract_first_json_payload,
    extract_json_string,
    parse_lenient_json,
    remove_trailing_json_commas,
    safe_extract_and_parse_json,
    strip_json_fences,
)


def test_strip_json_fences():
    assert strip_json_fences("```json\n{\"k\": \"v\"}\n```") == '{"k": "v"}'
    assert strip_json_fences("```JSON\n{\"k\": \"v\"}\n```") == '{"k": "v"}'
    assert strip_json_fences("```\n[1, 2, 3]\n```") == "[1, 2, 3]"
    assert strip_json_fences('{"k": "v"}') == '{"k": "v"}'
    assert strip_json_fences("") == ""


def test_extract_first_json_payload_with_conversational_text():
    raw = (
        "Here is the detailed analysis you requested:\n\n"
        "```json\n"
        "{\n"
        '  "product_name": "Test Lamp",\n'
        '  "points": ["Eco", "Durable"]\n'
        "}\n"
        "```\n\n"
        "Hope this helps!"
    )
    extracted = extract_first_json_payload(raw)
    assert extracted.startswith("{")
    assert extracted.endswith("}")
    parsed = safe_extract_and_parse_json(raw)
    assert parsed["product_name"] == "Test Lamp"
    assert parsed["points"] == ["Eco", "Durable"]


def test_extract_first_json_payload_ignores_internal_braces():
    raw = 'Sure thing! {"title": "Lamp {Special Edition}", "price": "$19.99"}'
    extracted = extract_first_json_payload(raw)
    assert extracted == '{"title": "Lamp {Special Edition}", "price": "$19.99"}'
    parsed = safe_extract_and_parse_json(raw)
    assert parsed["title"] == "Lamp {Special Edition}"


def test_extract_first_json_payload_handles_escaped_quotes():
    raw = '{"description": "A \\"heavy-duty\\" desk", "status": "ok"}'
    parsed = safe_extract_and_parse_json(raw)
    assert parsed["description"] == 'A "heavy-duty" desk'


def test_lenient_json_trailing_commas():
    raw = '{"items": [1, 2, 3, ], "config": {"debug": true, }, }'
    parsed = safe_extract_and_parse_json(raw)
    assert parsed["items"] == [1, 2, 3]
    assert parsed["config"]["debug"] is True


def test_lenient_json_unescaped_newlines():
    raw = '{"summary": "Line 1\nLine 2\nLine 3"}'
    parsed = safe_extract_and_parse_json(raw)
    assert "Line 1" in parsed["summary"]


def test_safe_extract_and_parse_json_default_fallback():
    assert safe_extract_and_parse_json("Not valid json at all", default={}) == {}
    with pytest.raises(Exception):
        safe_extract_and_parse_json("Not valid json at all")


def test_extract_json_string():
    raw = "Analysis result:\n```json\n{\"score\": 95}\n```"
    assert extract_json_string(raw) == '{"score\": 95}'
