# AI Image Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native implementation. Steps use checkbox syntax for tracking.

**Goal:** Add a persistent multi-image workspace with text generation, reference-image generation, and local masked editing through the existing AI configuration.

**Architecture:** First prove a pinned InvokeAI engine adapter against a mocked local provider in an isolated disposable project; continue with extraction only when that boundary works. A backend canvas service owns project assets, durable task state, model capability checks and provider snapshots; a frontend workspace hosts the canvas and calls only local APIs. Existing settings, navigation, provider routing and retry protections remain authoritative.

**Tech Stack:** FastAPI, SQLite, vanilla JavaScript shell, pinned InvokeAI TypeScript canvas engine if the adapter passes, browser canvas, Node test runner and pytest.

**Spec:** `docs/superpowers/specs/2026-10-28-ai-image-canvas-design.md`.

## Global Constraints

- No local model installation, real provider calls or production database modifications for verification.
- Pin InvokeAI to `612f87b1ae4989abbd334366d5c7a6c160935392`; preserve Apache 2.0 notices and check third-party dependency licenses.
- Existing image capability binding remains authoritative; never silently discard references or switch provider.
- Persist resources under the active application's data root, not the packaged application or localStorage; retain project identity across async operations.
- Non-idempotent failures and timeouts must not trigger automatic repeats; unknown outcomes stay unknown.

## Review Focus

- Text-only provider receives references: reject before network, without silently dropping them (Task 2).
- Provider binding changes after preview: reject stale version before charge (Task 2).
- Response arrives after canvas switch or deletion: associate only with original task/project and retain recoverable result (Tasks 3–4).
- Transparent images, mask dimensions and transformed coordinates: preserve pixels outside mask (Task 4).
- Crash during asset or document save: recover previous version and report storage exhaustion (Task 3).

### Task 1: Prove engine boundary in an isolated spike

**Files:** create only under a fresh temporary directory; use the upstream canvas engine and a simulated `/api/ai/generate` response.

**Interfaces:** produce a documented adapter contract that turns selected raster/image/mask into the existing `{capability:'image', payload:{contents:...}}` request and turns a normalized image response into an upstream candidate bound to its originating canvas.

- [ ] Write runnable tests that arrange two images, exercise viewport and selection, build a text-only request, a reference-image request and a single-image mask request, and accept a mock image result into the correct canvas.
- [ ] Confirm real upstream canvas rendering in isolated Chromium, with no remote AI calls. Exercise add, move and reopen of two images and mask coordinates.
- [ ] Measure imported dependency closure and build output. Compare adapter and upstream licenses and identify unimplemented ports for project mutations, raster persistence and image loading.
- [ ] If the adapter cannot be isolated, record the failing boundary and present alternatives before changing product code. If it works, specify exact extracted paths, licenses, build entry and adapter signatures in this plan before Task 4.

### Task 2: Provider capability and route preflight

**Files:** create `backend/services/canvas_ai_service.py`, `backend/routes/canvas.py`, `backend/tests/test_canvas_ai_service.py`; modify `backend/main.py` only to register the router.

**Interfaces:** `inspect_canvas_operation(snapshot, operation, reference_count, has_mask) -> capability result`; `POST /api/canvas/preflight` returns a masked provider identity and immutable configuration version; `POST /api/canvas/tasks` compares the confirmed identity/version with the resolved snapshot before any request.

- [ ] Add tests that text-to-image with references and image-to-image without references fail before adapter invocation; test supported text, reference and mask shapes and a changed provider version.
- [ ] Run `.venv/bin/python -m pytest backend/tests/test_canvas_ai_service.py -q` and verify expected failures.
- [ ] Implement preflight and fail-closed submission validation using existing provider snapshots and routing. Treat unknown third-party capabilities as unsupported until explicitly verified; never disclose credentials.
- [ ] Run the focused test and relevant AI adapter/router tests; confirm all pass.

### Task 3: Project data and durable task ledger

**Files:** create `backend/services/canvas_store.py`, `backend/tests/test_canvas_store.py`; extend `backend/routes/canvas.py` and existing DB setup only as needed.

**Interfaces:** canvas project CRUD with revision checks; asset import/read by opaque ID; task create/get by client operation ID with states `prepared`, `submitted`, `complete`, `failed`, `unknown`. Duplicate task identity must never dispatch twice.

- [ ] Add isolated tests for project save/reopen, bounded asset import, revision conflicts, interrupted atomic writes, disk-full reporting, duplicate operations, process restart and late result after project switch/deletion.
- [ ] Run the tests and confirm the missing implementation fails.
- [ ] Implement paths rooted in the configured user/customer data directory, bounded uploads, transactional metadata, explicit recovery and conservative unknown outcomes; preserve deleted-project results in a recovery area rather than retargeting them.
- [ ] Run focused tests and `git diff --check`.

### Task 4: Canvas adapter, editor and masked generation

**Files:** create `frontend/js/image-canvas/` modules and `frontend/css/image-canvas.css`; add corresponding `frontend/tests/image-canvas*.test.js`; adjust exact pinned vendor/build files based on Task 1.

**Interfaces:** `mountImageCanvas(root, services)` and `unmountImageCanvas()`; service calls for project/asset/task APIs from Tasks 2–3. Capture a frozen project ID, revision, source asset IDs, transforms, dimensions and mask before submission.

- [ ] Write tests for multi-image selection/movement/zoom, request selection, undo/redo, non-destructive result acceptance, project switch, out-of-order responses and restoration.
- [ ] Add pixel tests with transparency, resized/rotated image, mismatched mask dimensions and outside-mask preservation. Assert unsupported multi-reference mask requests are rejected.
- [ ] Run focused tests to confirm failure; implement the adapter and locally composite supported mask output over the original without modifying outside pixels.
- [ ] Run focused tests and browser tests with fake endpoints. Confirm a failed/unknown task stays visible and cannot be silently resubmitted.

### Task 5: Integrate shell and verify delivery

**Files:** modify `frontend/index.html`, `frontend/js/app.js`, desktop resource packaging if needed, tests for navigation and packaging; update `docs/项目当前状态.md` with dated boundaries.

- [ ] Add navigation test for the single shared sidebar, switching away/back without losing saved work, and provider credentials remaining in Settings only.
- [ ] Add isolated Mac bundle resource test and verify compatible dependencies and no secrets, local DB or personal assets in package.
- [ ] Implement the image-tools entry, lifecycle mounting and necessary static bundle packaging; preserve other modules and existing dirty work.
- [ ] Run complete frontend tests, relevant backend tests, JS syntax checks, `git diff --check` and desktop tests; visually inspect a candidate client with fake services and isolated data.
- [ ] Report fake-service verification and any unverified real-model capabilities. Real paid generation requires a separate explicit user budget/model authorization.
