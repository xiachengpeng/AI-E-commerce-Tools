import asyncio
from dataclasses import dataclass, field
from enum import Enum
import inspect
import random
import time
from typing import Any, Callable, Dict, Optional, Set, Tuple
import httpx


class OperationSafety(str, Enum):
    SAFE = "SAFE"
    IDEMPOTENT = "IDEMPOTENT"
    NON_IDEMPOTENT = "NON_IDEMPOTENT"


class ErrorCategory(str, Enum):
    NETWORK_TIMEOUT = "NETWORK_TIMEOUT"
    CONNECTION_RESET = "CONNECTION_RESET"
    TEMPORARY_RATE_LIMIT = "TEMPORARY_RATE_LIMIT"
    QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"
    AUTH_ERROR = "AUTH_ERROR"
    INVALID_REQUEST = "INVALID_REQUEST"
    INVALID_MODEL = "INVALID_MODEL"
    PROVIDER_OVERLOADED = "PROVIDER_OVERLOADED"
    UPSTREAM_GATEWAY = "UPSTREAM_GATEWAY"
    AMBIGUOUS_OUTCOME = "AMBIGUOUS_OUTCOME"
    CLIENT_CANCELLED = "CLIENT_CANCELLED"
    UNKNOWN = "UNKNOWN"


DEFAULT_RETRYABLE_CATEGORIES: Set[ErrorCategory] = {
    ErrorCategory.NETWORK_TIMEOUT,
    ErrorCategory.CONNECTION_RESET,
    ErrorCategory.TEMPORARY_RATE_LIMIT,
    ErrorCategory.PROVIDER_OVERLOADED,
    ErrorCategory.UPSTREAM_GATEWAY,
}


class RetryServiceError(Exception):
    """Base error for retry service failures."""

    def __init__(self, message: str, last_error: Optional[Exception] = None):
        super().__init__(message)
        self.last_error = last_error


class AmbiguousOutcomeError(RetryServiceError):
    """Raised when a non-idempotent operation may have reached upstream and outcome is unknown."""
    pass


class RetryBudgetExceededError(RetryServiceError):
    """Raised when retries are halted because time budget would be exceeded."""
    pass


class RetryExhaustedError(RetryServiceError):
    """Raised when all retry attempts have been exhausted."""
    pass


@dataclass(frozen=True)
class RetryPolicy:
    policy_name: str
    operation_safety: OperationSafety
    max_attempts: int = 4
    max_elapsed_time: float = 60.0  # seconds
    backoff_gradient: Tuple[float, ...] = (1.0, 2.0, 4.0, 8.0)
    backoff_cap: float = 15.0
    retry_after_cap: float = 60.0
    jitter: str = "full"  # "full", "equal", "none"
    retryable_categories: Set[ErrorCategory] = field(default_factory=lambda: set(DEFAULT_RETRYABLE_CATEGORIES))


@dataclass(frozen=True)
class RetryDecision:
    retryable: bool
    category: ErrorCategory
    reason: str
    delay_seconds: float
    request_may_have_reached_upstream: bool


@dataclass
class ExecutionState:
    operation_id: str
    execution_id: str
    attempt: int = 1
    max_attempts: int = 1
    state: str = "running"  # "running", "retrying", "succeeded", "failed", "ambiguous"
    next_retry_at: Optional[float] = None
    error_category: Optional[ErrorCategory] = None


def classify_error(exc: Exception) -> Tuple[ErrorCategory, bool]:
    """Classify exception and return (category, request_may_have_reached_upstream)."""
    if isinstance(exc, asyncio.CancelledError):
        return ErrorCategory.CLIENT_CANCELLED, False

    # HTTPX Exceptions
    if isinstance(exc, httpx.ReadTimeout):
        return ErrorCategory.NETWORK_TIMEOUT, True
    if isinstance(exc, httpx.WriteTimeout):
        return ErrorCategory.NETWORK_TIMEOUT, True
    if isinstance(exc, httpx.ConnectTimeout):
        return ErrorCategory.NETWORK_TIMEOUT, False
    if isinstance(exc, httpx.ConnectError):
        return ErrorCategory.CONNECTION_RESET, False
    if isinstance(exc, httpx.RemoteProtocolError):
        return ErrorCategory.NETWORK_TIMEOUT, True

    # Generic Connection Errors
    if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
        return ErrorCategory.CONNECTION_RESET, True

    # HTTP Status Error
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code if exc.response is not None else 500
        text = ""
        try:
            text = (exc.response.text or "").lower() if exc.response is not None else ""
        except Exception:
            pass

        if code == 408:
            return ErrorCategory.NETWORK_TIMEOUT, True
        if code == 429:
            if "insufficient_quota" in text or "quota" in text and "exceeded" in text:
                return ErrorCategory.QUOTA_EXHAUSTED, True
            return ErrorCategory.TEMPORARY_RATE_LIMIT, True
        if code in (401, 403):
            return ErrorCategory.AUTH_ERROR, True
        if code == 404:
            return ErrorCategory.INVALID_REQUEST, True
        if code == 400:
            return ErrorCategory.INVALID_REQUEST, True
        if code in (500, 503):
            return ErrorCategory.PROVIDER_OVERLOADED, True
        if code in (502, 504):
            return ErrorCategory.UPSTREAM_GATEWAY, True
        return ErrorCategory.UNKNOWN, True

    # Google GenAI / Google API core errors (checked duck-typed to avoid strict dependency on grpc)
    exc_type = type(exc).__name__
    exc_msg = str(exc).lower()

    if "ResourceExhausted" in exc_type or "429" in exc_msg:
        if "quota" in exc_msg and "exceeded" in exc_msg:
            return ErrorCategory.QUOTA_EXHAUSTED, True
        return ErrorCategory.TEMPORARY_RATE_LIMIT, True
    if "Unavailable" in exc_type or "503" in exc_msg:
        return ErrorCategory.PROVIDER_OVERLOADED, True
    if "DeadlineExceeded" in exc_type or "504" in exc_msg:
        return ErrorCategory.NETWORK_TIMEOUT, True
    if "Unauthenticated" in exc_type or "PermissionDenied" in exc_type or "401" in exc_msg or "403" in exc_msg:
        return ErrorCategory.AUTH_ERROR, True
    if "InvalidArgument" in exc_type or "400" in exc_msg:
        return ErrorCategory.INVALID_REQUEST, True

    if isinstance(exc, TimeoutError):
        return ErrorCategory.NETWORK_TIMEOUT, True

    return ErrorCategory.UNKNOWN, False


def _parse_retry_after(header_val: Optional[str]) -> Optional[float]:
    if not header_val:
        return None
    header_val = header_val.strip()
    try:
        # Seconds format
        val = float(header_val)
        return max(0.0, val)
    except ValueError:
        # Could be HTTP Date format, not commonly used in modern AI APIs, return None for safe fallback
        return None


def _calculate_backoff(policy: RetryPolicy, attempt: int) -> float:
    idx = min(attempt - 1, len(policy.backoff_gradient) - 1)
    if idx >= 0:
        base = policy.backoff_gradient[idx]
    else:
        base = 1.0 * (2 ** (attempt - 1))

    capped = min(base, policy.backoff_cap)

    if policy.jitter == "none":
        return capped
    elif policy.jitter == "equal":
        half = capped / 2.0
        return half + random.uniform(0, half)
    else:  # full jitter
        return random.uniform(0, capped)


def decide_retry(
    exc: Exception,
    *,
    policy: RetryPolicy,
    attempt: int,
    elapsed_time: float,
) -> RetryDecision:
    """Evaluate exception against policy, attempt count, and elapsed time to decide retry."""
    cat, reached = classify_error(exc)

    # 1. Cancelled error is never retryable
    if cat == ErrorCategory.CLIENT_CANCELLED:
        return RetryDecision(
            retryable=False,
            category=cat,
            reason="Operation cancelled by client",
            delay_seconds=0.0,
            request_may_have_reached_upstream=reached,
        )

    # 2. Non-idempotent operation with reached=True on ambiguous error (timeouts / connection drop mid-request)
    if policy.operation_safety == OperationSafety.NON_IDEMPOTENT and reached:
        if cat in (ErrorCategory.NETWORK_TIMEOUT, ErrorCategory.CONNECTION_RESET):
            return RetryDecision(
                retryable=False,
                category=ErrorCategory.AMBIGUOUS_OUTCOME,
                reason="Ambiguous outcome: non-idempotent request may have reached upstream",
                delay_seconds=0.0,
                request_may_have_reached_upstream=True,
            )

    # 3. Check if category is allowed by policy
    if cat not in policy.retryable_categories:
        return RetryDecision(
            retryable=False,
            category=cat,
            reason=f"Non-retryable error category: {cat.value}",
            delay_seconds=0.0,
            request_may_have_reached_upstream=reached,
        )

    # 4. Check max attempts
    if attempt >= policy.max_attempts:
        return RetryDecision(
            retryable=False,
            category=cat,
            reason=f"Max attempts ({policy.max_attempts}) reached",
            delay_seconds=0.0,
            request_may_have_reached_upstream=reached,
        )

    # 5. Determine delay (Retry-After header takes precedence)
    delay: float
    retry_after: Optional[float] = None
    if isinstance(exc, httpx.HTTPStatusError) and exc.response is not None:
        raw_header = exc.response.headers.get("Retry-After")
        retry_after = _parse_retry_after(raw_header)

    if retry_after is not None:
        if retry_after > policy.retry_after_cap:
            return RetryDecision(
                retryable=False,
                category=cat,
                reason=f"Retry-After ({retry_after:.1f}s) exceeds cap ({policy.retry_after_cap:.1f}s)",
                delay_seconds=0.0,
                request_may_have_reached_upstream=reached,
            )
        delay = retry_after
    else:
        delay = _calculate_backoff(policy, attempt)

    # 6. Check time budget (must not exceed max_elapsed_time)
    if elapsed_time + delay >= policy.max_elapsed_time:
        return RetryDecision(
            retryable=False,
            category=cat,
            reason=f"Retry would exceed budget ({elapsed_time + delay:.1f}s >= {policy.max_elapsed_time:.1f}s)",
            delay_seconds=0.0,
            request_may_have_reached_upstream=reached,
        )

    return RetryDecision(
        retryable=True,
        category=cat,
        reason=f"Retry attempt {attempt + 1}/{policy.max_attempts}",
        delay_seconds=delay,
        request_may_have_reached_upstream=reached,
    )


class PolicyResolver:
    """Provides predefined policies for different platform scenarios."""

    _POLICIES: Dict[str, RetryPolicy] = {
        "ai_image_generation": RetryPolicy(
            policy_name="ai_image_generation",
            operation_safety=OperationSafety.NON_IDEMPOTENT,
            max_attempts=5,
            max_elapsed_time=120.0,
            backoff_gradient=(2.0, 6.0, 15.0, 30.0),
            backoff_cap=30.0,
            retry_after_cap=120.0,
            jitter="full",
        ),
        "ai_text_generation": RetryPolicy(
            policy_name="ai_text_generation",
            operation_safety=OperationSafety.IDEMPOTENT,
            max_attempts=4,
            max_elapsed_time=60.0,
            backoff_gradient=(1.0, 2.0, 4.0, 8.0),
            backoff_cap=15.0,
            retry_after_cap=60.0,
            jitter="full",
        ),
        "image_download": RetryPolicy(
            policy_name="image_download",
            operation_safety=OperationSafety.SAFE,
            max_attempts=3,
            max_elapsed_time=30.0,
            backoff_gradient=(1.0, 2.0, 4.0),
            backoff_cap=10.0,
            retry_after_cap=30.0,
            jitter="full",
        ),
        "lightweight_query": RetryPolicy(
            policy_name="lightweight_query",
            operation_safety=OperationSafety.SAFE,
            max_attempts=3,
            max_elapsed_time=15.0,
            backoff_gradient=(0.5, 1.0, 2.0),
            backoff_cap=5.0,
            retry_after_cap=15.0,
            jitter="full",
        ),
        "shopify_mutation": RetryPolicy(
            policy_name="shopify_mutation",
            operation_safety=OperationSafety.IDEMPOTENT,
            max_attempts=4,
            max_elapsed_time=45.0,
            backoff_gradient=(1.0, 2.0, 5.0),
            backoff_cap=15.0,
            retry_after_cap=60.0,
            jitter="full",
        ),
        "wordpress_media_upload": RetryPolicy(
            policy_name="wordpress_media_upload",
            operation_safety=OperationSafety.NON_IDEMPOTENT,
            max_attempts=3,
            max_elapsed_time=60.0,
            backoff_gradient=(2.0, 5.0, 10.0),
            backoff_cap=15.0,
            retry_after_cap=60.0,
            jitter="full",
        ),
        "crawler_scrape": RetryPolicy(
            policy_name="crawler_scrape",
            operation_safety=OperationSafety.SAFE,
            max_attempts=3,
            max_elapsed_time=45.0,
            backoff_gradient=(2.0, 5.0, 10.0),
            backoff_cap=15.0,
            retry_after_cap=60.0,
            jitter="full",
        ),
    }

    @classmethod
    def get_policy(cls, scenario: str) -> RetryPolicy:
        if scenario in cls._POLICIES:
            return cls._POLICIES[scenario]
        # Default safe fallback policy
        return RetryPolicy(
            policy_name="default_fallback",
            operation_safety=OperationSafety.IDEMPOTENT,
            max_attempts=3,
            max_elapsed_time=30.0,
            backoff_gradient=(1.0, 2.0, 4.0),
            backoff_cap=10.0,
            retry_after_cap=30.0,
            jitter="full",
        )


async def execute_with_retry(
    operation: Callable[[], Any],
    *,
    policy: RetryPolicy,
    operation_id: str = "",
    execution_id: str = "",
    on_retry: Optional[Callable[[ExecutionState, RetryDecision], Any]] = None,
) -> Any:
    """Execute an async or sync callable with unified retry policy, budget tracking, and error categorization."""
    start_time = time.monotonic()
    attempt = 1
    state = ExecutionState(
        operation_id=operation_id,
        execution_id=execution_id,
        attempt=1,
        max_attempts=policy.max_attempts,
        state="running",
    )

    while True:
        try:
            if inspect.iscoroutinefunction(operation) or inspect.iscoroutine(operation):
                return await operation()
            res = operation()
            if inspect.iscoroutine(res):
                return await res
            return res
        except Exception as exc:
            if isinstance(exc, asyncio.CancelledError):
                state.state = "failed"
                state.error_category = ErrorCategory.CLIENT_CANCELLED
                raise

            elapsed = time.monotonic() - start_time
            decision = decide_retry(
                exc,
                policy=policy,
                attempt=attempt,
                elapsed_time=elapsed,
            )

            state.error_category = decision.category

            if not decision.retryable:
                state.state = "failed"
                if decision.category == ErrorCategory.AMBIGUOUS_OUTCOME:
                    state.state = "ambiguous"
                    raise AmbiguousOutcomeError(decision.reason, last_error=exc) from exc
                if "budget" in decision.reason.lower():
                    raise RetryBudgetExceededError(decision.reason, last_error=exc) from exc
                if attempt >= policy.max_attempts:
                    raise RetryExhaustedError(decision.reason, last_error=exc) from exc
                # Non-retryable error
                raise exc

            # Prepare next retry
            state.state = "retrying"
            state.next_retry_at = time.time() + decision.delay_seconds
            if on_retry:
                res = on_retry(state, decision)
                if inspect.iscoroutine(res):
                    await res

            if decision.delay_seconds > 0:
                await asyncio.sleep(decision.delay_seconds)

            attempt += 1
            state.attempt = attempt
