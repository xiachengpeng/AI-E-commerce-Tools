# 渐进融合第一批交付：研究摘要与人工事实交接

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 历史融合评估与交接**
> 保留各阶段的远端、旧入口、进程和测试记录；这些描述仅适用于原记录时点，不作为当前启动说明。
> 当前入口与验证范围：[项目当前状态](<../项目当前状态.md>)；[2026-10-26流程修复与边界](<../ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->


> 本文件记录此前MVP。后续完整交付已经完成，当前使用方式、验证和回滚请优先阅读[项目当前状态](../项目当前状态.md)及[12-完整融合最终交接记录.md](12-完整融合最终交接记录.md)。

2026-10-09，用户明确指示“按照你推荐的来 开始合并”，授权进入实施。本文件记录实际结果，取代前五份评估文档中“本轮未实施”的历史状态说明；评估结论和后续路线仍保留。

## 交付范围与实际边界

本批实现计划阶段0–3的MVP：AI E-commerce Tools保持原FastAPI、原生JavaScript、Tailwind3与原SQLite；研究项目保持独立原生API、唯一工作台worker、SQLite WAL和私有证据文件。研究入口嵌入主项目导航，完整研究操作通过“打开完整研究工作台”进入原界面。

```mermaid
flowchart LR
  UI[主项目浏览器：研究入口与原营销工具] -->|本机会话校验| MAIN[主FastAPI /api/research/v1]
  MAIN --> MATH[本地物流重、销量情景、国家字典]
  MAIN -->|固定目的地、服务凭据| SSH[本机19503：SSH加密隧道]
  SSH --> API[研究API8000 /internal/integration/v1]
  API --> DB[研究SQLite：项目和人工核实事件]
  DB --- WORKER[原唯一工作台worker]
  UI -->|逐项预览、勾选、填充、撤销| DRAFT[详情页 / Listing / 广告草稿]
  DRAFT --> ORIGINAL[现有显式生成、保存、上传流程]
```

已实现：物流实际重/体积重/计费重；低中高转化情景与流量范围；七个市场字典；项目分页、商品摘要、步骤状态、汇总报告API；带版本和身份的人工核实记录；核实事实预览与逐项选择；三个营销模块草稿填充、保留名称、追加事实与条件撤销；超时不自动重发、原操作编号查询；独立SSH连接进程及断线重连。

商品名称或AI提取结果默认`inferred`。只有用户明确确认自有商品、合法来源、当前国家/身份、有效时间及人工出处的记录可进入交接。竞品价格、折扣、退换货政策与素材不自动成为自家声明。上传产品图仍是原视觉真实性来源。

研究前端全局S/$和Tailwind4未并入主页面。两个数据库未迁移、未合并，旧表未变，旧API路径保持。没有调用付费AI、采集、翻译、飞书同步、上传或发布验证生产。

本批不承诺跨模块永久关联/导入幂等，也不新增自动生成任务。品牌档案Hub保持现有操作；交接不会自动改品牌设置。共享AI桥为可选阶段4，复杂SOP工作流统一和持久跨域关系为阶段5–6，后续按原计划独立验收，不能视为本批已完成。

## 文件与接口

| 归属 | 文件 | 职责 |
|---|---|---|
| 主 | `backend/modules/research_math/{logistics,estimates,markets}.py` | 复用原研究纯算法，无服务或数据库依赖 |
| 主 | `backend/models/research.py` | 严格DTO、项目/商品/国家/版本引用一致性 |
| 主 | `backend/services/research_client.py` | 固定目的地、2MB响应上限、10秒超时、安全错误、禁止自动重发 |
| 主 | `backend/services/research_mapper.py` | 人工事实筛选和营销草稿字段映射 |
| 主 | `backend/services/research_tunnel.py`、`run.py` | 可选SSH连接，独立进程，仅关闭自己创建的子进程 |
| 主 | `backend/routes/research.py`、`backend/main.py` | 研究会话、工具、摘要、预览、人工确认与确认状态路由 |
| 主 | `frontend/js/research.js`、`frontend/css/research.css`、`frontend/index.html`、`frontend/js/app.js` | 独立研究面板、生命周期隔离及导航 |
| 主 | `frontend/js/ads.js` | 可见事实输入、真实广告请求消费、向后兼容草稿保存 |
| 研究 | `src/rabbit_hole/api/integration.py` | 私有认证入口、只读投影、限定人工事实命令与确认状态 |
| 研究 | `src/rabbit_hole/application/integration_contracts.py` | 无原始项目/密钥透传；保留商品参数并剔除跟踪和秘密参数 |
| 研究 | `src/rabbit_hole/domain/marketing.py`、`domain/project.py` | 新事实命令复用原版本、digest、事务及事件机制 |
| 研究 | `src/rabbit_hole/runtime/server.py` | 只注册新路由，不增加消费者 |

主API前缀`/api/research/v1`，研究服务前缀`/internal/integration/v1`，契约版本1。项目列表默认20、上限50、UUID游标；单项目摘要上限200个商品。`GET /projects/{id}/report`是摘要统计，不是原完整证据报告；完整报告继续使用原工作台。

`POST /projects/{id}/products/{pid}/preview`重读来源并比较version/identity/market。`POST .../confirm-fact`需要UUID command_id、expected_version及明确own_product确认。`GET /projects/{id}/confirmations/{command_id}`只查询提交事件是否已观察到；`not_observed`不保证不会稍后提交，不清空原操作编号。人工重试保持同编号同输入，由原数据库机制去重；明确403/409/422可改正后重新确认。

## 日常启动与连接

主项目仍使用`.venv/bin/python run.py`，前端9502、后端9503。仅私有连接配置存在且启用时启动隧道；研究离线不会终止主程序。

主私有配置：`~/.local/share/ai-ecommerce-merge/research.json`。研究私有配置：`/Users/xcp/rabbit-hole-data/integration.json`。均为各自用户所有、权限600、位于Git之外；符号链接、公开可读或超长配置被拒绝。文档不记录服务密钥。

主配置的非秘密字段：`enabled`、`base_url`固定`http://127.0.0.1:19503`、`ssh_target`为`xcp@192.168.31.112`、`workbench_url`为原工作台地址。研究配置含`enabled`及独立`allow_confirmations`开关。两端独立共享的服务token只在后端之间传递，浏览器只接收当前主进程会话token。

隧道使用严格现有SSH主机验证与BatchMode，不更改known_hosts、不自动接受新指纹、不传SSH密码参数。重连只恢复传输，不重发任何业务操作。主机休眠或断网后研究读取会失败，主工具和计算器可继续使用。

浏览器允许本机9502/9503固定Origin；localhost与127.0.0.1别名兼容。现有应用不具备多人RBAC，此入口仍定位本机单用户，不可直接作为公网多用户服务。

## 安全备份与回滚

主私有备份：`/Users/xiachengpeng/.local/share/ai-ecommerce-merge/backups/20261009-main`；研究私有备份：`/Users/xcp/rabbit-hole-migration-backups/merge-20261009`。包括源码快照/Git bundle、SQLite online backup、资产/证据/密钥与运行配置；在独立目录验证恢复、完整性、外键、内容及文件哈希。不得提交或分享备份内容。

先将主私有配置`enabled`设为false，研究`allow_confirmations`设为false，当前请求之外不再允许新交接。主读配置按请求生效；关闭已有隧道随主程序正常停止，修改连接地址后重启主程序。原工作台/worker保持正常运行。

回退只回退本批明确代码提交或关闭注册路由，不`reset --hard`、不删真实事件、资产或研究记录。没有库迁移，因此本批回退不需要覆盖数据库。上线后如有用户新增数据，禁止将旧备份直接覆盖新库；真实恢复须先备份新状态并设计重放方案。

## 验证记录

基线：主642后端、486前端；研究1137后端/浏览器通过、4跳过，原Node9通过。隔离拷贝运行，现有虚拟环境/浏览器缓存复用，未安装或升级依赖。

最终隔离回归：主后端686通过（2个既有弃用警告），前端493通过；研究1148通过、4跳过（环境/兼容专用用例），Ruff全源码通过、Mypy78文件通过。主Tailwind构建、三个修改JS语法与两端diff检查通过。SSH监督进程使用隔离假传输验证启动/停止，不遗留自己的子进程。

已启用私有连接并更新研究API及主程序；研究原worker PID未变。真实只读检查：1个研究项目、13个商品摘要；研究未认证HTTP401；统计报告和计费重/unknown工具正常；10次列表读取保守p95约226ms。运行后主15张表、研究14张表业务内容与原备份一致，历史资产/证据/供应商配置一致；只排除原持续更新的runtime_health心跳，SQLite缓存按逻辑行而非物理页比较。

1920×1080真实浏览器：主页面与研究页切换、项目/商品显示、计费重1.2kg、人工确认默认未勾选、未核实字段拦截、广告事实输入均通过，无横向溢出；没有保存真实人工确认记录。故障演练仅终止本次监督进程拥有的SSH子进程：研究503、原/config200、本地math200、连接自动恢复；未停止原研究worker、未重发业务请求。

真实付费AI/采集/翻译/飞书/上传/发布未执行；用户经营流程和阶段4–6仍待后续，不由绿色测试代替。

## 审查裁决和待改进

- 使用原工作树内`codex/`分支与私有快照，遵守研究仓库原地工作要求。代价：后续需明确分支合并，不能依赖worktree清理。
- 当前研究缺少营销人工事实字段，因此阶段3先加入唯一受控事实命令及状态查询，通用任务命令留后续。代价：若不采用这条事实路径，关闭确认开关后只能查看摘要。
- 以计划明确的阶段0–3 MVP作为首批可部署界限，复杂研究仍保留原界面；草稿交接尚无永久导入关联。代价：阶段4–6仍需继续实施和验收。
- 审查中的迟到确认重绘会丢失新表单编辑，按实际影响提升为必须修复；已增加生命周期隔离测试。
- 待改进：私有配置错误字段类型应返回更友好错误；快速双击分页可能重复展示；极端有限数值乘法溢出应变成422。以上不影响正常有效输入，但属于后续加固事项。


研究源码本地提交：`d14e75f`（`codex/marketing-integration-20261009`）。主代码使用`codex/research-merge-20261009`分支，所有改动保留本地，不推送远端Git或创建PR；实际运行源码已生效。
# 后续完整交付（2026-10-09）

用户继续授权后，完整工作台、受控命令/状态、持久营销档案、成果关联及剩余验证已完成。当前使用、范围边界与回滚请读[项目当前状态](../项目当前状态.md)及[12-完整融合最终交接记录.md](12-完整融合最终交接记录.md)；下文仅记录先前阶段0–3，不再代表完整交付范围。
