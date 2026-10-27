# Prototype Instructions

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 设计与视觉验收记录**
> 保留设计来源、视口和原轮次视觉结论；后续业务界面已有调整，不将旧版passed外推为当前全产品视觉验收。
> 当前入口与验证范围：[项目当前状态](<../../../../项目当前状态.md>)；[2026-10-26流程修复与边界](<../../../../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
