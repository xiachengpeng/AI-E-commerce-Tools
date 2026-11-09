# Trends Query Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用户确认系统准备的商品查询词后即可查询两个 Trends 时间窗口。

**Architecture:** 新前端服务负责按身份复用、提取商品原文、调用主应用文本 AI 并校验候选。确认组件负责展示及编辑，仍用现有 createActionService 入队，仅成功入队后保存本地查询偏好。

**Tech Stack:** Vanilla JavaScript ES modules、node:test、现有 callAI(text)。

**Spec:** docs/superpowers/specs/2026-11-01-trends-query-design.md

## Global Constraints

- 不改后端证据门槛、不自动采集、不增加依赖、不自动提交仓库已有修改。
- 同一查询用于12个月和5年；AI 候选不构成需求/热门程度证据。
- 身份、市场与来源绑定；旧手动提交与未知结果的 UUID/输入保护继续有效。
- 验收使用隔离合成数据，不触发真实收费任务。

## Review Focus

- 异步结果晚于用户输入/页面销毁/身份切换，不能覆盖或跨商品提交。
- 本地查询失效、存储禁用、历史证据多个查询，不能盲目复用或影响既有任务。
- AI 空输出、引用不存在、品牌词/链接，不生成虚构替代建议。
- 不同模型返回多个 text parts 或 JSON 代码围栏，仍校验为有界候选。
- 模态窗口新增备选按钮后，主提交按钮和键盘焦点仍正确。

### Task 1: 查询准备服务

**Files:** 新增 frontend/js/research-workbench/services/trends-query.mjs 与 frontend/tests/research-workbench/trends-query.test.mjs。

**Interfaces:** trendsQueryBinding(project,product)、restoreTrendsQuery(context,product)、rememberTrendsQuery(context,product,candidate)、prepareTrendsQuery(context,product)。候选含 query、meaning、source_quote、basis；建议调用注入 context.context.callAI 或现有 globalThis.callAI。

- [x] 写失败测试：身份/市场隔离、已确认词复用、两个历史窗口冲突、无资料不调用 AI、引用校验与一次调用。
- [x] 运行测试，确认缺少功能导致失败。
- [x] 实现服务，验证上述行为与存储不可用容错。

### Task 2: 确认窗口与采集衔接

**Files:** 修改 components/action-confirmation.mjs，新增 components/trends-query-editor.mjs 与相关确认组件测试；必要时追加轻量 CSS。

**Interfaces:** 查询编辑器返回 query 输入与当前候选，提交仍只传 query；rememberTrendsQuery 仅在成功入队后调用。

- [x] 写失败测试：自动推荐与中文释义、用户输入保护、失败补充资料入口、主按钮定位、过期身份禁止提交、成功记忆与未知提交保护。
- [x] 实现编辑器与生命周期保护，保留手动查询和旧任务重试。
- [x] 运行定向测试与完整前端测试、语法和差异检查。

### Task 3: 本机交付

**Files:** 本机忽略目录中的备份、资源校验报告；docs/desktop-client/2026-11-01-Trends查询词准备.md。

- [x] 自查修改与测试覆盖，处理影响正确性的发现。
- [x] 用隔离合成快照和注入 AI 响应验证真实 UI；不调用真实收费请求。
- [x] 备份并原位更新正式客户端前端资源，验证签名、资源哈希及正常启动，保留正式研究数据。
- [x] 记录验收范围与未重制 DMG。
