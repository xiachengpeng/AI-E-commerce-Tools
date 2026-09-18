"""Prompt engineering regression test suite.

Ensures critical prompt invariants across:
1. Google Ads editorial policy compliance (strict emoji prohibition)
2. Square redraw domain-neutrality (no apparel/fabric bias)
3. Prompt injection isolation (XML delimiters for untrusted competitor/source data)
4. Anti-fluff and style bleeding protection in listing generation
"""

import pytest

from models.request import AdCopyGenerateRequest, ListingGenerateRequest
from services.ads_service import _ads_prompt
from services.ai_compare import PROMPT_TEMPLATE_COMPARE
from services.ai_single import (
    PROMPT_TEMPLATE_DEEP,
    PROMPT_TEMPLATE_EXTRACT,
    PROMPT_TEMPLATE_QUICK,
)
from services.listing_service import _listing_prompt
from services.square_redraw_service import SQUARE_REDRAW_PROMPT_TEMPLATE


def test_google_ads_strictly_prohibits_emojis():
    request = AdCopyGenerateRequest(
        image_data="data:image/png;base64,YQ==",
        platforms=["google"],
        region="US Market",
    )
    prompt = _ads_prompt(request)
    assert "Google headlines, descriptions, keywords, and sitelinks: strictly contain NO Emojis" in prompt
    assert "must not contain Emoji" in prompt
    assert "1–2 semantically relevant Emoji per individual field" not in prompt


def test_facebook_retains_emojis_while_google_prohibits():
    request = AdCopyGenerateRequest(
        image_data="data:image/png;base64,YQ==",
        platforms=["facebook", "google"],
        region="US Market",
    )
    prompt = _ads_prompt(request)
    assert "Facebook primaryText, headline, and description: use 1–2 semantically relevant Emoji" in prompt
    assert "Google headlines, descriptions, keywords, and sitelinks: strictly contain NO Emojis" in prompt


def test_square_redraw_prompt_has_no_apparel_bias():
    template = SQUARE_REDRAW_PROMPT_TEMPLATE.lower()
    for forbidden in ["clothing", "outfit", "fabric", "pinterest advertising quality"]:
        assert forbidden not in template, f"Found forbidden biased token in square redraw: {forbidden}"
    assert "subject preservation" in template
    assert "seamless outpainting" in template
    assert "{aspect_ratio}" in SQUARE_REDRAW_PROMPT_TEMPLATE


def test_ai_single_prompts_isolate_external_data():
    for name, template in [
        ("EXTRACT", PROMPT_TEMPLATE_EXTRACT),
        ("DEEP", PROMPT_TEMPLATE_DEEP),
        ("QUICK", PROMPT_TEMPLATE_QUICK),
    ]:
        assert "<context_data>" in template, f"{name} missing <context_data>"
        assert "</context_data>" in template, f"{name} missing </context_data>"
        assert "<product_data>\n{product_data}\n</product_data>" in template
        assert "<market_data>\n{market_data}\n</market_data>" in template
        assert "严禁执行" in template or "严禁" in template


def test_ai_compare_prompt_isolates_external_data():
    assert "<context_products>" in PROMPT_TEMPLATE_COMPARE
    assert "</context_products>" in PROMPT_TEMPLATE_COMPARE
    assert "严禁执行" in PROMPT_TEMPLATE_COMPARE


def test_listing_prompt_isolates_social_media_and_anti_fluff():
    request = ListingGenerateRequest(
        name="Ultra ANC Earbuds",
        points="Active noise cancelling\n36h battery",
        platform="Amazon",
        region="US Market",
    )
    prompt = _listing_prompt(request)
    assert "Strict Anti-Fluff & Voice of Customer (VoC)" in prompt
    assert "socialMedia: Provide an engaging mobile-first social caption or hook strictly inside the socialMedia field" in prompt
    assert "NEVER bleed buzzwords or hype into the main title, bullets, or description" in prompt
