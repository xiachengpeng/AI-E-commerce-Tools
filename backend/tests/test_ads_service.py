from services.ads_service import _ads_model_id, normalize_ad_copy_result


def test_ads_model_defaults_to_pro_preview_for_image_recognition(monkeypatch):
    monkeypatch.delenv("FRONTEND_VISION_MODEL", raising=False)
    monkeypatch.delenv("FRONTEND_IMAGE_MODEL", raising=False)
    monkeypatch.delenv("FRONTEND_TEXT_MODEL", raising=False)

    assert _ads_model_id() == "gemini-3.1-pro-preview"


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
