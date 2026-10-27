# Mac自用客户端一次性收尾 Implementation Plan

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 历史设计与实施计划**
> 保留方案、任务勾选和原轮次证据；任务勾选不表示本轮重新执行，也不构成新的执行授权。
> 当前入口与验证范围：[项目当前状态](<../../项目当前状态.md>)；[2026-10-26流程修复与边界](<../../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The implementation is native in the current session with one final independent review using GPT-6.1-sol. Steps use checkbox (`- [ ]`) syntax for tracking. User instruction: never use Astra.

**Goal:** 一次性完成Mac自用版已知缺口修复、真实有限验收、数据恢复演练和最终安装交接，保留明确的外部例外。

**Architecture:** 沿用FastAPI＋原生JS＋Electron与本机单一数据空间。先修迁移和资产保护，再补后台只读状态及有限运行策略；所有真实执行仍由唯一owner和原业务门禁控制。无第二套配置中心、无技术栈替换。

**Tech Stack:** Python 3.12本机现有环境、FastAPI、SQLAlchemy/SQLite、Vanilla JS/MJS、Electron 44.9.1、现有PyInstaller/Tailwind、pytest、node:test、CUA原生验收。

**Spec:** [收尾设计与验收约定](../specs/2026-10-21-mac-client-closeout-design.md)。既有约束补充参照[桌面客户端计划](../../desktop-client/桌面客户端可行性与实施计划.md)、[v9轮询验收](../../desktop-client/飞书轮询接线与验收.md)及根AGENTS.md。

## Global Constraints

- 不修改研究证据、版本、事实确认或决定门禁，不伪造商品事实、评分、广告投放结果或收益。
- 不恢复/重试原9条人工记录，不自动处理原3条飞书触发记录；真实外部执行必须有明确范围和有限调用次数。
- 不把浏览器profile、Cookie、API密钥、研究命令、未知提交身份或任意任务对象复制为新环境可执行状态。
- 不覆盖现有草稿，不覆盖用户新编辑，不用旧整库撤销新数据；所有恢复先演练到独立副本。
- 不删除原项目、原证据、旧浏览器资料、已有备份或脏工作区文件；无reset/clean、无宽泛git add、无自动提交无关改动。
- 不升级依赖或全面重构；本次只修改实现目标所必需的文件。若必须引入依赖，先提供不可替代的原因再处理。
- 不通过放宽Electron沙箱、webSecurity、会话/CSRF校验或文件路径保护解决导入和UI问题。
- 不增加第二套凭据编辑器或第二个worker；所有模块保留当前统一侧栏和原页面业务交互。
- 历史缺失、远端403和真实资料不足必须可见；未知不按0处理，不用演示数据通过业务验收。
- 本轮规划不改业务代码、不改运行开关、不调用收费服务、不写飞书或其他外部系统。

## Review Focus

1. 用户预览后又编辑了草稿，导入不可覆盖；取消选择、重复确认和容量不足均保留原内容。归Task 2/3。
2. 资产在扫描后被新业务记录引用，或引用解析失败，TTL清理不能删除它。归Task 4。
3. 配置active但worker不存在、心跳过期或只有历史成功行，状态面板不能显示运行正常。归Task 6。
4. 飞书记录输入变化、网络提交结果未知或程序重启，有限验收不能扩大范围/重置预算/重发同一任务，隐藏SDK或后端重试也不能突破实际网络提交上限。归Task 5/7。
5. 升级后用户产生新数据，回退旧应用不能覆盖新数据库；签名、资源或恢复失败需保留当前可运行版本。归Task 1/9/10。

## 总排程与完成口径

| 阶段 | 任务 | 产物 | 预计工程量 |
| --- | --- | --- | --- |
| A 数据与基线 | 1 | 可恢复快照、受保护记录和收尾台账 | 0.5天 |
| B 功能补齐 | 2—6 | 可用迁移、素材保护、有限执行、后台状态 | 4—6天 |
| C 实测与恢复 | 7—9 | 完整业务报告、联网/生命周期证据、恢复演练 | 2—3天＋实际观察窗口 |
| D 交付 | 10—11 | 新客户端、最终文档和例外清单 | 0.5—1天 |

合计约7—10.5个工程日，外加实际观察、设备/资料/证书等待。此为计划估算，不是已经完成的记录。连续执行各任务，不在每项完成后重新问是否继续；只在费用/外部权限边界和客观阻塞处集中询问。

状态只有`pass`、`failed`、`not_run`、`blocked_external`、`accepted_legacy_gap`。最后一种只允许用户明确接受。已知软件缺陷不能用例外清单消掉。

下述新文件、新接口均为**拟新增**，尚不存在；现有函数名按真实源码核对。每任务记录RED/GREEN、实际命令、结果、风险与回退。Git提交按任务选择明确文件，只提交本计划变更；现有大范围脏状态无法安全隔离时先保存补丁/哈希，不强行提交。

### Task 1: 冻结范围、备份及复现台账

**Files:** 复用`scripts/full_merge/backup.py`、`scripts/desktop/prepare_data.py`；新增`docs/desktop-client/收尾验收台账.md`；私有基线放`~/.local/share/ai-ecommerce-desktop/closeout/<session>/`。

**Interfaces:** Consumes v9真实数据根、现有`create_snapshot`/`database_stats`。Produces `baseline.json`（schema_version=1，快照摘要、源文件hash、受保护行hash、应用hash和各任务状态；不含凭据/行正文），后续全部任务引用同一session。

- [ ] 核对适用AGENTS、现有managed worktree和当前进程；记录原工作区脏文件hash；仅复用合适隔离工作区，不重建或reset。
- [ ] 使用现有备份函数对当前库、static、研究私有材料和配置生成新私有快照；测试验证篡改/丢文件会使现有校验失败，再验证原快照通过。
- [ ] 保存3条旧触发的私有身份/版本及9条人工行hash，已知缺失基线重新扫描确认，不直接沿用251作为当前准确值。
- [ ] 复现原生JSON禁用和超过24小时引用文件清理；先用副本/合成数据，不运行生产TTL清理。
- [ ] 跑既有隔离主套件、桌面测试及签名检查，建立当次基线；失败先定位，不靠删测试绕过。完成后保存窄范围提交或补丁。

**验收/回滚:** 快照独立校验通过，原数据未写，全部后续任务可引用其hash。失败仅保留失败快照并重做，不恢复旧整库。

### Task 2: 修复原生JSON选择及原三类草稿闭环

**Files:** `frontend/index.html`迁移file input、`frontend/js/local_transfer.js`、`frontend/tests/local_transfer.test.js`；仅在根因需要时修改`desktop/main.cjs`并扩展`desktop/tests/window-lifecycle.test.cjs`。

**Interfaces:** Consumes原`validate`/`preview`/`apply`白名单契约。Produces原契约不变、原生可用的文件选择和导入流程；不扩大支持的任务对象。

- [ ] RED原生用例`native_valid_json_select_reaches_preview`：合法小JSON能被选中，出现预览前localStorage不写入；记录v9失败证据。比较JSON扩展名/MIME、路径、重复弹窗、单击与取消，定位责任层，不预设删除accept或开放权限。
- [ ] RED测试预览后编辑、重复导入、错误JSON、超限、取消再选、容量失败；现有通过用例保留。
- [ ] 仅修改已定位原因；保留Node隔离、contextIsolation、sandbox、会话与文件路径保护，不为通过自动工具而扩大Chrome权限。
- [ ] Run `node --test frontend/tests/local_transfer.test.js desktop/tests/window-lifecycle.test.cjs`；Expected全绿。实际原生执行导出→选择→预览→确认→重新进入模块→恢复，重复导入不覆盖。
- [ ] 保存截图、状态和源/目标数量对照；只清理可恢复的自建验收草稿，不清空任何用户存储；记录提交/补丁。

**验收/回滚:** 三类真实闭环通过、错误状态可理解。失败恢复入口代码，保留原草稿和迁移包；不假报“全部浏览器已迁移”。

### Task 3: 详情页草稿与临时图片安全交接

**Files:** 新增`frontend/js/detail_project_transfer.js`、`frontend/tests/detail_project_transfer.test.js`；窄改`frontend/js/details.js`的`collectCurrentRenderProject`/`renderRestoredDetailProject`接入点和`frontend/index.html`显式入口；按需扩展`backend/main.py:persist_render_metadata_images`专项测试，不重写大型详情模块。

**Interfaces:** Consumes既有`kind='detail-page-project',version=2`项目快照与旧`dtc_studio_current_draft`。Produces拟新增`buildPortableDetailProject(source, mediaReader): Promise<object>`、`validatePortableDetailProject(value): object`、`restorePortableDetailProject(value): Promise<{projectId:string,warnings:string[]}>`，包标识`kind='detail-page-transfer',version=1`；仍使用原详情历史保存/恢复路径。

- [ ] RED：包含`x');alert(1);//`模块ID、事件属性、脚本URL、伪图片、未知命令/凭据字段均不能执行/导入；blob失效和大包明确失败而不丢原草稿。
- [ ] 定义DTO白名单，保留原图、模块图、复制模式、样式/排版、SEO、顺序和事实确认来源；新建安全ID并映射顺序。64MiB总JSON、8MiB单图片、PNG/JPEG/WebP且实际解码校验；拒绝可执行/未知内容。
- [ ] 旧任务DTO仅转换为资料与已有成果，不复活生成/上传/run/命令身份。未生成草稿也能导出，不要求先收费生成模块。原浏览器有效blob转为包内媒体；失效项列入警告并保留源记录。
- [ ] Run `node --test frontend/tests/detail_project_transfer.test.js frontend/tests/details_error_resilience.test.js frontend/tests/local_transfer.test.js`；Expected全绿。真实窗口导入并保存独立历史，重启恢复图片、排版、文案与顺序；恢复过程网络无AI/上传/命令请求。
- [ ] 对比模板/品牌/事实内容和已确认标记无提升；截图、源/目标摘要与提交/补丁入台账。

**验收/回滚:** 源资料逐项为“已迁移/源已失效/用户不迁移”之一；未处理不能消失。失败回退新入口/模块，保留原包与源浏览器；不恢复通用任意任务导入。

### Task 4: 引用清单、历史素材恢复与TTL防误删

**Files:** 新增`backend/services/asset_reference_service.py`、`scripts/desktop/audit_assets.py`、`backend/tests/test_asset_reference_service.py`；修改`backend/services/storage_cleanup_service.py`、`backend/tests/test_storage_cleanup_ttl.py`和必要的`backend/main.py`调用处；研究媒体展示仅在真实错误提示不足时窄改原组件。

**Interfaces:** Produces `collect_asset_references(database: Path, private_root: Path) -> AssetReferenceIndex`（`complete:bool, protected_paths:frozenset[Path], unresolved:tuple`）；索引建立不完整时清理fail-closed。CLI `audit_assets.py --data-dir <root> --output <private-report>`只读默认，不隐式下载或清理。

- [ ] RED：超过86400秒的已引用图片/上传/历史导出仍保留；无引用临时文件依旧按原规则清理；索引失败、扫描后新引用、符号链接和路径越界均不得误删。
- [ ] 在已有TTL逻辑前增加引用保护，实际删除前在共享写入/清理协调锁下复核；引用写入同样遵守该协调点。索引未知时跳过删除并报告，避免所有清理永久静默失效。
- [ ] 只读扫描当前引用、已有本地备份和可访问源文件，逐项分类。恢复匹配hash/媒体有效性的副本；同名异内容不覆盖，私有证据不搬入公开static；网络恢复仅在批准额度内进行。
- [ ] Run `.venv/bin/python -m pytest backend/tests/test_asset_reference_service.py backend/tests/test_storage_cleanup_ttl.py backend/tests/research/test_media_download.py -q`；Expected全绿。对副本重启/跨TTL复测引用仍可用。
- [ ] 每个缺失项交付恢复状态和依据；403明确显示来源限制/下一步，不绕站点限制。无法恢复清单集中给用户确认，不能先认定已接受；记录提交/补丁。

**验收/回滚:** 无新缺失、每个旧缺失有去向、引用资产不误删；不得以全部返回占位图宣称恢复完成。回退时保留已恢复副本和原文件，清理能力保持保守，不能重开有误删风险的旧TTL。

### Task 5: 有限运行与观察策略

**Files:** `backend/services/research_worker.py`、`backend/modules/research/rabbit_hole/cli.py`、`run.py`、`backend/desktop_entry.py`、`backend/tests/test_research_polling.py`；新增`backend/services/research_polling_policy.py`及测试；按现有边界窄改`backend/services/research_ai_adapter.py`、`backend/services/retry_service.py`和`backend/modules/research/rabbit_hole/integrations/provider_budget.py`的提交前额度校验，不接管其重试调度。

**Interfaces:** 拟新增 `PollingPolicy(mode: Literal['observe','execute'], allowed_triggers: tuple[TriggerScope,...], expires_at: datetime|None, max_new_jobs:int)`；`TriggerScope`精确包含table/record_id/input_version/protected_input_hash。`poll_with_policy(runtime, policy) -> PollOutcome(seen:int,enqueued:int,skipped:int)`；状态无凭据/原文。另定义`SessionBudgetStore.reserve(scope_id:str, operation_id:str, provider:str, network_attempt:int) -> Reservation`，读取已批准会话的不变范围和`max_network_submissions`（apify=1、serpapi=2、firecrawl=1、text_ai=12），每次实际网络提交前预留，包含后端重试尝试；相同身份预留幂等。会话账本仅位于私有根`closeout-sessions/<UUID>.json`，固定独立锁文件＋原子写/fsync，目录0700/文件0600，拒绝符号链接和越界；重启不重置。SDK继续attempts=1，重试只归现有retry_service，额度耗尽在发送前停止。

- [ ] RED：observe从不入队；execute无范围/过期即拒绝；旧3触发不在白名单；同ID不同版本/hash不能执行；重启不恢复已耗额度；并发额度预留只有一个成功，实际网络重试纳入上限；needs_human和未知run不自动重发。
- [ ] 保留现有布尔总开关和paused门禁，补策略字段；缺新字段默认observe。仅明确execute且满足范围与截止时间的记录进入原TriggerPoller/JobRepository，owner锁仍只有一个。
- [ ] 模拟轮询过程中凭据变更、部分入队超时、断网、限流、取消；检查其他原生任务可继续，错误持久且不含正文。只读观察不启动legacy任务消费的新任务。
- [ ] Run `.venv/bin/python -m pytest backend/tests/test_research_polling.py backend/tests/test_research_worker_local.py backend/tests/test_full_merge_no_remote.py -q`；Expected全绿。新策略与原consumer契约保持兼容，并更新冻结自检。
- [ ] 完成配置升级说明、固定安全错误码和提交/补丁；此阶段不修改真实active开关。

**验收/回滚:** 观察不产生任务，执行范围不可扩大，额度恢复后不重置；回退保留执行会话账本，默认paused，不恢复无范围自动执行。

### Task 6: 主设置后台状态面板

**Files:** 新增`backend/services/research_worker_status.py`、`backend/tests/test_research_worker_status.py`、`frontend/js/research-workbench/components/worker-status.mjs`和对应frontend测试；修改`backend/routes/research_workbench.py`、`frontend/js/settings_research.mjs`及必要设置样式。

**Interfaces:** 新增只读 `GET /api/research/workbench/v1/runtime-status`，沿用原会话/来源保护及no-store。DTO `contract_version=1`，`worker_state: paused|starting|running|not_running|degraded|unknown`，polling配置/观测状态、UTC最后观测、可空预计下次时间、安全原因码和队列聚合计数。不得返回私有路径、密钥、记录正文或原始异常。`renderWorkerStatus(context)`遵守现有life生命周期。

- [ ] RED：active但无心跳、过期成功状态、首次启动、DB不可读、UI切出晚响应均不显示健康或覆盖其他页面；GET不得执行轮询/创建客户端/修改队列。
- [ ] 从当前配置、心跳/轮询状态、现有队列和有限会话读取状态；未知显式unknown，预计时间加“预计”说明，不伪造精确倒计时。停用配置但进程仍未结束时提示待退出。
- [ ] 主设置只挂一次面板，显示运行/暂停/失败原因/人工待办和刷新；切出取消周期刷新，保留原配置草稿及唯一编辑器，不新增未实现的启停按钮。
- [ ] Run `.venv/bin/python -m pytest backend/tests/test_research_worker_status.py backend/tests/test_frontend_server.py -q`；Run `node --test frontend/tests/research-workbench/worker-status.test.mjs frontend/tests/research-workbench/main-settings.test.mjs`；Expected全绿。
- [ ] 原生桌面检查暂停、模拟过期/错误（隔离实例）和真实观察状态，截图与提交/补丁入台账。

**验收/回滚:** 用户能知道是否真在运行以及下一步；刷新无外部副作用。回退移除新面板/路由，不触碰原设置及凭据。

### Task 7: 有限真实调用与完整选品闭环

**Files:** 新增`scripts/desktop/accept_closeout.py`、其隔离测试和`docs/desktop-client/完整选品验收.md`；复用`services/journey.mjs`、原命令/报告接口；发现缺陷只在所属原模块窄修并配回归。

**Interfaces:** Consumes session基线、Task 5有限策略、Task 6状态。脚本 `--prepare/--run/--verify`按显式session保存提交前意图、run/command身份和结果，默认prepare；没有批准的调用清单与额度不执行run，不接受自动重放。

- [ ] 在无网络测试中RED覆盖“重复启动run阶段不会重新收费、额度不足先拒绝、未知结果只核对原身份、旧人工记录不变”；实现后GREEN。
- [ ] 执行前一次性确认Spec末尾调用上限、可写飞书验收目标及真实业务资料。优先复用已有100条样本，不重复采集。批准范围外的旧记录均跳过。
- [ ] 原生窗口走一条完整真实业务链并验证所有功能入口：词审核→素材/商品→核验→渠道/趋势→漏斗→成本→评分/证据→去向→报告/同步；测试计划和复盘的模拟表单单列演练，不伪装成真实订单或投放。
- [ ] 每一步保存当前版本、证据摘要、通过/失败和下一步；缺成本/资质时输出观察/证据不足。导出真实Markdown＋JSON/CSV数据，不给无证据的最终选品推荐。
- [ ] Run脚本`--verify`；对照原生页面、持久日志、下载文件及飞书读回。无新增旧触发/人工记录处理，无额外收费提交；缺陷RED→GREEN后重验受影响步骤，保留原命令身份。

**验收/回滚:** 一个可读真实决策报告＋覆盖全部功能的用例记录；失败原因诚实可见。无真实业务资料则blocked_external，不造数据过关。不恢复整库，保留验收项目与快照，任何外部写回均按原身份核对。

### Task 8: 连续联网、网络异常和原生生命周期

**Files:** `desktop/main.cjs`、`desktop/process-manager.cjs`及对应测试；按定位扩展`backend/tests/test_research_polling.py`、媒体生命周期测试；`docs/desktop-client/稳定性验收.md`。

**Interfaces:** Consumes观察策略和状态DTO；Produces可核验时间线与故障恢复证据，不创建未经授权的周期自动任务。

- [ ] RED回归：重复启动只一owner、轮询断网/恢复、关闭隐藏/正常退出、worker异常、部分媒体失败和晚响应、休眠后心跳过期不误报；仅修真实定位到的缺陷。
- [ ] 自动化使用隔离数据/fake传输，Run `node --test desktop/tests/*.test.cjs frontend/tests/research-workbench/media-navigation.test.mjs`及相关backend专项；Expected全绿。
- [ ] 用户批准窗口内：观察模式联网60分钟（不入队/收费），网络断开恢复、隐藏重开、正常退出端口释放；允许时做一次真实休眠/唤醒。不可重叠启动其他worker。
- [ ] 在一个实际工作日复核持久状态、任务数量和内存/缓存趋势；没有观察期不能填通过。需要后续自动检查时按用户授权使用正式自动化能力，不写临时cron。
- [ ] 对照基线复核9条人工行和旧触发无写入，提交证据和必要修复。

**验收/回滚:** 唯一owner和恢复过程有实际证据，未知结果无重复提交。失败立即paused并正常停止所属进程，保留日志和检查点，不强杀未确认的外部提交。

### Task 9: 备份恢复、升级失败和清洁机

**Files:** 复用`scripts/full_merge/backup.py`、`scripts/desktop/prepare_data.py`、`install_data.py`；新增`scripts/desktop/verify_recovery.py`及`backend/tests/test_desktop_recovery.py`。

**Interfaces:** `verify_recovery(snapshot: Path, destination: Path) -> RecoveryReport`仅允许全新隔离目的地，拒绝活动根/原库/非空目标；输出库、资产及签名关联的校验结果，不重签原证据或激活另一个生产owner。

- [ ] RED：损坏快照、WAL遗漏、部分复制、已存在目标、错误签名根、目的地包含新写入均拒绝；恢复副本验证完整性、逻辑行hash及文件hash。
- [ ] 实现隔离演练并Run `.venv/bin/python -m pytest backend/tests/test_desktop_recovery.py backend/tests/test_desktop_data_preparation.py backend/tests/test_desktop_data_installation.py -q`；Expected全绿。
- [ ] 演练新版失败保留旧包、签名失败拒绝替换、数据空间不随应用替换覆盖；对回退保留新写入做可核验演练。原研究签名/锁材料不另造一套激活。
- [ ] 若有用户授权的第二台Apple Silicon Mac/清洁用户空间，安装资源并验证不依赖开发目录/Python/Node；不默认使用此前只获只读授权的备用机。没有设备明确blocked_external，不用当前机改HOME冒充完整清洁机。
- [ ] 保留恢复副本和报告；旧备份删除不在本计划授权内。

**验收/回滚:** 本机恢复与升级失败演练通过；清洁机单独标记实际结果。任何失败不触碰当前库，恢复工具默认拒绝不明确目标。

### Task 10: 最终回归、独立复核、构建与安装

**Files:** 现有`scripts/full_merge/run_tests.py`、`scripts/desktop/build_backend.py`、`verify_bundle.py`、`desktop/build/package.cjs`；修复仅涉及上述任务负责的文件；新增`docs/desktop-client/最终交付验收.md`。

**Interfaces:** Consumes所有任务证据和例外清单；Produces最终应用hash、签名结果、source hash、安装前后数据核验和逐项验收矩阵。

- [ ] 运行隔离完整主套件；示例 `PLAYWRIGHT_BROWSERS_PATH=/Users/xiachengpeng/Library/Caches/ms-playwright .venv/bin/python scripts/full_merge/run_tests.py --suite main --output <新私有输出目录>`。工作区无.venv时显式用主环境绝对路径。修改研究域时另跑现有research隔离套件；不把历史数量当新结果。
- [ ] Run `node --test frontend/tests/*.test.js frontend/tests/research-workbench/*.test.mjs desktop/tests/*.test.cjs`；对变更JS逐个`node --check`，`git diff --check`；全部失败必须解释并修复，不跳过。
- [ ] 一次完整独立复核仅用GPT-6.1-sol，检查新增功能、保留业务规则和五类Review Focus；P0/P1/P2做一轮修复、针对性RED→GREEN及相关完整套件复验。
- [ ] 用现有私有构建工具制作新包，验证无数据库/密钥混入、前端CSS与图标资源、冻结探针及签名。升级前再次新备份；正常退出旧app并确认端口释放后以可回退方式替换应用，保留旧包。
- [ ] 原生从安装目录启动，项目/历史/媒体/迁移/状态实际抽查；核对数据和9条人工记录，保存真实截图和应用hash。当前目录源码测试通过不替代最终安装包验证。

**验收/回滚:** 所有软件P0/P1/P2关闭，安装包对应已测源码、数据无新增丢失。失败恢复上一应用包，数据保留当前版本；禁止旧库覆盖新写入。

### Task 11: 文档、例外确认与最终结案

**Files:** `README.md`、`docs/README.md`、`docs/项目当前状态.md`、`docs/desktop-client/Mac自用版使用说明.md`、`实施记录.md`及本次新验收文档；必要更新AGENTS运行事实，不改用户业务约束。

**Interfaces:** Produces单一现行入口、启动/退出/观察/有限执行/预算/备份恢复操作方法，以及逐项`pass/blocked_external/accepted_legacy_gap`矩阵；历史记录保留日期并标已被哪份现状替代。

- [ ] 检查文档冲突用例：最新入口不能再同时声称“线路11条/10条永远固定”“轮询未接线/已接线”“外部从未实测/已实测”；数量必须注明时点与来源。
- [ ] 整理当前说明，历史计划不作为新授权；链接检查、命令在正确数据根/环境演练，避免用户误启动旧库。
- [ ] 交付恢复清单与真实业务报告，对不可恢复历史素材逐项请求用户确认；未确认保留未完成，不私自accepted。
- [ ] 自用版完成与发行扩展分列：第二机未测、证书/Apple身份、公证未提供均明确状态；不通过关闭Gatekeeper完成分发。
- [ ] 最终逐项回答：哪些修复、哪些已实测、当前后台是否启用、额度/目标、还剩什么、如何恢复。只有矩阵满足Spec完成条件才宣布自用版收尾完成；不再用“一批测试全绿”代替交付结论。

**验收/回滚:** 用户只需一个现行使用入口，例外不隐藏。文档错误定向修订，历史原件留存。

## 外部条件与统一授权表（执行前一次确认）

| 项目 | 建议默认 | 未提供时的处理 |
| --- | --- | --- |
| 外部调用 | Apify至多1新增run/$0.25请求上限；SerpApi2、Firecrawl1、AI文字12；先复用已有线索 | 不执行真实收费请求，其他修复继续 |
| 总费用 | 建议$5暂停阈值，需用户确认；无法读取可靠计费时仅承诺逐项调用上限 | 不声称跨供应商硬扣费上限 |
| 飞书写回 | 仅独立验收项目最多2次新增快照，旧3条触发和9条人工不动 | 不写远端，已有连接/只读证据保留 |
| 实际资料 | 商品/成本/物流/资质的可核验证据 | 报告为观察/证据不足，不虚构测试和利润 |
| 联网/休眠 | 60分钟观察＋一个工作日复核；休眠单独选不影响使用的窗口 | 不强行休眠，不伪填长期实测 |
| 第二台Mac | 仅经用户授权的清洁环境 | 标清洁机未验证，不阻塞其余本机修复 |
| 发行身份 | 自用版暂不要求Developer ID/公证 | 对外发行明确未完成 |

## 自审结果

- 范围覆盖：草稿/遗留详情(Task 2/3)、素材/TTL(Task 4)、持续后台/状态(Task 5/6/8)、完整选品数据(Task 7)、恢复/清洁机(Task 9)、打包/签名边界/文档(Task 10/11)。
- 接口顺序：Task 1基线→2/3迁移；Task 4引用安全→所有真实重启；Task 5有限策略＋6状态→7真实流程＋8长时观察；Task 9恢复→10安装→11结案。
- 五类Review Focus均有对应RED测试；新接口明确标拟新增，没有将设计当现有实现。
- 无法恢复的资料、缺少真实业务证据、第二机与Apple身份均有明确阻塞/例外处理，没有承诺通过代码恢复全部历史或伪造业务结果。
- 当前只生成设计与计划，未开始上述实现。建议沿用本会话原生连续执行，仅最终一次独立6.1-sol复核，减少重复读上下文及反复确认。
