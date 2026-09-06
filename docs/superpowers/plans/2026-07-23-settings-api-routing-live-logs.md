# Settings API Routing and Live Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings page that persistently routes text and image AI capabilities to Gemini, Vertex AI, or OpenAI-compatible lines and displays redacted real-time application logs.

**Architecture:** Store provider lines and capability bindings in the existing SQLite database. Resolve a configuration snapshot through `AIRouter` for every request, dispatch through a protocol adapter, and publish structured logs through an in-memory `AppLogService` and SSE. Keep prompts, parsing, and third-party calls on the backend.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy, SQLite, google-genai, httpx, Server-Sent Events, vanilla JavaScript, existing CSS/Tailwind.

## Global Constraints

- Capabilities are exactly `text` and `image`.
- Protocols are exactly `gemini`, `vertex`, and `openai_compatible`.
- A saved binding affects the next request without restarting FastAPI.
- Existing in-flight requests keep their starting configuration snapshot.
- Do not automatically fail over to another provider.
- API keys, Authorization headers, Vertex credential contents, image Base64, complete prompts, and complete provider responses must never enter logs or read APIs.
- Provider secrets remain backend-only and persist only in ignored local SQLite state.
- OpenAI-compatible text calls use `POST /v1/chat/completions`; image generation uses the persisted provider mode: `POST /v1/images/generations` for text-to-image or multipart `POST /v1/images/edits` for image-to-image.
- The log buffer holds exactly the latest 200 entries and is not persisted.
- Preserve existing business prompts, result formats, scores, and history behavior.
- Preserve unrelated dirty-worktree changes and never stage `.env`, databases, generated images, `.superpowers/`, or local tool state.

---

## File Structure

**Create**

- `backend/models/settings.py` — Pydantic request/response schemas for providers, bindings, and connection tests.
- `backend/services/ai_config_service.py` — provider CRUD, binding rules, masking, snapshots, and first-run `.env` import.
- `backend/services/ai_adapters.py` — Gemini, Vertex, and OpenAI-compatible protocol adapters.
- `backend/services/ai_router.py` — capability resolution, retry orchestration, normalized responses, and AI logs.
- `backend/services/app_log_service.py` — 200-entry redacted log buffer and subscriber queues.
- `backend/tests/test_ai_config_service.py` — persistence, migration, binding, and masking tests.
- `backend/tests/test_ai_adapters.py` — protocol conversion tests.
- `backend/tests/test_ai_router.py` — runtime switching, snapshots, retries, and no-failover tests.
- `backend/tests/test_app_log_service.py` — redaction, capacity, and publish/subscribe tests.
- `backend/tests/test_settings_api.py` — settings CRUD, connection test, recent logs, and SSE API tests.
- `frontend/js/settings.js` — settings page state, CRUD, bindings, connection tests, and SSE client.
- `frontend/css/settings.css` — settings two-column operations layout and responsive behavior.
- `frontend/tests/settings.test.js` — DOM-free tests for exported settings helpers.

**Modify**

- `.gitignore` — ignore `.superpowers/`.
- `backend/db.py` — add provider and capability binding tables and safe SQLite migration.
- `backend/main.py` — register settings/log endpoints and initialize default provider state.
- `backend/models/request.py` — remove provider overrides from business requests after routing migration.
- `backend/services/ai_service.py` — retain compatibility facade while delegating to `AIRouter`.
- `backend/services/ai_single.py` — request the text capability without caller-selected provider.
- `backend/services/ai_compare.py` — request the text capability without caller-selected provider.
- `backend/services/scoring.py` — request the text capability without caller-selected provider.
- `backend/services/listing_service.py` — select text or image capability explicitly.
- `backend/services/ads_service.py` — select text or image capability explicitly.
- `backend/services/square_redraw_service.py` — route through image capability.
- `frontend/index.html` — add settings navigation, view markup, stylesheet, and script.
- `frontend/js/app.js` — initialize settings and expose current public routing metadata.
- `frontend/js/ads.js` — stop sending `ai_provider`.
- `frontend/js/listing.js` — stop sending `ai_provider`.
- `frontend/js/text_translate.js` — stop sending `ai_provider`.
- `frontend/js/utils.js` — send structured frontend log data.
- `backend/tests/test_main.py` and existing service tests — update compatibility assertions and regression coverage.
- `README.md` and `backend/.env.example` — document first-run import and settings workflow.

---

### Task 1: Persist Provider Lines and Capability Bindings

**Files:**
- Modify: `backend/db.py`
- Create: `backend/services/ai_config_service.py`
- Create: `backend/tests/test_ai_config_service.py`

**Interfaces:**
- Produces: `AIProviderConfig`, `AICapabilityBinding`.
- Produces: `ProviderSnapshot`, `list_providers(db)`, `create_provider(db, data)`, `update_provider(db, id, data)`, `delete_provider(db, id)`, `set_provider_enabled(db, id, enabled)`, `get_bindings(db)`, `set_binding(db, capability, provider_id)`, `get_snapshot(db, capability)`, `import_env_defaults_if_empty(db)`.

- [ ] **Step 1: Write failing database and service tests**

```python
# backend/tests/test_ai_config_service.py
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from db import Base
from services.ai_config_service import (
    create_provider, delete_provider, get_snapshot, mask_secret,
    set_binding, set_provider_enabled,
)

def make_db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()

def provider_data(**overrides):
    data = dict(
        name="Relay A", protocol="openai_compatible",
        base_url="https://relay.example.com", api_key="sk-secret-1234",
        text_model="text-model", image_model="image-model",
        supports_text=True, supports_image=True,
        timeout_seconds=60, max_retries=2, enabled=True,
    )
    data.update(overrides)
    return data

def test_snapshot_is_immutable_and_secret_is_masked():
    db = make_db()
    row = create_provider(db, provider_data())
    set_binding(db, "text", row.id)
    snapshot = get_snapshot(db, "text")
    assert snapshot.api_key == "sk-secret-1234"
    assert snapshot.capability == "text"
    assert mask_secret(snapshot.api_key) == "sk-****1234"

def test_bound_provider_cannot_be_disabled_or_deleted():
    db = make_db()
    row = create_provider(db, provider_data())
    set_binding(db, "image", row.id)
    for action in (
        lambda: set_provider_enabled(db, row.id, False),
        lambda: delete_provider(db, row.id),
    ):
        try:
            action()
            assert False, "expected ProviderInUseError"
        except ValueError as exc:
            assert "正在使用" in str(exc)
```

- [ ] **Step 2: Run tests and verify the missing module failure**

Run: `./.venv/bin/python -m pytest backend/tests/test_ai_config_service.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'services.ai_config_service'`.

- [ ] **Step 3: Add SQLAlchemy tables**

```python
# backend/db.py
class AIProviderConfig(Base):
    __tablename__ = "ai_provider_configs"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False, unique=True)
    protocol = Column(String(32), nullable=False)
    base_url = Column(Text, nullable=True)
    api_key = Column(Text, nullable=True)
    vertex_project_id = Column(Text, nullable=True)
    vertex_location = Column(String(80), nullable=True)
    vertex_key_path = Column(Text, nullable=True)
    text_model = Column(Text, nullable=True)
    image_model = Column(Text, nullable=True)
    supports_text = Column(Integer, nullable=False, default=1)
    supports_image = Column(Integer, nullable=False, default=0)
    timeout_seconds = Column(Integer, nullable=False, default=60)
    max_retries = Column(Integer, nullable=False, default=2)
    enabled = Column(Integer, nullable=False, default=1)
    last_test_status = Column(String(30), nullable=True)
    last_test_message = Column(Text, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)
    config_version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)

class AICapabilityBinding(Base):
    __tablename__ = "ai_capability_bindings"
    capability = Column(String(16), primary_key=True)
    provider_config_id = Column(
        Integer, ForeignKey("ai_provider_configs.id"), nullable=False
    )
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)
```

Call `migrate_ai_settings_tables()` from `init_db()`. The migration creates missing tables through `Base.metadata.create_all()`; existing columns are not destructively rewritten.

- [ ] **Step 4: Implement the configuration service**

```python
# backend/services/ai_config_service.py
from dataclasses import dataclass
from urllib.parse import urlparse
from db import AIProviderConfig, AICapabilityBinding

CAPABILITIES = {"text", "image"}
PROTOCOLS = {"gemini", "vertex", "openai_compatible"}

@dataclass(frozen=True)
class ProviderSnapshot:
    id: int
    capability: str
    name: str
    protocol: str
    base_url: str | None
    api_key: str | None
    vertex_project_id: str | None
    vertex_location: str | None
    vertex_key_path: str | None
    model: str
    timeout_seconds: int
    max_retries: int
    config_version: int

def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    prefix = value[:3] if len(value) > 7 else ""
    return f"{prefix}****{value[-4:]}"

def validate_base_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Base URL 必须是 http/https 地址")
    if parsed.username or parsed.password:
        raise ValueError("Base URL 不能包含用户名或密码")
    return value.rstrip("/")
```

Implement CRUD with `db.commit()`/`db.rollback()`. `get_snapshot()` validates enabled state, capability support, and non-empty capability model before returning the frozen dataclass. `update_provider()` increments `config_version`.

- [ ] **Step 5: Add first-run `.env` import tests and implementation**

```python
def test_import_env_only_when_provider_table_is_empty(monkeypatch):
    db = make_db()
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "key")
    monkeypatch.setenv("FRONTEND_TEXT_MODEL", "text-1")
    monkeypatch.setenv("FRONTEND_IMAGE_MODEL", "image-1")
    assert import_env_defaults_if_empty(db) is True
    assert import_env_defaults_if_empty(db) is False
    assert get_snapshot(db, "text").model == "text-1"
    assert get_snapshot(db, "image").model == "image-1"
```

The importer creates one enabled Gemini or Vertex line and both compatible bindings. It returns `True` only when an import occurred.

- [ ] **Step 6: Run tests**

Run: `./.venv/bin/python -m pytest backend/tests/test_ai_config_service.py -v`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/db.py backend/services/ai_config_service.py backend/tests/test_ai_config_service.py
git commit -m "feat: persist AI provider settings"
```

---

### Task 2: Add Structured Redacted Application Logs

**Files:**
- Create: `backend/services/app_log_service.py`
- Create: `backend/tests/test_app_log_service.py`
- Modify: `frontend/js/utils.js`

**Interfaces:**
- Produces: `AppLogEntry`, `AppLogService.emit(...)`, `recent()`, `subscribe()`, `unsubscribe(queue)`.

- [ ] **Step 1: Write failing redaction and subscription tests**

```python
# backend/tests/test_app_log_service.py
import asyncio
from services.app_log_service import AppLogService

def test_log_buffer_is_bounded_and_redacted():
    logs = AppLogService(capacity=200)
    for index in range(205):
        logs.emit(
            level="info", source="ai",
            message=f"Authorization: Bearer secret-{index} data:image/png;base64,AAAA",
        )
    recent = logs.recent()
    assert len(recent) == 200
    assert recent[0]["message"].endswith("[REDACTED]")
    assert "secret-" not in str(recent)
    assert "AAAA" not in str(recent)

async def test_subscriber_receives_new_entry():
    logs = AppLogService()
    queue = logs.subscribe()
    logs.emit(level="success", source="system", message="ready")
    assert (await asyncio.wait_for(queue.get(), .1))["message"] == "ready"
    logs.unsubscribe(queue)
```

- [ ] **Step 2: Verify failure**

Run: `./.venv/bin/python -m pytest backend/tests/test_app_log_service.py -v`

Expected: FAIL because `app_log_service` does not exist.

- [ ] **Step 3: Implement the bounded event service**

```python
# backend/services/app_log_service.py
import asyncio, datetime, re
from collections import deque

class AppLogService:
    def __init__(self, capacity: int = 200):
        self._entries = deque(maxlen=capacity)
        self._subscribers: set[asyncio.Queue] = set()

    @staticmethod
    def _redact(value: str) -> str:
        value = re.sub(r"(?i)authorization\\s*:\\s*bearer\\s+\\S+", "Authorization: [REDACTED]", value)
        value = re.sub(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", "[IMAGE REDACTED]", value)
        value = re.sub(r"(?i)(api[_ -]?key[\"'=:\\s]+)\\S+", r"\\1[REDACTED]", value)
        return value[:1000]

    def emit(self, *, level: str, source: str, message: str,
             capability: str | None = None, provider: str | None = None,
             model: str | None = None, duration_ms: int | None = None,
             retry: int | None = None) -> dict:
        entry = {
            "timestamp": datetime.datetime.now(datetime.UTC).isoformat(),
            "level": level, "source": source,
            "message": self._redact(str(message)),
            "capability": capability, "provider": provider, "model": model,
            "duration_ms": duration_ms, "retry": retry,
        }
        self._entries.append(entry)
        for queue in tuple(self._subscribers):
            queue.put_nowait(entry)
        return entry

    def recent(self) -> list[dict]:
        return list(self._entries)

    def subscribe(self) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=200)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

app_logs = AppLogService()
```

- [ ] **Step 4: Make frontend logs structured**

```javascript
// frontend/js/utils.js
async function remoteLog(message, fields = {}) {
    fetch(`${API_BASE}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            level: fields.level || "info",
            source: fields.source || "frontend",
            capability: fields.capability || null,
            message: String(message).replace(/%c/g, "")
        })
    }).catch(() => {});
}
```

- [ ] **Step 5: Run tests and syntax check**

Run: `./.venv/bin/python -m pytest backend/tests/test_app_log_service.py -v && node --check frontend/js/utils.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/services/app_log_service.py backend/tests/test_app_log_service.py frontend/js/utils.js
git commit -m "feat: add redacted application log stream"
```

---

### Task 3: Implement Gemini, Vertex, and OpenAI-Compatible Adapters

**Files:**
- Create: `backend/services/ai_adapters.py`
- Create: `backend/tests/test_ai_adapters.py`
- Modify: `backend/services/ai_service.py`

**Interfaces:**
- Consumes: `ProviderSnapshot`.
- Produces: `AIAdapter.generate(snapshot, payload) -> dict`.
- Produces: `get_adapter(protocol) -> AIAdapter`.

- [ ] **Step 1: Write failing adapter tests**

```python
# backend/tests/test_ai_adapters.py
from unittest.mock import AsyncMock
import pytest
from services.ai_adapters import OpenAICompatibleAdapter

@pytest.mark.asyncio
async def test_openai_text_path_and_normalized_response():
    transport = AsyncMock()
    transport.post.return_value.status_code = 200
    transport.post.return_value.json.return_value = {
        "choices": [{"message": {"content": "hello"}}]
    }
    adapter = OpenAICompatibleAdapter(client=transport)
    result = await adapter.generate(
        snapshot=make_snapshot(capability="text"),
        payload={"contents": [{"role": "user", "parts": [{"text": "Hi"}]}]},
    )
    assert transport.post.await_args.args[0].endswith("/v1/chat/completions")
    assert result["candidates"][0]["content"]["parts"][0]["text"] == "hello"

@pytest.mark.asyncio
async def test_openai_image_path_and_normalized_response():
    transport = AsyncMock()
    transport.post.return_value.status_code = 200
    transport.post.return_value.json.return_value = {
        "data": [{"b64_json": "AAAA"}]
    }
    adapter = OpenAICompatibleAdapter(client=transport)
    result = await adapter.generate(
        snapshot=make_snapshot(capability="image"),
        payload={"contents": [{"parts": [{"text": "Draw a mug"}]}]},
    )
    assert transport.post.await_args.args[0].endswith("/v1/images/generations")
    assert result["candidates"][0]["content"]["parts"][0]["inlineData"]["data"] == "AAAA"
```

Define `make_snapshot()` in the test with all `ProviderSnapshot` fields.

- [ ] **Step 2: Verify failure**

Run: `./.venv/bin/python -m pytest backend/tests/test_ai_adapters.py -v`

Expected: FAIL because adapters do not exist.

- [ ] **Step 3: Extract Google SDK conversion into an adapter**

Move `_convert_contents`, `_convert_generation_config`, and `_response_to_dict` from `AIService` into a shared Google adapter base. Implement:

```python
class GeminiAdapter:
    async def generate(self, snapshot: ProviderSnapshot, payload: dict) -> dict:
        client = self._client(snapshot)
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=snapshot.model,
            contents=convert_google_contents(payload.get("contents", [])),
            config=convert_google_config(payload.get("generationConfig", {})),
        )
        return google_response_to_dict(response)

class VertexAdapter(GeminiAdapter):
    def _client(self, snapshot):
        if snapshot.vertex_key_path:
            os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", snapshot.vertex_key_path)
        return genai.Client(
            vertexai=True,
            project=snapshot.vertex_project_id,
            location=snapshot.vertex_location,
        )
```

Cache clients by `(snapshot.id, snapshot.config_version)`.

- [ ] **Step 4: Implement OpenAI-compatible conversion**

```python
class OpenAICompatibleAdapter:
    def __init__(self, client=None):
        self.client = client or httpx.AsyncClient()

    async def generate(self, snapshot, payload):
        headers = {"Authorization": f"Bearer {snapshot.api_key}"}
        if snapshot.capability == "image":
            body = {
                "model": snapshot.model,
                "prompt": extract_text_prompt(payload),
                "response_format": "b64_json",
            }
            response = await self.client.post(
                f"{snapshot.base_url}/v1/images/generations",
                headers=headers, json=body, timeout=snapshot.timeout_seconds,
            )
            response.raise_for_status()
            item = response.json()["data"][0]
            return normalized_image_response(item["b64_json"], "image/png")
        body = {
            "model": snapshot.model,
            "messages": convert_openai_messages(payload.get("contents", [])),
        }
        response = await self.client.post(
            f"{snapshot.base_url}/v1/chat/completions",
            headers=headers, json=body, timeout=snapshot.timeout_seconds,
        )
        response.raise_for_status()
        return normalized_text_response(response.json()["choices"][0]["message"]["content"])
```

`convert_openai_messages()` turns inline images into OpenAI `image_url` data URLs and keeps textual parts. Never log the generated body.

- [ ] **Step 5: Keep `AIService` as a compatibility facade**

Remove provider-client construction from `AIService`. Keep `call_ai()` and `generate_content()` signatures working against the extracted Google adapter during this commit; Task 4 replaces their bodies with `AIRouter` delegation. Retain response parsing helpers used by current business services until Task 6 migrates their callers.

- [ ] **Step 6: Run adapter and legacy service tests**

Run: `./.venv/bin/python -m pytest backend/tests/test_ai_adapters.py backend/tests/test_ai_service.py -v`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/services/ai_adapters.py backend/services/ai_service.py backend/tests/test_ai_adapters.py backend/tests/test_ai_service.py
git commit -m "feat: add configurable AI protocol adapters"
```

---

### Task 4: Route Every AI Request by Capability

**Files:**
- Create: `backend/services/ai_router.py`
- Create: `backend/tests/test_ai_router.py`
- Modify: `backend/services/ai_service.py`

**Interfaces:**
- Consumes: `get_snapshot(db, capability)`, `get_adapter(protocol)`, `app_logs`.
- Produces: `AIRouter.generate(capability, payload, db=None) -> dict`.
- Produces: `AIService.call_ai(prompt, capability="text", ...)`.
- Produces: `AIService.generate_content(payload, capability, ...)`.

- [ ] **Step 1: Write failing runtime switch and retry tests**

```python
# backend/tests/test_ai_router.py
from unittest.mock import AsyncMock
import pytest
from services.ai_router import AIRouter

@pytest.mark.asyncio
async def test_next_request_uses_new_binding(monkeypatch):
    snapshots = [snapshot(id=1), snapshot(id=2)]
    monkeypatch.setattr("services.ai_router.get_snapshot", lambda db, cap: snapshots.pop(0))
    adapter = AsyncMock()
    adapter.generate.return_value = {"candidates": []}
    monkeypatch.setattr("services.ai_router.get_adapter", lambda protocol: adapter)
    router = AIRouter()
    await router.generate("text", {"contents": []}, db=object())
    await router.generate("text", {"contents": []}, db=object())
    assert [call.args[0].id for call in adapter.generate.await_args_list] == [1, 2]

@pytest.mark.asyncio
async def test_retry_does_not_change_provider(monkeypatch):
    selected = snapshot(id=9, max_retries=2)
    monkeypatch.setattr("services.ai_router.get_snapshot", lambda db, cap: selected)
    adapter = AsyncMock()
    adapter.generate.side_effect = [RuntimeError("rate limit"), {"candidates": []}]
    monkeypatch.setattr("services.ai_router.get_adapter", lambda protocol: adapter)
    await AIRouter(base_delay=0).generate("text", {}, db=object())
    assert adapter.generate.await_count == 2
    assert all(call.args[0].id == 9 for call in adapter.generate.await_args_list)
```

- [ ] **Step 2: Verify failure**

Run: `./.venv/bin/python -m pytest backend/tests/test_ai_router.py -v`

Expected: FAIL because `AIRouter` does not exist.

- [ ] **Step 3: Implement snapshot-based routing**

```python
# backend/services/ai_router.py
class AIRouter:
    def __init__(self, base_delay: float = 2):
        self.base_delay = base_delay

    async def generate(self, capability: str, payload: dict, db=None) -> dict:
        owns_db = db is None
        db = db or SessionLocal()
        try:
            snapshot = get_snapshot(db, capability)
        finally:
            if owns_db:
                db.close()
        adapter = get_adapter(snapshot.protocol)
        started = time.monotonic()
        for attempt in range(snapshot.max_retries + 1):
            try:
                result = await adapter.generate(snapshot, payload)
                app_logs.emit(
                    level="success", source="ai", message="AI 请求完成",
                    capability=capability, provider=snapshot.name,
                    model=snapshot.model,
                    duration_ms=round((time.monotonic() - started) * 1000),
                    retry=attempt,
                )
                return result
            except Exception as exc:
                if attempt >= snapshot.max_retries:
                    app_logs.emit(
                        level="error", source="ai",
                        message=map_provider_error(exc),
                        capability=capability, provider=snapshot.name,
                        model=snapshot.model, retry=attempt,
                    )
                    raise
                app_logs.emit(
                    level="warning", source="ai", message="AI 请求重试",
                    capability=capability, provider=snapshot.name,
                    model=snapshot.model, retry=attempt + 1,
                )
                await asyncio.sleep(self.base_delay * (2 ** attempt))
```

- [ ] **Step 4: Delegate the compatibility facade**

```python
# backend/services/ai_service.py
class AIService:
    @classmethod
    async def call_ai(cls, prompt, capability="text", response_mime_type="application/json"):
        response = await ai_router.generate(capability, {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": response_mime_type},
        })
        return first_text_from_normalized_response(response)

    @classmethod
    async def generate_content(cls, payload, capability):
        return await ai_router.generate(capability, payload)
```

Remove caller-controlled provider and model selection from the facade.

- [ ] **Step 5: Run routing and AI service tests**

Run: `./.venv/bin/python -m pytest backend/tests/test_ai_router.py backend/tests/test_ai_service.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/services/ai_router.py backend/services/ai_service.py backend/tests/test_ai_router.py backend/tests/test_ai_service.py
git commit -m "feat: route AI requests by capability"
```

---

### Task 5: Expose Settings, Connection Test, Recent Logs, and SSE APIs

**Files:**
- Create: `backend/models/settings.py`
- Modify: `backend/main.py`
- Create: `backend/tests/test_settings_api.py`

**Interfaces:**
- Consumes: all Task 1–4 services.
- Produces: `/api/settings/ai/*` and `/api/settings/logs/*`.

- [ ] **Step 1: Write failing API contract tests**

```python
# backend/tests/test_settings_api.py
def test_provider_read_never_returns_secret(client):
    created = client.post("/api/settings/ai/providers", json={
        "name": "Relay", "protocol": "openai_compatible",
        "base_url": "https://relay.example.com", "api_key": "sk-secret-1234",
        "text_model": "text", "supports_text": True,
        "supports_image": False, "timeout_seconds": 30,
        "max_retries": 1, "enabled": True,
    })
    assert created.status_code == 201
    item = created.json()
    assert "sk-secret-1234" not in str(item)
    assert item["has_api_key"] is True
    assert item["api_key_masked"] == "sk-****1234"

def test_bound_provider_delete_returns_conflict(client, bound_provider_id):
    response = client.delete(f"/api/settings/ai/providers/{bound_provider_id}")
    assert response.status_code == 409

def test_recent_logs_returns_list(client):
    assert client.get("/api/settings/logs/recent").json()["items"] == []
```

- [ ] **Step 2: Verify 404 failures**

Run: `./.venv/bin/python -m pytest backend/tests/test_settings_api.py -v`

Expected: FAIL with endpoint 404 responses.

- [ ] **Step 3: Define strict Pydantic schemas**

```python
# backend/models/settings.py
class AIProviderWrite(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    protocol: Literal["gemini", "vertex", "openai_compatible"]
    base_url: str | None = None
    api_key: str | None = None
    vertex_project_id: str | None = None
    vertex_location: str | None = None
    vertex_key_path: str | None = None
    text_model: str | None = None
    image_model: str | None = None
    supports_text: bool = True
    supports_image: bool = False
    timeout_seconds: int = Field(default=60, ge=1, le=600)
    max_retries: int = Field(default=2, ge=0, le=10)
    enabled: bool = True

class CapabilityBindingWrite(BaseModel):
    provider_config_id: int

class ProviderConnectionTest(BaseModel):
    provider_id: int | None = None
    draft: AIProviderWrite | None = None
    capability: Literal["text", "image"]
```

Add a model validator requiring exactly one of `provider_id` or `draft`.

- [ ] **Step 4: Add CRUD and binding endpoints**

Use `Depends(get_db)`, response models, and HTTP codes:

```python
@app.get("/api/settings/ai/providers")
def api_list_ai_providers(db: Session = Depends(get_db)):
    return {"items": [serialize_provider(row) for row in list_providers(db)]}

@app.put("/api/settings/ai/bindings/{capability}")
def api_set_ai_binding(capability: str, data: CapabilityBindingWrite,
                       db: Session = Depends(get_db)):
    try:
        return serialize_binding(set_binding(db, capability, data.provider_config_id))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
```

Implement these concrete endpoints with the same service functions:

```python
POST   /api/settings/ai/providers
PUT    /api/settings/ai/providers/{provider_id}
DELETE /api/settings/ai/providers/{provider_id}
POST   /api/settings/ai/providers/{provider_id}/enable
POST   /api/settings/ai/providers/{provider_id}/disable
GET    /api/settings/ai/bindings
PUT    /api/settings/ai/bindings/{capability}
```

Return 201 from create, 404 for a missing provider, 409 for an in-use delete/disable or incompatible binding, and Pydantic 422 for invalid field combinations.

- [ ] **Step 5: Add connection testing**

`POST /api/settings/ai/providers/test` accepts either a saved provider ID or a draft plus capability. Build a temporary snapshot, call its adapter with a minimal prompt (`Reply with OK`) or a 1×1 image prompt, measure duration, update saved providers' last-test fields, and return:

```json
{"status":"success","capability":"text","duration_ms":182,"message":"连接成功"}
```

Map authentication, missing model, rate limit, timeout, and unsupported image endpoint failures to stable Chinese messages.

- [ ] **Step 6: Add recent and SSE log endpoints**

```python
@app.get("/api/settings/logs/recent")
def api_recent_logs():
    return {"items": app_logs.recent()}

@app.get("/api/settings/logs/stream")
async def api_stream_logs(request: Request):
    queue = app_logs.subscribe()
    async def events():
        try:
            while not await request.is_disconnected():
                try:
                    entry = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {json.dumps(entry, ensure_ascii=False)}\\n\\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\\n\\n"
        finally:
            app_logs.unsubscribe(queue)
    return StreamingResponse(events(), media_type="text/event-stream")
```

Route `POST /log` through `app_logs.emit()` instead of direct `logger.info()`.

- [ ] **Step 7: Initialize default settings**

After `init_db()` in `backend/main.py`, open `SessionLocal`, call `import_env_defaults_if_empty(db)`, and close the session. Do not overwrite existing rows.

- [ ] **Step 8: Run API tests**

Run: `./.venv/bin/python -m pytest backend/tests/test_settings_api.py backend/tests/test_main.py -v`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/main.py backend/models/settings.py backend/tests/test_settings_api.py backend/tests/test_main.py
git commit -m "feat: expose AI settings and live log APIs"
```

---

### Task 6: Migrate Existing Business Services to Capability Routing

**Files:**
- Modify: `backend/models/request.py`
- Modify: `backend/services/ai_single.py`
- Modify: `backend/services/ai_compare.py`
- Modify: `backend/services/scoring.py`
- Modify: `backend/services/listing_service.py`
- Modify: `backend/services/ads_service.py`
- Modify: `backend/services/square_redraw_service.py`
- Modify: `backend/main.py`
- Modify: `backend/tests/test_ai_single.py`
- Modify: `backend/tests/test_ai_compare.py`
- Modify: `backend/tests/test_scoring.py`
- Modify: `backend/tests/test_listing_service.py`
- Modify: `backend/tests/test_ads_service.py`
- Modify: `backend/tests/test_square_redraw_service.py`
- Modify: `backend/tests/test_main.py`

**Interfaces:**
- Consumes: `AIService.call_ai(..., capability="text")`.
- Consumes: `AIService.generate_content(payload=..., capability="image"|"text")`.

- [ ] **Step 1: Update tests to reject caller-selected providers**

Change request tests so `ai_provider` is ignored/rejected and service mocks assert capability:

```python
with patch("services.listing_service.AIService.call_ai",
           new=AsyncMock(return_value='{"title":"x"}')) as mocked:
    await generate_listing(request)
    assert mocked.await_args.kwargs["capability"] == "text"
```

Add these exact capability assertions:

```python
# listing image extraction and ad image analysis return text
assert mocked.await_args.kwargs["capability"] == "text"

# image translation, detail generation, and square redraw return images
assert mocked.await_args.kwargs["capability"] == "image"
```

- [ ] **Step 2: Run focused tests and observe signature failures**

Run: `./.venv/bin/python -m pytest backend/tests/test_ai_single.py backend/tests/test_ai_compare.py backend/tests/test_scoring.py backend/tests/test_listing_service.py backend/tests/test_ads_service.py backend/tests/test_square_redraw_service.py -v`

Expected: FAIL because services still pass `provider`/`model_id`.

- [ ] **Step 3: Migrate text-only calls**

Use:

```python
text = await AIService.call_ai(
    prompt,
    capability="text",
    response_mime_type="application/json",
)
```

Make this replacement in:

- `backend/services/ai_single.py`
- `backend/services/ai_compare.py`
- `backend/services/scoring.py`
- `AIService.translate_text_batch()` in `backend/services/ai_service.py`
- the generation and compliance functions in `backend/services/listing_service.py`
- the copy-generation function in `backend/services/ads_service.py`

- [ ] **Step 4: Migrate image and multimodal calls**

Use:

```python
response = await AIService.generate_content(
    payload=payload,
    capability="image",
)
```

Use `capability="image"` in the backend proxy calls reached by `frontend/js/translate.js` and `frontend/js/details.js`, and in `backend/services/square_redraw_service.py`. Use `capability="text"` in `extract_listing_inputs()` and advertising image analysis because their expected result is JSON text even though the request contains an input image.

- [ ] **Step 5: Remove provider selection from public business models**

Remove `ai_provider` fields from `CompareRequest`, `TranslationRequest`, `ListingGenerateRequest`, `ListingImageExtractRequest`, `ListingComplianceRequest`, and `AdCopyGenerateRequest`. Remove corresponding endpoint forwarding.

- [ ] **Step 6: Make `/api/ai/generate` capability-based**

Require `capability` and `payload`; ignore browser-supplied credentials, Provider, and model:

```python
@app.post("/api/ai/generate")
async def api_ai_generate(data: dict):
    capability = data.get("capability")
    if capability not in {"text", "image"}:
        raise HTTPException(422, "capability 必须是 text 或 image")
    return await AIService.generate_content(
        payload=data.get("payload", {}),
        capability=capability,
    )
```

- [ ] **Step 7: Run service and endpoint tests**

Run: `./.venv/bin/python -m pytest backend/tests -v`

Expected: all backend tests PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/models/request.py backend/main.py backend/services backend/tests
git commit -m "refactor: route business AI calls by capability"
```

---

### Task 7: Build the Settings Operations UI

**Files:**
- Modify: `frontend/index.html`
- Create: `frontend/css/settings.css`
- Create: `frontend/js/settings.js`
- Create: `frontend/tests/settings.test.js`
- Modify: `frontend/js/app.js`

**Interfaces:**
- Consumes: settings provider and binding APIs.
- Produces: `initSettings()`, `loadSettingsData()`, `openProviderEditor(id)`, `saveProvider()`, `testProviderConnection()`, `saveCapabilityBinding(capability)`.

- [ ] **Step 1: Write DOM-free helper tests**

```javascript
// frontend/tests/settings.test.js
const assert = require("node:assert/strict");
const {
  providerSupportsCapability,
  buildProviderPayload,
  maskedKeyPlaceholder
} = require("../js/settings.js");

assert.equal(providerSupportsCapability(
  {enabled:true, supports_text:true}, "text"), true);
assert.equal(providerSupportsCapability(
  {enabled:false, supports_text:true}, "text"), false);
assert.equal(maskedKeyPlaceholder(
  {has_api_key:true, api_key_masked:"sk-****1234"}), "已保存：sk-****1234");
assert.deepEqual(buildProviderPayload({
  name:" Relay ", protocol:"openai_compatible",
  base_url:"https://relay.example.com/", api_key:"",
  supports_text:true, supports_image:false,
  timeout_seconds:"30", max_retries:"2", enabled:true
}), {
  name:"Relay", protocol:"openai_compatible",
  base_url:"https://relay.example.com", api_key:null,
  supports_text:true, supports_image:false,
  timeout_seconds:30, max_retries:2, enabled:true
});
```

- [ ] **Step 2: Verify failure**

Run: `node frontend/tests/settings.test.js`

Expected: FAIL because `frontend/js/settings.js` does not exist.

- [ ] **Step 3: Add navigation and settings markup**

Add a bottom navigation button:

```html
<button id="tab-settings" onclick="switchMainTab('settings')" class="side-tab" title="系统设置">
  <i class="ph ph-gear-six"></i><span>设置</span>
</button>
```

Add `#view-settings` with:

- `#settingsTextProvider` and `#settingsImageProvider` binding selects.
- `#settingsProviderList`.
- `#settingsProviderForm` modal/panel with all protocol fields.
- `#settingsLogPanel` placeholder for Task 8.

Load `css/settings.css` and load `js/settings.js` before `app.js`.

- [ ] **Step 4: Implement provider helpers and data loading**

```javascript
function providerSupportsCapability(provider, capability) {
    return provider.enabled && provider[`supports_${capability}`] === true;
}

async function loadSettingsData() {
    const [providersResponse, bindingsResponse] = await Promise.all([
        fetch(`${API_BASE}/api/settings/ai/providers`),
        fetch(`${API_BASE}/api/settings/ai/bindings`)
    ]);
    settingsState.providers = (await providersResponse.json()).items;
    settingsState.bindings = await bindingsResponse.json();
    renderCapabilityBindings();
    renderProviderList();
}
```

Export pure helpers through `module.exports` only when `typeof module !== "undefined"`.

- [ ] **Step 5: Implement CRUD, connection tests, and binding saves**

All mutations disable the initiating button, retain form state on failure, show `showToast()`, and call `loadSettingsData()` on success. API Key input remains blank on edit and uses the masked value as placeholder only.

When the backend returns 409 for delete/disable, display its `detail` without clearing the current selection.

- [ ] **Step 6: Implement the approved two-column layout**

```css
/* frontend/css/settings.css */
.settings-shell {
  display:grid;
  grid-template-columns:minmax(420px, .9fr) minmax(520px, 1.1fr);
  gap:16px;
  height:100%;
  padding:20px;
}
.settings-config-column,
.settings-log-column { min-height:0; overflow:auto; }
@media (max-width: 1050px) {
  .settings-shell { grid-template-columns:1fr; overflow:auto; }
  .settings-log-column { min-height:520px; }
}
```

Match existing neutral cards, indigo actions, Phosphor icons, and toast behavior.

- [ ] **Step 7: Initialize only when the settings tab opens**

In `switchMainTab()`:

```javascript
if (tabId === "settings" && typeof initSettings === "function") {
    initSettings();
}
```

Make `initSettings()` idempotent.

- [ ] **Step 8: Run helper and syntax checks**

Run: `node frontend/tests/settings.test.js && for file in frontend/js/*.js; do node --check "$file" || exit 1; done`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/index.html frontend/css/settings.css frontend/js/settings.js frontend/js/app.js frontend/tests/settings.test.js
git commit -m "feat: add AI settings operations page"
```

---

### Task 8: Add the Live Log Terminal UI

**Files:**
- Modify: `frontend/js/settings.js`
- Modify: `frontend/css/settings.css`
- Modify: `frontend/index.html`
- Modify: `frontend/tests/settings.test.js`

**Interfaces:**
- Consumes: `/api/settings/logs/recent` and `/api/settings/logs/stream`.
- Produces: `connectSettingsLogs()`, `disconnectSettingsLogs()`, `appendSettingsLog(entry)`, `filterSettingsLogs()`.

- [ ] **Step 1: Add failing log-filter tests**

```javascript
const { logMatchesFilters } = require("../js/settings.js");
const entry = {level:"error", source:"ai", capability:"image"};
assert.equal(logMatchesFilters(entry, {
  level:"error", source:"all", capability:"image"
}), true);
assert.equal(logMatchesFilters(entry, {
  level:"info", source:"all", capability:"image"
}), false);
```

- [ ] **Step 2: Verify failure**

Run: `node frontend/tests/settings.test.js`

Expected: FAIL because `logMatchesFilters` is missing.

- [ ] **Step 3: Add log controls**

Add:

- Connection badge `#settingsLogConnection`.
- Level, source, and capability filters.
- Pause/resume button.
- Auto-scroll checkbox.
- Clear-visible and copy-visible buttons.
- `#settingsLogEntries` with `aria-live="polite"`.

- [ ] **Step 4: Load recent entries and connect SSE**

```javascript
async function connectSettingsLogs() {
    if (settingsState.logSource) return;
    const recent = await fetch(`${API_BASE}/api/settings/logs/recent`).then(r => r.json());
    settingsState.logs = recent.items.slice(-200);
    renderSettingsLogs();
    const source = new EventSource(`${API_BASE}/api/settings/logs/stream`);
    settingsState.logSource = source;
    source.onopen = () => setLogConnection("connected");
    source.onerror = () => setLogConnection("reconnecting");
    source.onmessage = event => appendSettingsLog(JSON.parse(event.data));
}
```

Do not manually create parallel reconnect timers; native `EventSource` performs reconnects.

- [ ] **Step 5: Implement pause, filters, clear, copy, and autoscroll**

Paused events still enter the local 200-entry buffer but do not trigger rerender until resumed. Clear-visible resets only `settingsState.logs`; a page reload retrieves the backend snapshot again. Copy uses the existing clipboard helper pattern and includes only filtered visible lines.

- [ ] **Step 6: Disconnect when leaving settings**

Extend `switchMainTab()`:

```javascript
if (tabId !== "settings" && typeof disconnectSettingsLogs === "function") {
    disconnectSettingsLogs();
}
```

- [ ] **Step 7: Run tests and syntax checks**

Run: `node frontend/tests/settings.test.js && node --check frontend/js/settings.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html frontend/css/settings.css frontend/js/settings.js frontend/tests/settings.test.js frontend/js/app.js
git commit -m "feat: stream live application logs in settings"
```

---

### Task 9: Remove Browser Provider Selection and Publish Current Public Routing

**Files:**
- Modify: `frontend/js/app.js`
- Modify: `frontend/js/ads.js`
- Modify: `frontend/js/listing.js`
- Modify: `frontend/js/text_translate.js`
- Modify: `frontend/js/details.js`
- Modify: `frontend/js/translate.js`
- Modify: `backend/main.py`
- Modify: `backend/tests/test_main.py`

**Interfaces:**
- Produces: `/config` with public `TEXT_ROUTE` and `IMAGE_ROUTE`.
- Consumes: `/api/ai/generate` with `capability`.

- [ ] **Step 1: Update `/config` tests**

```python
def test_config_exposes_public_routes_without_secrets(client):
    data = client.get("/config").json()
    assert data["TEXT_ROUTE"]["capability"] == "text"
    assert data["IMAGE_ROUTE"]["capability"] == "image"
    assert "api_key" not in str(data).lower()
```

- [ ] **Step 2: Verify the test fails**

Run: `./.venv/bin/python -m pytest backend/tests/test_main.py::test_config_exposes_public_routes_without_secrets -v`

Expected: FAIL because the route objects do not exist.

- [ ] **Step 3: Return public routing metadata**

```python
@app.get("/config")
def get_frontend_config(db: Session = Depends(get_db)):
    return {
        "TEXT_ROUTE": serialize_public_snapshot(get_snapshot(db, "text")),
        "IMAGE_ROUTE": serialize_public_snapshot(get_snapshot(db, "image")),
        "CONCURRENCY_LIMIT": FRONTEND_CONCURRENCY_LIMIT,
        "STAGGER_DELAY": FRONTEND_STAGGER_DELAY,
    }
```

`serialize_public_snapshot()` returns only capability, provider name, protocol, and model.

- [ ] **Step 4: Make the frontend call by capability**

```javascript
async function callAI(capability, payload) {
    return fetchWithRetry(`${API_BASE}/api/ai/generate`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({capability, payload})
    });
}
```

Replace `callAI(TEXT_MODEL, payload)` with `callAI("text", payload)` and `callAI(IMAGE_MODEL, payload)` with `callAI("image", payload)`.

- [ ] **Step 5: Stop sending `ai_provider`**

Remove `ai_provider: AI_PROVIDER` from ads, listing, comparison, and translation requests. Display provider/model names from `TEXT_ROUTE` and `IMAGE_ROUTE` only for status messaging.

- [ ] **Step 6: Run backend and frontend checks**

Run: `./.venv/bin/python -m pytest backend/tests/test_main.py -v && for file in frontend/js/*.js; do node --check "$file" || exit 1; done`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py backend/tests/test_main.py frontend/js
git commit -m "refactor: make browser AI calls capability-based"
```

---

### Task 10: Documentation, Hygiene, and Full Regression

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `backend/.env.example`
- Modify: tests only if full regression reveals a real compatibility mismatch.

**Interfaces:**
- Consumes: completed feature.
- Produces: verified user-facing setup documentation.

- [ ] **Step 1: Ignore the visual companion directory**

Add exactly:

```gitignore
# Local brainstorming mockups
.superpowers/
```

Do not alter other current `.gitignore` changes.

- [ ] **Step 2: Document settings-first configuration**

Update README with:

```markdown
### AI 线路设置

首次启动仍从 `backend/.env` 导入 Gemini 或 Vertex 默认配置。之后可在左侧
“设置”页面新增 Gemini、Vertex AI 或 OpenAI Compatible 线路，并分别为
文本 AI 和图片 AI 选择线路。保存后下一次请求立即生效，无需重启。

OpenAI Compatible 的 Base URL 填服务根地址；程序调用
`/v1/chat/completions` 和 `/v1/images/generations`。API Key 仅保存在本地
SQLite，设置读取接口和实时日志不会返回原值。
```

Document the live-log scope and redaction rules.

- [ ] **Step 3: Update the environment example**

Keep current variables as first-run defaults. Add comments stating that they are imported only when no provider rows exist and that settings later take precedence.

- [ ] **Step 4: Run complete verification**

Run:

```bash
./.venv/bin/python -m pytest backend/tests
for file in frontend/js/*.js frontend/tests/*.js; do node --check "$file" || exit 1; done
node frontend/tests/detail_prompt.test.js
node frontend/tests/settings.test.js
./.venv/bin/python -m compileall -q backend run.py
git diff --check
```

Expected:

- All backend tests pass.
- Both frontend test scripts pass.
- All JavaScript syntax checks pass.
- Python compilation succeeds.
- `git diff --check` prints nothing.

- [ ] **Step 5: Perform a local smoke test**

Run `./.venv/bin/python run.py`, then verify:

1. Settings opens from the bottom navigation.
2. Existing `.env` values appear as an imported default line.
3. A draft OpenAI-compatible line can be tested without saving.
4. Text and image bindings can be changed independently.
5. A subsequent request logs the selected capability, line, model, duration, and status.
6. Refresh preserves provider settings and bindings.
7. Leaving and re-entering settings reconnects SSE without duplicate events.
8. Browser network responses and logs contain no unmasked API key.

- [ ] **Step 6: Commit**

```bash
git add .gitignore README.md backend/.env.example
git commit -m "docs: document configurable AI routing"
```

- [ ] **Step 7: Review branch completion**

Use `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`, and finally `superpowers:finishing-a-development-branch`. Do not merge, push, or discard the user's unrelated working-tree changes without explicit authorization.
