These AGENTS.md instructions replace all previously provided AGENTS.md instructions.

# AI E-commerce Tools Project Guide

## Project Overview

AI E-commerce Tools is a local FastAPI application with a vanilla JavaScript frontend for cross-border e-commerce workflows.

Current product areas:

- Competitor URL scraping, analysis, comparison, and deterministic scoring.
- AI detail-page image planning, generation, regeneration, SEO metadata, long-image composition, and project history.
- Listing extraction, generation, and compliance checks.
- Multi-platform advertising copy generation.
- Image translation, cleanup, localization, and rendering, including Thai.
- Batch text localization to multiple target languages, including Chinese and Thai.
- Batch square/redraw processing with retry, deletion, preview, and ZIP download.
- AI provider settings, per-capability routing, connection tests, and live application logs.
- SQLite-backed history for supported business modules.

## Runtime Architecture

- `run.py` starts the FastAPI backend on port 8000 and the static frontend on port 8080.
- `backend/main.py` owns HTTP routes, startup/shutdown hooks, settings APIs, history APIs, and feature endpoints.
- `frontend/index.html` contains the application shell and feature views.
- `frontend/js/app.js` loads public runtime configuration, provides `callAI(capability, payload)`, and switches top-level views.
- `backend/db.py` contains SQLAlchemy database setup and persisted history/settings models.
- Local SQLite state is stored in `backend/history.db`.

Frontend AI calls follow this chain:

```text
frontend callAI("text" | "image", payload)
  -> POST /api/ai/generate
  -> backend/services/ai_router.py
  -> SQLite capability binding and provider snapshot
  -> backend/services/ai_adapters.py
  -> Gemini, Vertex AI, or OpenAI Compatible provider
  -> normalized response returned to the frontend
```

The browser must not call AI providers directly.

## Feature And Frontend Map

- `frontend/js/analysis.js`: competitor URLs, analysis progress, comparison rendering, and report export.
- `frontend/js/details.js`: detail-page uploads, AI product-name/selling-point extraction, module planning, prompts, generation, regeneration, SEO, quality checks, long-image export, and history restoration.
- `frontend/js/config.js`: stable frontend options and detail-page module defaults.
- `frontend/js/listing.js`: Listing input extraction, generation, validation, rendering, and compliance suggestions.
- `frontend/js/ads.js`: advertising inputs, platform selection, generation, rendering, and copy actions.
- `frontend/js/translate.js`: batch image translation and localized image rendering.
- `frontend/js/text_translate.js`: one-request multi-language text localization and result cards.
- `frontend/js/square_redraw.js`: local upload queue, target ratios, server batch coordination, preview, retry, removal, and download.
- `frontend/js/settings.js`: provider CRUD, saved/draft connection tests, text/image bindings, live log stream, filtering, and copying.
- `frontend/js/history_manager.js`: history loading, rendering, restoration, and deletion.
- `frontend/js/utils.js`: shared frontend utilities.
- `frontend/css/input.css`: Tailwind input.
- `frontend/css/style.css`: shared application styles.
- `frontend/css/analysis.css`, `settings.css`, and `square_redraw.css`: feature-specific styles.

## Backend Service Map

- `backend/services/ai_service.py`: small AI facade used by feature services; delegates to `AIRouter`.
- `backend/services/ai_router.py`: resolves capability bindings, executes retries, maps provider errors, and emits structured AI logs.
- `backend/services/ai_adapters.py`: protocol adapters and normalized request/response conversion.
- `backend/services/ai_config_service.py`: provider validation, CRUD, capability bindings, snapshots, and initial environment import.
- `backend/services/app_log_service.py`: bounded in-memory logs, subscribers, structured fields, and sensitive-data redaction.
- `backend/services/firecrawl.py`: remote page scraping.
- `backend/services/amazon_parser.py` and `cleaner.py`: scraped content parsing and cleanup.
- `backend/services/ai_single.py`, `ai_compare.py`, and `scoring.py`: competitor analysis and deterministic scores.
- `backend/services/listing_service.py`: Listing extraction, generation, and compliance logic.
- `backend/services/ads_service.py`: advertising copy generation.
- `backend/services/square_redraw_service.py`: persisted redraw batches, item processing, retry, removal, and ZIP assembly.
- `backend/models/request.py`: business request models.
- `backend/models/settings.py`: AI settings request/response models.

## AI Routing And Settings

- AI is routed by capability: `text` and `image`.
- Each capability is bound to one enabled provider that supports the capability and has a configured model.
- Supported protocols are Gemini, Vertex AI, and OpenAI Compatible.
- OpenAI Compatible providers persist an image generation mode. `image_to_image`
  calls `/v1/images/edits` with multipart reference images; `text_to_image` calls
  `/v1/images/generations` without reference images. Existing providers default
  to `image_to_image`.
- Provider and binding changes are persisted to SQLite and apply to the next request without restarting the app.
- Environment configuration is imported only to establish defaults when settings storage is empty.
- Provider settings returned to the browser must mask secrets; blank secret fields during edits must preserve the saved value.
- Saved and draft provider tests must test the requested capability, not silently substitute another model or protocol.
- Frontend feature code should use `callAI()` or a backend feature endpoint, never reproduce provider-specific request logic.
- Normalized AI responses must remain compatible with existing frontend consumers.

## Live Logs

- Settings logs are bounded, in-memory application events for the current backend process; they are not business history and do not survive restart.
- The settings page uses recent-log snapshots plus an SSE stream.
- Keep capability, provider, model, duration, retry, status, and safe diagnostic fields useful for local debugging.
- Continue redacting API keys, Authorization headers, credentials, service-account material, prompts, provider responses containing sensitive payloads, and image data URLs.
- Do not weaken fail-closed diagnostic scrubbing when adding new error details.

## Setup, Run, Build, And Test

Create a local environment and install dependencies:

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install
```

Start the full application from the repository root:

```bash
.venv/bin/python run.py
```

Local URLs:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://127.0.0.1:8080/index.html`

Before restarting, stop existing project processes and ensure ports 8000 and 8080 are free.

Build or watch Tailwind CSS:

```bash
cd frontend && npm run build:css
cd frontend && npm run watch:css
```

`frontend/dist/` is ignored. A new Git worktree may need `npm install` and `npm run build:css` before the page is visually usable.

Run backend tests:

```bash
.venv/bin/python -m pytest backend/tests
```

Run the complete frontend test suite:

```bash
node --test frontend/tests/*.test.js
```

Syntax-check every changed frontend JavaScript file:

```bash
node --check frontend/js/<changed-file>.js
```

Use `git diff --check` before committing.

## Local State And Secrets

Never commit or upload:

- `.env`, `.env.local`, or `backend/.env`.
- `backend/history.db`.
- `debug/`.
- Generated files under `backend/static/`.
- `frontend/dist/` or `node_modules/`.
- `.claude/`, `.codex-run-logs/`, `.worktrees/`, or other local tool state.
- Service-account JSON files, hard-coded API keys, Authorization values, tokens, or credentials.

When testing in an isolated worktree, copy local state only when necessary, keep it ignored, and never stage it. Do not expose secret values in terminal output, tests, logs, screenshots, fixtures, or documentation.

## Implementation Invariants

### Detail-page generation

- Uploaded product images are the visual source of truth.
- Do not alter or invent product category, silhouette, structure, parts, accessories, color, material, finish, proportions, logo, controls, buttons, ports, labels, texture, or component placement.
- Background, lighting, and non-product decoration may change only when they do not obscure or redesign the product.
- Detail-page modules are unselected by default; the user chooses which modules to generate.
- Every module defaults to including copy once selected, and each module can independently disable added copy.
- Detail-page copy language options include Thai.
- No-copy mode must not add headlines, labels, specifications, dimensions, badges, watermarks, letters, numbers, icons, arrows, or other typographic elements.
- Original product markings may remain only when faithfully reproduced; they must not be rewritten, translated, replaced, or redesigned.
- AI selling-point extraction fills an inferred localized product name only when the product-name input was empty. Never overwrite a user-entered product name.
- Module copy mode must propagate into generation tasks, regeneration, saved project snapshots, and history restoration. Old history without the field defaults to copy enabled.
- SEO title and Alt metadata remain separate from text rendered into the generated image.

### Competitor analysis

- Scoring is deterministic backend logic; frontend presentation must stay consistent with backend values.
- For refreshes, keep existing rendered analysis visible until the replacement request succeeds.
- Preserve parsing and cleanup limits when changing scraping or comparison prompts.

### Settings and provider routing

- Provider selection is per capability, immediate, and persisted.
- OpenAI image mode changes are provider-specific, immediate, and persisted. An
  image-to-image request without a valid source image must fail before any
  provider request so the existing local fallback can handle it; never silently
  downgrade that request to text-to-image.
- Disabling or deleting a provider that is currently bound must remain blocked until bindings are moved.
- Changes to adapters or routing require focused tests for provider validation, binding selection, retries, normalization, error mapping, and secret scrubbing.

### Square redraw

- Preserve per-item status, retry, deletion, aspect-ratio handling, batch recovery, history, and ZIP behavior.
- Do not reprocess items already matching the target ratio unless the explicit workflow requires it.
- Generated images belong under ignored local static storage, not Git.

### Text and image translation

- Batch text translation sends one request containing all selected target languages.
- Chinese and Thai are supported text-translation targets.
- Image translation supports Thai and must preserve the source image composition while replacing localized text according to the selected workflow.

### History and compatibility

- Keep persisted payloads backward compatible. Normalize missing fields rather than rejecting older records.
- Business history is separate from settings live logs.
- Do not clear existing successful UI state before a replacement request succeeds.

## Working Tree Hygiene

- Preserve unrelated user changes and dirty worktree state.
- Do not revert, delete, or reformat unrelated files.
- Keep changes focused and pair behavior changes with tests.
- Use the existing large-file organization unless the requested work clearly benefits from a focused extraction.
- Do not commit generated assets, databases, local logs, credentials, or temporary debugging scripts.
