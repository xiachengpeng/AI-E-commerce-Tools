import base64
from unittest.mock import AsyncMock, patch

import pytest

from models.request import AdCopyGenerateRequest
from services.ads_service import generate_ad_copy, normalize_ad_copy_result


def test_normalize_ad_copy_result_fills_all_styles_and_selected_platforms():
    result = normalize_ad_copy_result(
        {
            "product": {"name": {"target": "Bamboo Basket", "zh": "竹篮"}},
            "styles": [
                {
                    "id": "problem_solution",
                    "facebook": {
                        "headline": {"target": "Tidy Your Kitchen", "zh": "整理厨房"}
                    },
                }
            ],
        },
        platforms=["facebook"],
    )

    assert len(result["styles"]) == 9
    first = result["styles"][0]
    assert first["id"] == "problem_solution"
    assert first["facebook"]["headline"]["target"] == "Tidy Your Kitchen"
    assert first["facebook"]["primaryText"] == {"target": "", "zh": ""}
    assert "google" not in first


def test_normalize_ad_copy_result_supports_google_lists():
    result = normalize_ad_copy_result(
        {
            "styles": [
                {
                    "id": "feature_benefit",
                    "google": {
                        "headlines": ["Absorbent Bath Mat"],
                        "descriptions": [{"target": "Dries fast", "zh": "快速干燥"}],
                        "keywords": [{"keyword": "bath mat", "zh": "浴室垫"}],
                        "sitelinks": [{"text": "Shop Now", "zh": "立即购买"}],
                    },
                }
            ],
        },
        platforms=["google"],
    )

    style = result["styles"][1]
    assert style["id"] == "feature_benefit"
    assert style["google"]["headlines"][0] == {"target": "Absorbent Bath Mat", "zh": ""}
    assert style["google"]["descriptions"][0] == {"target": "Dries fast", "zh": "快速干燥"}
    assert style["google"]["keywords"][0] == {"target": "bath mat", "zh": "浴室垫"}
    assert style["google"]["sitelinks"][0] == {"target": "Shop Now", "zh": "立即购买"}


def test_normalize_ad_copy_result_adds_stable_pinterest_block():
    result = normalize_ad_copy_result(
        {
            "styles": [{
                "id": "problem_solution",
                "pinterest": {
                    "title": {"target": "A calm home", "zh": "宁静之家"},
                    "description": {"target": "Make room to breathe.", "zh": "为呼吸留出空间。"},
                    "tags": [
                        {"target": "HomeDecor", "zh": "#家居装饰"},
                        {"target": "##CalmHome", "zh": "宁静之家"},
                        {"target": "#HomeDecor", "zh": "#家居装饰"},
                        {"target": "", "zh": ""},
                    ],
                    "altText": {"target": "Neutral chair beside a window", "zh": "窗边的中性色座椅"},
                },
            }]
        },
        ["pinterest"],
    )

    pinterest = result["styles"][0]["pinterest"]
    assert pinterest["title"] == {"target": "A calm home", "zh": "宁静之家"}
    assert pinterest["tags"] == [
        {"target": "#HomeDecor", "zh": "#家居装饰"},
        {"target": "#CalmHome", "zh": "#宁静之家"},
    ]
    assert pinterest["altText"]["target"] == "Neutral chair beside a window"


def test_normalize_ad_copy_result_accepts_string_tags_and_fills_missing_fields():
    result = normalize_ad_copy_result(
        {"styles": [{"id": "feature_benefit", "pinterest": {"tags": "#Sale, New Arrival  #Gift"}}]},
        ["pinterest"],
    )

    pinterest = result["styles"][1]["pinterest"]
    assert pinterest == {
        "title": {"target": "", "zh": ""},
        "description": {"target": "", "zh": ""},
        "tags": [
            {"target": "#Sale", "zh": ""},
            {"target": "#New", "zh": ""},
            {"target": "#Arrival", "zh": ""},
            {"target": "#Gift", "zh": ""},
        ],
        "altText": {"target": "", "zh": ""},
    }


def test_normalize_ad_copy_result_omits_unselected_pinterest():
    result = normalize_ad_copy_result({}, ["facebook"])
    assert all("pinterest" not in style for style in result["styles"])


@pytest.mark.asyncio
async def test_generate_ad_copy_routes_image_analysis_to_text_capability():
    request = AdCopyGenerateRequest(
        image_data="data:image/png;base64," + base64.b64encode(b"fake").decode(),
        platforms=["facebook"],
        region="US Market",
    )
    response = {
        "candidates": [{
            "content": {
                "parts": [{"text": '{"product":{"name":"Lamp"},"styles":[]}'}]
            }
        }]
    }
    with patch(
        "services.ads_service.AIService.generate_content",
        new=AsyncMock(return_value=response),
    ) as mocked:
        result = await generate_ad_copy(request)

    assert result["product"]["name"]["target"] == "Lamp"
    assert mocked.await_args.kwargs["capability"] == "text"


@pytest.mark.asyncio
async def test_generate_ad_copy_emits_safe_image_processing_boundaries():
    request = AdCopyGenerateRequest(
        image_data="data:image/png;base64,"
        + base64.b64encode(b"private-image").decode(),
        platforms=["facebook"],
        region="US Market",
    )
    response = {
        "candidates": [{
            "content": {
                "parts": [{"text": '{"product":{},"styles":[]}'}]
            }
        }]
    }
    with patch(
        "services.ads_service.AIService.generate_content",
        new=AsyncMock(return_value=response),
    ), patch(
        "services.ads_service.app_logs.emit",
    ) as emit:
        await generate_ad_copy(request)

    assert [call.kwargs["message"] for call in emit.call_args_list] == [
        "图片广告处理开始",
        "图片广告处理完成",
    ]
    assert all(call.kwargs["source"] == "image" for call in emit.call_args_list)
    assert "private-image" not in repr(emit.call_args_list)
