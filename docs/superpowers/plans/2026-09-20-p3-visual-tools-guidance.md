# Phase P3: 全局视觉工具流打通与非专业卖家体验升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 针对非专业跨境电商卖家，重塑图片翻译、尺寸重绘、系统设置与品牌画像四大模块的交互指引、预设组与流转链路，消除硬编码误导与工程师黑话。

**Architecture:**
- 在图片翻译模块移除硬编码 `Gemini Active`，纠正空状态文案并增加地域语言预设包（欧美/东南亚/日韩）；
- 在尺寸重绘模块消除“重跑失败”黑话，为常用比例增加电商平台标签（Amazon/Shopify/Shopee/TikTok），并增加向图片翻译的流转动作；
- 在 AI 设置中心为 Gemini 与 OpenAI 兼容协议增加常用推荐模型一键填入药丸；
- 在品牌营销画像底座中提供一键载入官方示范范本（人体工学椅），降低填写门槛。

**Tech Stack:** Vanilla JavaScript (ES2022+), Tailwind CSS, Node.js built-in test runner (`node:test`, `node:assert/strict`).

**Spec:** `docs/superpowers/specs/2026-09-20-p3-visual-tools-guidance-design.md`

## Global Constraints

- 绝不破坏既有 941 项全量单元测试（575 Python + 366 Node.js）。
- 保持跨模块数据注入协议兼容（`window.transImages`, `switchMainTab`, `renderTransCards`）。
- 绝不向前端泄露 API Key、模型 Secret 等敏感凭据。
- 遵循 TDD 铁律，每一项任务严格先写失败测试，在终端看到红灯后再写实现，测试通过后独立提交。

---

### Task 1: AI 图片翻译体验重塑与硬编码消除 (Image Translation Overhaul)

**Files:**
- Modify: `frontend/index.html:2170-2210`
- Modify: `frontend/js/translate.js:20-60`
- Test: `frontend/tests/translate_guidance.test.js`

**Interfaces:**
- Consumes: `TRANS_LANG_OPTIONS`, `getSelectedTransLangs()`, `updateLangDropdownLabel()`, `updateTransStartBtn()`
- Produces: `applyQuickLangPreset(presetKey)`, dynamic `#transEngineStatus`

- [ ] **Step 1: 编写图片翻译指引与预设失败单测**
创建 `frontend/tests/translate_guidance.test.js`，测试：
1. `index.html` 不再包含硬编码 `Gemini Active`，取而代之的是通用的 `#transEngineStatus`。
2. `transEmptyState` 文案明确说明翻译与排版回填功能，而非单纯的水印擦除。
3. `applyQuickLangPreset('western')` 能够正确勾选欧美五国语言并更新选中标签；`applyQuickLangPreset('sea')` 能正确勾选东南亚语言。
4. 下拉菜单中存在常用语言预设快捷按钮。

- [ ] **Step 2: 运行单测确认失败**
Run: `node --test frontend/tests/translate_guidance.test.js`
Expected: FAIL

- [ ] **Step 3: 编写图片翻译优化实现代码**
1. 在 `frontend/index.html` 中替换硬编码 `Gemini Active` 为动态 `#transEngineStatus`，优化 `transEmptyState` 文案；在 `langDropdownMenu` 增加预设区域按钮条；在 `styleStrength` 旁增加通俗说明。
2. 在 `frontend/js/translate.js` 中实现 `applyQuickLangPreset(presetKey)`。

- [ ] **Step 4: 运行单测确认通过**
Run: `node --test frontend/tests/translate_guidance.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**
```bash
git add frontend/index.html frontend/js/translate.js frontend/tests/translate_guidance.test.js
git commit -m "feat(translate): remove hardcoded provider text and add region language presets"
```

---

### Task 2: AI 尺寸重绘去黑话、场景化比例与流转闭环 (Square Redraw Overhaul)

**Files:**
- Modify: `frontend/index.html:2090-2130`
- Modify: `frontend/js/square_redraw.js:140-155,270-350`
- Test: `frontend/tests/square_redraw_guidance.test.js`

**Interfaces:**
- Consumes: `squareRedrawImages`, `switchMainTab`, `transImages`, `renderTransCards`
- Produces: `sendSquareRedrawToTranslate(itemId)`

- [ ] **Step 1: 编写尺寸重绘去黑话与流转失败单测**
创建 `frontend/tests/square_redraw_guidance.test.js`，测试：
1. 界面与脚本中的“重跑失败”全面替换为“重试失败项”，失败卡片提示包含友好的排错说明。
2. `squareRedrawAspectSelect` 下拉选项包含电商平台场景提示（Amazon、Shopify、Shopee、TikTok 等）。
3. `sendSquareRedrawToTranslate(itemId)` 能够将成功重绘的图片无损推入图片翻译队列，并触发页面跳转与 Toast。

- [ ] **Step 2: 运行单测确认失败**
Run: `node --test frontend/tests/square_redraw_guidance.test.js`
Expected: FAIL

- [ ] **Step 3: 编写尺寸重绘优化实现代码**
1. 在 `frontend/index.html` 中更新 `#squareRedrawRetryBtn` 文案，增强 `squareRedrawAspectSelect` 的 option 标签。
2. 在 `frontend/js/square_redraw.js` 中将微文案升级，并实现 `sendSquareRedrawToTranslate(itemId)`，在卡片和预览弹窗中挂载流转按钮。

- [ ] **Step 4: 运行单测确认通过**
Run: `node --test frontend/tests/square_redraw_guidance.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**
```bash
git add frontend/index.html frontend/js/square_redraw.js frontend/tests/square_redraw_guidance.test.js
git commit -m "feat(square-redraw): eliminate jargon, add platform ratios, and link to translate"
```

---

### Task 3: 系统设置中心小白配置指引与常用模型一键填入 (Settings Quick Model Pills)

**Files:**
- Modify: `frontend/index.html:3800-4100`
- Modify: `frontend/js/settings.js:800-1100`
- Test: `frontend/tests/settings_quick_model_pills.test.js`

**Interfaces:**
- Consumes: `renderProviderModal`, `onSettingsProtocolChange`
- Produces: `applyQuickModelPill(capability, modelName)`

- [ ] **Step 1: 编写常用模型药丸失败单测**
创建 `frontend/tests/settings_quick_model_pills.test.js`，测试：
1. 切换协议至 `gemini` 时渲染 Gemini 常用模型药丸（`gemini-2.5-flash`, `gemini-2.5-pro` 等）。
2. 切换协议至 `openai_compatible` 时渲染常用兼容模型药丸（`gpt-4o`, `gpt-4o-mini` 等）。
3. 点击药丸能够直接将模型名填充至对应文本或图片模型输入框。

- [ ] **Step 2: 运行单测确认失败**
Run: `node --test frontend/tests/settings_quick_model_pills.test.js`
Expected: FAIL

- [ ] **Step 3: 编写常用模型药丸实现代码**
1. 在 `frontend/index.html` 的服务商编辑模态框中添加模型推荐药丸容器。
2. 在 `frontend/js/settings.js` 中根据所选协议动态渲染模型药丸并绑定一键填入事件。

- [ ] **Step 4: 运行单测确认通过**
Run: `node --test frontend/tests/settings_quick_model_pills.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**
```bash
git add frontend/index.html frontend/js/settings.js frontend/tests/settings_quick_model_pills.test.js
git commit -m "feat(settings): add quick model recommendation pills for provider setup"
```

---

### Task 4: 品牌营销画像官方示范范本载入与微文案优化 (Brand Context Demo Profile)

**Files:**
- Modify: `frontend/index.html:2770-2850`
- Modify: `frontend/js/brand_context.js:150-250`
- Test: `frontend/tests/brand_context_demo_profile.test.js`

**Interfaces:**
- Consumes: `brandContextHub`
- Produces: `loadOfficialDemoProfile()`

- [ ] **Step 1: 编写示范范本载入失败单测**
创建 `frontend/tests/brand_context_demo_profile.test.js`，测试：
1. 调用 `window.brandContextHub.loadOfficialDemoProfile()` 能够将标准化的人体工学椅示范案例载入表单。
2. DOM 中存在「载入官方示范案例」按钮。
3. 表单中包含通俗易懂的启发式副标题。

- [ ] **Step 2: 运行单测确认失败**
Run: `node --test frontend/tests/brand_context_demo_profile.test.js`
Expected: FAIL

- [ ] **Step 3: 编写示范范本载入实现代码**
1. 在 `frontend/index.html` 的 `brandContextModal` 中添加「载入示范案例」快捷按钮及副标题提示。
2. 在 `frontend/js/brand_context.js` 中实现 `loadOfficialDemoProfile()`。

- [ ] **Step 4: 运行单测确认通过**
Run: `node --test frontend/tests/brand_context_demo_profile.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**
```bash
git add frontend/index.html frontend/js/brand_context.js frontend/tests/brand_context_demo_profile.test.js
git commit -m "feat(brand-context): add official demo profile template and beginner guidance"
```

---

### Task 5: 双端全量回归与 Walkthrough 更新

- [ ] **Step 1: 运行全量前端单元测试**
Run: `node --test frontend/tests/*.test.js`
Expected: PASS (全绿，无新增失败)

- [ ] **Step 2: 运行全量后端单元测试**
Run: `.venv/bin/python -m pytest backend/tests`
Expected: 575 passed

- [ ] **Step 3: 检查 git 洁净度**
Run: `git diff --check`
Expected: 0 warnings

- [ ] **Step 4: 更新 walkthrough 交付文档**
更新 `walkthrough.md` 与 `task.md`。
