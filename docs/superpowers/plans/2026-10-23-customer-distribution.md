# Customer Distribution Implementation Plan

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 历史设计与实施计划**
> 保留方案、任务勾选和原轮次证据；任务勾选不表示本轮重新执行，也不构成新的执行授权。
> 当前入口与验证范围：[项目当前状态](<../../项目当前状态.md>)；[2026-10-26流程修复与边界](<../../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 制作不带开发者状态、可独立初始化和保留数据升级的 Mac 客户测试候选包。

**Architecture:** 保留 Electron、FastAPI、原前端。新增专用客户初始化和冷启动版本备份；客户设置通过现有研究会话保护的接口管理。发行构建使用明确资源白名单，独立应用身份和数据目录。

**Tech Stack:** Python 3.12 / SQLite / FastAPI / vanilla JS / Electron 44.9.1。

**Spec:** `docs/superpowers/specs/2026-10-23-customer-distribution-design.md`

## Global Constraints

- 不改动自用客户端和数据；不提交、清理或回退现有脏工作区。
- 不预置 API 密钥；后台默认暂停；不进行收费调用或飞书写入。
- 版本 0.2.0；固定客户应用身份和数据目录；Apple Silicon。
- 保留历史迁移授权校验；仅全新空库使用独立 fresh_install 授权。
- 无正式签名、公证及第二台 Mac 验证时标记客户测试候选包。

## Review Focus

1. 初始化中断、重复启动不能覆盖既有数据；Task 1 验证原子发布及锁。
2. 已存在数据库、坏 marker、坏签名、降级必须拒绝；Task 1 验证拒绝且原文件不变。
3. 升级备份必须包含 DB/WAL 逻辑状态、证据、密钥和浏览器业务草稿；Task 1 验证完整快照及锁冲突拒绝。
4. 设置配置不能绕过本机 Origin/会话令牌或在浏览时启动付费任务；Task 2 验证接口保护和默认暂停。
5. 打包资源不能携带开发者数据和绝对路径；Task 3 验证白名单、秘密内容检测及实际制品审计。

### Task 1: Independent customer lifecycle

**Files:** `backend/services/customer_distribution.py`, `backend/services/research_activation.py`, `backend/desktop_entry.py`, `desktop/main.cjs`, `desktop/distribution.cjs`, `backend/tests/test_customer_distribution.py`, `desktop/tests/distribution.test.cjs`。

**Interfaces:** `prepare_customer_data(data: Path, version: str) -> dict`; `distributionPaths(appData, profile) -> {data,profile}`; 资源内 `release.json` 的 channel/version/schema 字段。

- [x] 编写并运行独立初始化、坏目录/签名拒绝、重启保留和版本备份测试，确认 RED。
- [x] 实现原子空库创建、独立签名授权、冷启动备份和应用身份隔离。
- [x] 运行 `.venv/bin/python -m pytest backend/tests/test_customer_distribution.py backend/tests/test_desktop_entry.py` 和桌面测试。Expected: 全通过。

### Task 2: Customer setup and operating controls

**Files:** `backend/routes/customer_setup.py`, `backend/main.py`, `frontend/js/customer_setup.mjs`, `frontend/index.html`, `frontend/js/brand_context.js`, `backend/tests/test_customer_setup.py`, `frontend/tests/research-workbench/customer-setup.test.mjs`。

**Interfaces:** GET/POST `/api/research/workbench/v1/customer-setup` 仅客户版、复用研究会话；前端原生模块入口。

- [x] 编写未配置状态、业务参数验证、显式启用/暂停、跨站拒绝和空品牌列表测试，确认 RED。
- [x] 实现可重新打开的首次引导、研究规则确认与采集/观察轮询开关；更改提示正常退出重开生效。
- [x] 运行接口与前端专用测试。Expected: 全通过，零外部请求。

### Task 3: Reproducible clean package and manual updates

**Files:** `scripts/desktop/build_customer.py`, `scripts/desktop/verify_customer.py`, `desktop/build/customer-package.cjs`, `backend/tests/test_customer_package.py`, 客户使用/更新说明。

**Interfaces:** 明确工具路径和新输出目录；禁止从自用数据目录打包；生成 app、DMG、SHA256 及 release 检查报告。

- [x] 编写包内秘密/私有状态和工具白名单测试，确认 RED。
- [x] 实现独立构建、资源审计、版本元数据和发布前签名门禁。
- [x] 运行构建测试并制作独立候选包。Expected: 审计通过；无正式证书时明确 candidate。

### Task 4: Acceptance and handoff

**Files:** 验收记录、客户安装升级说明、项目当前状态。

- [x] 执行前端、后端、桌面完整回归，检查所有改动脚本语法和 diff。
- [x] 冻结程序新建独立数据、重启及版本升级演练；验证无 API 凭据、零历史、独立密钥、暂停后台。
- [x] 安装包校验、实际桌面首次引导核验，保留原自用安装。
- [x] 由 GPT-6.1-sol 进行一次独立代码审查，修复重要问题并补回归。
- [x] 交付候选包、SHA256、客户说明、升级/回滚说明和未完成外部条件。
