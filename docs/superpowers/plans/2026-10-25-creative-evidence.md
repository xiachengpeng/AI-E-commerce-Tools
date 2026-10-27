# 广告证据检查 Implementation Plan

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 历史设计与实施计划**
> 保留方案、任务勾选和原轮次证据；任务勾选不表示本轮重新执行，也不构成新的执行授权。
> 当前入口与验证范围：[项目当前状态](<../../项目当前状态.md>)；[2026-10-26流程修复与边界](<../../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. No delegation required for this focused feature.

**Goal:** 显示实际素材并自动检查已有证据，明确缺项及人工复核范围。
**Architecture:** Vanilla JS pure evidence evaluator + small UI panel; existing form/DTO/server gates retained.
**Tech Stack:** ES modules, scoped CSS, Node tests.
**Spec:** docs/superpowers/specs/2026-10-25-creative-evidence-design.md

## Constraints

不请求收费服务，不自动保存/通过，不按广告ID或URL差异推断创意独立性，保留草稿/版本/命令ID、媒体来源绑定与既有业务规则。

## Review Focus

零条/一条/超过三条；重复ID/素材URL；过期或未来观察；身份变更；人工新增资料与旧草稿；重复点击不丢输入。

## Task 1: Actual records and check summary

- [x] 写纯函数测试与动态表单数量/添加/提交测试，确认失败。
- [x] 实现services/creative-evidence.mjs及components/creative-check.mjs。
- [x] product.mjs按实际记录开表单，显式新增，保持原命令。
- [x] presentation.mjs移除误导性固定三栏说明、放入检查摘要及下一步。
- [x] Scoped CSS及缓存版本，运行专项和完整前端测试/语法/diff。
- [x] 仅更新客户端前端资源，签名/资源检查，实际窗口零费用验收。
- [x] 文档、截图、回滚记录；不提交Git。

## Execution ledger

Completed inline. Ruling: retain authoritative server confirmation gates; current persisted observations lack visual independence proof, so checks are advisory and uncertainty remains explicit. No new collection/AI/network checks. 882 frontend tests passed. Independent review completed; footer relocation/zero-row and submitted fingerprint guards fixed and tested; real DOM zero-to-one-to-two input preservation verified. Client resources signed/verified, backend unchanged. See dated acceptance record for evidence and rollback.
