"""Tests for resilient JSON parsing and error recovery in Listing generation."""

import pytest

from services.listing_service import parse_ai_json_object


def test_parse_ai_json_object_repairs_invalid_escapes():
    raw = r"""{
        "title": {
            "target": "Fast Charging 5000mAh\+ Power Bank",
            "zh": "快充 5000mAh\+ 移动电源"
        },
        "description": {
            "target": "100\% satisfaction guarantee with 24\/7 support",
            "zh": "100\% 满意度保证与全天候支持"
        }
    }"""
    result = parse_ai_json_object(raw)
    assert "5000mAh" in result["title"]["target"]
    assert "100" in result["description"]["target"]


def test_parse_ai_json_object_repairs_unescaped_internal_quotes():
    raw = """{
        "title": {
            "target": "15.6" Waterproof Laptop Sleeve Case",
            "zh": "15.6寸防水电脑保护套"
        },
        "bullets": [
            {
                "target": "Featuring "Zero-Drift" lock mechanism",
                "zh": "搭载"零变形"锁定结构"
            }
        ]
    }"""
    result = parse_ai_json_object(raw)
    assert '15.6" Waterproof Laptop Sleeve Case' in result["title"]["target"]
    assert len(result["bullets"]) == 1


def test_parse_ai_json_object_repairs_truncated_5000_char_listing():
    # Construct a realistic truncated listing around 5000 chars ending abruptly
    bullets_part = ",\n".join([
        f'{{"target": "[DURABLE {i}] High strength composite material with reinforced seams", "zh": "高强度复合材料与加固接缝"}}'
        for i in range(1, 10)
    ])
    keywords_part = ",\n".join([
        f'{{"target": "keyword phrase number {i} for optimization", "zh": "优化关键词词组{i}"}}'
        for i in range(1, 40)
    ])
    raw = f"""{{
        "title": {{
            "target": "Professional Heavy Duty Laptop Backpack with USB Charging Port",
            "zh": "专业大容量电脑双肩包带USB充电接口"
        }},
        "titleAlternatives": [
            {{"target": "Alt Title 1", "zh": "备选标题1", "style": "SEO"}},
            {{"target": "Alt Title 2", "zh": "备选标题2", "style": "Conversion"}}
        ],
        "bullets": [
            {bullets_part}
        ],
        "keywords": {{
            "core": [
                {keywords_part}
            ]
        }},
        "description": {{
            "target": "Crafted with water-resistant polyester fabric, this backpack provides reliable protection"""
    
    assert len(raw) > 3000
    result = parse_ai_json_object(raw)
    assert result["title"]["target"] == "Professional Heavy Duty Laptop Backpack with USB Charging Port"
    assert len(result["bullets"]) >= 5
    assert len(result["keywords"]["core"]) >= 10


def test_parse_ai_json_object_accepts_python_dict_syntax():
    raw = "{'title': {'target': 'Ergonomic Desk', 'zh': '人体工学桌'}, 'active': True}"
    result = parse_ai_json_object(raw)
    assert result["title"]["target"] == "Ergonomic Desk"


def test_parse_ai_json_object_unparseable_raises_clean_error(caplog):
    secret = "TOP-SECRET-KEY-12345"
    with pytest.raises(ValueError, match="AI 返回的 JSON 格式无效") as raised:
        parse_ai_json_object(f"Totally not json at all: {secret}")
    assert secret not in caplog.text
    assert secret not in str(raised.value)
