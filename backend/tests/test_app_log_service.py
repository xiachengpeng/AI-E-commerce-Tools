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


def test_slow_subscriber_does_not_prevent_emitting_entries():
    logs = AppLogService()
    slow_queue = logs.subscribe()

    for index in range(201):
        logs.emit(level="info", source="system", message=f"entry {index}")

    assert len(logs.recent()) == 200
    assert slow_queue.full()
