# 竞品 Firecrawl 多账号实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在竞品爬虫弹窗与设置页管理同一份多账号，明确启用后供新分析使用。

**Architecture:** 保留原 FirecrawlConfig 活动行和旧 API；使用现有 AppSetting 保存有版本的账号目录，原子同步活动行，不改变数据库结构。研究用途保持独立。服务端请求快照固定分析的账号；UI 复用原表单唯一节点。

**Tech Stack:** FastAPI、SQLAlchemy/SQLite、原生 JavaScript/dialog。

**Spec:** 用户本轮“改吧”确认的多账号需求与本计划约束。

## Global Constraints

- 保留已有密钥与分析数据，留空保留密钥，公开响应只返回掩码。
- 选择只查看；新增、保存、测试均不自动启用；启用有明确按钮。
- 测试结果按账号及版本隔离；未保存草稿测试不写入已保存状态。
- 不轮换密钥、不额外重试、不增加真实收费调用。
- 本轮沿用当前含大量未提交成果的工作区，备份任务文件，不创建丢失当前成果的空白工作树；不提交/推送。

## Review Focus

- 原有单账号读取不能触发写入；旧客户端更新活动账号须同步目录。
- 空密钥、自建无密钥服务不能悄悄借用另一个账号的密钥。
- 测试期间修改或启用账号，迟到结果不能污染当前状态。
- 草稿/明文查看时切换与关闭不能串密钥、丢失输入或关闭忙碌操作。
- 一次多链接分析固定同一账号；后续分析使用新账号。

### Task 1: 服务与调用链

**Files:** 新增 backend/services/crawler_config_service.py、backend/tests/test_crawler_profiles.py；修改 backend/main.py、backend/models/settings.py、backend/services/firecrawl.py。

**Interfaces:** GET/PUT /api/settings/crawler 保持旧字段；新增 profiles POST、GET、PUT、activate；测试与 reveal 接收 profile_id/expected_version。

- [x] 先写目录兼容、创建保存不激活、版本冲突、测试隔离、密钥和快照测试，运行确认失败。
- [x] 实现原子目录/兼容活动行和路由，分析请求快照。
- [x] 隔离数据库运行新旧相关测试，修复失败。

### Task 2: 共用账号界面

**Files:** frontend/index.html、frontend/js/settings.js、frontend/js/utils.js、frontend/css/settings.css；frontend/tests/crawler_profiles.test.js。

**Interfaces:** 原表单新增账号选择、名称、新增/使用按钮；UI 中保留活动快照与所选账号快照。

- [x] 写切换不启用、未保存保护、测试账号绑定、忙碌锁和保存测试，确认失败。
- [x] 实现下拉、命名、明确启用、状态与掩码，兼容原弹窗节点搬移与关闭。
- [x] 前端完整测试、桌面测试、语法及样式检查。

### Task 3: 验收与交付

**Files:** 当前状态与专项验收文档；私有候选客户端。

- [x] 隔离假接口走新增/保存/测试/启用，真实页面只读视觉验收。
- [x] 独立复核整体变化；修复重要问题后复测。
- [x] 重建后端客户端、验证签名与资源，安全更新自用客户端，记录回滚位置；不更新旧客户安装包。
- [x] 记录测试范围与限制，交付使用说明。

## 执行记录

本轮在原工作区备份后完成，无提交/推送。独立复核修复空密钥借用环境密钥的问题。用户随后要求删除名称栏，已改为新增自动编号，原名称仅保留下拉展示。验收边界及回滚详见专项记录。
