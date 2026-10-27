# Integrated research source and provenance

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 现行入口或维护说明**
> 使用说明按当前代码同步；测试结果引用对应日期验收，本次文档整理没有运行收费链路或重新验收所有功能。
> 当前入口与验证范围：[项目当前状态](<../../../docs/项目当前状态.md>)；[2026-10-26流程修复与边界](<../../../docs/ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

Updated: 2026-10-26. This module is part of the main application; the old “Inactive research source” description no longer describes runtime integration.

Copied from approved research commit `b749491c29fce8ac5bdad613f1ef569cb6df186b`.
Source archive SHA256: `45f2311698da4d9fa6a2c0f59829bb362a4ca3ea2d448204396f6fc1cef269eb`.

The commit/archive identifiers above describe the imported source, not a hash of the current working tree. The integrated `rabbit_hole/` implementation has subsequent adapter and business fixes; do not claim it remains byte-for-byte identical to the source archive. The current module is used through the main research facade/routes and shared lifecycle, subject to explicit local activation/configuration.

`compat/` preserves original CLI, automation, operations documentation, frontend/icon attribution and build/test material for compatibility verification. Its old standalone startup/deployment instructions are historical and are not the main application entry point. Do not update copied compatibility fixtures or license attribution merely to synchronize product docs.

Main runtime: `run.py`, FastAPI on9503, `frontend_server.py` on9502, canonical SQLite and private research evidence root. Native UI lives in `frontend/js/research-workbench/`. No remote source checkout, SSH tunnel or old frontend is required for normal local operation. See [current project state](../../../docs/项目当前状态.md).

## Dependencies and isolated verification

`backend/requirements.txt` uses constraints from `requirements-full-merge.lock`; use the existing unified environment. The compatibility `pyproject.toml` is historical metadata, not a replacement main install entry point.

For the complete isolated suite, use the existing Python environment to run `scripts/full_merge/run_tests.py --suite main|research|all --output <private-temp>`. Read the runner's dependency/browser prerequisites first; it copies source into isolated sandboxes and requires existing compatible frontend packages and browser tooling. Do not use live SQLite, actual provider credentials or external writes for verification. Test caches/dependencies are not part of this documentation update.

Original frontend assertions are mapped in `docs/merge-assessment/full-merge-coverage.json`. Inventory preservation and local fixture tests do not establish real provider, collection or sync success. Source/licensing attribution in `compat/frontend/ui-icons/` remains intact.

## 2026-10-26 integrated workflow changes

The native UI now exposes triage/recovery, explicit completed-keyword rescans, and funnel/score tasks within their business stages. `application/actions.py` validates `rescan_of` against the same project and keyword, deduplicates a successor per completed task, and requires the matching `retry_action_id` for explicit blocked recovery. Do not replay unknown outcomes or change accounts automatically. No schema migration or historical evidence threshold change was made.

Latest scoped verification: 898 frontend, 1326 isolated main-backend, 43 focused research and 15 desktop tests passed; focused suites are not additive global totals. The aggregate runner's all-files frontend `--test-isolation=none` invocation has a documented global-state collision; the documented normal frontend command and per-file guarded runs passed. Do not claim the aggregate command succeeded end-to-end. See [repair acceptance and limitations](../../../docs/ux-audit/2026-10-26-sop-flow-repair/验收记录.md).

Ad age plus a recent active observation does not establish uninterrupted delivery for 30 days. This integration still requires historical source evidence to prove continuity; absent evidence remains unknown. No paid end-to-end collection or Feishu write was rerun during this repair acceptance or documentation synchronization.
