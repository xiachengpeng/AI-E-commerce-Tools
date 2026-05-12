import pytest

from services.listing_service import (
    extract_first_json_payload,
    first_text_from_response,
    normalize_compliance_result,
    normalize_listing_result,
    parse_ai_json_object,
)


def test_parse_ai_json_object_accepts_fenced_json():
    result = parse_ai_json_object('```json\n{"name": "Lamp"}\n```')

    assert result == {"name": "Lamp"}


def test_parse_ai_json_object_accepts_single_item_array():
    result = parse_ai_json_object('[{"name": "Lamp"}]')

    assert result == {"name": "Lamp"}


def test_parse_ai_json_object_extracts_json_from_explanatory_text():
    result = parse_ai_json_object('好的，以下是结果：\n```json\n{"name": "Lamp", "points": "A"}\n```\n希望有帮助。')

    assert result == {"name": "Lamp", "points": "A"}


def test_extract_first_json_payload_ignores_braces_inside_strings():
    payload = extract_first_json_payload('prefix {"name": "Lamp {warm}", "points": "A"} suffix')

    assert payload == '{"name": "Lamp {warm}", "points": "A"}'


def test_parse_ai_json_object_accepts_raw_newlines_inside_strings():
    result = parse_ai_json_object('{"name": "Lamp", "points": "卖点1\n卖点2\n卖点3"}')

    assert result["points"] == "卖点1\n卖点2\n卖点3"


def test_parse_ai_json_object_accepts_trailing_commas():
    result = parse_ai_json_object('{"name": "Lamp", "points": "A",}')

    assert result == {"name": "Lamp", "points": "A"}


def test_parse_ai_json_object_empty_text_has_clear_error():
    with pytest.raises(ValueError, match="AI 返回内容为空"):
        parse_ai_json_object("")


def test_first_text_from_response_handles_empty_candidates():
    assert first_text_from_response({"candidates": []}) == ""


def test_normalize_listing_result_fills_missing_sections():
    result = normalize_listing_result({
        "title": "Lamp title",
        "keywords": {"long_tail": ["rattan pendant lamp"]},
    })

    assert result["title"]["target"] == "Lamp title"
    assert result["description"] == {"target": "", "zh": ""}
    assert result["keywords"]["longTail"][0]["target"] == "rattan pendant lamp"
    assert result["qa"] == []


def test_normalize_listing_result_supports_keyword_translation_aliases_and_filters_empty_qa():
    result = normalize_listing_result({
        "keywords": {
            "core": [{"keyword": "bamboo storage baskets", "translation": "竹制收纳篮"}],
            "ads": [{"term": "handmade home decor", "cn": "手工家居装饰"}],
        },
        "qa": [
            {"q": {}, "a": {}},
            {"question": {"target": "Is it washable?", "zh": "它可以清洗吗？"}, "answer": {"target": "Wipe clean only.", "zh": "仅可擦拭清洁。"}},
        ],
    })

    assert result["keywords"]["core"] == [{"target": "bamboo storage baskets", "zh": "竹制收纳篮"}]
    assert result["keywords"]["ads"] == [{"target": "handmade home decor", "zh": "手工家居装饰"}]
    assert len(result["qa"]) == 1
    assert result["qa"][0]["q"]["target"] == "Is it washable?"


def test_normalize_compliance_result_filters_bad_risks():
    result = normalize_compliance_result({
        "overall_level": "medium",
        "summary": "有夸大风险",
        "risks": [{"level": "medium", "type": "虚假宣传", "evidence": "best", "reason": "无法证明"}, "bad"],
        "rewrite_suggestions": [{"field": "title", "current_text": "best", "suggested_text": "reliable", "reason": "更稳妥"}],
    })

    assert result["overall_level"] == "medium"
    assert len(result["risks"]) == 1
    assert result["rewrite_suggestions"][0]["suggested_text"] == "reliable"


def test_normalize_compliance_result_wraps_text_suggestions():
    result = normalize_compliance_result({"rewrite_suggestions": ["删除 best"]})

    assert result["rewrite_suggestions"][0]["reason"] == "删除 best"
    assert result["rewrite_suggestions"][0]["suggested_text"] == ""
