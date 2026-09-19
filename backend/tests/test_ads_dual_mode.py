import pytest
from pydantic import ValidationError
from unittest.mock import patch, AsyncMock
from models.request import AdCopyGenerateRequest
from services.ads_service import _ads_prompt, generate_ad_copy

def test_ad_copy_request_supports_text_only():
    req = AdCopyGenerateRequest(
        image_data=None,
        platforms=["google", "facebook"],
        region="United States",
        product_name="Ergonomic Lumbar Support Cushion",
        selling_points="Memory foam, breathable mesh cover",
        keywords="lumbar cushion, back support",
    )
    assert req.image_data is None
    assert req.product_name == "Ergonomic Lumbar Support Cushion"
    assert req.selling_points == "Memory foam, breathable mesh cover"
    assert req.keywords == "lumbar cushion, back support"

def test_ad_copy_request_rejects_both_image_and_name_empty():
    with pytest.raises(ValidationError):
        AdCopyGenerateRequest(
            image_data=None,
            platforms=["google"],
            region="United States",
            product_name=""
        )

def test_ads_prompt_contains_google_rsa_character_limits():
    req = AdCopyGenerateRequest(
        image_data=None,
        platforms=["google", "facebook"],
        region="United States",
        product_name="Ergonomic Pillow"
    )
    prompt = _ads_prompt(req)
    assert "strictly <= 30 characters" in prompt or "<= 30 characters" in prompt
    assert "strictly <= 90 characters" in prompt or "<= 90 characters" in prompt
    assert "125 CHARACTERS" in prompt

@pytest.mark.asyncio
async def test_generate_ad_copy_text_only_dispatch():
    req = AdCopyGenerateRequest(
        image_data=None,
        platforms=["google"],
        region="United States",
        product_name="Ergonomic Lumbar Support Cushion"
    )
    mock_ai_resp = {
        "candidates": [{
            "content": {
                "parts": [{
                    "text": """{
                        "product": {"name": {"target": "Ergonomic Cushion", "zh": "人体工学靠垫"}},
                        "google": {
                            "headlines": [{"target": "Relieve Back Pain", "zh": "缓解背痛"}],
                            "descriptions": [{"target": "Premium memory foam lumbar cushion for office chairs.", "zh": "适合办公椅的优质记忆棉腰靠。"}],
                            "keywords": [{"target": "lumbar support", "zh": "腰部支撑"}],
                            "sitelinks": [{"headline": {"target": "Buy Now", "zh": "立即购买"}}]
                        }
                    }"""
                }]
            }
        }]
    }
    with patch("services.ads_service.AIService.generate_content", new_callable=AsyncMock) as mock_gen:
        mock_gen.return_value = mock_ai_resp
        result = await generate_ad_copy(req)
        assert mock_gen.called
        call_kwargs = mock_gen.call_args.kwargs
        payload = call_kwargs["payload"]
        parts = payload["contents"][0]["parts"]
        # In text-only mode, there should be no inlineData in parts
        assert len(parts) == 1
        assert "inlineData" not in parts[0]
        assert "Ergonomic Lumbar Support Cushion" in parts[0]["text"]
        assert len(result["styles"]) == 9
        assert "google" in result["styles"][0]
