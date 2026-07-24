# Detailed AI Error Logging Design

Date: 2026-07-24

## Goal

Make local AI failures diagnosable from the Settings log console without
opening the backend terminal. The application is intended for personal local
use, so upstream error details may be displayed, while credentials remain
redacted.

## Scope

This change covers AI provider calls routed through `AIRouter`, saved and
draft provider connection tests, the `/api/ai/generate` response, retained
application logs, and the Settings live-log UI.

It does not add remote log shipping, file-based log retention, authentication,
or a production/debug environment switch.

## Error Details

For every failed provider attempt, collect a normalized diagnostic record:

- Error category such as authentication, rate limit, timeout, model missing,
  protocol incompatibility, or upstream failure.
- HTTP status when available.
- Provider error code and request ID when available.
- Exception class.
- The complete upstream exception message and response body when available.
- Attempt number, configured retry limit, elapsed request time, provider,
  model, and capability.

The terminal failure log includes the same diagnostic data as the final retry.
Retry logs include the diagnostic data for the attempt that triggered the
retry.

## Credential Boundary

Detailed logging does not disable credential protection. Before a diagnostic
record reaches the log service or an HTTP response, the existing redaction
pipeline must remove:

- API keys and authorization headers.
- Access, refresh, and ID tokens.
- Client secrets and passwords.
- Service-account private keys and credential JSON.
- Inline image/Base64 payloads.

Upstream response text is otherwise retained without the current short generic
replacement. Long text remains bounded to prevent an unbounded log entry.

## API Behavior

`/api/ai/generate` catches normalized provider errors and returns a structured
JSON error instead of an unhandled exception:

- `401` or `403` for authentication and permission failures.
- `404` for an unavailable model.
- `429` for rate limiting or quota exhaustion.
- `504` for timeouts.
- `502` for incompatible or failed upstream provider responses.

The response includes category, safe diagnostic details, provider, model,
capability, and retry count. It never includes credential material.

Connection-test endpoints continue returning their existing result envelope,
but the message contains the sanitized detailed diagnostic summary.

## Log UI

The Settings log console renders normalized diagnostic fields when present.
Long messages and response details are shown in a pre-wrapped expandable
details block so ordinary success logs remain compact. Existing filtering,
replay, reconnect, and overflow recovery behavior is preserved.

## Architecture

Provider exception inspection and HTTP mapping live in
`backend/services/ai_router.py` as a small reusable diagnostic type. Both the
runtime router and connection-test path use that type, preventing the two paths
from reporting different explanations for the same provider error.

`AppLogService` remains the final redaction boundary. It accepts structured
diagnostic metadata, sanitizes it before retaining or publishing it, and keeps
all existing copies consistent: emit return value, recent history, subscriber
queue, and SSE frames.

The frontend only renders fields returned by the backend and does not parse raw
exception strings to infer status or category.

## Testing

Backend tests must prove:

- A provider `429` produces category `rate_limit`, status `429`, detailed
  retry and terminal logs, and an HTTP `429` response.
- Authentication, model, timeout, protocol, and generic upstream failures map
  to the documented HTTP status.
- Connection tests expose the same sanitized diagnostic summary.
- Raw upstream messages and response bodies survive when safe.
- Credentials embedded in exception text, headers, JSON, escaped strings, or
  nested response data remain redacted from emit results, history,
  subscribers, SSE, and HTTP responses.
- Retry attempt and duration metadata are accurate.

Frontend tests must prove:

- Diagnostic fields render in an expandable details block.
- Ordinary logs remain compact.
- Upstream text is escaped rather than inserted as HTML.

All existing backend, frontend, syntax, build, and compatibility checks must
continue passing.
