# 选品研究导航与确认体验修复计划

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 历史设计与实施计划**
> 保留方案、任务勾选和原轮次证据；任务勾选不表示本轮重新执行，也不构成新的执行授权。
> 当前入口与验证范围：[项目当前状态](<../../项目当前状态.md>)；[2026-10-26流程修复与边界](<../../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复用户截图中的入口错位、返回缺失与步骤不可返回，并简化相关性依据填写。

**Architecture:** 保留原生工作台与命令/API，仅修正页面导航状态、导航组件和确认表单呈现。导航历史只保存页面位置，不恢复旧业务快照；草稿沿用现有生命周期与存储。

**Tech Stack:** Vanilla JavaScript ESM、既有 CSS、Node test、Mac Electron。

**Spec:** 本轮用户六项反馈与附图；按既有授权直接实施，不另行要求用户确认技术细节。

## Global Constraints

- 不改变证据、版本、审批、预算门槛；不自动调用 AI、采集或写飞书。
- 保留业务数据、已有草稿及任意历史相关性文字；不清理无关工作区修改。
- 本轮不提交 Git；直接维护用户当前已集成工作区，不迁移旧脏文件。

## Review Focus

- 找线索必须进入 keywords，并标记第一步；核实商品进入 leads。
- 返回不覆盖最新项目数据、不回放写操作；跨项目读取必须校验生命周期。
- 无商品时点击后续阶段应明确提示，不能静默落回同一页。
- 常见依据、其他自填、旧历史文字、取消与草稿恢复均保留 reason 字符串协议。
- 长项目名、窄窗口、大字号、菜单键盘/外部点击不能遮挡工具栏或横向溢出。

### Task 1: 导航与返回

**Files:** index.mjs、components/navigation.mjs、services/navigation.mjs、components/presentation.mjs、tests/research-workbench/navigation-feedback.test.mjs。

- [x] 写回归测试：找线索进入关键词；平铺入口；无商品后续步骤提示；相同页刷新不重复入历史、返回使用最新数据、历史有界。
- [x] 运行测试观察真实失败。
- [x] 导航组件提取、修复步骤状态，增加工作台内返回历史与首页兜底。
- [x] 运行相关测试并浏览器核对。

### Task 2: 相关性依据与布局

**Files:** components/forms.mjs、pages/product.mjs、research-design.css、frontend/index.html、tests/research-workbench/navigation-feedback.test.mjs。

- [x] 写测试：选择常见依据生成原有 reason；其他及旧值不丢失；选择不会自动确认相关性或提交。
- [x] 运行观察失败，再实现最小建议选择器。
- [x] 顶部用正常布局、两项入口平铺；下拉面板相对触发器定位；补状态与可访问说明。
- [x] 全前端测试、语法及 diff 检查；浏览器及实际客户端只读/草稿验收。

### Task 3: 交付

- [x] 单独复核新任务差异，修复必要问题。
- [x] 保留旧 app，更新本机客户端前端资源，验证签名及资源一致性。
- [x] 更新本轮验收记录与当前状态，说明客户旧安装包不会自动改变。

执行完成：见 [验收记录](../../ux-audit/2026-10-24-research-navigation/验收记录.md)。未提交Git；保留原工作区改动及逐文件回滚副本。
