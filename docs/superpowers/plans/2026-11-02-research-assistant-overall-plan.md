# 选品研究助手整体改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after the product design is approved. 本轮只出计划，不实施，不自动提交现有工作区修改。

**Goal:** 由项目研究方向自动准备搜索方案，经明确审核发现广告与商品，接续保留、核对、评分、决定、测试和复盘，减少重复输入和人为导航。

**Architecture:** 保留原项目聚合、十步骤和任务系统。新增持久助手运行与步骤记录，调度已有 actions；新增有来源的提取草稿任务，所有正式保存仍调用原领域命令。界面从助手状态和权威缺项展示主要下一动作。

**Tech Stack:** FastAPI、Python、SQLAlchemy/SQLite、现有 AI 路由与研究 adapter、原生 JS ES modules、node:test、pytest；不新增前端框架或云服务器。

**Spec:** ../specs/2026-11-02-research-assistant-overall-design.md（本计划逐条对应的产品方案，实施前必须同时阅读）。

**状态：** 2026-11-02 待用户审阅。取代 2026-11-01 草案；本轮仅静态核对源码和文档检查，没有真实采集或收费请求，也未运行应用测试。

## Global Constraints

- 初始关键词根据已保存研究方向和市场准备；系统准备词是主流程，手填词与商品链接是辅助。
- 已有项目不重复询问方向；每个项目一个市场，更换市场创建新项目，不原地混用证据。
- 人工审核可见实际搜索词后才 scan；扩词需有效来源与相关性，不能无限自动搜索。
- 默认建议首批最多 3 个词、一次深入 1 个明确保留商品，仍受更严格的既有规则限制；初始建议原上限 30 不扩张。
- 正式 focus_product 要求 retained；triage、身份确认、最终决定及测试批准各自保留独立语义与理由。
- 后台十步骤、服务端 requirement_statuses、粗筛、成本、评分、决策及版本门槛保持权威，不依 mockup 放宽。
- AI 匹配和提取草稿显示其来源与方法；不伪造人工确认，不把相对热度当销量。
- 经济模型为 18 个必需字段；未知不补 0，页面售价不当采购成本，报价口径与有效期保持原校验。
- 复用当前设置和主设置唯一编辑器；模式、账户、模型变化不静默替换进行中任务。
- 使用原研究数据根、签名/激活/台账和进程所有权。后台默认运行不等于允许新收费请求；不新增全局关闭开关。
- 调度按本次已授权范围和预算；不确定提交先恢复回执，不自动重发；完成词重搜保留 rescan_of。
- 不改实际商品判断，不自动发送飞书/其他同步，不投放、付款、发布或自动覆盖营销数据。
- 本轮不运行原 worker 验证 UI；实施验收使用隔离数据，真实集成单独记录授权和额度。
- 修改前保护工作区已有改动；正式数据与凭据不复制进可公开原型、测试或截图。

## Review Focus

1. AI 初始词、原文扩词、商品 Trends 词用途不同；身份或来源过期时不得错用缓存或扩大搜索。（任务 3、5、6）
2. 预览、保留与深研不能混同；保留保存成功但 focus/建运行失败时须恢复原中间结果。（任务 4）
3. 自己的任务成功会增加 project.version；必须区分正常版本增长与方向、规则、账户、来源的真正失效。（任务 2、6）
4. 批量审核/核对部分保存、断网或租约失效后，不能换命令 ID 再发或重复调用付费服务。（任务 3、4、6、7）
5. 新表注册可能影响旧迁移报告校验；升级不能让已恢复的唯一正式数据被误判、替换或退回临时副本。（任务 2、9）

## 关键术语与接口提案

以下是新增设计，不是已经存在的 API 或源码。

- AssistantRun：项目内一次有限目标运行。intent 为 prepare_keywords、research_product、prepare_expansion 之一，分别准备初始方案、研究保留商品、准备来源扩词；每个 intent 只能执行自己授权的阶段。
- 运行状态：preparing、awaiting_scope、discovering、awaiting_candidate、awaiting_product_review、researching、awaiting_evidence、ready_for_decision、completed、paused、blocked、stopped。它们仅是助手执行状态，不替代领域步骤。
- RunRequest：command_id、expected_version、intent、可选 product_id/keyword_id、limits；服务端根据意图和实际依赖确定可用范围，拒绝任意动作列表。
- ScopeApproval：command_id、expected_version、stage（search/trends/expansion_search）、plan_digest、可见 selected_keyword_ids 或 query、limits。搜索审批只覆盖显示且审核的词；趋势审批只覆盖当前商品同词双窗口。
- RunDTO：run_id、project_id、product_id、intent、status、phase、revision、scope摘要、关联 task_ids、missing、next_action、pause_reason、结果摘要。禁止返回凭据。
- next_action：kind、target、requires_user、reason、enabled。正式缺项引用服务端的 key，不另写前端通过规则。
- DraftBundle：product_id、identity_revision、source_digest、origin=automated_draft、confirmed=false、带 source_id/source_kind/content_hash/source_quote 的字段、unknown_fields，以及可选 Trends 候选词。草稿不写入正式 evidence/funnel/economics。

拟新增路径均在现有 /api/research/workbench/v1 前缀下：

- POST /projects/{project_id}/assistant-runs：创建有限运行；返回持久回执。
- GET /projects/{project_id}/assistant-runs：读取进行中/历史运行，不触发处理。
- GET /projects/{project_id}/assistant-runs/{run_id}：读取真实状态。
- POST /projects/{project_id}/assistant-runs/{run_id}/scope：显式审核可见方案。
- POST 同一 run 下的 /pause、/resume、/stop：停止新派发、按原范围受约束恢复、结束该运行；不关闭全局后台。

正式数据保存仍走现有 /commands 与回执查询，新增接口不得接受“全部通过”或任意代用户决策的请求。

## 文件职责

| 类别 | 文件 | 职责 |
| --- | --- | --- |
| 新增 | backend/models/research_assistant.py | 上述请求、DTO、草稿引用结构 |
| 新增 | backend/modules/research/rabbit_hole/persistence/assistant_runs.py | 运行/步骤表、租约、唯一键和回执 |
| 新增 | backend/modules/research/rabbit_hole/application/assistant.py | 授权范围、依赖调度、下一动作与阶段恢复 |
| 新增 | backend/modules/research/rabbit_hole/application/research_drafts.py | 来源约束的商品查询词、Meta/页面草稿，调用现有 extract 操作 |
| 修改 | backend/modules/research/rabbit_hole/application/actions.py、runner.py | 注册 extract 草稿任务、预算/指纹/取消和结果持久化；已有任务复用 |
| 修改 | backend/modules/research/rabbit_hole/persistence/sql.py | 新表明确注册与受控升级 |
| 修改 | backend/routes/research_workbench.py | 助手 API、项目访问及版本检查 |
| 修改 | backend/services/research_worker.py | 在现有唯一 worker 所有权内接入助手循环 |
| 修改 | backend/services/research_integrations.py、research_ai_usage.py | extract 依赖注入与既有逻辑额度接入，不另建 AI 客户端 |
| 新增 | frontend/js/research-workbench/services/assistant.mjs | RunDTO/API、持久回执与页面生命周期 |
| 新增 | frontend/js/research-workbench/components/research-assistant.mjs | 项目概览、运行进度和下一动作展示 |
| 新增 | frontend/js/research-workbench/components/search-plan.mjs、evidence-review.mjs | 可见词组审批、集中事实核对 |
| 修改 | frontend/js/research-workbench/index.mjs、pages/project-forms.mjs、pages/projects.mjs | 起点、方向复用、恢复及原编辑器衔接 |
| 修改 | pages/focused-exploration.mjs、pages/product.mjs | 候选初筛、来源核对、成本与决定接入 |
| 修改 | services/actions.mjs、services/journey.mjs、components/presentation.mjs、components/workflow-controls.mjs、frontend/css/research-polish.css | 新任务名称、权威状态映射、布局与共享导航兼容 |

其中 pages/、services/、components/ 未带完整路径的前端项均位于 frontend/js/research-workbench/。现有 trends-query.mjs、身份对照、草稿编辑、媒体租约、报告和十步骤继续复用。frontend_server.py 已按研究路径前缀代理，新增子路由不应扩大可转发域；新增 relay 回归证明无请求重放。

## 任务 1：先锁定完整交互，再选视觉

**Files:** 产品方案；隔离原型拟位于 debug/research-assistant-prototype-20261102/；验收记录拟为 docs/ux-audit/2026-11-02-research-assistant/设计核对.md。

**Consumes:** 配套产品方案、现有共享导航与实际截图。
**Produces:** 可追溯的全节点流程与可点击设计原型；不接真实服务。

- [ ] 逐项走查方向来源、词来源、搜索审批、候选 triage、身份、粗筛、趋势查询词、渠道、成本、决定、测试与复盘，记录每个输入是谁提供。
- [ ] 方案审阅后按 Product Design 生成覆盖正确逻辑的视觉选择；此前两批图不复用为目标。
- [ ] 视觉目标选定后制作隔离原型，完整覆盖顺利路径、失败路径及返回/恢复；所有数据标为演示。
- [ ] 实际点击一次新建项目路径和一次已有项目路径，记录输入、判断、提交和页面切换；不按画面数冒充操作数。
- [ ] 原型审阅确认后才接入产品实现。

## 任务 2：持久运行、绑定与升级

**Files:** 新增 models/research_assistant.py、persistence/assistant_runs.py；修改 persistence/sql.py。
**Tests（新增）:** backend/tests/research/test_assistant_runs.py。
**Interfaces:** AssistantRunStore.create(project_id, request)、get(project_id, run_id)、claim_next(owner, now)、checkpoint(run_id, expected_revision, patch)、record_step(run_id, step_key, input_digest, task_id)；全部异步，返回上述 DTO 或步骤记录。

- [ ] 写失败测试：同 command_id 同内容复用、不同内容冲突；项目隔离；重复 claim 单所有者；步骤唯一键；正常版本增长不失效、相关输入变化使范围过期。
- [ ] 写升级失败测试：空库、已有项目库、带已验证迁移报告的库，旧项目/证据/命令/设置不丢；没有验证的迁移仍拒绝。
- [ ] 运行新测试，确认因缺少实现而失败。
- [ ] 实现新表 assistant_runs 与 assistant_steps。运行记录存意图、相关指纹、授权快照、额度、状态/修订、租约及回执；步骤唯一键为 run_id + step_key + input_digest。
- [ ] 新表导入加入 initialize_sqlite 明确注册；有旧迁移标记时走受控升级并验证新表/旧证据，不能删除标记或放宽迁移校验。
- [ ] 运行新测试及 test_sqlite_storage.py、test_local_migration.py，通过后检查差异仅涉及本任务。

## 任务 3：从方向准备搜索方案并显式审核

**Files:** application/assistant.py、routes/research_workbench.py；新增 components/search-plan.mjs、services/assistant.mjs；修改 project-forms.mjs、index.mjs。
**Tests（新增）:** backend/tests/research/test_assistant_scope.py、frontend/tests/research-workbench/search-plan.test.mjs。
**Interfaces:** prepare_keyword_run(store, request, actor)、approve_scope(store, run_id, approval, actor)；renderSearchPlan(context, runDTO)；createAssistantService(context).create/get/approve。

- [ ] 写失败测试：新项目范围/市场必需；已有方向不重填；有效建议中文释义；AI 无结果不补词；推荐最多 3 个但不超过有效规则；空/隐藏/过期/超额方案禁止提交。
- [ ] 写失败测试：词被改、项目方向变化或账户切换后旧 plan_digest 不可审核；双击与审核后断网不重复批准/扫描；以前的完成词不能凭新方案暗中重搜。
- [ ] 运行新测试确认失败。
- [ ] 准备阶段只创建既有 keywords 任务，复用已存有效结果；不在 GET/打开页面时生成新调用。
- [ ] approve_scope 核验所见词 ID、文本、市场、配置及摘要，在原事务/命令体系逐项明确 approve_keyword，连同 scope 和待派发步骤持久记录；使用稳定命令 ID 和原校验，不能用 automation 伪造审核。
- [ ] 前端展示方向和搜索方案，主按钮对可见词组审核并入队；多项审核后实际任务回执由助手读取，不自行生成假进度。
- [ ] 新测试及 initial_keyword_policy、project_direction、confirmation-dialog、keyword-feedback 对应现有测试通过。

## 任务 4：候选取舍、保留理由与身份/粗筛

**Files:** focused-exploration.mjs、product.mjs、research-assistant.mjs（新增）；复用原身份/creative-evidence/triage 组件。
**Tests:** candidate-switch.test.mjs、product-identity-dialog.test.mjs、creative-evidence.test.mjs；新增 assistant-candidates.test.mjs。
**Interfaces:** 新建前端 continueRetainedProduct(context, productId, dispositionDraft)，内部依次原 triage_product → focus_product → 创建 research_product 运行；每步独立回执与稳定命令；不另加绕过 triage 的后端命令。

- [ ] 写失败测试：点预览不保存 triage；未保留不能 focus；理由未保存不能宣称已深入；保存 retained 后 focus 失败可续做且不重复 triage。
- [ ] 写三种身份结果、矛盾 payload 拒绝、旧 false 记录仍为未核实、人工结果不被 AI 覆盖、不一致不自动淘汰、改商品 URL 后失效、独立创意未知、少素材与跨候选迟到响应的回归。
- [ ] 运行新增/修改测试确认失败。
- [ ] 实现同页预览、明确取舍和理由表单，恢复每步回执；观察/淘汰不删除历史。
- [ ] 展示原来源对照与广告粗筛检查，AI 严格匹配单独标识，人工确认继续调用原命令。
- [ ] 上述前端测试、media-navigation.test.mjs 以及 test_workbench_domain.py、test_workbench_ad_evidence.py、test_workbench_verification.py 通过；候选切换/销毁释放原媒体租约与异步任务。

## 任务 5：有出处的草稿与商品趋势查询词

**Files:** research_drafts.py、models/research_assistant.py、actions.py、runner.py；接入 research_integrations.py/research_ai_usage.py 的既有 extract 操作。
**Tests（新增）:** backend/tests/research/test_assistant_drafts.py。
**Interfaces:** prepare_research_draft(project, product_id, sources, ai_adapter, action_context) → DraftBundle；validate_draft_bundle(bundle, current_sources) → DraftBundle。新 action.kind=extract，result 存草稿，不调用 evidence/funnel/economics 正式命令。

- [ ] 写失败测试：未核实商品/分类页无法准备专属查询；探索词不能直接替代商品词；品牌词/空词/伪造引用被拒；来源改动不复用。
- [ ] 写失败测试：Meta 样本量不冒充广告主总数；页面缺 CTA/卖点时保持未知；提取不生成确认；来源内指令不能改变任务；秘密/原始响应不泄漏日志。
- [ ] 运行新测试确认失败。
- [ ] 复用严格商品来源与 trends-query 已有边界，将助手所需准备迁入持久 extract 路径，保留旧前端入口兼容；extract 的 target_signature、预算列表、失败/停止映射与引用验证成套接入。
- [ ] 使用现有 ResearchAIAdapter 的 extract 操作，逻辑额度先 reserve；不绕开 AIRouter，不新建供应商 API 客户端或重复扣逻辑额度。
- [ ] 输出每项出处、未知字段及 confirmed=false；趋势两个窗口只能使用审核的同一商品词。
- [ ] 新测试及现有 trends-query.test.mjs、test_research_ai_adapter.py、test_research_ai_faults.py 通过。

## 任务 6：连续调度、预算与恢复

**Files:** assistant.py、research_worker.py、routes/research_workbench.py；复用 actions.py/runner.py。
**Tests（新增）:** backend/tests/research/test_assistant_orchestration.py；修改 test_research_worker_local.py、test_frontend_research_relay.py。
**Interfaces:** AssistantController.tick() → bool、pause/resume/stop(project_id, run_id, expected_revision) → RunDTO；在 UnifiedResearchRunner 现有所有权下调度，不新增独立进程。

- [ ] 写失败测试：初始词准备授权不等于扫描/深入授权；只派发本次方案中的已批准词，不顺带执行其他旧词；retained/focus/来源依赖不满足则 next_action 指向核对；独立资料可继续但不越门槛。
- [ ] 写失败测试：并发预算、重复 tick、派发后崩溃、已完成词重搜、未知提交、账户变更、后台未就绪、退出重开及暂停后收到外部结果。
- [ ] 运行测试确认失败。
- [ ] 每步先领取运行/步骤租约，再依稳定身份复用原 enqueue_action；按当前 scope 逐个派发 scan，不直接调用会捎带项目其他词的 scan_all；关联子任务并恢复回执。新预算是既有计量的运行内上限，不重复记账。
- [ ] 在现有 UnifiedResearchRunner 中接入助手循环；无待执行 run 时不产生外部调用，关闭/失去所有权时取消循环。保留既有激活与运行策略。
- [ ] run 只对相关方向/规则/账户/来源指纹失效；自己的成果保存导致版本增长时读取最新版本、重新检查依赖，不能无限 409 或绕过旧输入保护。
- [ ] 暂停阻止新派发，停止结束新运行但保留子任务实际状态；resume 先核对原范围与未知结果。GET 不派发且代理不重放 POST。
- [ ] 全部新测试及 scan_recovery、scan_refresh、workbench_runner、research_worker_local、frontend_research_relay 对应测试通过。

## 任务 7：集中核对与成本缺项

**Files:** evidence-review.mjs、product.mjs、services/assistant.mjs、presentation.mjs、research-polish.css。
**Tests（新增）:** frontend/tests/research-workbench/assistant-evidence-review.test.mjs；扩充 product.test.mjs、drafts.test.mjs。
**Interfaces:** renderEvidenceReview(context, {product, draft, requirements}) → HTMLElement；saveReviewedItems(context, reviewedItems, draftReceipts) → {saved, pending, conflict}，逐项使用原命令/当前版本。

- [ ] 写失败测试：双窗口独立核对、同词市场/身份绑定、Meta/页面项缺失、批量部分成功、未知回执、409、保存后不跳回空表。
- [ ] 写失败测试：18 个成本必需字段与服务端一致；报价过期、套餐/数量/币种不明、认证未知、有效值复用和手工编辑不被覆盖。
- [ ] 运行测试确认失败。
- [ ] 从当前 sources/drafts 预填原表单可确定字段；用户明确选择的项才提交 confirmed；未知项保留待办，不新增“全部通过”。
- [ ] 成本按已有/缺项/详细费用分组；本期只复用既有真实值及来源，不新增无来源通用费率或任意报价文件导入。
- [ ] 回执说明保存结果与权威剩余项；任何失败保留输入与已成功记录；保存满足依赖后助手继续，不要求找下一页。
- [ ] 新前端测试及 test_workbench_requirements.py、test_workbench_evidence.py、test_workbench_logistics.py 通过。

## 任务 8：评分、决定、测试、复盘与报告闭环

**Files:** assistant.py、research-assistant.mjs、journey.mjs、workflow-controls.mjs、product.mjs、pages/reports.mjs；必要时增强 application/reports.py 的边界展示。
**Tests（新增）:** frontend/tests/research-workbench/assistant-closeout.test.mjs；复用后台 scoring、reports、domain 测试。
**Interfaces:** next_action.kind 映射到原 evaluate、decide、test_plan、test_result、review 入口。只有 evaluate 可在当前 run 合法范围自动执行；正式判断与批准保持用户原命令。

- [ ] 写失败测试：缺项只出初步摘要、评分过期重核、硬门槛未通过不进测试池；保留与正式决定不混同。
- [ ] 写失败测试：计划无自动投放、测试无结果不复盘成功、实际结果修订/作废保留历史；复盘新词待审核；报告缺项清晰。
- [ ] 运行测试确认失败。
- [ ] 实现正式评分前自动检查并调用原 evaluate；缓存/重复 tick 复用同一当前评估结果，证据变化才重算。
- [ ] 决定与测试表单复用现有生命周期，预填有依据建议但不默认提交；测试结果仍来自真实报表。报告与可选营销交接保持来源版本，不自动飞书同步。
- [ ] 全部新测试及 journey、sop-flow、native-workflows 和后台 workbench_scoring、workbench_reports、workbench_domain 测试通过。

## 任务 9：全链路验收与客户端交付

**Files:** 新增 docs/ux-audit/2026-11-02-research-assistant/验收记录.md；完成后更新 docs/项目当前状态.md；安装证据放忽略目录。

- [ ] 使用隔离合成数据按产品方案“异常分支”逐行走通，记录真实输入/点击/独立判断数，并列出额外人工的原因。
- [ ] 验收既有项目、新项目、已有词复用、无结果、身份疑点、素材不足、部分渠道失败、成本缺失、决定/测试/复盘、重启恢复。
- [ ] 执行完整前端套件、所有修改 JS/MJS 语法检查、相关后端及完整 backend/tests 回归；报告环境限制和未覆盖部分，不复用旧成绩。
- [ ] 运行 git diff --check；新文档和未跟踪文件另做内容/格式检查，不混入已有用户修改。
- [ ] 正式安装前备份现有客户端与同根正式数据，验证新增表升级、旧记录/设置/来源及激活仍可用；不改数据根、应用身份，不创建第二个正式副本。
- [ ] 只在用户已授权的实际服务和额度内做真实集成，明确模拟与真实验证差异。若本轮仅交付设计，不执行此步。
- [ ] 实施授权包含本机更新时才安装，校验包/资源/9502与9503启动及恢复；客户 DMG 另行打包与验收。

## 验证命令基线

- 前端全量：node --test frontend/tests/*.test.js frontend/tests/research-workbench/*.test.mjs
- 单项后端：.venv/bin/python -m pytest <本任务列出的测试路径>
- 最终后端回归：.venv/bin/python -m pytest backend/tests
- 语法：对每个变更的 JS/MJS 执行 node --check
- 差异：git diff --check

新文件测试使用本计划完整路径；旧后台研究测试位于 backend/tests/research/，主集成测试位于 backend/tests/。执行前区分隔离 fixture 与收费标记；普通验证不应开启真实外部服务。

## 需求覆盖自检

| 产品方案要求 | 工程归属 |
| --- | --- |
| 新旧项目起点、方向/市场、配置复用 | 任务 1、3 |
| 初始词准备、释义、审核及范围/预算 | 任务 3、6 |
| 广告搜索、关联页面、来源/去重/空结果 | 任务 4、6、9 |
| triage 理由、retained/focus、身份与粗筛 | 任务 4 |
| 原文扩词、商品专属趋势词、双窗口 | 任务 3、5、6、7 |
| Meta/页面草稿、其他渠道能力边界 | 任务 5、7 |
| 18 字段、报价/套餐/风险/认证缺项 | 任务 7 |
| 正式评分、最终去向、营销交接 | 任务 8 |
| 测试计划、真实结果、研究/测试复盘、报告 | 任务 8 |
| 状态、暂停、预算、回执、重启与版本 | 任务 2、6、7 |
| 共享导航、唯一设置编辑器、媒体生命周期、窄屏大字 | 任务 1、4、7、9 |
| 旧数据、迁移/激活、本机与客户包 | 任务 2、9 |

自检结论：上述要求均有任务与验证归属；新接口、文件和自动草稿仍为提案。产品方案尚待审阅，未将任何任务标记完成，未声称已达到傻瓜模式。

本轮静态检查记录：核对 52 个既有实现/测试文件存在；核对十个权威步骤均在两份文档覆盖；以 AST 读取源码确认经济模型 18 个必需字段，并检查字段均列入产品方案。格式检查单独进行。此记录不是应用测试通过证明。
