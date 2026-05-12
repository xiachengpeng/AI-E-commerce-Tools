# AI Stability Engineering Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI JSON handling, local configuration, and generated-state storage safer and more consistent without changing user-facing workflows.

**Architecture:** Add one backend utility for lenient AI JSON parsing, then migrate existing backend AI consumers to it in small steps. Remove machine-specific defaults from configuration, document required environment variables, and keep generated SQLite/static state out of source control.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy, pytest, vanilla JavaScript frontend, Google Gemini/Vertex through `google-genai`.

---

## File Structure

- Create `backend/services/ai_json.py`: shared JSON extraction, repair, and normalization helpers for model responses.
- Create `backend/tests/test_ai_json.py`: focused unit tests for the shared parser.
- Modify `backend/services/listing_service.py`: remove duplicated JSON parsing helpers and import `parse_ai_json_object`.
- Modify `backend/main.py`: import `normalize_ai_json_object` and `parse_ai_json_object`, then use them for competitor single/deep analysis.
- Modify `backend/services/scoring.py`: replace local JSON extraction/loading with shared parser.
- Modify `backend/services/ai_compare.py`: replace local JSON extraction/loading with shared parser.
- Modify `backend/services/ai_service.py`: use shared parser for text translation batch results.
- Modify `backend/config.py`: remove local absolute Vertex credential default path and validate provider-specific configuration clearly.
- Create `.env.example`: safe documented environment template.
- Modify `.gitignore`: ensure local databases, generated static assets, and local tool state are ignored.

## Scope Boundaries

This plan does not split large frontend files, redesign the history schema, or change API response shapes. Those are valuable follow-up projects, but they should remain separate so this phase stays low-risk and easy to verify.

---

### Task 1: Add Shared AI JSON Parser

**Files:**
- Create: `backend/services/ai_json.py`
- Create: `backend/tests/test_ai_json.py`

- [ ] **Step 1: Write failing parser tests**

Create `backend/tests/test_ai_json.py`:

```python
import pytest

from services.ai_json import (
    extract_first_json_payload,
    normalize_ai_json_object,
    parse_ai_json,
    parse_ai_json_object,
)


def test_extract_first_json_payload_from_markdown_fence():
    text = "Here is the result:\n```json\n{\"name\": \"Lamp\"}\n```\nThanks"

    assert extract_first_json_payload(text) == "{\"name\": \"Lamp\"}"


def test_parse_ai_json_repairs_trailing_commas():
    result = parse_ai_json("{\"name\": \"Lamp\", \"points\": [\"A\",],}")

    assert result == {"name": "Lamp", "points": ["A"]}


def test_parse_ai_json_repairs_raw_newlines_inside_strings():
    result = parse_ai_json("{\"points\": \"卖点1\n卖点2\"}")

    assert result == {"points": "卖点1\n卖点2"}


def test_parse_ai_json_object_accepts_single_item_array():
    result = parse_ai_json_object("[{\"name\": \"Lamp\"}]")

    assert result == {"name": "Lamp"}


def test_parse_ai_json_object_rejects_non_object_array():
    result = parse_ai_json_object("[\"bad\"]")

    assert result == {}


def test_normalize_ai_json_object_accepts_dict():
    assert normalize_ai_json_object({"name": "Lamp"}) == {"name": "Lamp"}


def test_parse_ai_json_empty_text_has_clear_error():
    with pytest.raises(ValueError, match="AI 返回内容为空"):
        parse_ai_json("")
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
python -m pytest backend/tests/test_ai_json.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'services.ai_json'`.

- [ ] **Step 3: Implement shared parser**

Create `backend/services/ai_json.py`:

```python
import json
import re
from typing import Any


def strip_json_fences(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def extract_first_json_payload(text: str) -> str:
    text = strip_json_fences(text)
    if not text:
        return ""

    start = -1
    opening = ""
    closing = ""
    for idx, char in enumerate(text):
        if char in "{[":
            start = idx
            opening = char
            closing = "}" if char == "{" else "]"
            break

    if start == -1:
        return text

    depth = 0
    in_string = False
    escaped = False
    for idx in range(start, len(text)):
        char = text[idx]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return text[start:idx + 1]

    return text[start:]


def escape_control_chars_in_json_strings(text: str) -> str:
    result = []
    in_string = False
    escaped = False
    for char in text:
        if in_string:
            if escaped:
                result.append(char)
                escaped = False
                continue
            if char == "\\":
                result.append(char)
                escaped = True
                continue
            if char == '"':
                result.append(char)
                in_string = False
                continue
            if char == "\n":
                result.append("\\n")
                continue
            if char == "\r":
                result.append("\\r")
                continue
            if char == "\t":
                result.append("\\t")
                continue
            result.append(char)
            continue

        result.append(char)
        if char == '"':
            in_string = True

    return "".join(result)


def remove_trailing_json_commas(text: str) -> str:
    return re.sub(r",\s*([}\]])", r"\1", text)


def parse_lenient_json(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        repaired = remove_trailing_json_commas(escape_control_chars_in_json_strings(text))
        return json.loads(repaired)


def parse_ai_json(text: str) -> Any:
    clean_text = extract_first_json_payload(text)
    if not clean_text:
        raise ValueError("AI 返回内容为空")
    return parse_lenient_json(clean_text)


def normalize_ai_json_object(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return {}


def parse_ai_json_object(text: str) -> dict:
    return normalize_ai_json_object(parse_ai_json(text))
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
python -m pytest backend/tests/test_ai_json.py -v
```

Expected: PASS, 7 tests passed.

- [ ] **Step 5: Commit**

```bash
git add backend/services/ai_json.py backend/tests/test_ai_json.py
git commit -m "test: add shared AI JSON parser"
```

---

### Task 2: Migrate Listing Service to Shared Parser

**Files:**
- Modify: `backend/services/listing_service.py`
- Modify: `backend/tests/test_listing_service.py`

- [ ] **Step 1: Update listing parser import tests**

Modify imports in `backend/tests/test_listing_service.py` so parser tests import from the shared utility:

```python
from services.ai_json import parse_ai_json_object
from services.listing_service import (
    normalize_compliance_result,
    normalize_listing_result,
)
```

Keep existing parser behavior tests in the file unchanged. They should now prove the shared parser preserves Listing behavior.

- [ ] **Step 2: Run listing tests before implementation**

Run:

```bash
python -m pytest backend/tests/test_listing_service.py -v
```

Expected: PASS if Task 1 is complete, because the shared parser already supports the required behavior.

- [ ] **Step 3: Replace duplicated parser code in listing service**

In `backend/services/listing_service.py`, add:

```python
from services.ai_json import parse_ai_json_object
```

Remove these now-duplicated local functions from `backend/services/listing_service.py`:

```python
strip_json_fences
extract_first_json_payload
escape_control_chars_in_json_strings
remove_trailing_json_commas
parse_lenient_json
parse_ai_json_object
```

Keep `normalize_json_object` only if another local function still uses it directly. If it becomes unused after the import, remove it too.

- [ ] **Step 4: Run listing tests**

Run:

```bash
python -m pytest backend/tests/test_listing_service.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/listing_service.py backend/tests/test_listing_service.py
git commit -m "refactor: reuse shared AI JSON parser in listing service"
```

---

### Task 3: Migrate Competitor Analysis Parsing

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/tests/test_main.py`

- [ ] **Step 1: Update tests to import shared normalizer**

In `backend/tests/test_main.py`, remove `normalize_ai_json_object` from the `from main import (...)` block and add:

```python
from services.ai_json import normalize_ai_json_object
```

Keep the existing `test_normalize_ai_json_object_accepts_single_item_list` and `test_normalize_ai_json_object_rejects_non_object_list` tests unchanged.

- [ ] **Step 2: Add competitor parser regression test**

Add to `backend/tests/test_main.py`:

```python
def test_parse_ai_json_object_handles_fenced_competitor_payload():
    from services.ai_json import parse_ai_json_object

    result = parse_ai_json_object('```json\n[{"product_name": "Pool", "price": "$99"}]\n```')

    assert result == {"product_name": "Pool", "price": "$99"}
```

- [ ] **Step 3: Run targeted tests before implementation**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_parse_ai_json_object_handles_fenced_competitor_payload backend/tests/test_main.py::test_normalize_ai_json_object_accepts_single_item_list -v
```

Expected: PASS after Task 1.

- [ ] **Step 4: Use shared parser in main analysis flow**

In `backend/main.py`, change imports:

```python
from services.ai_json import normalize_ai_json_object, parse_ai_json_object
```

Remove the local function:

```python
def normalize_ai_json_object(value: Any) -> dict:
    ...
```

Replace:

```python
parsed_data = normalize_ai_json_object(json.loads(ai_result_json_str))
```

with:

```python
parsed_data = parse_ai_json_object(ai_result_json_str)
```

Replace:

```python
result = normalize_ai_json_object(json.loads(ai_result_json_str))
```

with:

```python
result = parse_ai_json_object(ai_result_json_str)
```

Keep this `json.loads` call unchanged because it parses Pydantic-owned JSON, not AI-owned JSON:

```python
pure_json = json.loads(response_data.model_dump_json())
```

- [ ] **Step 5: Run main tests**

Run:

```bash
python -m pytest backend/tests/test_main.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_main.py
git commit -m "refactor: use shared parser for competitor analysis JSON"
```

---

### Task 4: Migrate Scoring, Comparison, and Text Translation JSON Parsing

**Files:**
- Modify: `backend/services/scoring.py`
- Modify: `backend/services/ai_compare.py`
- Modify: `backend/services/ai_service.py`
- Modify: `backend/tests/test_scoring.py`
- Modify: `backend/tests/test_ai_compare.py`
- Modify: `backend/tests/test_ai_service.py`

- [ ] **Step 1: Add scoring fenced JSON regression test**

Add to `backend/tests/test_scoring.py`:

```python
@pytest.mark.asyncio
async def test_calculate_score_accepts_fenced_json(sample_product_data):
    fenced_json = """```json
        {
          "product": "Test Product",
          "opportunity_score": 70,
          "difficulty_score": 40,
          "final_decision": "建议进入",
          "decision_details": {"confidence": "medium", "reason": "机会明确"},
          "sub_scores": {"opportunity": {}, "difficulty": {}},
          "evaluation_details": []
        }
        ```"""

    with patch("services.scoring.AIService.call_ai", new=AsyncMock(return_value=fenced_json)):
        from services.scoring import calculate_score
        result = await calculate_score(sample_product_data, provider="gemini")

    assert result["opportunity_score"] == 70
    assert result["difficulty_score"] == 40
```

- [ ] **Step 2: Add comparison fenced JSON regression test**

Add to `backend/tests/test_ai_compare.py`:

```python
@pytest.mark.asyncio
async def test_compare_products_accepts_fenced_json(sample_product_data):
    fenced_json = """```json
        {
          "market_position": "中端市场",
          "competition_level": "中等",
          "winner_product": "Lamp",
          "comprehensive_evaluation": [],
          "recommendation_list": []
        }
        ```"""

    with patch("services.ai_compare.AIService.call_ai", new=AsyncMock(return_value=fenced_json)):
        from services.ai_compare import compare_products
        result = await compare_products([sample_product_data], provider="gemini")

    assert result["winner_product"] == "Lamp"
```

- [ ] **Step 3: Add translation batch parser regression test**

Add to `backend/tests/test_ai_service.py`:

```python
@pytest.mark.asyncio
async def test_translate_text_batch_accepts_fenced_json(monkeypatch):
    async def fake_call_ai(*args, **kwargs):
        return '```json\n{"English": "Hello", "Japanese": "こんにちは"}\n```'

    monkeypatch.setattr(AIService, "call_ai", fake_call_ai)

    result = await AIService.translate_text_batch("你好", ["English", "Japanese"])

    assert result == {"English": "Hello", "Japanese": "こんにちは"}
```

- [ ] **Step 4: Run targeted tests and verify current failures if local extractors are too narrow**

Run:

```bash
python -m pytest backend/tests/test_scoring.py backend/tests/test_ai_compare.py backend/tests/test_ai_service.py -v
```

Expected before implementation: existing tests may pass, but new tests should expose any parser inconsistency or test syntax mistakes. Fix only the tests if they do not match the existing async style.

- [ ] **Step 5: Replace local JSON extraction in scoring**

In `backend/services/scoring.py`, add:

```python
from services.ai_json import parse_ai_json_object
```

Replace:

```python
parsed = json.loads(_extract_json(json_str))
```

with:

```python
parsed = parse_ai_json_object(json_str)
```

Remove `_extract_json` and the unused `json` import if no longer needed.

- [ ] **Step 6: Replace local JSON extraction in comparison**

In `backend/services/ai_compare.py`, add:

```python
from services.ai_json import parse_ai_json_object
```

Replace:

```python
parsed = json.loads(_extract_json(json_str))
```

with:

```python
parsed = parse_ai_json_object(json_str)
```

Remove `_extract_json` and the unused `json` import if no longer needed.

- [ ] **Step 7: Replace translation batch JSON parsing**

In `backend/services/ai_service.py`, add:

```python
from services.ai_json import parse_ai_json_object
```

Replace:

```python
clean_json = response_text.replace("```json", "").replace("```", "").strip()
result = json.loads(clean_json)
```

with:

```python
result = parse_ai_json_object(response_text)
```

Keep `json` imported if other code in `ai_service.py` still uses it; otherwise remove it.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
python -m pytest backend/tests/test_scoring.py backend/tests/test_ai_compare.py backend/tests/test_ai_service.py -v
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/services/scoring.py backend/services/ai_compare.py backend/services/ai_service.py backend/tests/test_scoring.py backend/tests/test_ai_compare.py backend/tests/test_ai_service.py
git commit -m "refactor: standardize backend AI JSON parsing"
```

---

### Task 5: Harden Backend Configuration

**Files:**
- Modify: `backend/config.py`
- Create: `.env.example`
- Modify: `backend/tests/test_main.py`

- [ ] **Step 1: Add config safety test**

Add to `backend/tests/test_main.py`:

```python
def test_config_endpoint_does_not_expose_local_paths():
    resp = client.get("/config")

    assert resp.status_code == 200
    body = json.dumps(resp.json(), ensure_ascii=False)
    assert "Workspace" not in body
    assert ".json" not in body
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in body
```

- [ ] **Step 2: Run config endpoint tests**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_config_endpoint backend/tests/test_main.py::test_config_endpoint_does_not_expose_local_paths -v
```

Expected: PASS, because `/config` should already avoid returning secrets and paths.

- [ ] **Step 3: Remove local absolute credential default**

In `backend/config.py`, replace:

```python
VERTEX_KEY_PATH = os.getenv("VERTEX_KEY_PATH", r"D:\Workspace\miyao\hezihua0215 Gemini API Key\ornate-rarity-493511-p5-6759bce81d52.json")
```

with:

```python
VERTEX_KEY_PATH = os.getenv("VERTEX_KEY_PATH", "")
```

Replace the final validation block with:

```python
if AI_PROVIDER == "gemini" and not GEMINI_API_KEY:
    raise EnvironmentError("GEMINI_API_KEY 未配置，请在 backend/.env 文件中设置。")

if AI_PROVIDER == "vertex" and not VERTEX_PROJECT_ID:
    raise EnvironmentError("VERTEX_PROJECT_ID 未配置，请在 backend/.env 文件中设置。")
```

- [ ] **Step 4: Add safe environment template**

Create `.env.example`:

```env
# AI provider: gemini or vertex
AI_PROVIDER=gemini

# Gemini
GEMINI_API_KEY=replace_with_your_gemini_key
GEMINI_MODEL_ID=gemini-3.1-pro-preview

# Vertex AI
VERTEX_PROJECT_ID=replace_with_your_vertex_project_id
VERTEX_LOCATION=global
VERTEX_KEY_PATH=

# Firecrawl
FIRECRAWL_API_URL=http://localhost:3002/v1/scrape
FIRECRAWL_API_KEY=replace_with_your_firecrawl_key

# Frontend runtime config
FRONTEND_TEXT_MODEL=gemini-3.1-flash-preview
FRONTEND_IMAGE_MODEL=gemini-3.1-flash-image-preview
FRONTEND_VISION_MODEL=gemini-3.1-flash-preview
FRONTEND_CONCURRENCY_LIMIT=2
FRONTEND_STAGGER_DELAY=2000

# Local frontend origins
CORS_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
MAX_URL_LENGTH=2048
```

- [ ] **Step 5: Run config tests**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_config_endpoint backend/tests/test_main.py::test_config_endpoint_does_not_expose_local_paths -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/config.py .env.example backend/tests/test_main.py
git commit -m "chore: remove local credential defaults"
```

---

### Task 6: Keep Local Generated State Out of Git

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Inspect existing ignore rules**

Run:

```bash
git check-ignore -v backend/history.db backend/static/test.png .claude/state.json .codex-run-logs/log.txt
```

Expected: each path should be ignored. If any path is not ignored, this task must add a rule for it.

- [ ] **Step 2: Update `.gitignore` with explicit local-state rules**

Ensure `.gitignore` contains these lines:

```gitignore
# Local environment and secrets
.env
.env.local
backend/.env

# Local databases
backend/history.db
backend/*.db

# Generated assets
backend/static/

# Local agent/tool state
.claude/
.codex-run-logs/
debug/
```

- [ ] **Step 3: Verify ignore rules**

Run:

```bash
git check-ignore -v backend/history.db backend/static/test.png .claude/state.json .codex-run-logs/log.txt debug/local.txt
```

Expected: every path prints the matching `.gitignore` rule.

- [ ] **Step 4: Check whether ignored files are already tracked**

Run:

```bash
git ls-files backend/history.db backend/static .claude .codex-run-logs debug
```

Expected: no output. If `backend/history.db` appears, remove it from the index without deleting the local file:

```bash
git rm --cached backend/history.db
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore local generated state"
```

If `git rm --cached backend/history.db` was needed, include it in the same commit:

```bash
git add .gitignore
git rm --cached backend/history.db
git commit -m "chore: stop tracking local history database"
```

---

### Task 7: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run backend tests**

Run:

```bash
python -m pytest backend/tests -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend syntax checks for touched-adjacent modules**

Run:

```bash
node --check frontend/js/analysis.js
node --check frontend/js/details.js
node --check frontend/js/listing.js
node --check frontend/js/translate.js
node --check frontend/js/history_manager.js
```

Expected: each command exits with code 0 and prints no syntax error.

- [ ] **Step 3: Check repository status**

Run:

```bash
git status --short
```

Expected: only intentional committed changes are absent from status. Pre-existing unrelated user changes may remain and must not be reverted.

- [ ] **Step 4: Commit verification note if docs changed**

If implementation changed this plan during execution, commit the updated plan:

```bash
git add docs/superpowers/plans/2026-05-12-ai-stability-engineering-hygiene.md
git commit -m "docs: update AI stability implementation plan"
```

---

## Self-Review

- Spec coverage: The plan covers shared AI JSON parsing, backend migration, configuration safety, `.env.example`, ignored local state, and verification. It intentionally excludes frontend module splitting and history schema redesign.
- Placeholder scan: No `TBD`, `TODO`, or open-ended implementation steps remain. Each implementation step names concrete files, code, commands, and expected results.
- Type consistency: The shared parser exposes `parse_ai_json`, `parse_ai_json_object`, `normalize_ai_json_object`, and `extract_first_json_payload`; later tasks use those exact names.
