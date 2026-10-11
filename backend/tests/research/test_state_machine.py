from __future__ import annotations

import pytest
from pydantic import ValidationError

from rabbit_hole.pipeline import (
    AUTO_FIELD_PREFIX,
    FeishuMutation,
    ForbiddenTransition,
    ReasonRequired,
    RevalidationRequired,
    StateMachine,
)


@pytest.fixture
def state_machine() -> StateMachine:
    return StateMachine()


@pytest.mark.parametrize(
    ("current", "target", "actor"),
    [
        ("待生成", "待研究", "automation"),
        ("待研究", "待人工选择", "automation"),
        ("待人工选择", "已启用", "human"),
        ("待人工选择", "暂停", "human"),
        ("待审核", "已启用", "human"),
        ("已启用", "待扫描", "human"),
        ("待扫描", "扫描中", "automation"),
        ("扫描中", "已启用", "automation"),
        ("扫描中", "降频", "automation"),
        ("扫描中", "建议暂停", "automation"),
        ("扫描中", "暂停", "human"),
        ("建议暂停", "暂停", "human"),
        ("已启用", "暂停", "human"),
        ("待执行", "执行中", "automation"),
        ("执行中", "已完成", "automation"),
        ("执行中", "待延迟重试", "automation"),
        ("执行中", "需人工处理", "automation"),
        ("待延迟重试", "执行中", "automation"),
        ("待补充", "开始验证", "human"),
        ("开始验证", "队列中", "automation"),
        ("队列中", "采集中", "automation"),
        ("采集中", "待识别具体产品", "automation"),
        ("采集中", "待确认创意", "automation"),
        ("采集中", "待询价", "automation"),
        ("采集中", "待补充证据", "automation"),
        ("采集中", "观察池", "automation"),
        ("采集中", "待评分", "automation"),
        ("采集中", "输入已变更", "automation"),
        ("采集中", "需人工处理", "automation"),
        ("待评分", "待人工复核", "automation"),
    ],
)
def test_declared_workflow_transition_is_allowed(
    state_machine: StateMachine, current: str, target: str, actor: str
) -> None:
    """Removing any declared edge would strand one state from spec section 8."""

    assert state_machine.transition(current, target, actor=actor) == target


def test_automation_cannot_enter_final_pool(state_machine: StateMachine) -> None:
    """Allowing the rules engine to choose a final pool bypasses human review."""

    with pytest.raises(ForbiddenTransition):
        state_machine.transition("待评分", "测试池", actor="automation")


@pytest.mark.parametrize("target", ["测试池", "备选池", "观察池", "淘汰池"])
def test_human_final_decision_requires_reason(
    state_machine: StateMachine, target: str
) -> None:
    """A blank rationale would make a final business decision unauditable."""

    with pytest.raises(ReasonRequired):
        state_machine.transition("待人工复核", target, actor="human", reason="  ")


@pytest.mark.parametrize("target", ["测试池", "备选池", "观察池", "淘汰池"])
def test_human_can_make_a_reasoned_final_decision(
    state_machine: StateMachine, target: str
) -> None:
    assert (
        state_machine.transition(
            "待人工复核", target, actor="human", reason="documented decision"
        )
        == target
    )


def test_return_for_completion_is_the_only_reason_optional_review_action(
    state_machine: StateMachine,
) -> None:
    assert (
        state_machine.transition("待人工复核", "待补充", actor="human", reason="")
        == "待补充"
    )


@pytest.mark.parametrize(
    "current",
    [
        "待识别具体产品",
        "待确认创意",
        "待询价",
        "待补充证据",
        "观察池",
        "输入已变更",
        "需人工处理",
        "待人工复核",
        "测试池",
        "备选池",
        "淘汰池",
    ],
)
def test_candidate_revalidation_must_be_explicit(
    state_machine: StateMachine, current: str
) -> None:
    """An automatic rerun would erase the user's control over new evidence runs."""

    with pytest.raises(RevalidationRequired):
        state_machine.transition(current, "开始验证", actor="human")

    assert (
        state_machine.transition(
            current, "开始验证", actor="human", explicit_revalidation=True
        )
        == "开始验证"
    )


def test_automation_cannot_revalidate_or_modify_a_human_terminal_state(
    state_machine: StateMachine,
) -> None:
    with pytest.raises(ForbiddenTransition):
        state_machine.transition(
            "测试池", "开始验证", actor="automation", explicit_revalidation=True
        )


def test_unknown_edge_is_rejected(state_machine: StateMachine) -> None:
    with pytest.raises(ForbiddenTransition):
        state_machine.transition("待研究", "测试池", actor="human", reason="skip")


def test_source_mutation_cannot_bypass_the_automation_transition_guard() -> None:
    """A fenced source update must validate its observed state, not just target."""

    with pytest.raises(ValidationError, match="forbidden transition"):
        FeishuMutation(
            operation_key="job:source:final",
            table="市场评估表",
            action="update",
            record_id="rec-1",
            expected_version="7",
            current_state="待人工复核",
            state="输入已变更",
            actor="automation",
            explicit_revalidation=False,
            fields={AUTO_FIELD_PREFIX + "运行状态": "输入已变更"},
        )


def test_fenced_input_changed_mutation_uses_a_declared_automation_edge() -> None:
    mutation = FeishuMutation(
        operation_key="job:source:input-changed",
        table="市场评估表",
        action="update",
        record_id="rec-1",
        expected_version="7",
        current_state="开始验证",
        state="输入已变更",
        actor="automation",
        explicit_revalidation=False,
        fields={AUTO_FIELD_PREFIX + "运行状态": "输入已变更"},
    )

    assert mutation.state == "输入已变更"


def test_state_mutation_requires_an_observed_current_state() -> None:
    """No update or upsert can silently skip the transition guard."""

    with pytest.raises(ValidationError, match="current_state"):
        FeishuMutation(
            operation_key="job:source:missing-state",
            table="市场评估表",
            action="update",
            record_id="rec-1",
            expected_version="7",
            state="输入已变更",
            actor="automation",
            explicit_revalidation=False,
            fields={AUTO_FIELD_PREFIX + "运行状态": "输入已变更"},
        )

    with pytest.raises(ValidationError, match="use action='create'"):
        FeishuMutation(
            operation_key="job:source:unsafe-upsert",
            table="市场评估表",
            action="upsert",
            unique_key="product|US",
            current_state=StateMachine.INITIAL_STATE,
            state="待询价",
            actor="automation",
            explicit_revalidation=False,
        )


def test_upsert_update_checks_actor_and_explicit_revalidation() -> None:
    """An upsert of an existing row is an ordinary fenced state transition."""

    with pytest.raises(ValidationError, match="explicit revalidation"):
        FeishuMutation(
            operation_key="job:source:upsert",
            table="市场评估表",
            action="upsert",
            unique_key="product|US",
            current_state="待补充证据",
            state="开始验证",
            actor="human",
            explicit_revalidation=False,
        )

    mutation = FeishuMutation(
        operation_key="job:source:upsert",
        table="市场评估表",
        action="upsert",
        unique_key="product|US",
        current_state="待补充证据",
        state="开始验证",
        actor="human",
        explicit_revalidation=True,
    )

    assert mutation.state == "开始验证"


def test_create_has_a_closed_initial_state_policy() -> None:
    """Create is the only path from the explicit new-record sentinel."""

    mutation = FeishuMutation(
        operation_key="job:ad:create",
        table="广告与素材",
        action="create",
        unique_key="ad-1",
        current_state=StateMachine.INITIAL_STATE,
        state="已采集",
        actor="automation",
        explicit_revalidation=False,
    )
    assert mutation.state == "已采集"

    with pytest.raises(ValidationError, match="not an allowed initial state"):
        FeishuMutation(
            operation_key="job:market:create",
            table="市场评估表",
            action="create",
            unique_key="product|US",
            current_state=StateMachine.INITIAL_STATE,
            state="测试池",
            actor="automation",
            explicit_revalidation=False,
        )
