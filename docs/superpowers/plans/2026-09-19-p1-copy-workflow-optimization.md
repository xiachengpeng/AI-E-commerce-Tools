# 全量文案与流程深度重塑 (Phase P1: 商详引导预设、全站空状态升级、去工程师黑话、Listing精修对比) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 升级详情页首屏 Onboarding 与高转化预设触达、改造全站消极空状态为引导卡片、消除工程师黑话使业务表意通俗易懂、为 Listing 局部定向精修增加原版对比与采纳/放弃机制。

**Architecture:** 
- 前端 `frontend/index.html` 与 `frontend/js/details.js`：将详情页右侧空白 `showcaseArea` 升级为 3 步可视化引导与 6 大高转化预设组合快捷选用卡片；在独立站图文预览空状态时增加快捷行动引导。
- 前端 `frontend/js/history_manager.js` 与 `frontend/js/listing.js`：重塑历史记录和 Listing 空状态为友好且具指引性的引导卡片。
- 前端微文案与 Tooltip：通俗化“零变形约束”（标明“100% 外观一致性锁定”）、“DTC 图文”（标明“独立站富文本落地页”），去除生硬技术术语。
- 前端 `frontend/js/listing.js`：为标题、五点描述局部精修设计对比暂存态（Pending Comparison），并提供【采纳新版】与【保留原版】操作，避免单向覆盖用户心仪内容。

**Tech Stack:** Vanilla JavaScript (ES2022+), Tailwind CSS, Node.js Test Runner (`node --test`), Pytest.

**Spec:** `docs/superpowers/specs/2026-09-19-p1-copy-workflow-optimization-design.md`

## Global Constraints

- **TDD Iron Law**: 每个功能必须先编写测试并验证失败，再编写实现代码，验证通过后再提交。
- **Working Tree Hygiene**: 保留用户未暂存文件，严禁破坏或 revert 工作区中未提交代码。
- **Zero Regression**: 保持全站 919+ 现有前后端测试持续 100% 通过。
- **Compatibility**: 保持现有 `MODULE_PRESETS` 键值与 DOM 元素 ID 兼容，不破坏已有逻辑与单测。

## Review Focus

1. `details.js` 中点击右侧 Onboarding 预设卡片能正确触发预设选用，并在左侧即时同步选中模块状态。
2. `dtcHybridContainer` 在未生成任务或任务列表为空时，展示空状态引导并提供预设选用能力。
3. `history_manager.js` 在空记录时展示规范卡片，不影响原有批量删除及多模块历史切换。
4. `listing.js` 在五点换一换或精修完成后，支持展示【原版】与【精修版】，点击【采纳】后更新数据并存入历史，点击【保留原版】时还原并关闭对比。
5. 全量双端测试通过，无任何语法或断言错误。

---

### Task 1: 商详首屏 Onboarding Hub 引导与 6 大高转化预设卡片

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/details.js`
- Test: `frontend/tests/detail_onboarding_hub.test.js`

**Interfaces:**
- Consumes: `applyModulePreset(presetKey)`, `MODULE_PRESETS`, `modules`
- Produces: `renderDetailOnboardingHub()`, Onboarding 快捷预设点击事件

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement Onboarding Hub in HTML and details.js**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 2: 全站消极空状态重塑为 Onboarding 行动指引

**Files:**
- Modify: `frontend/js/history_manager.js`
- Modify: `frontend/js/listing.js`
- Modify: `frontend/js/details.js`
- Test: `frontend/tests/empty_state_onboarding.test.js`

**Interfaces:**
- Consumes: `renderHistoryItems()`, `renderListingData()`, `renderDtcHybridPreview()`
- Produces: 友好引导空状态卡片与 CTA 行为

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement enhanced empty states**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 3: 全站微文案去黑话与通俗化优化

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/details.js`
- Test: `frontend/tests/microcopy_clarity.test.js`

**Interfaces:**
- Consumes: DOM labels, badge titles, tooltips
- Produces: 规范清晰且包含“零变形约束”通俗化解读的文本

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Update microcopy and tooltips**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 4: Listing 局部定向精修原版对比与采纳/保留机制

**Files:**
- Modify: `frontend/js/listing.js`
- Test: `frontend/tests/listing_regeneration_comparison.test.js`

**Interfaces:**
- Consumes: `regenerateListingSection(section, bulletIndex, instruction)`
- Produces: `acceptRegeneratedSection(section, bulletIndex)`, `dismissRegeneratedSection(section, bulletIndex)`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement comparison state and UI controls**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 5: 全量双端测试回归与代码洁净度验证

**Files:**
- Test: Backend pytest suite (`backend/tests`)
- Test: Frontend node:test suite (`frontend/tests/*.test.js`)

- [ ] **Step 1: Run backend pytest suite**
- [ ] **Step 2: Run frontend test suite**
- [ ] **Step 3: Check git diff hygiene**
- [ ] **Step 4: Update walkthrough and task artifacts**
