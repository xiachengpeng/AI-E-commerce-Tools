import asyncio
import threading

import pytest

from services.app_log_service import APP_LOG_OVERFLOW, AppLogService


def test_log_session_id_is_stable_per_service_and_injectable():
    first_boot = AppLogService(session_id="boot-a")
    second_boot = AppLogService(session_id="boot-b")

    first_entry = first_boot.emit(
        level="info",
        source="system",
        message="first boot",
    )
    second_entry = second_boot.emit(
        level="info",
        source="system",
        message="second boot",
    )

    assert first_entry["session_id"] == "boot-a"
    assert second_entry["session_id"] == "boot-b"
    assert first_entry["id"] == second_entry["id"] == 1


def test_log_ids_are_monotonic_across_buffer_eviction_and_copied():
    logs = AppLogService(capacity=2)

    first = logs.emit(level="info", source="system", message="first")
    second = logs.emit(level="info", source="system", message="second")
    third = logs.emit(level="info", source="system", message="third")

    assert [first["id"], second["id"], third["id"]] == [1, 2, 3]
    assert [entry["id"] for entry in logs.recent()] == [2, 3]

    third["id"] = 999
    assert logs.recent()[-1]["id"] == 3


@pytest.mark.asyncio
async def test_threaded_emits_preserve_history_and_publication_order():
    slow_redaction_started = threading.Event()
    release_slow_redaction = threading.Event()
    fast_redaction_started = threading.Event()

    class DelayedRedactionLogs(AppLogService):
        @staticmethod
        def _redact(value):
            if value == "slow":
                slow_redaction_started.set()
                release_slow_redaction.wait(1)
            elif value == "fast":
                fast_redaction_started.set()
            return AppLogService._redact(value)

    logs = DelayedRedactionLogs(session_id="boot-a")
    queue = logs.subscribe()
    slow_thread = threading.Thread(
        target=lambda: logs.emit(
            level="info",
            source="system",
            message="slow",
        )
    )
    fast_thread = threading.Thread(
        target=lambda: logs.emit(
            level="info",
            source="system",
            message="fast",
        )
    )

    slow_thread.start()
    assert await asyncio.to_thread(slow_redaction_started.wait, 1)
    fast_thread.start()
    await asyncio.to_thread(fast_redaction_started.wait, 0.1)
    release_slow_redaction.set()
    await asyncio.to_thread(slow_thread.join, 1)
    await asyncio.to_thread(fast_thread.join, 1)

    delivered = [
        await asyncio.wait_for(queue.get(), 0.2),
        await asyncio.wait_for(queue.get(), 0.2),
    ]

    assert [entry["id"] for entry in logs.recent()] == [1, 2]
    assert [entry["id"] for entry in delivered] == [1, 2]


@pytest.mark.asyncio
async def test_cross_thread_emit_wakes_subscriber_on_owning_loop():
    logs = AppLogService(session_id="boot-a")
    queue = logs.subscribe()
    pending = asyncio.create_task(queue.get())
    await asyncio.sleep(0)

    await asyncio.to_thread(
        logs.emit,
        level="info",
        source="system",
        message="from worker",
    )
    delivered = await asyncio.wait_for(pending, 0.2)

    assert delivered["session_id"] == "boot-a"
    assert delivered["id"] == 1


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


@pytest.mark.parametrize(
    ("message", "secrets"),
    [
        (
            'vertex_key_path="/private/vertex-secret.json" status=ready',
            ["/private/vertex-secret.json"],
        ),
        (
            '{"vertex_key_path": "/private/json-secret.json", "count": 2}',
            ["/private/json-secret.json"],
        ),
        (
            "image_data=data:image/png;base64,QUJDRA== count=1",
            ["QUJDRA=="],
        ),
        (
            '{"image_data": "opaque-image-secret", "count": 3}',
            ["opaque-image-secret"],
        ),
        (
            '{"inlineData": {"mimeType": "image/png", "data": "INLINESECRET"}, "count": 4}',
            ["INLINESECRET"],
        ),
        (
            "{'inline_data': {'mime_type': 'image/png', 'data': 'SNAKESECRET'}, 'count': 5}",
            ["SNAKESECRET"],
        ),
        (
            "inlineData.data=DOTSECRET status=ok",
            ["DOTSECRET"],
        ),
        (
            "{inlineData: {mimeType: image/png, data: BARESECRET}, count: 6}",
            ["BARESECRET"],
        ),
    ],
)
def test_sensitive_credential_and_image_variants_are_redacted(
    message,
    secrets,
):
    entry = AppLogService().emit(
        level="info",
        source="image",
        message=message,
    )

    for secret in secrets:
        assert secret not in entry["message"]
    assert "[REDACTED]" in entry["message"] or "[IMAGE REDACTED]" in entry["message"]
    for safe_metadata in ("count", "status", "mimeType", "mime_type"):
        if safe_metadata in message:
            assert safe_metadata in entry["message"]


@pytest.mark.asyncio
async def test_recent_and_subscriber_never_expose_inline_image_data():
    logs = AppLogService()
    queue = logs.subscribe()

    logs.emit(
        level="info",
        source="image",
        message='{"inlineData":{"data":"VERYSECRET"},"status":"done"}',
    )

    delivered = await asyncio.wait_for(queue.get(), 0.1)
    assert "VERYSECRET" not in str(delivered)
    assert "VERYSECRET" not in str(logs.recent())
    assert "status" in delivered["message"]


def test_closed_subscriber_loop_is_pruned_without_breaking_emit():
    logs = AppLogService()

    async def subscribe_once():
        return logs.subscribe()

    queue = asyncio.run(subscribe_once())

    entry = logs.emit(
        level="success",
        source="system",
        message="business request completed",
    )

    assert entry["message"] == "business request completed"
    assert logs.recent() == [entry]
    assert queue not in logs._subscribers


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


@pytest.mark.parametrize(
    ("message", "key", "secret"),
    [
        ('{"api_key": "json-secret"}', '"api_key": ', "json-secret"),
        ("{'apiKey': 'repr-secret'}", "'apiKey': ", "repr-secret"),
        ('{"api-key" = "hyphen-secret"}', '"api-key" = ', "hyphen-secret"),
        ("{'API Key' = 'space-secret'}", "'API Key' = ", "space-secret"),
        ('{X-API-Key: bare-secret}', "X-API-Key: ", "bare-secret"),
        ("{api_key=bare-equals-secret}", "api_key=", "bare-equals-secret"),
    ],
)
def test_serialized_api_key_mapping_forms_redact_only_the_value(message, key, secret):
    entry = AppLogService().emit(level="info", source="system", message=message)

    assert key in entry["message"]
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


@pytest.mark.asyncio
async def test_full_subscriber_queue_collapses_to_recoverable_overflow():
    logs = AppLogService(capacity=200, session_id="boot-a")
    slow_queue = logs.subscribe()

    for index in range(500):
        logs.emit(level="info", source="system", message=f"entry {index}")
    await asyncio.sleep(0)

    assert len(logs.recent()) == 200
    assert slow_queue.qsize() == 1
    assert slow_queue.get_nowait() is APP_LOG_OVERFLOW

    recovered = logs.recent_after(
        "boot-a",
        0,
        subscriber_queue=slow_queue,
    )
    assert [entry["id"] for entry in recovered] == list(range(301, 501))

    logs.emit(level="info", source="system", message="after recovery")
    await asyncio.sleep(0)
    assert slow_queue.get_nowait()["id"] == 501
