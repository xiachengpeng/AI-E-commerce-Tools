These AGENTS.md instructions replace all previously provided AGENTS.md instructions.

# AI E-commerce Tools Project Guide

## Project Overview

AI E-commerce Tools is a local FastAPI application with a vanilla JavaScript frontend for cross-border e-commerce workflows.

Current product areas:

- Competitor URL scraping, analysis, comparison, and deterministic scoring.
- AI detail-page image planning, generation, regeneration, SEO metadata, long-image composition, and project history.
- High-density 3-card configuration sidebar layout (Presentation & Layout, Scene & Visual Styling, Quality & Performance) with ~35% vertical space reduction.
- Product Identity & Zero-Drift consistency lock (`strictProductLockToggle`, `零变形约束`) strictly forbidding AI product morphing.
- Failed module image retry resilience with isolated task filtering, top alert banners, and concurrent in-place regeneration.
- DTC hybrid PDP generation, 5-style aesthetic layouts, custom brand color grading, typography modal with template persistence, and self-contained dual CMS export (Shopify & WordPress).
- Multi-target cloud storage and image asset hosting (WordPress REST API multi-site, Shopify Admin API multi-store, Cloudflare R2 S3-compatible SigV4) with per-destination upload isolation, dynamic queue synchronization on target/sub-site switch, zero-touch policy, and PDP HTML cloud URL replacement/revert.
- Universal cloud image asset uploader (`universal_uploader.js`) with single/batch queues, WebP compression, smart SEO naming, and Vision AI multi-modal tag inference.
- Launch Kit one-click store deployment packager (`launch_kit_service.py`) generating standalone responsive HTML, section visual slices, JSON-LD Schema, and SEO manifests.
- WebP high-fidelity image compression service with visual lossless defaults, transparency/ICC/EXIF preservation, and size reduction stats.
- Global Brand Profile Hub (`brandContextHub`) with cross-module persistence (Listing, Ads, Details, Analysis), heuristic + AI product category inference, and competitive battle-card synthesis.
- AI watermark and object removal with interactive canvas editor, 8-way handles, and localized history.
- Listing extraction, generation, and compliance checks.
- Multi-platform advertising copy generation.
- Image translation, cleanup, localization, and rendering, including Thai.
- Batch text localization to multiple target languages, including Chinese and Thai.
- Batch square/redraw processing with retry, deletion, preview, and ZIP download.
- AI provider settings, per-capability routing, connection tests, and live application logs.
- SQLite-backed history for supported business modules.

## Runtime Architecture

- `run.py` starts the FastAPI backend on port 9503 and the static frontend on port 9502.
- `backend/main.py` owns HTTP routes, startup/shutdown hooks, settings APIs, history APIs, and feature endpoints.
- `backend/routes/generation.py` owns AI-backed translation, Listing, advertising, watermark, generic AI, and frontend-log endpoints; it is included by `backend/main.py` without changing public paths.
- `backend/routes/storage.py` owns storage configuration CRUD, connection testing, and proxied image upload dispatching for WordPress, Shopify, and Cloudflare R2.
- `backend/models/storage.py` owns storage schemas, credentials, upload requests/responses, and masked configuration models.
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
- `frontend/js/brand_context.js`: global product and brand context hub, modal controller, inline selector updates, multi-profile localStorage management, heuristic/AI category inference, and cross-module dispatch.
- `frontend/js/details.js`: detail-page uploads, AI product-name/selling-point extraction, module planning, prompts, generation, regeneration, SEO, quality checks, long-image export, history restoration, asset hosting drawer, per-destination queue synchronization, and HTML cloud URL replacement/reversion.
- `frontend/js/universal_uploader.js`: universal multi-target cloud uploader modal, queue management, WebP compression, smart SEO naming, and Vision AI semantic image tagging.
- `frontend/js/config.js`: stable frontend options and detail-page module defaults.
- `frontend/js/languages.js`: shared language catalog for detail/listing/ads, image translation, and text translation.
- `frontend/js/listing.js`: Listing input extraction, generation, validation, rendering, and compliance suggestions.
- `frontend/js/ads.js`: advertising inputs, platform selection, generation, rendering, and copy actions.
- `frontend/js/translate.js`: batch image translation and localized image rendering.
- `frontend/js/text_translate.js`: one-request multi-language text localization and result cards.
- `frontend/js/square_redraw.js`: local upload queue, target ratios, server batch coordination, preview, retry, removal, and download.
- `frontend/js/settings.js`: provider CRUD, saved/draft connection tests, text/image bindings, live log stream, filtering, and copying.
- `frontend/js/history_manager.js`: universal history drawer loading, tab switching, rendering, restoration, and deletion.
- `frontend/js/utils.js`: shared frontend utilities.
- `frontend/js/lib/html2canvas.min.js`: local canvas snapshot library for client-side long-image generation.
- `frontend/css/input.css`: Tailwind input.
- `frontend/css/style.css`: shared application styles.
- `frontend/css/analysis.css`, `settings.css`, and `square_redraw.css`: feature-specific styles.

## Backend Service Map

- `backend/services/ai_service.py`: small AI facade used by feature services; delegates to `AIRouter`.
- `backend/services/ai_router.py`: resolves capability bindings, executes retries, maps provider errors, and emits structured AI logs.
- `backend/services/ai_adapters.py`: protocol adapters and normalized request/response conversion.
- `backend/services/ai_config_service.py`: provider validation, CRUD, capability bindings, snapshots, and initial environment import.
- `backend/services/app_log_service.py`: bounded in-memory logs, subscribers, structured fields, and sensitive-data redaction.
- `backend/services/storage_service.py`: multi-target storage driver for WordPress REST API (media upload), Shopify Admin GraphQL API (staged uploads), and Cloudflare R2 (SigV4 S3 signature), secret masking, and destination routing.
- `backend/services/storage_cleanup_service.py`: background cleanup of orphaned temporary files and local asset caches.
- `backend/services/launch_kit_service.py`: Launch Kit generation, ZIP packaging of standalone PDP HTML, section visual slices, JSON-LD Schema, and SEO manifest.
- `backend/services/security_utils.py`: credential masking, path traversal prevention, and safe URL sanitization.
- `backend/services/json_utils.py`: robust JSON extraction and repair for structured AI outputs.
- `backend/services/image_compression_service.py`: Pillow-backed high-quality WebP conversion, quality/method tuning, ICC/EXIF preservation, and size savings reporting.
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

Create a local environment with Python 3.10+ (the codebase uses modern union type annotations) and install dependencies:

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install
```

Start the full application from the repository root:

```bash
.venv/bin/python run.py
```

Local URLs:

- Backend: `http://127.0.0.1:9503`
- Frontend: `http://127.0.0.1:9502/index.html`

Before restarting, stop existing project processes and ensure ports 9503 and 9502 are free.

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

### Detail-page generation and configuration sidebar

- Uploaded product images are the visual source of truth.
- High-density 3-card configuration layout: 【呈现形态与版式】(Presentation & Layout), 【场景与视觉风格】(Scene & Visual), 【品控与出图优化】(Quality & Performance). Keep microcopy as compact single-line text (`text-[9px] text-slate-400`) to preserve vertical ergonomics and prevent core inputs from being pushed off-screen.
- DTC presentation mode switcher (`setDetailPresentationMode`) toggles between `hybrid` and `images`. When in `images` mode, all DTC-specific sub-options (`#dtcStyleConfigContainer` containing layout style, brand color, custom picker, typography trigger, and trust bar) must collapse cleanly.
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

### Product identity & zero-drift consistency lock

- Zero-drift mandate (`strictProductLockToggle`, `零变形约束`): When active, prompt engineering enforces highest-priority `Consistency Mandate` in `IMAGE TASK`, followed by `STRICT ZERO-DRIFT MANDATE (PHYSICAL INVARIANT)`, `ABSOLUTE PROHIBITION ON PRODUCT MORPHING`, and `FEATURE VISUALIZATION BOUNDARY`.
- Dual-end anchoring: head prompt anchors reference images as immutable physical ground truth; tail `HARD RULES` explicitly defend product fidelity.
- Repaint defense: user in-place repaint rules (`repaintRule`) strictly forbid modifying the physical product itself.

### Failed image retry and generation resilience

- Task filtering: `getFailedModuleTasks()` filters global generation context specifically for modules with status `failed`, `cancelled`, or missing image data, while strictly preserving already succeeded tasks.
- Non-destructive execution: `retryFailedModuleImages()` retries only failed items in-place with concurrency limits without re-running completed tasks.
- Feedback synchronization: `updateDetailFailureUI()` synchronizes toolbar retry button (`btnRetryFailedToolbar`), top banner alert (`detailFailureAlertBar`), and batch retry button (`btnRetryFailedImages`) in real-time upon any failure, retry start, or success.

### Universal cloud asset uploader & launch kit

- Universal uploader modal (`universal_uploader.js`): Single and batch image asset dispatch to WordPress, Shopify, and Cloudflare R2 across Details, Redraw, Watermark, and Translate modules.
- Built-in WebP conversion pipeline with smart SEO naming sanitation and Vision AI multi-modal tag inference.
- Launch Kit export (`launch_kit_service.py`): Packages self-contained responsive DTC HTML, section visual slices, JSON-LD Schema, and SEO manifest into a downloadable ZIP.

### DTC hybrid PDP and typography

- The detail page supports two presentation views: DTC Hybrid PDP (`hybrid`) and Single Image Gallery (`gallery`). Controls for viewport, styles, brand colors, and typography modal must toggle with view state.
- Layout style switcher supports 5 distinct aesthetic styles (`editorial`, `minimalist`, `bento`, `lookbook`, `technical`) that switch live without regenerating images or text.
- Brand colors support 7 presets plus arbitrary custom hex values. Custom color derivation mathematically calculates:
  - `primary`: base hex color.
  - `light`: 93% blend with pure white for subtle tinted module backgrounds.
  - `border`: 75% blend with pure white for borders and dividers.
  - `text`: 25% darkened contrast value for readable text on light tints.
- Color pickers and hex inputs must update via both `oninput` (real-time dragging/typing) and `onchange`.
- Typography customization modal (`#dtcTypographyModal`) manages global font families (including Google Fonts auto-import), title font/size/weight/spacing, subtitle size/weight, and body size/weight/line-height with instant live preview.
- Built-in typography presets provide 5 curated scenarios (`modern`, `luxury`, `tech`, `bold_cpg`, `minimal_lifestyle`). User-saved templates persist to browser `localStorage` with save, dropdown listing, and deletion capabilities.
- Standalone HTML export (`copyShopifyHtml` and `copyDtcSectionHtml`) must be completely self-contained:
  - Embed Google Fonts `@import` rules for all non-system fonts used.
  - CSS variables scoped to `.dtc-pdp-wrapper` and `.dtc-modular-section`.
  - Defensive resets must precede typography hierarchy rules so that custom title and body weights are never overwritten.
  - Typography properties use `!important` to prevent host CMS themes (e.g. Astra, OceanWP, Shopify Dawn) from altering font sizes, weights, or line heights.
  - Neutralize WordPress `wpautop` automatic paragraph injection via newline compression in `cleanDtcExportHtml`.
  - Use zero-JS semantic `<details>` and `<summary>` for FAQ accordions so they function across restrictive CMS environments without external JavaScript.
- Project snapshots and history restoration must capture and restore `customBrandColor` and `typography` configurations, with fallback defaults for legacy records.

### PDP asset hosting and multi-site storage

- Supported storage targets: WordPress (`wordpress`), Shopify (`shopify`), Cloudflare R2 (`r2`).
- Composite target destination key format: `${storage_type}:${config_id}` (e.g. `wordpress:1`, `shopify:3`, `r2:2`).
- Per-destination upload state isolation: images maintain uploaded remote URLs indexed by destination key in `uploadedUrls` / `remoteUrlsByTarget`.
- Target and sub-site switching (`syncPdpQueueStateToCurrentTarget`) must recompute per-image status badges (`已上传` with green check vs `未上传` / `待上传` with upload action) based solely on whether the active destination key has a valid remote URL. Switching targets must never bleed upload status across different sites or stores.
- Sub-site/store dropdown changes must update `activeWpConfigId` / `activeShopifyConfigId` and immediately invoke `syncPdpQueueStateToCurrentTarget()` and header badge updates.
- Zero-touch confirmation: selecting a target or sub-site never alters remote assets or triggers automatic uploads.
- Upload lock: `isPdpAssetUploading` prevents concurrent upload batch conflicts or destination toggling corruption.
- HTML replacement (`applyRemoteUrlsToPdpHtml`) replaces local/static paths in PDP HTML with cloud URLs; missing uploads trigger explicit warnings rather than silent broken links. `revertToLocalPdpImages` restores local paths without data loss.
- Storage secrets (Application Passwords, Admin API Access Tokens, S3 Secret Access Keys) must be masked (`••••••••` / `val[:3]••••val[-3:]`) when returned to the browser; blank inputs during edits preserve saved secrets.

### WebP image compression

- Default compression quality is 90 with compression method 6 for visually lossless fidelity.
- Alpha channel transparency must be preserved (convert LA/P-with-transparency to RGBA, not RGB).
- CMYK images must be converted to RGB.
- ICC color profile and EXIF metadata must be carried over when present.
- Return detailed statistics: `original_size`, `compressed_size`, `savings_bytes`, `savings_percent`.

### Brand Profile Hub and category inference

- Global singleton `window.brandContextHub` persists profiles in `localStorage` under `ai_ecommerce_brand_profiles`.
- Fields: `name`, `brandName`, `category`, `icp`, `painPoints`, `differentiators`, `vocKeywords`, `tone`, `competitorNotes`.
- Category resolution follows a two-tier strategy: instant rule-based keyword heuristics (`inferCategoryFromText`) followed by AI-assisted inference (`aiInferCategoryFromModal` / `xp_inferCategoryFromText`) fallback.
- Multi-module profile injection into Listing, Ads, and Details must never clobber existing user edits without confirmation.

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
