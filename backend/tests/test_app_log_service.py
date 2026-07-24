import asyncio
import json
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


@pytest.mark.parametrize(
    ("message", "secrets", "preserved"),
    [
        (
            (
                '{"inlineData":{"metadata":{"data":"safe-metadata"},'
                '"mimeType":"image/png","data":"ACTUAL-IMAGE-SECRET"}}'
            ),
            ["ACTUAL-IMAGE-SECRET"],
            ["safe-metadata", "mimeType"],
        ),
        (
            (
                "{'imageBase64': 'CAMEL-IMAGE', "
                "'base64_image': 'SNAKE-IMAGE', "
                "'credentials': {'private_key_id': 'KEY-ID', "
                "'client_email': 'service@example.com', "
                "'client_id': 'CLIENT-ID', "
                "'client_x509_cert_url': 'https://cert-secret', "
                "'auth_uri': 'https://auth-secret', "
                "'token_uri': 'https://token-secret', "
                "'universe_domain': 'universe-secret'}}"
            ),
            [
                "CAMEL-IMAGE",
                "SNAKE-IMAGE",
                "KEY-ID",
                "service@example.com",
                "CLIENT-ID",
                "https://cert-secret",
                "https://auth-secret",
                "https://token-secret",
                "universe-secret",
            ],
            ["credentials"],
        ),
        (
            (
                "upload=data:image/png;charset=utf-8;"
                "name=preview.png;base64,PARAMETERIZEDSECRET status=ok"
            ),
            ["PARAMETERIZEDSECRET"],
            ["status=ok"],
        ),
        (
            (
                "credential=-----BEGIN PRIVATE KEY-----\n"
                "PEM-SECRET\n"
                "-----END PRIVATE KEY----- status=loaded"
            ),
            ["PEM-SECRET"],
            ["status=loaded"],
        ),
    ],
)
def test_bypass_variants_are_redacted_from_serialized_messages(
    message,
    secrets,
    preserved,
):
    entry = AppLogService().emit(
        level="info",
        source="image",
        message=message,
    )

    for secret in secrets:
        assert secret not in str(entry["message"])
    for value in preserved:
        assert value in str(entry["message"])


@pytest.mark.asyncio
async def test_recursive_structured_sanitization_reaches_recent_and_subscriber():
    logs = AppLogService()
    queue = logs.subscribe()
    structured = {
        "event": "image-ready",
        "items": [
            {"image_base64": "STRUCTURED-IMAGE"},
            {
                "inline_data": {
                    "mime_type": "image/png",
                    "data": "STRUCTURED-INLINE",
                }
            },
        ],
        "google_credentials": {
            "private_key": (
                "-----BEGIN PRIVATE KEY-----\n"
                "STRUCTURED-PEM\n"
                "-----END PRIVATE KEY-----"
            ),
            "vertex_key_path": "/private/vertex.json",
        },
    }

    returned = logs.emit(
        level="info",
        source="system",
        message=structured,
        provider={"client_email": "structured@example.com"},
        model="{'private_key_id': 'MODEL-KEY-ID'}",
    )
    delivered = await asyncio.wait_for(queue.get(), 0.1)
    recent = logs.recent()[0]

    for entry in (returned, delivered, recent):
        serialized = str(entry)
        for secret in (
            "STRUCTURED-IMAGE",
            "STRUCTURED-INLINE",
            "STRUCTURED-PEM",
            "/private/vertex.json",
            "structured@example.com",
            "MODEL-KEY-ID",
        ):
            assert secret not in serialized
        assert "image-ready" in serialized
        assert "image/png" in serialized

    returned["message"]["items"][0]["image_base64"] = "MUTATED"
    assert "MUTATED" not in str(logs.recent())


@pytest.mark.asyncio
async def test_vertex_service_account_and_image_aliases_are_redacted_everywhere():
    logs = AppLogService()
    queue = logs.subscribe()
    structured = {
        "vertex_project_id": "vertex-project-secret",
        "vertex_location": "vertex-location-secret",
        "credentials": {
            "project_id": "service-account-project-secret",
            "auth_provider_x509_cert_url": "https://auth-cert-secret",
        },
        "images": [
            {"base64": "base64-image-secret"},
            {"b64_json": "b64-json-image-secret"},
        ],
        "status": "ready",
        "count": 2,
        "mime_type": "image/png",
    }

    returned = logs.emit(
        level="info",
        source="image",
        message=structured,
    )
    delivered = await asyncio.wait_for(queue.get(), 0.1)
    recent = logs.recent()[0]

    for entry in (returned, delivered, recent):
        serialized = str(entry)
        for secret in (
            "vertex-project-secret",
            "vertex-location-secret",
            "service-account-project-secret",
            "https://auth-cert-secret",
            "base64-image-secret",
            "b64-json-image-secret",
        ):
            assert secret not in serialized
        assert entry["message"]["status"] == "ready"
        assert entry["message"]["count"] == 2
        assert entry["message"]["mime_type"] == "image/png"


@pytest.mark.asyncio
async def test_google_oauth_credential_containers_fail_closed_everywhere():
    logs = AppLogService()
    queue = logs.subscribe()
    structured = {
        "headers": {
            "x-goog-api-key": "GOOGLE-HEADER-SECRET",
            "Authorization": "Bearer AUTHORIZATION-SECRET",
        },
        "credentials": {
            "refresh_token": "REFRESH-TOKEN-SECRET",
            "accessToken": "ACCESS-TOKEN-SECRET",
            "id_token": "ID-TOKEN-SECRET",
            "client_secret": "CLIENT-SECRET",
        },
        "serviceAccount": {
            "private_key": "PRIVATE-KEY-SECRET",
            "client_x509_cert_url": "CERTIFICATE-SECRET",
        },
        "client": {
            "password": "PASSWORD-SECRET",
            "apiKey": "CLIENT-API-SECRET",
        },
        "image": "RAW-IMAGE-SECRET",
        "imageB64": "IMAGE-B64-SECRET",
        "status": "ready",
        "count": 2,
        "mime_type": "image/png",
        "model": "safe-model",
        "provider": "safe-provider",
        "capability": "image",
        "duration_ms": 12,
        "retry": 1,
        "config_version": 7,
    }

    returned = logs.emit(
        level="info",
        source="image",
        message=structured,
    )
    delivered = await asyncio.wait_for(queue.get(), 0.1)
    recent = logs.recent()[0]

    for entry in (returned, delivered, recent):
        rendered = str(entry)
        for secret in (
            "GOOGLE-HEADER-SECRET",
            "AUTHORIZATION-SECRET",
            "REFRESH-TOKEN-SECRET",
            "ACCESS-TOKEN-SECRET",
            "ID-TOKEN-SECRET",
            "CLIENT-SECRET",
            "PRIVATE-KEY-SECRET",
            "CERTIFICATE-SECRET",
            "PASSWORD-SECRET",
            "CLIENT-API-SECRET",
            "RAW-IMAGE-SECRET",
            "IMAGE-B64-SECRET",
        ):
            assert secret not in rendered
        assert entry["message"]["status"] == "ready"
        assert entry["message"]["count"] == 2
        assert entry["message"]["mime_type"] == "image/png"
        assert entry["message"]["model"] == "safe-model"
        assert entry["message"]["provider"] == "safe-provider"
        assert entry["message"]["capability"] == "image"
        assert entry["message"]["duration_ms"] == 12
        assert entry["message"]["retry"] == 1
        assert entry["message"]["config_version"] == 7


STRING_FALLBACK_BYPASSES = [
    (
        r'{\"x-goog-api-key\":\"ESCAPED-GOOGLE-SECRET\", '
        r'\"status\":\"ready\"}',
        ("ESCAPED-GOOGLE-SECRET",),
        ("status", "ready"),
    ),
    (
        '{"refresh_token":"TRUNCATED-REFRESH-SECRET',
        ("TRUNCATED-REFRESH-SECRET",),
        (),
    ),
    (
        "{'accessToken'='ACCESS-TOKEN-SECRET', count=2}",
        ("ACCESS-TOKEN-SECRET",),
        ("count=2",),
    ),
    (
        "{client_credentials=[{'client_secret':'CLIENT-SECRET'}] "
        "status=ready}",
        ("CLIENT-SECRET",),
        ("status=ready",),
    ),
    (
        "auth = Bearer AUTH-HEADER-SECRET; config_version=4",
        ("AUTH-HEADER-SECRET",),
        ("config_version=4",),
    ),
    (
        "upload=data:image/png;charset=utf-8;name=preview.png;base64,"
        "QUJD\r\n  REVGRw== status=ready",
        ("QUJD", "REVGRw=="),
        ("status=ready",),
    ),
    (
        r'{\"b64_json\":\"QUJD\r\n  REVGRw==',
        ("QUJD", "REVGRw=="),
        (),
    ),
    (
        "certificate=-----BEGIN CERTIFICATE-----\n"
        "CERTIFICATE-BLOCK-SECRET",
        ("CERTIFICATE-BLOCK-SECRET",),
        (),
    ),
]


@pytest.mark.parametrize(
    ("message", "secrets", "safe_fragments"),
    STRING_FALLBACK_BYPASSES,
)
@pytest.mark.asyncio
async def test_string_fallback_bypasses_are_redacted_from_all_log_copies(
    message,
    secrets,
    safe_fragments,
):
    logs = AppLogService()
    queue = logs.subscribe()

    returned = logs.emit(
        level="info",
        source="system",
        message=message,
    )
    delivered = await asyncio.wait_for(queue.get(), 0.1)
    recent = logs.recent()[0]

    for entry in (returned, delivered, recent):
        rendered = str(entry)
        for secret in secrets:
            assert secret not in rendered
        for fragment in safe_fragments:
            assert fragment in rendered


@pytest.mark.parametrize(
    ("message", "secret", "safe_metadata"),
    [
        (
            "{vertex_project_id=VERTEX-PROJECT-SECRET, status=ready}",
            "VERTEX-PROJECT-SECRET",
            "status=ready",
        ),
        (
            "{vertex-location: VERTEX-LOCATION-SECRET, count=2}",
            "VERTEX-LOCATION-SECRET",
            "count=2",
        ),
        (
            "{project_id=SERVICE-PROJECT-SECRET, status=ready}",
            "SERVICE-PROJECT-SECRET",
            "status=ready",
        ),
        (
            "{auth_provider_x509_cert_url=https://auth-cert-secret, count=3}",
            "https://auth-cert-secret",
            "count=3",
        ),
        (
            "{base64=BASE64-IMAGE-SECRET, mime_type=image/png}",
            "BASE64-IMAGE-SECRET",
            "mime_type=image/png",
        ),
        (
            "{b64_json: B64-JSON-IMAGE-SECRET, mimeType: image/jpeg}",
            "B64-JSON-IMAGE-SECRET",
            "mimeType: image/jpeg",
        ),
    ],
)
def test_new_sensitive_labels_cannot_bypass_serialized_string_redaction(
    message,
    secret,
    safe_metadata,
):
    entry = AppLogService().emit(
        level="info",
        source="image",
        message=message,
    )

    assert secret not in entry["message"]
    assert "[REDACTED]" in entry["message"]
    assert safe_metadata in entry["message"]


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


def test_structured_provider_diagnostic_redacts_embedded_credentials():
    entry = AppLogService().emit(
        level="error",
        source="ai",
        message={
            "summary": "AI 提供商请求频率受限",
            "diagnostic": {
                "category": "rate_limit",
                "http_status": 429,
                "provider_code": "RATE_LIMITED",
                "request_id": "request-429",
                "exception_type": "HTTPStatusError",
                "upstream_message": (
                    "Authorization: Bearer message-secret"
                ),
                "response_body": {
                    "api_key": "body-api-secret",
                    "nested": {
                        "authorization": "Bearer body-auth-secret"
                    },
                    "error": {"code": "RATE_LIMITED"},
                },
            },
            "attempt": 2,
            "max_attempts": 2,
        },
    )

    rendered = str(entry)
    for secret in (
        "message-secret",
        "body-api-secret",
        "body-auth-secret",
    ):
        assert secret not in rendered
    diagnostic = entry["message"]["diagnostic"]
    assert diagnostic["http_status"] == 429
    assert diagnostic["provider_code"] == "RATE_LIMITED"
    assert diagnostic["request_id"] == "request-429"
    assert diagnostic["response_body"]["error"] == {"code": "RATE_LIMITED"}


@pytest.mark.asyncio
async def test_pydantic_loc_context_redacts_input_from_all_log_copies():
    logs = AppLogService(session_id="boot-a")
    queue = logs.subscribe()
    diagnostic = {
        "errors": [
            {
                "type": "missing",
                "loc": ["body", "prompt"],
                "msg": "Field required",
                "input": "PROMPT-SECRET",
            },
            {
                "type": "image_type",
                "loc": ["body", "input_images", 0],
                "msg": "Invalid image",
                "input": "IMAGE-SECRET",
            },
            {
                "type": "string_type",
                "loc": ["body", "title"],
                "msg": "Input should be a string",
                "input": "safe-title",
            },
        ]
    }

    sanitized = AppLogService.sanitize(diagnostic)
    returned = logs.emit(
        level="error",
        source="ai",
        message={"summary": "validation failed", "diagnostic": diagnostic},
    )
    delivered = await asyncio.wait_for(queue.get(), 0.1)
    recent = logs.recent()[0]

    for value in (
        sanitized,
        returned["message"]["diagnostic"],
        delivered["message"]["diagnostic"],
        recent["message"]["diagnostic"],
    ):
        rendered = str(value)
        assert "PROMPT-SECRET" not in rendered
        assert "IMAGE-SECRET" not in rendered
        assert value["errors"][0]["input"] == "[REDACTED]"
        assert value["errors"][1]["input"] == "[REDACTED]"
        assert value["errors"][2]["input"] == "safe-title"
        assert value["errors"][0]["loc"] == ["body", "prompt"]


def test_structured_diagnostic_has_shared_size_and_item_budgets():
    diagnostic = {
        "response_body": {
            f"group-{group}": {
                f"leaf-{leaf}": "safe-value-" + ("x" * 1000)
                for leaf in range(150)
            }
            for group in range(150)
        }
    }

    sanitized = AppLogService.sanitize(diagnostic)
    rendered = json.dumps(sanitized, ensure_ascii=False)
    many_items = AppLogService.sanitize({
        "response_body": {
            f"group-{group}": {
                f"leaf-{leaf}": "v"
                for leaf in range(150)
            }
            for group in range(150)
        }
    })

    def structured_slots(value):
        if isinstance(value, dict):
            return len(value) + sum(
                structured_slots(item) for item in value.values()
            )
        if isinstance(value, (list, tuple)):
            return len(value) + sum(
                structured_slots(item) for item in value
            )
        return 0

    assert len(rendered) <= 20_000
    assert structured_slots(sanitized) <= 100
    assert structured_slots(many_items) <= 100
    assert "[TRUNCATED]" in rendered
    assert "[TRUNCATED]" in str(many_items)


@pytest.mark.parametrize(
    ("message", "credential_paths", "safe_text"),
    [
        (
            "FileNotFoundError: /private/key.json status=retryable",
            ("/private/key.json",),
            "FileNotFoundError",
        ),
        (
            "[Errno 2] No such file or directory: '/private/key.json'",
            ("/private/key.json",),
            "[Errno 2]",
        ),
        (
            r"FileNotFoundError: D:\keys\service.json status=retryable",
            (r"D:\keys\service.json",),
            "FileNotFoundError",
        ),
        (
            (
                "credential files missing: /srv/service-account.json "
                "/srv/signing.pem /srv/signing.key "
                "/srv/signing.p12 /srv/signing.pfx status=retryable"
            ),
            (
                "/srv/service-account.json",
                "/srv/signing.pem",
                "/srv/signing.key",
                "/srv/signing.p12",
                "/srv/signing.pfx",
            ),
            "credential files",
        ),
    ],
)
def test_public_sanitize_redacts_unlabeled_credential_paths(
    message,
    credential_paths,
    safe_text,
):
    sanitized = AppLogService.sanitize(message)

    for path in credential_paths:
        assert path not in sanitized
    assert safe_text in sanitized


def test_public_sanitize_preserves_safe_paths_urls_and_redacts_prompt():
    message = (
        "invalid prompt: customer text\n"
        "artifact=/tmp/customer-data.json status=retryable "
        "docs=https://provider.example/status/key.json"
    )

    sanitized = AppLogService.sanitize(message)

    assert "customer text" not in sanitized
    assert "invalid prompt: [REDACTED]" in sanitized
    assert "/tmp/customer-data.json" in sanitized
    assert "status=retryable" in sanitized
    assert "https://provider.example/status/key.json" in sanitized


def test_public_sanitize_redacts_quoted_spaced_and_file_uri_credential_paths():
    credential_paths = (
        "/Users/alice/Google Credentials/service account.json",
        r"C:\Users\Alice\Secret Keys\service account.json",
        "file:///private/key.json",
    )
    message = (
        f'credentials missing: "{credential_paths[0]}" '
        f"windows='{credential_paths[1]}' "
        f"uri={credential_paths[2]} "
        "safe=/tmp/customer-data.json "
        "docs=https://provider.example/status/key.json "
        "status=retryable"
    )

    sanitized = AppLogService.sanitize(message)

    for path in credential_paths:
        assert path not in sanitized
    assert "safe=/tmp/customer-data.json" in sanitized
    assert "https://provider.example/status/key.json" in sanitized
    assert "status=retryable" in sanitized


@pytest.mark.asyncio
async def test_unlabeled_credential_paths_are_redacted_from_all_log_copies():
    logs = AppLogService()
    queue = logs.subscribe()
    message = (
        "FileNotFoundError: /private/key.json "
        r"[Errno 2] D:\keys\service.json "
        "status=retryable"
    )

    returned = logs.emit(level="error", source="ai", message=message)
    delivered = await asyncio.wait_for(queue.get(), 0.1)
    recent = logs.recent()[0]

    for entry in (returned, delivered, recent):
        rendered = str(entry)
        assert "/private/key.json" not in rendered
        assert r"D:\keys\service.json" not in rendered
        assert "FileNotFoundError" in rendered
        assert "status=retryable" in rendered


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
