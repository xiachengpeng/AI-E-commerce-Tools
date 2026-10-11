from __future__ import annotations

import importlib
import importlib.util

from tests.test_workbench_domain import (
    NOW,
    complete_research,
    identified_product,
    project,
)


def _module():
    spec = importlib.util.find_spec("rabbit_hole.domain.requirements")
    assert spec is not None, "workbench evidence requirement contract is missing"
    return importlib.import_module("rabbit_hole.domain.requirements")


def _complete_without(channel: str):
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    product["evidence"] = [
        item for item in product["evidence"] if item["channel"] != channel
    ]
    return state, product


def test_missing_recommended_channel_is_unknown_but_does_not_block_score():
    state, product = _complete_without("amazon")

    statuses = _module().requirement_statuses(state, product, NOW)
    amazon = next(item for item in statuses if item["key"] == "amazon")

    assert amazon["level"] == "recommended"
    assert amazon["status"] == "unknown"
    assert amazon["blocks_scoring"] is False


def test_missing_required_trend_is_unknown_and_blocks_score():
    state, product = _complete_without("trends")

    statuses = _module().requirement_statuses(state, product, NOW)
    trend = next(item for item in statuses if item["key"] == "trends_12m")

    assert trend["level"] == "required"
    assert trend["status"] == "unknown"
    assert trend["blocks_scoring"] is True


def test_explicit_project_rule_can_elevate_recommended_channel():
    state, product = _complete_without("amazon")
    state["evidence_requirement_levels"] = {"amazon": "required"}

    amazon = next(
        item
        for item in _module().requirement_statuses(state, product, NOW)
        if item["key"] == "amazon"
    )

    assert amazon["level"] == "required"
    assert amazon["status"] == "unknown"
    assert amazon["blocks_scoring"] is True


def test_incomplete_similarweb_is_unknown_without_becoming_zero_or_blocking():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    latest = next(
        item for item in reversed(product["evidence"]) if item["channel"] == "similarweb"
    )
    latest["direct_share"] = None

    similarweb = next(
        item
        for item in _module().requirement_statuses(state, product, NOW)
        if item["key"] == "similarweb"
    )

    assert similarweb["status"] == "unknown"
    assert similarweb["blocks_scoring"] is False


def test_requirement_level_patch_rejects_unknown_channels_and_levels():
    validate = _module().validate_evidence_requirement_patch
    current = {"amazon": "recommended"}

    for patch in ({"youtube": "required"}, {"amazon": "always"}):
        try:
            validate(current, patch)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid evidence requirement patch was accepted")
