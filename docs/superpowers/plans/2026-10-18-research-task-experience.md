# 选品研究任务体验实施计划

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 历史设计与实施计划**
> 保留方案、任务勾选和原轮次证据；任务勾选不表示本轮重新执行，也不构成新的执行授权。
> 当前入口与验证范围：[项目当前状态](<../../项目当前状态.md>)；[2026-10-26流程修复与边界](<../../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用户知道从哪开始、当前需完成什么、缺哪些事实，以及研究结果意味着什么。

**Architecture:** 保持现有命令、十阶段、数据和后端门槛。在前端增加纯函数业务任务投影，供商品档案、项目入口与结果摘要复用；不增设数据库或第二套规则。风险与认证使用现有后端支持的未知值，不迁移历史记录。

**Tech Stack:** 原生 JavaScript ES modules、FastAPI、SQLite、node:test。

**Spec:** docs/ux-audit/2026-10-18-task-flow/选品研究-任务体验分析与改进方案.md

## Global Constraints

- 不修改现有评分和证据门槛，不将未知改成0或低风险。
- 不改写历史数据，不自动调用外部服务、批准测试、投放或同步。
- 不覆盖草稿、人工输入或无关工作区修改。
- 保留十阶段入口、原有操作与命令身份，减少主流程认知负担。

## Review Focus

- 观察/淘汰/备选记录及失效决定不能显示成商品通过。
- 新风险和认证未知不得因表单默认值提交为已核实；明确false必须保留。
- 未提供steps、旧结构和缺口细项时不编造检查结果。
- 缺口入口只导航，不自动写入评分或发起收费请求。
- 四段导航保留十阶段能力，切换不跨商品、不隐式提交。

## Task 1: 业务任务投影

Files: 新增 `frontend/js/research-workbench/services/journey.mjs` 和 `frontend/tests/research-workbench/journey.test.mjs`。
Interfaces: `journeyGroups` 四组；`stepStatusLabel(step,product)`；`productTasks(product)` 返回有明确阻塞状态的阶段；`decisionSummary(product)` 返回标签、理由和是否失效。

- [x] 添加测试：四组覆盖十阶段一次；通过的decision/review显示已记录/已保存；失效决定明确；未知步骤不编造任务完成。
- [x] 运行测试观察预期失败，实施纯投影，重新运行通过。

## Task 2: 商品任务与安全表单

Files: `pages/product.mjs`、`components/forms.mjs`、`frontend/css/research-workbench.css`、product测试。
Consumes: Task1投影。Produces: 四组导航+保留详细十阶段入口；具体待办可直接切到对应阶段；风险/认证未知不误提交；成本派生仅供预览。

- [x] 添加失败测试：任务入口导航不写入；风险初始空、明确历史值保留；认证空/false/true序列化；拒绝未核实风险提交；派生收入不覆盖用户值。
- [x] 实施导航与任务卡，状态文案分型；表单必填校验使用原生reportValidity兼容测试环境；未知风险可保存草稿但不能保存未核实风险为low。
- [x] 本地成本预览只计算售价×件数参考收入，明确非实际客单价、实际利润仍由后端计算。
- [x] 运行相关测试通过。

## Task 3: 起点与结论

Files: `pages/projects.mjs`、`pages/project-forms.mjs`、`pages/focused-exploration.mjs`、`pages/reports.mjs`、`settings.mjs` 与对应测试。

- [x] 添加失败测试：入口解释交付；输入提示；结果直接显示商品人工决定/证据状态；日志名称使用业务词；AI匹配不显示人工确认。
- [x] 实施基于现有数据的下一步入口、按商品展示结论并保留下载/复盘；不增加第二套评分。
- [x] 运行整个前端测试套件、修改脚本语法检查、diff检查。

## Task 4: 浏览器验证与记录

- [x] 使用当前内置浏览器查看项目入口、商品四组、缺口跳转、风险表单、结论；不保存生产业务记录、不新增外部调用。
- [x] 保存截图、执行结果和剩余工作。保留现有运行进程；仅在确需后端更新时才按项目启动规则重启。

## Execution rulings

- 用户已明确“改”，在当前会话直接实施，无需再次审批同一范围；不创建新线程。
- 当前大量未提交的融合及修复是交付基线，原工作区就地增量修改；不复制丢失的本地状态、不自动commit。
- 本计划交付分析方案前两批的用户任务层，并改善结果摘要；跨重启的新增任务编排另需执行器级实施，不能伪装为前端批量请求。本轮不声称交付自动选品全流程。

## 验证记录

- Task 1–3: 红绿测试后实施；独立 6.1 Sol 审查发现备选过期引导问题，已补回归修复。
- 浏览器发现跨项目结论跳转需要读取权威项目，已复用历史入口的带导航时序保护的只读加载，并补集成回归；结果默认只显示所选项目。
- 认证旧布尔草稿兼容已补测，不改变待核对提交身份。
- Task 4: 内置浏览器验证新起点、四组任务、具体缺口跳转、未知风险和项目结论筛选；未保存业务表单、未发起收费任务。
- 本轮未修改后端代码/依赖/数据库，不需要重启现有服务。更详细记录见 docs/ux-audit/2026-10-18-task-flow/实施与验证记录.md。
