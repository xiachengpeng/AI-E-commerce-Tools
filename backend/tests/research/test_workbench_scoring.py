from __future__ import annotations

import importlib
import importlib.util

from tests.test_workbench_domain import (
    command,
    complete_research,
    identified_product,
    project,
)


def _module():
    spec = importlib.util.find_spec("rabbit_hole.domain.scoring")
    assert spec is not None, "workbench scoring contract is missing"
    return importlib.import_module("rabbit_hole.domain.scoring")


def _evaluated_score():
    state = project()
    product = identified_product(state)
    complete_research(state, product)
    command(state, "evaluate", {"product_id": product["id"]})
    return state, product, product["scores"][-1]


def test_each_dimension_has_versioned_rules_and_current_evidence_ids():
    _, _, score = _evaluated_score()

    assert score["score_version"] == "workbench-score-v1"
    assert score["score_version"] == _module().SCORING_VERSION
    for dimension in score["dimensions"]:
        assert dimension["rule_ids"]
        assert isinstance(dimension["evidence_ids"], list)
        assert dimension["evidence_ids"]
        assert dimension["missing_evidence"] == []
        assert dimension["calculation"]
        assert dimension["calculated_at"] == score["created_at"]


def test_final_gate_rows_are_typed_and_explainable():
    _, _, score = _evaluated_score()

    assert score["final_gates"]
    for gate in score["final_gates"]:
        assert gate["kind"] == "final_hard_gate"
        assert gate["status"] in {"pass", "fail", "unknown", "not_applicable"}
        assert gate["rule_id"]
        assert isinstance(gate["evidence_ids"], list)
        assert gate["reason"]
