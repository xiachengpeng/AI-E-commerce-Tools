# Infinite Image Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native implementation. Steps use checkbox syntax for tracking.

**Goal:** Reuse the reference site's node canvas and image workflow, integrated with the existing desktop app and its configured image AI service.

**Architecture:** Isolate the pinned MIT React/Vite canvas UI as a local image-only frontend and adapt its project/asset persistence and image generation to the existing FastAPI canvas service. Keep the previous Invoke canvas as a separate legacy view, with no destructive migration; preserve task identities and existing provider credential boundaries.

**Tech Stack:** React/Vite/TypeScript pinned by the upstream lockfile; FastAPI/SQLite, existing provider router, Electron; Node tests and pytest.

**Spec:** `docs/superpowers/specs/2026-10-28-infinite-canvas-redesign.md` (user confirmed 2026-10-28).

## Global Constraints

- Pinned upstream revision `9cd3deacbcc598361807afc16c059a80dd18b6f9`, MIT notices and dependent license inventory.
- Only image and text nodes for image workflows; exclude video, audio, Agent, dynamic plugins and external credential configuration/requests.
- Never make a real paid AI request during verification; no browser provider credentials, no silent provider switching or retry.
- Original user data, current running client, legacy canvas data and unrelated uncommitted changes remain intact; no unsolicited Git commit, merge, publish or customer release.
- Validate in disposable directories and simulated providers first; preserve existing installed app until candidate verified and user-authorized safe restart.

## Review Focus

- Async result after node deletion, changed connections or canvas switch belongs to its captured original task/project and is recoverable (Task 3).
- Page reload or save failure must not erase a pending edited project, existing old canvas or source asset (Tasks 2–4).
- User-supplied external URLs, model plugins, and media cannot cause browser direct provider calls or expose secrets (Tasks 1–3).
- Batch generation may cost multiple requests; show the count before submission, ledger each attempt independently and never auto-retry uncertainty (Task 3).
- Reference front-end dependencies, CSS, keyboard handling and popovers must not break main app or require network at runtime (Tasks 1 and 4).

### Task 1: Verify the upstream canvas boundary

**Files:** temporary checkout `/tmp/canvas-reference-20261028` only; later create `frontend/infinite-image-canvas/` and document exact copied upstream files and licenses.

**Interfaces:** disposable `mountNodeCanvas(root, services)` accepting local persistence and mock image services; no external provider/network call.

- [ ] Inspect upstream node/store/router/image service dependencies and lockfile at the pinned revision. Record exact import closure and bundled license notices; account for fonts, icons and external URLs.
- [ ] In a temporary build, retain image and text nodes, connections, zoom, selection and toolbar; remove video/audio/Agent/plugin entrypoints and any direct AI calls. Supply fake project storage and image generation.
- [ ] Demonstrate browser behavior with two images, text, an image-reference connection, move, zoom, reload and a fake generated result. Verify loaded resources and requests use loopback only; verify native shell CSS/navigation remain intact.
- [ ] If upstream cannot be safely isolated or its image nodes cannot use an injected service, report concrete evidence before making product changes. Otherwise record the exact adapter and reproducible build commands in this plan and continue.

### Task 2: Durable node projects and legacy coexistence

**Files:** modify `backend/services/canvas_store.py`, `backend/routes/canvas.py`; create `backend/tests/test_node_canvas_store.py`; modify `frontend/index.html`, `frontend/js/app.js` for explicitly separate legacy entry.

**Interfaces:** `CanvasStore.create_project(title, format='invoke-v1'|'node-v1')`; node documents use the existing revision-checked `save_project(id, revision, document)` and project-scoped asset APIs; legacy callers continue to create/read `invoke-v1` unchanged.

- [ ] Add failing tests for legacy project upgrade without modification, separate node project list/read, revision conflict, missing/foreign assets and restart of node/connection/viewport data.
- [ ] Implement additive schema migration with safe legacy defaults and explicit format filtering; persist node documents and image references with existing quotas and atomic write behavior.
- [ ] Preserve a discoverable legacy view and export/access path; never feed legacy documents to the new editor or vice versa.
- [ ] Run focused store, route and legacy frontend tests. Verify existing canvas snapshots stay byte-for-byte unchanged during new canvas creation.

### Task 3: Connect node generation to the existing image backend

**Files:** modify `backend/services/canvas_ai_service.py`, `backend/routes/canvas.py`, `backend/services/canvas_store.py`; create `backend/tests/test_node_canvas_tasks.py`; create `frontend/infinite-image-canvas/src/local-api.ts` and `src/node-generation-adapter.ts`.

**Interfaces:** `submitNodeGeneration(projectId, nodeId, nodeRevision, operationKey, prompt, orderedReferenceAssetIds, maskAssetId, expectedProvider)` returns existing durable task metadata. Each batch item has its own operation key and captured input/version; server uses current provider snapshot and existing preflight.

- [ ] Add failing tests for text-only provider with references, stale provider version, multiple ordered references, mask pixel preservation, duplicate operation, separate batch identities and retry/timeout uncertainty.
- [ ] Implement immutable node and source metadata on durable tasks; output remains associated with the original project and node snapshot even when node is deleted or canvas switches. Result must be recoverable without silently overwriting a changed node.
- [ ] Adapt upstream image-node requests to the local API. Disable every upstream browser direct request, dynamic model plugin and proxy bypass; preserve visible pending/success/failure/unknown states.
- [ ] Run relevant provider and task tests; use a mock service to assert single actual network attempt per operation and no secret or external traffic.

### Task 4: Ship and validate the image-only node canvas

**Files:** create `frontend/infinite-image-canvas/` from the pinned upstream scope and its `LICENSE`/dependency notices; modify `frontend/index.html`, `frontend/js/app.js`, `scripts/desktop/build_backend.py`, `scripts/desktop/verify_bundle.py`; create focused frontend and packaging tests; update `docs/项目当前状态.md`.

**Interfaces:** static build is served locally; lifecycle mount/suspend preserves the app sidebar and node state. Frontend asset paths remain resolvable after desktop packaging, without Internet access.

- [ ] Test navigation, exact image-only toolbar and reference-node links; test old canvas access, user edits and project restoration, failed save, stale revision and pending results.
- [ ] Implement upstream UI integration with isolated styles, local asset URLs and accessible loading/errors. Confirm no video, audio, Agent, external provider settings or plugin controls appear.
- [ ] Run all frontend tests, targeted backend tests, JS/TS checks, `git diff --check`, desktop resource and signature checks; browser test with mock AI and isolated user data.
- [ ] Perform independent whole-change code review and resolve critical/important findings. Build a candidate and verify locally; install only after a safe user-authorized restart and keep rollback. Do not claim real-model compatibility without a separate explicit paid test authorization.

### Task 1 boundary evidence (2026-10-28)

- Upstream `/tmp/canvas-reference-20261028`, commit above. `pnpm 10.12.4 install --frozen-lockfile --ignore-scripts` then `pnpm run build` succeeded; npm lock is not in sync and `npm ci` fails. Build: 3.7 MB; production dependency license inventory includes MIT, Apache-2.0, BSD, ISC, 0BSD, BlueOak, CC-BY and CC0. The final included dependency closure and license texts must be verified, not assumed from this inventory.
- Disposable adaptations replace `pages/canvas/project.tsx` image calls with local stub functions, `stores/canvas/use-canvas-store.ts` persistence and `services/image-storage.ts` blob store with loopback mock endpoints; remove video/audio dock buttons and Agent panel. CSP limits runtime network to loopback server plus data/blob. A fake image endpoint is distinct from real services.
- Browser exercised two image nodes with a reference connection and fake edit; a separate project persisted a generated image, text node and 75% zoom via fake backend, reopened successfully; simulated iframe host switched modules and restored state. Default 3 outputs issued three distinct mock requests, so production batch preflight and ledger are mandatory.
- This spike uses an in-memory mock, not production durability; menu/keyboard routes, plugin hooks, external URL paths, all image-edit variants, exact complete license closure and the real desktop package are not yet proven and remain implementation gates.
