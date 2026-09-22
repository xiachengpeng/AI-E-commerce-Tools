import asyncio
import time
from unittest.mock import AsyncMock, MagicMock
import httpx
import pytest

from backend.services.retry_service import (
    AmbiguousOutcomeError,
    ErrorCategory,
    ExecutionState,
    OperationSafety,
    PolicyResolver,
    RetryBudgetExceededError,
    RetryDecision,
    RetryExhaustedError,
    RetryPolicy,
    classify_error,
    decide_retry,
    execute_with_retry,
)


def test_classify_network_timeouts_reached_flag():
    # ReadTimeout means request was already transmitted to server
    read_err = httpx.ReadTimeout("Read timed out")
    cat, reached = classify_error(read_err)
    assert cat == ErrorCategory.NETWORK_TIMEOUT
    assert reached is True

    # WriteTimeout means partial or full transmission underway
    write_err = httpx.WriteTimeout("Write timed out")
    cat, reached = classify_error(write_err)
    assert cat == ErrorCategory.NETWORK_TIMEOUT
    assert reached is True

    # ConnectTimeout means TCP/TLS handshake failed, request never reached upstream
    conn_timeout = httpx.ConnectTimeout("Connection timed out")
    cat, reached = classify_error(conn_timeout)
    assert cat == ErrorCategory.NETWORK_TIMEOUT
    assert reached is False

    # ConnectError means connection refused/DNS failure
    conn_err = httpx.ConnectError("Connection refused")
    cat, reached = classify_error(conn_err)
    assert cat == ErrorCategory.CONNECTION_RESET
    assert reached is False


def test_non_idempotent_read_timeout_yields_ambiguous_outcome():
    read_err = httpx.ReadTimeout("Read timed out after 30s")
    policy = PolicyResolver.get_policy("ai_image_generation")
    assert policy.operation_safety == OperationSafety.NON_IDEMPOTENT

    decision = decide_retry(read_err, policy=policy, attempt=1, elapsed_time=10.0)
    assert decision.retryable is False
    assert decision.category == ErrorCategory.AMBIGUOUS_OUTCOME
    assert decision.request_may_have_reached_upstream is True
    assert "ambiguous" in decision.reason.lower()


def test_idempotent_read_timeout_allows_retry():
    read_err = httpx.ReadTimeout("Read timed out after 10s")
    policy = PolicyResolver.get_policy("ai_text_generation")
    assert policy.operation_safety in (OperationSafety.IDEMPOTENT, OperationSafety.SAFE)

    decision = decide_retry(read_err, policy=policy, attempt=1, elapsed_time=10.0)
    assert decision.retryable is True
    assert decision.category == ErrorCategory.NETWORK_TIMEOUT
    assert decision.request_may_have_reached_upstream is True
    assert decision.delay_seconds > 0


def test_budget_exceeded_stops_retry_without_sleeping():
    # 503 error would normally be retryable
    request = httpx.Request("POST", "https://api.example.com/generate")
    response = httpx.Response(503, request=request)
    err = httpx.HTTPStatusError("Service Unavailable", request=request, response=response)

    policy = RetryPolicy(
        policy_name="test_budget",
        operation_safety=OperationSafety.IDEMPOTENT,
        max_attempts=5,
        max_elapsed_time=20.0,
        backoff_gradient=(5.0, 10.0, 15.0),
        backoff_cap=30.0,
        retry_after_cap=60.0,
        jitter="none",
    )

    # If elapsed_time is 18s and next backoff delay is 5s, 18 + 5 = 23 >= 20 max_elapsed_time
    decision = decide_retry(err, policy=policy, attempt=1, elapsed_time=18.0)
    assert decision.retryable is False
    assert "budget" in decision.reason.lower()


def test_retry_after_header_handling():
    request = httpx.Request("POST", "https://api.example.com/generate")
    # Upstream gave 429 with Retry-After: 6
    response = httpx.Response(429, headers={"Retry-After": "6"}, request=request)
    err = httpx.HTTPStatusError("Rate Limit", request=request, response=response)

    policy = PolicyResolver.get_policy("ai_text_generation")
    decision = decide_retry(err, policy=policy, attempt=1, elapsed_time=5.0)
    assert decision.retryable is True
    assert decision.category == ErrorCategory.TEMPORARY_RATE_LIMIT
    assert decision.delay_seconds == 6.0

    # If Retry-After exceeds policy retry_after_cap
    response_large = httpx.Response(429, headers={"Retry-After": "300"}, request=request)
    err_large = httpx.HTTPStatusError("Rate Limit", request=request, response=response_large)
    decision_large = decide_retry(err_large, policy=policy, attempt=1, elapsed_time=5.0)
    assert "retry-after" in decision_large.reason.lower()
    assert "exceeds cap" in decision_large.reason.lower()


def test_client_cancelled_error_never_retried():
    err = asyncio.CancelledError()
    policy = PolicyResolver.get_policy("ai_image_generation")
    decision = decide_retry(err, policy=policy, attempt=1, elapsed_time=1.0)
    assert decision.retryable is False
    assert decision.category == ErrorCategory.CLIENT_CANCELLED


def test_non_retryable_client_errors():
    request = httpx.Request("POST", "https://api.example.com/generate")
    for status_code, expected_cat in [
        (400, ErrorCategory.INVALID_REQUEST),
        (401, ErrorCategory.AUTH_ERROR),
        (403, ErrorCategory.AUTH_ERROR),
        (404, ErrorCategory.INVALID_REQUEST),
    ]:
        resp = httpx.Response(status_code, request=request)
        err = httpx.HTTPStatusError(f"Error {status_code}", request=request, response=resp)
        policy = PolicyResolver.get_policy("ai_text_generation")
        decision = decide_retry(err, policy=policy, attempt=1, elapsed_time=1.0)
        assert decision.retryable is False
        assert decision.category == expected_cat


@pytest.mark.asyncio
async def test_execute_with_retry_success_after_transient_failure():
    attempts = 0
    on_retry_called = []

    async def transient_op():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            # Simulate transient 503
            req = httpx.Request("POST", "https://api.example.com/test")
            resp = httpx.Response(503, request=req)
            raise httpx.HTTPStatusError("503 Unavailable", request=req, response=resp)
        return {"status": "ok", "attempts": attempts}

    async def on_retry(state, decision):
        on_retry_called.append((state.attempt, decision.delay_seconds))

    policy = RetryPolicy(
        policy_name="test_transient",
        operation_safety=OperationSafety.IDEMPOTENT,
        max_attempts=4,
        max_elapsed_time=10.0,
        backoff_gradient=(0.01, 0.02, 0.04),
        backoff_cap=1.0,
        retry_after_cap=5.0,
        jitter="none",
    )

    result = await execute_with_retry(
        transient_op,
        policy=policy,
        operation_id="op_123",
        execution_id="exec_abc",
        on_retry=on_retry,
    )
    assert result["status"] == "ok"
    assert attempts == 3
    assert len(on_retry_called) == 2


@pytest.mark.asyncio
async def test_execute_with_retry_raises_ambiguous_outcome_for_non_idempotent():
    attempts = 0

    async def non_idempotent_op():
        nonlocal attempts
        attempts += 1
        raise httpx.ReadTimeout("Server took too long processing image")

    policy = RetryPolicy(
        policy_name="test_non_idempotent",
        operation_safety=OperationSafety.NON_IDEMPOTENT,
        max_attempts=3,
        max_elapsed_time=30.0,
        backoff_gradient=(0.01, 0.02),
        backoff_cap=1.0,
        retry_after_cap=5.0,
        jitter="none",
    )

    with pytest.raises(AmbiguousOutcomeError) as exc_info:
        await execute_with_retry(
            non_idempotent_op,
            policy=policy,
            operation_id="op_img",
            execution_id="exec_img",
        )

    # Must fail on attempt 1 without retry
    assert attempts == 1
    assert "ambiguous" in str(exc_info.value).lower()
