# Phase P2: 全量文案与流程深度重塑 — 生成后后链路闭环与业务交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建商详全案生成后的一键交付中心、打通竞品分析长报告底部的落地行动呼吁，并全面诊断重塑全站冷硬报错与操作反馈文案，消除非专业跨境卖家的流程断点。

**Architecture:** 
- 在详情页结果区底部挂载自适应交付中心组件（`#detailDeliveryHandoffCard`），在生成完成或还原历史时展示核心交付（长图导出、独立站 HTML、图床托管、Launch Kit 物料包）及跨模块流转至 Listing/Ads。
- 在竞品分析报告（单品报告及多品矩阵报告）末尾渲染“赢家洞察落地行动”底部卡片，提供无需返回顶部的直达流转操作。
- 在 `details.js`、`listing.js`、`ads.js`、`square_redraw.js` 中将冷硬、工程师导向的技术提示重塑为带有清晰原因与解决方案的诊断性文案。

**Tech Stack:** Vanilla JavaScript (ES2022+), Tailwind CSS, Node.js built-in test runner (`node:test`, `node:assert/strict`).

**Spec:** `docs/superpowers/specs/2026-09-20-p2-post-generation-guidance-design.md`

## Global Constraints

- 绝不破坏既有 928+ 项全量单元测试（575 Python + 353 Node.js）。
- 保持跨模块数据注入协议兼容（`window.listingDraftState`、`window.adsDraftState`、`switchMainTab`）。
- 绝不向前端泄露 API Key、模型 Secret 等敏感凭据。
- 遵循 TDD 铁律，每一项任务严格先写失败测试，在终端看到红灯后再写实现，测试通过后独立提交。

## Review Focus

1. **零模块或全失败时的防御**: 当生成任务被中止（abort）或所有模块生成失败时，交付中心不得误报“生成完成”，且不得阻碍失败重试条的正常呈现。
2. **跨模块流转空值防御**: 从详情页流转到 Listing 或 Ads 时，若当前无产品名称或卖点为空，应给出温和的补充提示，不能抛出 TypeError 或写入 `undefined`。
3. **竞品分析语言切换同步**: 底部行动呼吁卡片必须跟随语言切换（`xp_currentLang` 中文/英文）动态同步文案。
4. **历史恢复与重置视图**: 历史记录恢复已生成的详情页项目时，交付中心应正常呈现；点击“返回修改”或清空重置时，交付中心应被重置隐藏。
5. **DOM 依赖弹性**: 所有新增的流转及渲染方法在 headless/node:test 环境中无 DOM 或部分 DOM 缺失时应具备防御性可选链保护，不引发未捕获异常。

---

### Task 1: 商详生成后交付中心 (Post-Generation Delivery Hub)

**Files:**
- Modify: `frontend/index.html:1250-1260`
- Modify: `frontend/js/details.js:3980-4030,4700-4750`
- Test: `frontend/tests/detail_delivery_hub.test.js`

**Interfaces:**
- Consumes: `globalGenContext`, `switchMainTab`, `openLongImageBuilder`, `openDetailDtcHtmlModal`, `openPdpAssetHostingModal`, `exportFullLaunchKit`
- Produces: `renderDetailDeliveryHub()`, `transferDetailToListing()`, `transferDetailToAds()`

- [ ] **Step 1: 编写交付中心失败单测**

创建 `frontend/tests/detail_delivery_hub.test.js`，测试：
1. `renderDetailDeliveryHub` 能够正确在 DOM 中渲染交付统计、长图导出、DTC HTML 复制、图床托管按钮。
2. `transferDetailToListing` 能够提取当前详情页产品名称与卖点并存入 `listingDraftState` 并触发页面跳转。
3. `transferDetailToAds` 能够提取当前详情页产品名称与卖点并存入 `adsDraftState` 并触发页面跳转。
4. 在无成功模块时交付中心不展示或显示友好提示。

- [ ] **Step 2: 运行单测确认失败**

Run: `node --test frontend/tests/detail_delivery_hub.test.js`
Expected: FAIL (函数未定义或 DOM 元素不存在)

- [ ] **Step 3: 编写交付中心实现代码**

1. 在 `frontend/index.html` 的 `resultArea` 内增加 `#detailDeliveryHandoffCard` 结构容器。
2. 在 `frontend/js/details.js` 中实现：
   - `renderDetailDeliveryHub(successCount, totalCount)`
   - `transferDetailToListing()`
   - `transferDetailToAds()`
   - 在 `generateDetailPlan` 完成回调与 `restoreDetailProjectFromHistory` 中调用 `renderDetailDeliveryHub`。
   - 在 `resetView()` 中隐藏交付中心。

- [ ] **Step 4: 运行单测确认通过**

Run: `node --test frontend/tests/detail_delivery_hub.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add frontend/index.html frontend/js/details.js frontend/tests/detail_delivery_hub.test.js
git commit -m "feat(details): add post-generation delivery hub and cross-module transfers"
```

---

### Task 2: 竞品分析报告底部下一步行动呼吁 (Competitor Analysis CTA Handoff)

**Files:**
- Modify: `frontend/index.html:400-500`
- Modify: `frontend/js/analysis.js:2100-2650`
- Test: `frontend/tests/analysis_bottom_handoff.test.js`

**Interfaces:**
- Consumes: `xp_currentSingleData`, `xp_currentMatrixData`, `xp_transferToListing`, `xp_transferToAds`, `xp_transferToDetails`, `xp_transferToBrandProfile`, `xp_transferMatrixToListing`, `xp_transferMatrixToAds`, `xp_transferMatrixToDetails`
- Produces: `xp_renderSingleBottomHandoff()`, `xp_renderMatrixBottomHandoff()`

- [ ] **Step 1: 编写竞品报告底部行动卡片失败单测**

创建 `frontend/tests/analysis_bottom_handoff.test.js`，测试：
1. 单品报告渲染完毕后，底部存在 `#xp-singleBottomHandoff` 且包含 Listing/Ads/Details/BrandProfile 四大流转按钮。
2. 多品矩阵渲染完毕后，底部存在 `#xp-matrixBottomHandoff` 且包含对标赢家的四大流转按钮。
3. 支持中英文文案随语言切换。

- [ ] **Step 2: 运行单测确认失败**

Run: `node --test frontend/tests/analysis_bottom_handoff.test.js`
Expected: FAIL

- [ ] **Step 3: 编写底部行动卡片实现代码**

1. 在 `frontend/index.html` 的 `xp-single-template` 尾部添加 `#xp-singleBottomHandoff` 占位，在 `xp-matrix-template` 尾部添加 `#xp-matrixBottomHandoff` 占位。
2. 在 `frontend/js/analysis.js` 中实现：
   - `xp_renderSingleBottomHandoff(d)`
   - `xp_renderMatrixBottomHandoff(data)`
   - 在 `xp_renderSingleTemplate` 与 `xp_renderMatrixTemplate` 尾部触发渲染。

- [ ] **Step 4: 运行单测确认通过**

Run: `node --test frontend/tests/analysis_bottom_handoff.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add frontend/index.html frontend/js/analysis.js frontend/tests/analysis_bottom_handoff.test.js
git commit -m "feat(analysis): add actionable bottom handoff cards to single and matrix reports"
```

---

### Task 3: 全局操作反馈与诊断性微文案优化 (Actionable Diagnostic Toasts)

**Files:**
- Modify: `frontend/js/details.js:2400-3200,4500-4750`
- Modify: `frontend/js/listing.js:140-160,630-640,1500-1520`
- Modify: `frontend/js/ads.js:260-270,360-370,705-715`
- Modify: `frontend/js/square_redraw.js:180-210`
- Test: `frontend/tests/diagnostic_feedback_toasts.test.js`

**Interfaces:**
- Consumes: `showToast(msg, type)`
- Produces: 升级后的高可读性、可指导操作的诊断性提示语

- [ ] **Step 1: 编写诊断文案优化测试**

创建 `frontend/tests/diagnostic_feedback_toasts.test.js`，测试：
1. 校验当输入为空或异常时，提示中包含具体指导（如明确指出必填字段、指引前往设置、给出支持的文件格式）。
2. 杜绝出现冷冰冰的单一词汇报错（如单纯的“生成失败”、“下载失败”等无解决方案提示）。

- [ ] **Step 2: 运行测试确认需要调整的项目**

Run: `node --test frontend/tests/diagnostic_feedback_toasts.test.js`
Expected: FAIL

- [ ] **Step 3: 优化文案与提示逻辑**

逐个模块替换原有的冷硬提示为具备建设性、指引性的文案。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test frontend/tests/diagnostic_feedback_toasts.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add frontend/js/details.js frontend/js/listing.js frontend/js/ads.js frontend/js/square_redraw.js frontend/tests/diagnostic_feedback_toasts.test.js
git commit -m "fix(ui): upgrade user feedback and error messages with actionable diagnostic guidance"
```

---

### Task 4: 全量双端测试回归与交付文档更新

**Files:**
- Modify: `task.md`
- Modify: `walkthrough.md`

- [ ] **Step 1: 运行全量前端单元测试**

Run: `node --test frontend/tests/*.test.js`
Expected: 356+ PASS, 0 FAIL

- [ ] **Step 2: 运行全量后端单元测试**

Run: `.venv/bin/python -m pytest backend/tests`
Expected: 575 PASS, 0 FAIL

- [ ] **Step 3: 语法与工作区洁净度检查**

Run: `git diff --check`
Expected: Clean

- [ ] **Step 4: 更新任务追踪与 Walkthrough**

更新 `task.md` 与 `walkthrough.md`，记录 Phase P2 完整变更。
