import asyncio

import pytest

from services.app_log_service import AppLogService


def test_log_buffer_is_bounded_and_redacted():
    logs = AppLogService(capacity=200)

    for index in range(205):
        logs.emit(
            level="info",
            source="ai",
            message=(
                f"Authorization: Bearer secret-{index} "
                "data:image/png;base64,AAAA api_key=key-secret"
            ),
        )

    recent = logs.recent()

    assert len(recent) == 200
    assert recent[0]["message"].endswith("[REDACTED]")
    assert "secret-" not in str(recent)
    assert "AAAA" not in str(recent)
    assert "key-secret" not in str(recent)


@pytest.mark.asyncio
async def test_subscriber_receives_new_entry():
    logs = AppLogService()
    queue = logs.subscribe()

    logs.emit(level="success", source="system", message="ready")

    assert (await asyncio.wait_for(queue.get(), 0.1))["message"] == "ready"
    logs.unsubscribe(queue)


def test_api_key_header_forms_are_redacted():
    logs = AppLogService()

    entry = logs.emit(
        level="warning",
        source="system",
        message='API-Key: header-secret; api key="quoted-secret"',
    )

    assert entry["message"] == "API-Key: [REDACTED]; api key=\"[REDACTED]\""


@pytest.mark.parametrize(
    ("authorization", "secret"),
    [
        ("Authorization: Basic basic-secret", "basic-secret"),
        ("authorization=Bearer bearer-secret", "bearer-secret"),
        ("AUTHORIZATION : Token token-secret", "token-secret"),
        ("Authorization=Custom custom-secret", "custom-secret"),
    ],
)
def test_all_authorization_credential_forms_are_redacted(authorization, secret):
    entry = AppLogService().emit(
        level="info", source="system", message=f"request {authorization}"
    )

    assert secret not in entry["message"]
    assert "[REDACTED]" in entry["message"]


@pytest.mark.parametrize(
    ("message", "secret"),
    [
        ('{"Authorization": "Bearer json-secret"}', "json-secret"),
        ("{'Authorization': 'Bearer repr-secret'}", "repr-secret"),
    ],
)
def test_quoted_authorization_keys_in_serialized_mappings_are_redacted(message, secret):
    entry = AppLogService().emit(level="info", source="system", message=message)

    assert secret not in entry["message"]
    assert "[REDACTED]" in entry["message"]


@pytest.mark.asyncio
async def test_string_structured_fields_are_redacted_before_publication():
    logs = AppLogService()
    queue = logs.subscribe()

    entry = logs.emit(
        level="info",
        source="system",
        message="safe summary",
        capability="Authorization=Bearer capability-secret",
        provider="response: provider-secret",
        model='{"prompt": "model-secret"}',
    )

    delivered = await asyncio.wait_for(queue.get(), 0.1)
    assert delivered == entry
    assert "capability-secret" not in str(entry)
    assert "provider-secret" not in str(entry)
    assert "model-secret" not in str(entry)
    assert entry["message"] == "safe summary"


def test_labeled_prompt_and_response_payloads_are_redacted():
    entry = AppLogService().emit(
        level="info",
        source="ai",
        message=(
            "summary: completed\n"
            "prompt: expose secret instructions\n"
            "response: raw provider response\n"
            '{"prompt": "json-prompt-secret", "response": "json-response-secret"}'
        ),
    )

    assert entry["message"].startswith("summary: completed")
    for secret in (
        "expose secret instructions",
        "raw provider response",
        "json-prompt-secret",
        "json-response-secret",
    ):
        assert secret not in entry["message"]
    assert entry["message"].count("[REDACTED]") == 4


def test_prompt_and_response_separator_and_provider_key_variants_are_redacted():
    entry = AppLogService().emit(
        level="info",
        source="ai",
        message=(
            "Prompt = equals-secret\n"
            "prompt: colon-secret\n"
            '{"PROMPT": "upper-secret", "provider_response": "snake-secret", '
            '"providerResponse": "camel-secret"}'
        ),
    )

    for secret in (
        "equals-secret",
        "colon-secret",
        "upper-secret",
        "snake-secret",
        "camel-secret",
    ):
        assert secret not in entry["message"]
    assert entry["message"].count("[REDACTED]") == 5


@pytest.mark.asyncio
async def test_returned_history_and_subscriber_entries_are_independent_copies():
    logs = AppLogService()
    first_subscriber = logs.subscribe()
    second_subscriber = logs.subscribe()

    returned = logs.emit(level="info", source="system", message="original")
    first_event = await asyncio.wait_for(first_subscriber.get(), 0.1)
    second_event = await asyncio.wait_for(second_subscriber.get(), 0.1)
    recent = logs.recent()

    returned["message"] = "returned mutation"
    first_event["message"] = "first subscriber mutation"
    recent[0]["message"] = "recent mutation"

    assert second_event["message"] == "original"
    assert logs.recent()[0]["message"] == "original"


def test_duration_and_retry_are_coerced_to_integers_or_none():
    entry = AppLogService().emit(
        level="info",
        source="system",
        message="safe summary",
        duration_ms="125",
        retry="2",
    )
    invalid = AppLogService().emit(
        level="info",
        source="system",
        message="safe summary",
        duration_ms="prompt: duration-secret",
        retry="not-a-number",
    )

    assert (entry["duration_ms"], entry["retry"]) == (125, 2)
    assert (invalid["duration_ms"], invalid["retry"]) == (None, None)
    assert "duration-secret" not in str(invalid)


@pytest.mark.asyncio
async def test_unsubscribed_queue_does_not_receive_new_entries():
    logs = AppLogService()
    queue = logs.subscribe()
    logs.unsubscribe(queue)

    logs.emit(level="info", source="system", message="after unsubscribe")

    assert queue.empty()


def test_full_subscriber_queue_drops_new_entries_without_interrupting_emit():
    logs = AppLogService()
    slow_queue = logs.subscribe()

    for index in range(201):
        logs.emit(level="info", source="system", message=f"entry {index}")

    assert len(logs.recent()) == 200
    assert slow_queue.full()
    assert slow_queue.get_nowait()["message"] == "entry 0"
    assert logs.recent()[-1]["message"] == "entry 200"
