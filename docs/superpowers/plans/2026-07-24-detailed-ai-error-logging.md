# Detailed AI Error Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface complete, credential-redacted AI provider diagnostics in backend responses and the Settings live-log console.

**Architecture:** Add one normalized provider diagnostic type in `ai_router.py` and use it for error classification, retry logs, terminal exceptions, connection tests, and HTTP status mapping. Extend the structured log model and Settings renderer so details remain machine-readable and expandable without parsing exception strings.

**Tech Stack:** Python 3.10+, FastAPI, httpx, Google GenAI SDK, pytest, vanilla JavaScript, Node test runner.

## Global Constraints

- Upstream exception messages and response bodies are visible for local debugging.
- API keys, authorization tokens, private keys, credential JSON, credential paths, prompts, and inline image payloads remain redacted.
- Structured log copies returned from `emit`, retained in history, delivered to subscribers, and serialized through SSE remain identical after sanitization.
- Existing retry counts, SSE replay/reconnect behavior, and text/image capability routing remain unchanged.
- No remote log shipping, file retention, authentication, or environment toggle is added.

---

### Task 1: Normalize provider diagnostics and detailed retry logs

**Files:**
- Modify: `backend/services/ai_router.py`
- Test: `backend/tests/test_ai_router.py`
- Test: `backend/tests/test_app_log_service.py`

**Interfaces:**
- Produces: `ProviderErrorDiagnostic` with `category`, `http_status`, `provider_code`, `request_id`, `exception_type`, `upstream_message`, and `response_body`.
- Produces: `diagnose_provider_error(exc) -> ProviderErrorDiagnostic`.
- Produces: `AIProviderRequestError.diagnostic`.
- Consumes: existing `AppLogService.emit`.

- [ ] **Step 1: Write failing diagnostic and retry-log tests**

Add tests that create an `httpx.HTTPStatusError` with status `429`, headers
containing a request ID, and a JSON body. Assert that
`diagnose_provider_error()` returns the normalized fields, retry and terminal
logs contain a structured `diagnostic` object, and credentials embedded in the
message/body are absent after passing through a real `AppLogService`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
.venv/bin/python -m pytest backend/tests/test_ai_router.py backend/tests/test_app_log_service.py -q -k 'diagnostic or detailed_retry'
```

Expected: failures because `ProviderErrorDiagnostic`,
`diagnose_provider_error`, and structured diagnostic log data do not exist.

- [ ] **Step 3: Implement the normalized diagnostic**

Implement a frozen dataclass and safe extraction helpers. Inspect exception and
response attributes without assuming a specific SDK:

```python
@dataclass(frozen=True)
class ProviderErrorDiagnostic:
    category: str
    http_status: int | None
    provider_code: str | None
    request_id: str | None
    exception_type: str
    upstream_message: str
    response_body: object | None

    def as_log_dict(self) -> dict:
        return dataclasses.asdict(self)
```

Read response status, `x-request-id`/`x-goog-request-id`, and JSON/text body
when present. Bound individual text fields before they reach the log service.
Make `map_provider_error()` delegate to `diagnose_provider_error()` and attach
the diagnostic to `AIProviderRequestError`.

For each caught attempt, emit:

```python
message={
    "summary": "AI 请求重试" if retrying else str(mapped),
    "diagnostic": diagnostic.as_log_dict(),
    "attempt": attempt + 1,
    "max_attempts": snapshot.max_retries + 1,
}
```

Include elapsed `duration_ms` on retry and terminal logs.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/services/ai_router.py backend/tests/test_ai_router.py backend/tests/test_app_log_service.py
git commit -m "feat: add detailed provider diagnostics"
```

### Task 2: Return detailed connection-test and runtime HTTP errors

**Files:**
- Modify: `backend/main.py`
- Test: `backend/tests/test_main.py`
- Test: `backend/tests/test_settings_api.py`

**Interfaces:**
- Consumes: `AIProviderRequestError.diagnostic`.
- Consumes: `diagnose_provider_error(exc)`.
- Produces: provider-category-to-HTTP-status mapping for `/api/ai/generate`.

- [ ] **Step 1: Write failing HTTP and connection-test tests**

Add parameterized tests for authentication, missing model, rate limit,
timeout, protocol error, and upstream failure. Assert status codes
`401/404/429/504/502` respectively and a JSON `detail` object containing the
category and sanitized diagnostic. Add a connection-test test asserting its
message includes `HTTP 429`, `RESOURCE_EXHAUSTED`, exception type, and upstream
text.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
.venv/bin/python -m pytest backend/tests/test_main.py backend/tests/test_settings_api.py -q -k 'provider_http_error or detailed_connection'
```

Expected: `/api/ai/generate` returns an unhandled `500`, and connection tests
return only the generic mapped message.

- [ ] **Step 3: Implement structured HTTP errors**

Catch `AIProviderRequestError` in `api_ai_generate`, map its category to the
documented status, sanitize the diagnostic using the same `AppLogService`
boundary, and raise `HTTPException(status_code=..., detail=...)`.

In connection tests, call `diagnose_provider_error(exc)` once and format:

```text
AI 提供商请求频率受限 | HTTP 429 | code=RESOURCE_EXHAUSTED |
type=ClientError | request_id=... | upstream=...
```

The existing result envelope and persisted test-status behavior remain
unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add backend/main.py backend/tests/test_main.py backend/tests/test_settings_api.py
git commit -m "feat: expose detailed AI request failures"
```

### Task 3: Render expandable diagnostic details in Settings

**Files:**
- Modify: `frontend/js/settings.js`
- Modify: `frontend/css/settings.css`
- Test: `frontend/tests/settings.test.js`

**Interfaces:**
- Consumes: log entries whose `message` may be a structured object containing
  `summary`, `diagnostic`, `attempt`, and `max_attempts`.
- Produces: `settingsLogSummary(entry) -> string`.
- Produces: `settingsLogDetails(entry) -> Array<[string, string]>`.

- [ ] **Step 1: Write failing formatter and escaping tests**

Add Node assertions that a structured diagnostic keeps a compact summary,
returns status/code/type/request ID/upstream/body detail rows, and preserves
malicious HTML as text. Assert legacy string messages still format exactly as
before.

- [ ] **Step 2: Run the frontend test and verify RED**

```bash
node frontend/tests/settings.test.js
```

Expected: failure because diagnostic formatting helpers are absent.

- [ ] **Step 3: Implement expandable detail rendering**

Extend log rendering to create DOM nodes with `textContent`. Render the compact
fields first, then a native `<details>` element with a `<summary>查看错误详情</summary>`
and pre-wrapped key/value rows when diagnostics exist. Do not use
`innerHTML` for diagnostic values.

Add focused CSS for wrapping long text, a bounded expanded panel, and readable
labels without changing ordinary log layout.

- [ ] **Step 4: Run frontend tests and syntax checks**

```bash
node --test frontend/tests/*.test.js
for file in frontend/js/*.js; do node --check "$file" || exit 1; done
```

Expected: all frontend tests and syntax checks pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add frontend/js/settings.js frontend/css/settings.css frontend/tests/settings.test.js
git commit -m "feat: render expandable AI error details"
```

### Task 4: Full verification and live 429 reproduction

**Files:**
- Modify only if a verification failure exposes a scoped regression.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: a running local application whose Settings console exposes the
  current Vertex `429` with detailed fields.

- [ ] **Step 1: Run full automated verification**

```bash
.venv/bin/python -m pytest backend/tests
node --test frontend/tests/*.test.js
for file in frontend/js/*.js; do node --check "$file" || exit 1; done
(cd frontend && npm run build:css)
.venv/bin/python -m compileall -q backend run.py
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run credential-leak regression searches**

Run focused redaction tests and inspect the feature diff for new raw
`print()`/`logger.*` calls, environment secret reads, database files, static
outputs, and `.env` files. Expected: no credential material or local state is
tracked.

- [ ] **Step 3: Restart and reproduce the live provider error**

Restart `run.py`, invoke the saved text provider connection test, and confirm
the Settings log contains `rate_limit`, `HTTP 429`, the provider code and
exception type while containing no credential values.

- [ ] **Step 4: Request final read-only review**

Review the complete detailed-logging diff for Critical or Important issues,
especially redaction boundaries, exception-body parsing, response status
mapping, HTML escaping, and legacy log compatibility.

- [ ] **Step 5: Commit any scoped review fixes and rerun verification**

If review finds an issue, add a failing regression test, implement the minimal
fix, commit it, and rerun Steps 1–3. Otherwise leave the verified commits
unchanged.
