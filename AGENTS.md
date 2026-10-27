These AGENTS.md instructions replace all previously provided AGENTS.md instructions.

# AI E-commerce Tools Project Guide

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 现行入口或维护说明**
> 使用说明按当前代码同步；测试结果引用对应日期验收，本次文档整理没有运行收费链路或重新验收所有功能。
> 当前入口与验证范围：[项目当前状态](<docs/项目当前状态.md>)；[2026-10-26流程修复与边界](<docs/ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

## Project Overview

AI E-commerce Tools is a local FastAPI application with a vanilla JavaScript frontend for cross-border e-commerce workflows.

Current product areas:

- Native product research/SOP workflow: projects, reviewed search terms, source-bound product/ad media, triage, ten-step evidence and decision flow, tests/reviews, reports and persistent task logs.
- One shared grouped sidebar across every module; external integration credentials are managed in main Settings.

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

- `run.py` starts the FastAPI backend on port 9503 and `frontend_server.py` on port 9502. The latter serves static files and relays only allowlisted research/integration paths to the fixed loopback API without replaying mutations.
- The research worker starts only for explicitly enabled active mode with valid consumed activation/ledger state; do not start workers or paid queues merely to verify UI.
- `backend/routes/research_workbench.py` exposes the native research workflow; `backend/modules/research/rabbit_hole/` contains its integrated domain/application/persistence code. No remote SOP API, SSH tunnel or iframe is required.
- Research evidence/config/signing material stays under the private research root, separate from marketing static assets.
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

## 代码库理解与 Token 节省规范 (Token Optimization)

- 分析整体架构、跨模块关系或涉及 3 个及以上文件时，先界定问题范围，查看本文件的模块地图和相关配置/入口，再用 `rg --files`、`rg -n` 定位。避免无目标地逐个读取大量完整文件；文件数量本身不构成整库打包的理由。
- 需要广泛了解代码结构时，可按需使用 Repomix 的 Tree-sitter 压缩。优先复用仍与当前源码一致的上下文文件；仅打包相关模块，使用 `--include` / `--ignore` 限制范围，不默认打包整个仓库。
- 使用已安装或项目已固定版本的工具。不要为了读取代码而自动执行会下载未固定版本工具的 `npx repomix`；工具不可用时，继续通过定向搜索、导入关系和源码片段完成分析，不因此阻塞任务。
- 压缩结果仅用于导航和结构概览，不能作为业务逻辑、安全、数据库或兼容性结论的唯一依据。即使不修改代码，也应核验支撑重要结论的原始实现、配置和测试；修改前精读相关逻辑及直接调用方。
- 保持默认忽略规则与安全扫描开启，并显式排除凭据、环境文件、数据库、生成素材、构建产物、依赖及本地工具状态；遵守下文 Local State And Secrets。安全扫描不能替代人工核对，不使用远程上传或剪贴板复制选项。
- 输出放在已忽略的 `debug/repomix/` 等本地目录，不写到仓库根目录，不提交 Git。创建目录后使用不覆盖已有文件的输出名；记录打包范围和源码状态，相关代码变更后重新生成或核验。
- 先检查输出摘要、文件范围与大小，再按问题读取相关 XML 区段；输出过大就缩小范围，不一次读入整个压缩文件。没有执行压缩或源码未覆盖的部分，应如实说明，不编造分析依据。

示例（仅在 Repomix 已可用时，从仓库根目录运行；先创建输出目录，并按任务调整范围和输出名）：

```bash
repomix --compress --style xml --include 'frontend/js/research-workbench/**/*.mjs' -o debug/repomix/research-context.xml
```

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

## Research UI And Shared Navigation

- `frontend/js/research-workbench/index.mjs` owns native workbench lifecycle; `pages/`, `components/`, and `services/` retain existing commands and DTO contracts.
- `services/journey.mjs` maps ten authoritative steps into four business-language groups; do not loosen server evidence, version or decision gates to match a mockup.
- `services/media-cache.mjs` provides bounded lifecycle-owned media leases; preserve exact project/source/revision binding and release blobs on teardown.
- `frontend/js/settings_research.mjs` mounts the single integration credential editor in main Settings; preserve blank-secret behavior and unique editor ownership.
- `frontend/js/app.js:updateResearchDesignNavigation` mounts the original navigation controls once for all modules. `unified-navigation-mode` scopes shared sidebar CSS; `research-design-mode` scopes research content/settings presentation only. Never restore the legacy sidebar on a module switch.
- Preserve group expansion within the session and reveal the active nested entry on direct entry/refresh; keep original IDs, handlers, content state and settings restoration lifecycle.
- Current documentation entry point: `docs/README.md`; current facts and dated verification boundaries: `docs/项目当前状态.md`. Historical plans are not new execution authorization.

### Research flow contracts (2026-10-26)

- The visible journey has five stages; `journeyGroups` is a four-group internal projection. Preserve all ten authoritative steps. `components/workflow-controls.mjs` exposes funnel, score, test and review tasks without weakening server gates.
- Candidate triage (retain/observe/reject) opens the existing reason form and requires explicit saving. Keep recovery and source history; retained does not mean passed.
- `services/journey.mjs:projectResume` restores valid focus first, otherwise a recent source with results. Valid non-test decisions on a focused product route to review; stale decisions need rechecking.
- Completed-word rescans require `rescan_of` bound to the completed same-project/same-keyword task. Keep old results and deduplicate the successor; blocked recovery must target the matching `retry_action_id`. Never turn ambiguous outcomes into fresh automatic searches or switch accounts silently.
- `scanCandidates` must match server eligibility and batch limit; empty previews must not submit. Ad age and recent activity do not prove uninterrupted 30-day delivery; preserve unknown continuity.
- Latest dated acceptance is `docs/ux-audit/2026-10-26-sop-flow-repair/验收记录.md`. Its test counts and installed-client evidence are historical verification boundaries, not a substitute for rerunning relevant checks after future changes. Customer DMG updates are separate from local-client updates.

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
node --test frontend/tests/*.test.js frontend/tests/research-workbench/*.test.mjs
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

### Research product/ad identity review

- Evidence review UI must expose positive, negative, and unresolved outcomes with a clear next action; an unchecked confirmation box alone must not represent both mismatch and unreviewed evidence.
- Product/ad review uses `relevance_result`: `matched`（一致）, `mismatch`（不一致）, or `unverified`（暂时无法判断）. Only `matched` sets `relevance_confirmed=true`; the backend must reject contradictory values and retain the existing evidence and expansion gates.
- Missing media, timeouts, inaccessible pages, or insufficient evidence mean unresolved, not a confirmed mismatch or match. Never infer a human confirmation from successful scraping or an AI suggestion.
- Saving a mismatch must retain its reason and source evidence, show the result in the candidate list and detail panel, block keyword expansion, and offer correction/review. It must not automatically delete, reject, or archive the lead; triage remains a separate explicit action.
- Preserve the original confirmation command, version checks, submission identity, drafts, and source-bound comparison dialog. Correcting a product URL must continue to invalidate affected evidence while preserving history.
- Keep old records and callers compatible: when `relevance_result` is absent, derive `matched` from true and `unverified` from false; do not reinterpret an old false value as a recorded mismatch.
- Changes to this flow require focused checks for all three saved outcomes, contradictory payload rejection, reopening/correction, and expansion remaining blocked for mismatch/unresolved evidence. Use isolated data for saves; do not submit paid tasks or change a real product judgment merely to verify UI.
- Implementation references: `components/identity-result.mjs`, `components/product-identity-dialog.mjs`, `pages/product.mjs`, and `pages/focused-exploration.mjs` under `frontend/js/research-workbench/`; authoritative validation remains in `backend/modules/research/rabbit_hole/domain/project.py`.

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

### Progressive 4-Step Detail Workflow & 3-Column Studio

- 4-step progressive pipeline:
  - Step 1 Channel Select (`setDetailChannel`): Adapts recommended layouts, presets, viewports, and primary delivery CTA.
  - Step 2 Asset Roles (`resolveAssetSemanticRoles`): Concurrently inspects up to 6 uploaded assets, inferring semantic roles (primary, detail, lifestyle, angle, packaging).
  - Step 3 Facts Confirmation (`confirmProductFact`, `confirmAllProductFacts`): Lightweight card for reviewing extracted facts (category, material, dimensions, warranty, etc.) before image/copy synthesis.
  - Step 4 AI Plan (`buildRecommendedDetailPlan`, `validateContentPlanEvidence`): Automatically recommends high-converting modules while gating missing evidence.
- 3-column unified workbench:
  - Left Section Tree (`#sectionTreeSidebar`): Section reordering, visibility toggle, sub-status badges, and module insertion.
  - Center Dual Preview (`#modulesResultContainer` / `#dtcHybridContainer`): Instant switching between Gallery and Hybrid PDP, with click-to-highlight bi-directional inspector synchronization.
  - Right Section Inspector (`#sectionInspectorSidebar`): In-place editing of headlines, subheadlines, taglines, and SEO metadata; preset-driven and natural language prompt repainting (`PRESET_REPAINT_PROMPTS`); multi-version history with zero-loss rollback.
- Adaptive primary delivery CTA (`#btnPrimaryDeliveryCTA`, `updatePrimaryDeliveryCTA`): Automatically tunes action label for Shopify, Amazon A+, Social Media, or Universal ZIP.
- Publish readiness dashboard (`computePublishReadiness`): 4-dimensional score across visuals, copy, hosting, and SEO.
- Local autosave (`scheduleDraftAutosave`, `saveStudioDraft`): 1.5-second debounced local persistence with header timestamp status.

### Factual Integrity Gate & No Fallback Copy

- Strict prohibition of fabricated / fallback copy: When AI copy generation fails or lacks verified facts, never fabricate template slogans, prices, discounts, warranty durations, return policies, or material certifications. Failure is failure; fallback copy causes merchant and consumer misunderstanding and legal compliance risk.
- `generateDtcSectionCopy` strictly returns `null` and records `task.dtcCopyError` on failure or unverified output.
- `prepareTaskDtcCopy` returns `{ hasCopy: false, isCopyFailed: true }` without injecting `MODULE_DEFAULT_EN` slogans.
- Structural sections (`renderDtcStepsSection`, `renderDtcSpecsSection`, `renderDtcBundleBoxSection`, `renderDtcBundleSavingsSection`, `renderDtcFaqSection`) render explicit status cards (`.dtc-copy-status-card`) with retry buttons (`retryTaskAuxiliaryStep`) instead of hallucinated prices, alloys, certifications, 24h shipping, or warranty terms.
- 5 DTC layouts (Editorial, Minimalist, Bento, Lookbook, Technical) consistently display `.dtc-copy-status-card` when `hasCopy` is false, with inline retry and inspector edit capability.
- `cleanDtcExportHtml` purges `.dtc-copy-status-card` to ensure internal retry UI never leaks into exported Shopify/WordPress HTML.
- Language boundary: When target language is English, Chinese copy is flagged as mismatched and blocked from rendering on English PDPs.

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

### Unified AI API Retry & Fault Tolerance System

- Single Controller Principle: All synchronization, backoff, and retry orchestration are strictly owned by backend `retry_service.py`. Long-running AI generation requests in frontend `fetchWithRetry` must not re-issue duplicate network requests.
- Google GenAI SDK explicit locking: Google SDK transport clients must configure `HttpRetryOptions(attempts=1)` to disable invisible internal retries and prevent multiplying backoff loops.
- Two-Tier Capability Matrix (`provider_capabilities.py`): Fine-grained per-provider and per-operation capabilities declare idempotency headers (`supports_idempotency`, `header_name`), `supports_retry_after`, and `has_side_effect_on_read_timeout`.
- AMBIGUOUS_OUTCOME Circuit Breaker: Non-idempotent operations (image generation, WordPress media upload) encountering network read/write timeouts after request submission strictly halt automatic retries and forbid silent fallback provider switching to prevent double charging or duplicate remote assets.
- Exponential Backoff & Jitter: Adheres to `Retry-After` response headers, respects global time budgets (`max_elapsed_time`), and applies Full Jitter randomization.
- SSE Real-time Feedback & Redaction: Retry progression broadcasts via SSE `ai_retry` events with attempt counts and wait durations. Final failure messages are scrubbed of Python traces, internal IPs, and upstream URLs via `formatFriendlyDetailErrorMessage`.

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
