# 项目文档索引

- 2026-10-27：[竞品报告营销策略排版更新](ux-audit/2026-10-26-marketing-layout/验收记录.md)：渠道横排、脚本自适应铺开，内容完整保留。

- 2026-10-26：[竞品 Firecrawl 多账号与紧凑弹窗](ux-audit/2026-10-26-crawler-profiles/验收记录.md)：选择只查看，明确启用；已删除重复名称栏。

<!-- project-doc-status:start -->
> **文档状态同步：2026-10-26 · 现行入口或维护说明**
> 使用说明按当前代码同步；测试结果引用对应日期验收，本次文档整理没有运行收费链路或重新验收所有功能。
> 当前入口与验证范围：[项目当前状态](<项目当前状态.md>)；[2026-10-26流程修复与边界](<ux-audit/2026-10-26-sop-flow-repair/验收记录.md>)。
<!-- project-doc-status:end -->

2026-10-26 竞品分析的爬虫设置改为原页弹窗，使用同一配置，保留链接和报告；自用客户端已更新，前端908、桌面15通过。[实际截图与验收](ux-audit/2026-10-26-crawler-dialog/验收记录.md)。

2026-10-26 Firecrawl“连接成功却显示异常”已修复：按真实status判断并同步卡片/概览，自用客户端已更新；前端904、桌面15通过。[原因与验收](ux-audit/2026-10-26-firecrawl-status/验收记录.md)。

2026-10-26 候选商品切换改为局部更新，保留页面/列表/滚动位置，素材加载预留高度；自用客户端已更新，完整前端902、桌面15通过。[实测与回滚](ux-audit/2026-10-26-candidate-switch/验收记录.md)。

2026-10-26 选品研究流程断点修复已更新自用客户端：快速取舍、恢复已有研究、显式补采、漏斗/评分主流程入口。[操作、测试、原始SOP边界与回滚](ux-audit/2026-10-26-sop-flow-repair/验收记录.md)。

2026-10-25 核实商品操作区移到右侧“还需核实”上方，集中展示下一步说明及线索切换；自用客户端已更新。[位置截图与验收](ux-audit/2026-10-25-product-controls-position/验收记录.md)。

2026-10-25 商品核对改为原地弹窗：按钮说明操作用途，保存后返回列表并提示核实广告素材；保留来源、草稿、版本与相关性门槛。自用客户端已更新，前端853、桌面15通过。[本轮截图、验证与回滚](ux-audit/2026-10-25-product-identity-dialog/验收记录.md)。

2026-10-25 核实商品：广告原文去重，新搜索衔接本地商品页读取，素材区显示状态、原因与原地日志；旧线索可显式补读。自用客户端已更新，前端848、桌面15、后端专项117通过。Quick Covers实际读取返回404，未获取商品图；客户旧DMG未重建。[证据、边界及回滚](ux-audit/2026-10-25-product-media/验收记录.md)。

2026-10-24 关键词表格进一步调整：固定主次操作、紧凑预览标签及窄窗口布局，本机客户端已更新；前端802、桌面15通过。[本轮截图与验收](ux-audit/2026-10-24-keyword-layout/验收记录.md)。

2026-10-24 选品研究逐页UI修复已更新本机客户端：核对面板分区、正常流工具栏、展开保留、空状态、表单字号和窄窗口排版。检查24个页面/状态，前端802、桌面15通过；未执行收费任务，客户旧DMG未重建。[验收与截图](ux-audit/2026-10-24-research-ui/验收记录.md)。

2026-10-24 补充修复第3/4/5步：未选商品时直接显示选择入口，已选商品时进入分析。本机已更新，前端798、桌面15通过。[原因与验收](ux-audit/2026-10-24-research-navigation/验收记录.md)。

2026-10-24 选品研究：平铺工具/历史、返回上一页、修复找线索、顶部布局、相关性依据下拉；本机客户端已更新。见[验收、范围与回滚](ux-audit/2026-10-24-research-navigation/验收记录.md)。本轮前端795、桌面15通过，客户旧安装包未重新构建。

2026-10-23 新增 Mac 客户纯净版 0.2.0 测试候选：独立空数据、客户自配账户、首次引导、默认暂停、手动升级备份。自用版保持独立。[客户安装与更新](desktop-client/客户版安装与更新指南.md)、[本机验收及正式发行缺口](desktop-client/客户纯净版验收记录.md)。缺少 Developer ID、公证和第二台 Mac 验收，尚非正式发行包。

2026-10-23 已修复客户端ZIP下载，外部服务增加按需查看完整密钥与多套命名配置/明确启用；原配置保留。[使用、验证与回滚](desktop-client/下载与多套密钥配置更新.md)。

2026-10-22 尺寸重绘第1版已接入正式页面与Mac客户端：[更新与回滚](desktop-client/尺寸重绘界面更新.md)、[视觉及交互验收](design/square-redraw/2026-10-22/design-qa.md)。本轮完整前端777、桌面12项通过；未重验收费外部服务。

2026-10-22 Mac自用版收尾完成：客户端已安装，后台处理手动任务、飞书只观察；60分钟实测及单条同步读回通过。历史缺失素材按用户指令放弃恢复，详细结果及发行边界见[最终交付验收](desktop-client/最终交付验收.md)。


同步日期：2026-10-26。先读[项目当前状态](项目当前状态.md)与[Mac自用版使用说明](desktop-client/Mac自用版使用说明.md)。本次核对全部150份Markdown：更新144份项目维护文档，另新增同步清单；6份兼容来源/技能资料保留原样。范围、逐文件清单和校验见[文档同步记录](文档同步记录-2026-10-26.md)。

本次同步更新项目说明、开发指南、研究来源说明、Mac使用与客户交付说明、设计验收及全部`docs/` Markdown的状态入口。历史正文保留；当前主流程为五阶段、十步专业检查，内部分组投影仍为四组。没有修改业务代码、配置、依赖、数据库或外部服务。兼容来源/图标归属及技能资料共6份按来源约束保留原样；忽略目录、工具状态、构建产物、依赖及备份不属于本次项目文档清单。

## 推荐阅读

1. [项目说明与启动](../README.md)。
2. [当前架构、业务流程与验证范围](项目当前状态.md)。
3. [完整融合交接](merge-assessment/12-完整融合最终交接记录.md)。
4. [24页设计](design/research-ui/2026-10-19/README.md)及[最新视觉纠正](design/research-ui/2026-10-19/fidelity-correction.md)。
5. [开发规范与文件职责](../AGENTS.md)。

## 桌面客户端

收尾执行总计划：[Mac自用客户端一次性收尾](superpowers/plans/2026-10-21-mac-client-final-closeout.md)；[设计与验收约定](superpowers/specs/2026-10-21-mac-client-closeout-design.md)。两者为待审阅计划，不是已完成记录或新的后台运行授权。

[桌面客户端可行性与实施计划](desktop-client/桌面客户端可行性与实施计划.md)。首期Mac自用，共用核心代码并保留后续Web部署能力。2026-10-21已安装v9，旧数据接管、单次采集/飞书读写实测、周期轮询接线及安装包离线验收通过；持续运行保持暂停。原生草稿导入闭环、持续联网观察与正式发布仍待完成。另见[飞书轮询接线与验收](desktop-client/飞书轮询接线与验收.md)。参见[使用说明](desktop-client/Mac自用版使用说明.md)和[实施记录](desktop-client/实施记录.md)。

## 全部维护文档

| 文档 | 用途/时态 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 当前说明/历史任务（见正文范围） |
| [README.md](../README.md) | 当前说明/历史任务（见正文范围） |
| [backend/modules/research/SOURCE.md](../backend/modules/research/SOURCE.md) | 当前说明/历史任务（见正文范围） |
| [design-qa.md](../design-qa.md) | 设计参考与分轮验收 |
| [docs/design/research-ui/2026-10-19/README.md](design/research-ui/2026-10-19/README.md) | 设计参考与分轮验收 |
| [docs/design/research-ui/2026-10-19/fidelity-correction.md](design/research-ui/2026-10-19/fidelity-correction.md) | 设计参考与分轮验收 |
| [docs/design/research-ui/2026-10-19/implementation-acceptance.md](design/research-ui/2026-10-19/implementation-acceptance.md) | 设计参考与分轮验收 |
| [docs/design/research-ui/2026-10-19/设计生成规格.md](design/research-ui/2026-10-19/设计生成规格.md) | 设计参考与分轮验收 |
| [docs/merge-assessment/01-项目现状分析.md](merge-assessment/01-项目现状分析.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/02-功能融合对照表.md](merge-assessment/02-功能融合对照表.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/03-融合可行性与风险评估.md](merge-assessment/03-融合可行性与风险评估.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/04-融合架构方案.md](merge-assessment/04-融合架构方案.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/05-分阶段实施计划.md](merge-assessment/05-分阶段实施计划.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/06-MVP实施与运行说明.md](merge-assessment/06-MVP实施与运行说明.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/07-完整融合交付与运维.md](merge-assessment/07-完整融合交付与运维.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/08-前端访问故障修复.md](merge-assessment/08-前端访问故障修复.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/09-完整归并架构方案.md](merge-assessment/09-完整归并架构方案.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/10-完整归并实施计划.md](merge-assessment/10-完整归并实施计划.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/11-完整归并验收与运行说明.md](merge-assessment/11-完整归并验收与运行说明.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/12-完整融合最终交接记录.md](merge-assessment/12-完整融合最终交接记录.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/task18-rehearsal.md](merge-assessment/task18-rehearsal.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/task19-ownership.md](merge-assessment/task19-ownership.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/task20-cutover.md](merge-assessment/task20-cutover.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/merge-assessment/task21-local-runtime.md](merge-assessment/task21-local-runtime.md) | 融合阶段记录；以当前总览区分时点 |
| [docs/superpowers/plans/2026-05-12-ai-stability-engineering-hygiene.md](superpowers/plans/2026-05-12-ai-stability-engineering-hygiene.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-05-19-ad-copy-generator.md](superpowers/plans/2026-05-19-ad-copy-generator.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-06-24-square-redraw-batch.md](superpowers/plans/2026-06-24-square-redraw-batch.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-23-settings-api-routing-live-logs.md](superpowers/plans/2026-07-23-settings-api-routing-live-logs.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-24-detailed-ai-error-logging.md](superpowers/plans/2026-07-24-detailed-ai-error-logging.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-26-detail-ai-product-name.md](superpowers/plans/2026-07-26-detail-ai-product-name.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-26-detail-module-copy-toggle.md](superpowers/plans/2026-07-26-detail-module-copy-toggle.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-26-detail-modules-unselected-default.md](superpowers/plans/2026-07-26-detail-modules-unselected-default.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-26-text-translation-chinese-target.md](superpowers/plans/2026-07-26-text-translation-chinese-target.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-28-agents-project-guide-refresh.md](superpowers/plans/2026-07-28-agents-project-guide-refresh.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-28-ai-watermark-removal.md](superpowers/plans/2026-07-28-ai-watermark-removal.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-29-ad-copy-emoji-product-name.md](superpowers/plans/2026-07-29-ad-copy-emoji-product-name.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-29-pinterest-pin-ad-copy.md](superpowers/plans/2026-07-29-pinterest-pin-ad-copy.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-29-watermark-result-zoom.md](superpowers/plans/2026-07-29-watermark-result-zoom.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-30-ad-copy-bilingual-labels.md](superpowers/plans/2026-07-30-ad-copy-bilingual-labels.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-07-30-ad-copy-result-filters.md](superpowers/plans/2026-07-30-ad-copy-result-filters.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-08-11-openai-image-generation-mode.md](superpowers/plans/2026-08-11-openai-image-generation-mode.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-19-p0-copy-workflow-optimization.md](superpowers/plans/2026-09-19-p0-copy-workflow-optimization.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-19-p1-copy-workflow-optimization.md](superpowers/plans/2026-09-19-p1-copy-workflow-optimization.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-19-phase-1-core-fixes-and-security.md](superpowers/plans/2026-09-19-phase-1-core-fixes-and-security.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-19-phase-2-performance-and-resource-management.md](superpowers/plans/2026-09-19-phase-2-performance-and-resource-management.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-19-phase-3-architecture-and-resilience.md](superpowers/plans/2026-09-19-phase-3-architecture-and-resilience.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-20-ccswitch-usage-query.md](superpowers/plans/2026-09-20-ccswitch-usage-query.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-20-p2-post-generation-guidance.md](superpowers/plans/2026-09-20-p2-post-generation-guidance.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-20-p3-visual-tools-guidance.md](superpowers/plans/2026-09-20-p3-visual-tools-guidance.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-09-22-unified-ai-api-retry-system.md](superpowers/plans/2026-09-22-unified-ai-api-retry-system.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-10-18-research-task-experience.md](superpowers/plans/2026-10-18-research-task-experience.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/plans/2026-10-19-research-ui-24-pages.md](superpowers/plans/2026-10-19-research-ui-24-pages.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-05-19-ad-copy-generator-design.md](superpowers/specs/2026-05-19-ad-copy-generator-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-06-24-square-redraw-batch-design.md](superpowers/specs/2026-06-24-square-redraw-batch-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-23-settings-api-routing-live-logs-design.md](superpowers/specs/2026-07-23-settings-api-routing-live-logs-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-24-detailed-ai-error-logging-design.md](superpowers/specs/2026-07-24-detailed-ai-error-logging-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-26-detail-ai-product-name-design.md](superpowers/specs/2026-07-26-detail-ai-product-name-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-26-detail-module-copy-toggle-design.md](superpowers/specs/2026-07-26-detail-module-copy-toggle-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-26-detail-modules-unselected-default-design.md](superpowers/specs/2026-07-26-detail-modules-unselected-default-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-26-text-translation-chinese-target-design.md](superpowers/specs/2026-07-26-text-translation-chinese-target-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-28-agents-project-guide-refresh-design.md](superpowers/specs/2026-07-28-agents-project-guide-refresh-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-28-ai-watermark-removal-design.md](superpowers/specs/2026-07-28-ai-watermark-removal-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-28-watermark-result-zoom-design.md](superpowers/specs/2026-07-28-watermark-result-zoom-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-29-ad-copy-emoji-product-name-design.md](superpowers/specs/2026-07-29-ad-copy-emoji-product-name-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-29-pinterest-pin-ad-copy-design.md](superpowers/specs/2026-07-29-pinterest-pin-ad-copy-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-30-ad-copy-bilingual-labels-design.md](superpowers/specs/2026-07-30-ad-copy-bilingual-labels-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-07-30-ad-copy-result-filters-design.md](superpowers/specs/2026-07-30-ad-copy-result-filters-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-08-11-openai-image-generation-mode-design.md](superpowers/specs/2026-08-11-openai-image-generation-mode-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-09-19-p0-copy-workflow-optimization-design.md](superpowers/specs/2026-09-19-p0-copy-workflow-optimization-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-09-19-p1-copy-workflow-optimization-design.md](superpowers/specs/2026-09-19-p1-copy-workflow-optimization-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-09-20-ccswitch-usage-query-design.md](superpowers/specs/2026-09-20-ccswitch-usage-query-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-09-20-p2-post-generation-guidance-design.md](superpowers/specs/2026-09-20-p2-post-generation-guidance-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-09-20-p3-visual-tools-guidance-design.md](superpowers/specs/2026-09-20-p3-visual-tools-guidance-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/superpowers/specs/2026-09-22-unified-ai-api-retry-system-design.md](superpowers/specs/2026-09-22-unified-ai-api-retry-system-design.md) | 历史设计/计划，保留原任务状态 |
| [docs/ux-audit/2026-10-16-research/修复与验证记录-2026-10-17.md](ux-audit/2026-10-16-research/修复与验证记录-2026-10-17.md) | 历史审计与修复证据 |
| [docs/ux-audit/2026-10-16-research/选品研究-真实浏览器验收报告.md](ux-audit/2026-10-16-research/选品研究-真实浏览器验收报告.md) | 历史审计与修复证据 |
| [docs/ux-audit/2026-10-18-media-navigation/修复与验收记录.md](ux-audit/2026-10-18-media-navigation/修复与验收记录.md) | 历史审计与修复证据 |
| [docs/ux-audit/2026-10-18-task-flow/实施与验证记录.md](ux-audit/2026-10-18-task-flow/实施与验证记录.md) | 历史审计与修复证据 |
| [docs/ux-audit/2026-10-18-task-flow/选品研究-任务体验分析与改进方案.md](ux-audit/2026-10-18-task-flow/选品研究-任务体验分析与改进方案.md) | 历史审计与修复证据 |
| [docs/ux-audit/2026-10-18-user-rewalk/repair/修复与验收记录.md](ux-audit/2026-10-18-user-rewalk/repair/修复与验收记录.md) | 历史审计与修复证据 |
| [docs/ux-audit/2026-10-18-user-rewalk/选品研究-改进后真实流程复测报告.md](ux-audit/2026-10-18-user-rewalk/选品研究-改进后真实流程复测报告.md) | 历史审计与修复证据 |
| [docs/项目当前状态.md](项目当前状态.md) | 当前说明/历史任务（见正文范围） |
| [frontend/assets/research/README.md](../frontend/assets/research/README.md) | 当前说明/历史任务（见正文范围） |
| [task-7-report.md](../task-7-report.md) | 当前说明/历史任务（见正文范围） |

## 同步检查范围

- 历史文件补充时态说明和当前总览链接，不重写原快照、证据摘要、迁移裁决、测试结果或复选框。
- README、AGENTS、研究来源说明补齐原生研究、统一导航、统一接口配置和完整前端测试命令。
- 最新侧栏记录为上一轮733项前端测试通过；本次仅进行文档链接、引用文件存在性和差异检查，不把旧后端报告冒充新验证。
- `backend/modules/research/compat/`中的旧部署手册/示例属于源项目保留材料；运行入口以根README为准。`agents/skills/`是技能定义，不是需要同步改写的产品文档。

## 2026-10-24 研究确认交互更新

“重试搜索”等研究操作改为原页弹窗，保留费用提示和单次提交保护；已更新本机客户端。807项前端、15项桌面通过，未提交真实搜索。见[验收与回滚](ux-audit/2026-10-24-confirmation-dialog/验收记录.md)。

## 2026-10-24 当前词采集日志窗口

未完成状态旁新增“查看采集日志”，原页展示失败阶段、已记录原因、本次尝试执行过程及下一步；排队开始后原地更新。自用客户端已更新，813项前端、15项桌面通过。见[验证、截图与回滚](ux-audit/2026-10-24-collection-logs/验收记录.md)。

## 2026-10-24 广告采集方式与多 API 配置

当前词旁可切换浏览器/API，API模式下可选择设置中已保存的命名配置，显式确认后切换共用账号。方式仅对本项目，账号对所有项目共用；不会自动轮换或采集。824项前端、15项桌面及28/6项后端专项通过。见[验收、作用范围与回滚](ux-audit/2026-10-24-collection-mode/验收记录.md)。

## 2026-10-24 运行日志层级合并

后台状态并入实时日志卡片，默认展示运行/队列摘要，单层详情按需展开；持久研究日志改为标题栏快捷入口，记录机制保持区分。自用客户端已更新，827项前端、15项桌面通过。见[截图、验证与回滚](ux-audit/2026-10-24-logs-unification/验收记录.md)。

## 2026-10-24 外部接口与存储标签修复

存储改为独立静态标签和面板，修复外部接口高亮却显示存储内容的问题，保留既有配置与上传器设置入口。已更新自用客户端并核验两个分区；829 项前端、15 项桌面通过，无后端或凭据变更，无远程上传/收费调用，客户 DMG 未重建。见[截图、验证与回滚](ux-audit/2026-10-24-storage-tab/验收记录.md)。

## 2026-10-24 外部接口账号管理排版

服务列表收紧，右侧账号选择/新增、凭据、保存/测试/放弃统一成一个表单；当前使用和备用状态明确，新增空白状态及启用防重复修正。自用客户端普通/研究框架已核验，833项前端、15项桌面通过；多账号写入仅隔离模拟，未改生产账号，客户DMG未重建。[本轮记录与截图](ux-audit/2026-10-24-integrations-layout/验收记录.md)。

## 2026-10-24 AI新增入口位置

新增AI线路按钮已移入AI模型→能力路由卡片标题栏，与刷新并排，无独占行。客户端已更新；11项设置导航专项通过，原新增编辑器打开/关闭已核验，无配置写入。见[记录](ux-audit/2026-10-24-ai-add-button-inline/验收记录.md)。

## 2026-10-25 研究起点与初始词确认

第1步显示关键词准备，第2步显示商品核实或对应空白指引；按钮组有明确间距。AI确认完整展示保存的研究目标，资料改变要求重新确认；原后端完整方向传递已用隔离测试验证。空项目禁用批量扫描。已更新自用客户端，前端838、桌面15、方向策略专项5通过，无真实收费提交或生产配置写入。见[验证、截图及回滚](ux-audit/2026-10-25-research-start/验收记录.md)。

## 2026-10-25 关键词标题栏与原地反馈

关键词按钮与标题放入独立标题栏，空状态/表格不再挤占操作行。AI初始词任务状态、完成数量与失败原因在本区显示，原有确认与防重复保留。真实客户端已核验已有28词任务结果，运行与失败在隔离页面模拟验证；前端843、桌面15通过，无真实外部提交，客户DMG未重建。[证据与回滚](ux-audit/2026-10-25-keyword-feedback/验收记录.md)。

## 2026-10-25 商品与广告内容分区

原文紧凑工具栏、商品售价信息及右侧线索扩展入口已更新自用客户端；详见[验收、截图与回滚](ux-audit/2026-10-25-lead-content-tabs/验收记录.md)。

## 2026-10-25 商品售价修复

千位价格、促销价及旧快照展示已修复，实际客户端核验USD 1,249.00。见[专项验收与回滚](ux-audit/2026-10-25-price-extraction/验收记录.md)。

- [2026-10-25 商品资料顺序与广告主页名称说明](ux-audit/2026-10-25-candidate-labels/验收记录.md)。

- [2026-10-25 商品核对三种结果：操作与验收](ux-audit/2026-10-25-identity-outcomes/验收记录.md)。

- [2026-10-25 搜索词中文释义：操作与验收](ux-audit/2026-10-25-keyword-meaning/验收记录.md)。

- [2026-10-25 广告证据自动检查与实际素材数量](ux-audit/2026-10-25-creative-evidence/验收记录.md)。

- [2026-10-26 多套餐价格区间、总价与折合单价](ux-audit/2026-10-26-variant-prices/验收记录.md)。

- [2026-10-26 广告证据保存结果与跳转闭环修复](ux-audit/2026-10-26-coarse-save-flow/验收记录.md)。
