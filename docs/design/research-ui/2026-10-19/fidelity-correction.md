# 设计还原纠正执行记录

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 设计与视觉验收记录**
> 保留设计来源、视口和原轮次视觉结论；后续业务界面已有调整，不将旧版passed外推为当前全产品视觉验收。
> 当前入口与验证范围：[项目当前状态](<../../../项目当前状态.md>)；[2026-10-26流程修复与边界](<../../../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->


最终视觉验收：**passed（2026-10-20，保留真实业务约束与已记录P3细差）**。此前blocked过程保留在下文；结果以根目录design-qa.md的新鲜截图与验证为准，不把功能测试通过替代视觉检查。

本轮快照：`/Users/xiachengpeng/.codex/backups/research-ui-20261019/before-fidelity-172947.zip`。

## 已实施、继续对照中

- 共用框架：状态信息移入顶部栏，消除原额外30px状态行；步骤条和标题区域重新量取。
- 01：还原有边框的新研究入口区、项目缩略图/市场/更新/核实进度/操作同一行、右侧编号待办。项目行约130px，主体左侧760.6px/待办355.4px，参考比例对应。进度只按实际已确认商品计算，合并档案排除。
- 02：创建前六站视觉导航，原创建字段及顺序、研究方式单选、辅助梳理入口、右侧三条收益说明与注意事项；表单与侧栏按655px/437px分配。单选是创建前输入辅助，不进入后端命令。
- 05：六队列分类Tab，只读切换并保留所有判断/恢复/撤销入口；列表与当前线索改为1.65:1，同屏预览移到判断前，原广告长文可展开。
- 06/07/10/11/13/16：真实工作台进入步骤时直接打开原有操作表单，不再先经过通用说明卡；原资料、检查清单与次要操作保留在展开入口中。首次展示不提交；取消可返回原资料页；显式再进入重新打开对应表单。

## 仍需逐页修正与复验

03关键词表与抽屉、04三列素材、08来源扩词、09需求证据、11订单测算、12评分、14/15计划与结果、17—24辅助页：继续逐页同视口比较，不能因为已有旧样式或已接入而判为完成。

## 验证

新增商品核实计数、队列Tab无写操作、直接表单首开无请求及取消回资料的回归测试；已有命令payload与未知成本规则继续复用。最终完整测试结果及浏览器截图在后续验收时填写，不沿用前轮“passed”。

Ruling: 保留业务函数与数据契约，不要求保留旧DOM构图；原次要操作允许移入明确展开入口，但不能删除。
Ruling: 真实数据差异仅影响内容；不豁免区域尺寸、位置、信息层级、字重、间距和按钮状态。

## Continued correction — 2026-10-19

- External services: resolved legacy `#view-settings` auto-fit grid specificity that forced three columns. Original Firecrawl editor is moved with a restoration marker, retaining competitor/research purpose selector and the existing credential handlers. Read-only browser verification confirmed both purposes remain present. No credential save/test was performed.
- Test pages: history now retains the same three section controls; returning to the plan remains read-only. Changing product clears the prior product's test subview. Regression `test history keeps section navigation available...` observed RED → GREEN.
- Order worksheet: compact costs in source order, a read-only revenue reference, collapsible multi-item rationale (automatically opens when quantity > 1), and secondary actions outside the primary footer. All original inputs and payload serialization remain.
- Paths: added a read-only provenance inspector and collapsible additional products. Selecting a child shows that child's stored quote, parent, bound ad and current product. Regression `source path inspection...` observed RED → GREEN; cross-project owner loading test remains green.
- Expansion: opens the existing citation-backed keyword editor alongside the original stored source. No approval/scan is automatic. Regression `design expansion opens existing cited keyword form...` observed RED → GREEN.
- Last full suite before the expansion change: 708 passed / 0 failed. A newer full suite is running; do not treat this number as final verification.
- Saved a new 24-page capture set at ignored `debug/research-ui-20261019/correction/NN-current.png`. These are intermediate, not a visual acceptance pass. The 24 settings fixture is standalone; production settings shell is separately checked in `24-real-current.png`.
- Visual acceptance remains **blocked**: source layout differences remain in several pages, especially coarse review, scoring, rules, sync, history and tools. Do not infer acceptance from unit-test success.

## Candidate implementation and verification

- Coarse review: added a rule requirement strip and live form progress, with deduplicated IDs and no automatic independence confirmation. Regression `creative review progress...` RED → GREEN.
- Scoring: five evidence groups now show current-version backend dimensions or an explicit pending state. Old-version scores are not reused. Complete requirements and original evaluation action remain. Regression `score evidence rows...` RED → GREEN.
- Funnel: original bound ad/product media now occupies the upper comparison region, with original form fields below.
- Test/review pages: context bands and saved decision/result summaries use only existing records. Test results retain source/period fields, original status transitions and full result history.
- Order worksheet: added quote/risk summary cards and moved the original footer to the lower action column. The original submit button uses the HTML `form` attribute; browser verification confirmed submission reaches the original handler, validation automatically reveals the missing section, and simulated network failure preserves fields and submission identity. No real POST was made.
- Paths: additional products remain available under an expandable list; child provenance inspection is read-only. The selected queue row now follows the actual selected product rather than always styling the first row.
- Rules: grouped existing definitions into advertising, profit/risk and scoring/time groups; changes still use the original configure command and invalid-field routing.
- History: date groups and activity icons added. Ordinary activity API intentionally omits product IDs, reasons, version payload and snapshots (`backend/routes/research_workbench.py:232–269`); absent historical product details are not synthesized from current data.
- Sync: current project/version/market/decision summary added for human review; wording distinguishes current DTO context from the server preview's immutable digest/record/table scope. Approval and uncertain-write protections unchanged.
- Tools: added a read-only local draft index and folded raw imported receipt detail. Index uses the existing draft-key parser; it does not hydrate forms, change command IDs or replay requests.
- Fresh-context review by `fidelity_candidate_review_sol`: one Important finding, draft index missed persistent drafts after reload and several valid form types. **Final: fixed** — `draft index reads persisted rule and revision drafts after refresh without hydrating or resubmitting` RED → GREEN; merged storage and in-memory records read-only, memory wins, all recognized key kinds supported. Full suite **713 passed / 0 failed** after the fix and subsequent order/context changes. No second reviewer dispatched.
- Browser: 1024×768 identity page had no document overflow or overflowing input/action controls; 390×844 had document width 390. Horizontally scrollable section tabs are retained, and changing/invalidating a section now reveals its selected tab.
- Browser: test result → round history → plan navigation succeeded; the same section controls remained available.
- Browser: real saved-point trend chart drew correctly from the explicitly labelled synthetic fixture series; production still uses only saved current-market/current-identity points. Empty series is not substituted with fabricated data.
- Visual gate remains **blocked pending final per-page comparison and remaining layout correction**. Candidate images are intermediate evidence, not an acceptance certificate.

### Color calibration

Rendered the approved 24 PNG unchanged in the same browser, beside a CSS `#1765ff` control, at 1:1 natural pixels. Browser capture changed the CSS control to RGB(72,76,251) and a source blue pixel RGB(0,90,252) to RGB(67,64,247). Thus raw reference vs browser PNG colors are not in an identical capture pipeline. Do not compensate CSS with an inverse visual hue guess. The research accent was instead matched to the original source's approximate sRGB primary (`#005cff`), and comparisons should use the browser-captured reference for color evaluation. Calibration is ignored QA data only (`color-calibration.png`), not a production asset.

Ruling: 设置中的“存储”使用原有存储区域的导航入口，AI/外部接口/运行日志继续使用原有分区控制器 — 避免为视觉页签复制配置逻辑与凭据编辑器 — 若后续需要完全独立的存储路由，应另做状态与回归测试；当前入口可到达既有存储功能。


## 2026-10-20 继续修正与新鲜验证

当前仍为 **blocked**；本轮没有把业务测试通过换算为视觉通过。

### 本轮修改

- 共用框架：进一步校准步骤条与标题基线，修正其他模块的全局 strong 紫色样式污染；研究区域显式使用正文色。已有色彩采集链路差异的结论仍适用。
- 03：390px编辑抽屉、原字段提示、原填写规则展开、占位说明、保存为待审核按钮及底栏位置。原输入对象、必填状态、序列化、草稿与提交身份不变；关闭仍用原导航。
- 04：桌面候选列表与来源区各自滚动，原确认按钮放入底栏，保留精确广告绑定、分页与素材缓存。
- 05：原筛选表单嵌入右侧详情；原选择理由、观察/淘汰/保留、恢复和撤销规则保留。不确定写入期间禁止更改去向，避免让用户误认为新选择已提交。隔离失败后原理由和选择仍保留。
- 07：来源观察日期、独立活跃创意要求和真实填写进度；按ID/URL匹配原素材。没有来源的第二/第三创意保持无素材提示，不用其他广告补图。
- 08：修正进入即新增的行为，先显示保存的原文、新词表与下一步。只有点击“手动添加”才进入原来源引用表单，取消回阅读页。新增页所有原引用字段保留；没有自动AI、审核或搜索。浏览器发现共享装饰器重复插入商品信息，已以专用展示标记避免重复。
- 09：趋势区与原渠道证据表单同屏；渠道切换缓存原表单DOM，保留本次未保存网址和数值；放弃草稿释放缓存。原范围、网址、周期、暂缺原因、期限和确认规则保留。趋势查询词和地区来自当前已保存序列，切到缺失的5年范围明确显示未保存，不复用12个月词/数据。渠道图标使用现有Phosphor库。
- 10/11：缩放双来源、原成本字段与标签/输入比例、报价/风险摘要；未知成本仍不计零、不宣称完整利润。原底栏按钮用 form 属性关联原表单。
- 12/13：仅展示当前版本完整评分；没有完整评分时测试/备选选项标记暂不可选，后端仍校验所有门槛，不复制或修改评分算法。
- 14—16：原计划/结果/历史/复盘动作保留，所有结果仍来自真实记录；未填写值保持未知。
- 17：候选结论5列表、关键缺口、原报告下载主操作、右侧当前版本/人工决定/缺失证据/已确认结果/下一步；新增本地关键词/来源/确认测试统计分区，只切已读取DTO，不触发采集；明确0与未知。商品数量增加时自然纵向延展，不删记录来贴图。
- 18：实际任务状态筛选、本地选择、400px任务列表；日志用实际动作/时间/内容表格，保留原始记录展开，未知阶段不伪造已完成状态。原重试查询词、停止、截图与持久日志接口保留。
- 19：现有来源路径和只读详情，补标准箭头图标；不生成虚构分支。
- 20：三组原规则字段加编号和边框卡片，按钮改“保存规则变更”，原采集/预算/扩词/AI分区继续可用。
- 21：同一次不可变预览与摘要核对复选框，核对后才能批准；新预览重置核对。未执行真实批准或写入。不确定写入仍保留人工核对保护。
- 22/23：历史类型和选择状态、持久草稿索引；只读查看不重新加载或发送草稿命令。
- 24：修复设置双重padding及列表跨10行造成的空白；沿用唯一Firecrawl编辑器和用途切换，原保存按钮移入共同底栏，保存失败/脏状态保护。技术能力明细折叠，存储仍到原区域。离开研究恢复原设置结构与唯一编辑器。

### 验证（本轮）

- 完整前端 `node --test frontend/tests/*.test.js frontend/tests/research-workbench/*.test.mjs`：**729通过，0失败，0跳过**。日志：`debug/research-ui-20261019/correction/final-suite.log`。
- 51个前端JS/ES模块语法检查、`git diff --check`通过；结果 `final-static-checks.json`。
- 本轮新增/修正用例包含趋势范围原词不串用、日志按任务过滤且不虚构状态、扩词先读再显式添加；相关RED与GREEN日志均在同一忽略目录。此前渠道切换、同步核对、决策门槛、设置保存、草稿持久索引和不确定写入回归继续通过。
- 23研究页与真实统一设置页重新捕获，CSS1440×1024、DPR1、研究容器scrollTop0，验收工具条隐藏。`NN-clean.png`、`24-real-clean.png`、`NN-compare.jpg`；旧candidate/verified图不是最新验收证据。
- 03/05/09分别检查390×844与1024×768，无主体和输入横向溢出；08新增阅读页390宽无主体溢出。07/11/20最新主按钮底部分别约936/921/994px；03约979px，均在1024px视口内。
- 浏览器：09切换Meta再返回Similarweb，两个未保存网址及50000访问量保留；取消关表单而趋势仍在。13测试/备选在缺少评分时禁用。17统计分区实际切换，空确认测试不伪造结果。08新增后5个原字段仍在，取消恢复阅读页。
- 真实设置只读：Firecrawl始终只有1个编辑器；竞品用途显示原保存，研究底栏隐藏；研究用途显示原研究保存；离开研究返回设置时编辑器回原父容器，临时底栏清零。未保存密钥、测试连接或变更绑定。
- 本轮最终隔离浏览器控制台无error/warn。原后端套件数字是前轮记录，本轮未重跑后端，不将其当作本轮结论。
- 仅启动界面验收后端与前端，后台研究worker未启动；没有真实采集、AI生成、投放、飞书写入、数据库迁移、依赖安装/升级或提交。已有工作区改动均保留。

### 中途待关闭视觉项（已在下段复验关闭）

- P2 / 08：最新阅读页已纠正入口，但设计图“选中已提取关键词后，右侧就地编辑”的状态尚未按相同交互状态还原；当前新增仍进入原编辑页。需要复用原编辑表单做同屏选中编辑，并覆盖引用/取消/失效来源保护，不能只把“有添加入口”计为设计通过。
- P2 / 20：主标准卡片已经分组，但客单价最小/最大和直接流量仍以5列原字段展开，源图采用客单价成组与更多规则折叠。需要在保持原输入和跨Tab无效字段定位的前提下重排，不可删掉直接流量规则来缩短。
- P3：中文字库与微小字距、部分按钮辅助图标/边框、03抽屉计数器与更细间距未达到逐像素同一。不能把上述两个P2也降为P3。


### 最后两项P2关闭与最终验证

- 08：现在点击真实新词行，在右侧表下嵌入原 `edit_keyword` 表单，左侧原文保持可见。原父词、商品、来源ID、引用片段、类型、含义及原提交链保留；选择引用来源同步左侧阅读，不重写引用片段。编辑缓存保留本页未保存值；不确定/进行中提交时禁止切词、新增和继续流程。原完整编辑页仍供新增使用，取消回阅读状态。
- 08：浏览器切换隔离广告来源，左侧原文更新但引用仍为原输入；还原商品来源后清空搜索词保存，原生校验聚焦text，未发写请求。恢复输入后主保存底998px。选中编辑与源图同状态重新组合比较，关闭P2。
- 20：客单价最低/最高使用原输入组成范围，阈值顺序对齐；直接流量原字段保留于明确“更多规则”中。三标准卡、单位和四条规则影响说明重新校准，底栏约1003px。
- 20：通用表单校验改为向上寻找原分组，并展开祖先details，保持嵌套输入仍能自动定位正确Tab；不是改变校验或放宽门槛。浏览器将隐藏直接流量填-1、切到采集预算页再保存，自动回选品标准、展开更多规则并聚焦该输入。恢复35后未提交。
- 新增 `nested rule inputs...`、`selected expansion word...` 及追加的不确定提交禁止新增回归均观察RED→GREEN；相关日志在correction目录。首次测试用例编写时出现的fixture参数错误已修正后重新确认行为RED，不将其当业务失败。
- 最新完整前端 **731通过、0失败、0跳过**；51模块语法、diff检查通过。后端仍未重跑。
- 新增08/20在390×844、1024×768输入不溢出；控制台无error/warn。所有业务写测试仅在隔离fixture或单元测试，不保存真实配置/研究。
- 最终组合比较未再发现本轮范围内未关闭P0/P1/P2。P3限于细字体、图标/边框和计数器等，示例数量/素材/分数与真实DTO差异单独说明，不伪造数据。

## 2026-10-20补充：统一全局侧栏

此前新版侧栏依赖研究内容模式，切换竞品分析会恢复旧导航；现已修复为一次挂载原控件、跨模块共用新版侧栏。只切换当前高亮，保留分组展开及事件；直接刷新到Listing等嵌套入口会展开所在分组。研究内容CSS与原设置编辑器恢复逻辑仍独立，不把研究布局施加到竞品内容。

实际浏览器验证研究↔竞品、Listing、设置、刷新恢复，已有竞品结果保留，未见error/warn。导航回归先失败后通过；完整前端记录733通过、0失败、0跳过（含2个新增导航测试），`node --check frontend/js/app.js`及`git diff --check`通过。证据为本机忽略目录 `debug/research-ui-20261019/correction/sidebar-tests.log` 与 `debug/research-ui-20261020/sidebar/`。这是上一轮实际代码验证，不是本次文档更新重新执行全套测试；后端/外部业务未重验。原731等数字保留为先前快照，不与733相加。
