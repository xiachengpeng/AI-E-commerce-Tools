"""Unresolved dynamic copy must never become evidence or a translation request."""
import copy

import pytest

from rabbit_hole.integrations.collectors.provider_api import parse_meta_items


def row(body, cards):
    return {"ad_archive_id": "dynamic-ad", "is_active": True, "snapshot": {
        "body": {"text": body}, "cards": cards,
        "videos": [{"video_hd_url": "https://example.com/video.mp4"}],
    }}


def test_same_ad_single_card_body_used_when_main_body_is_template():
    ad = parse_meta_items([row("{{product.brand}}", [{"body": "A stable shopping cart."}])])[0]
    assert ad["primary_text"] == "A stable shopping cart."


def test_different_card_variants_are_not_merged_or_guessed():
    ad = parse_meta_items([row("{{product.brand}}", [{"body": "Variant A"}, {"body": "Variant B"}])])[0]
    assert ad["primary_text"] == "{{product.brand}}"


def test_real_main_copy_is_not_replaced():
    ad = parse_meta_items([row("Original body", [{"body": "Card body"}])])[0]
    assert ad["primary_text"] == "Original body"


@pytest.mark.parametrize("text", ["{{product.brand}}", "Buy {{product.name}} today", " ", ""])
def test_unavailable_copy_cannot_be_an_expansion_passage(text):
    from test_workbench_provenance import project_with_sources

    from rabbit_hole.domain.provenance import source_passages
    project, product, ad, _ = project_with_sources()
    ad["primary_text"] = text
    before = copy.deepcopy(project)
    assert not any(p.source_kind == "ad" for p in source_passages(project, product["id"]))
    assert project == before
