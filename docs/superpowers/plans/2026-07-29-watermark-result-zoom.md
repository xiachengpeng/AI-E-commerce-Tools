# AI 消除结果放大预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 消除后的结果图片增加可访问的全屏放大预览，同时保持原有结果对比、历史恢复和下载行为不变。

**Architecture:** 在现有 AI 消除模块内部管理一个独立预览层。HTML 提供语义化对话框与两个打开入口，CSS 负责保持原设计风格和视口内完整显示，`watermark_removal.js` 负责打开、关闭、焦点恢复、背景滚动锁定和结果失效时清理。

**Tech Stack:** Vanilla HTML、CSS、JavaScript、Node.js 内置测试运行器。

## Global Constraints

- 预览只展示当前成功的 AI 消除结果，不发起新的 AI 请求。
- 支持结果图片、放大按钮和键盘打开；支持关闭按钮、遮罩点击和 `Escape` 关闭。
- 关闭后恢复打开入口的焦点，打开时锁定背景滚动。
- 更换图片、清空结果或结果失效时关闭并清理预览。
- 不修改下载接口、后端接口或数据库结构。

---

### Task 1: 预览结构与视觉

**Files:**
- Modify: `frontend/index.html:1313-1343`
- Modify: `frontend/css/watermark_removal.css`
- Test: `frontend/tests/watermark_removal_ui.test.js`

**Interfaces:**
- Consumes: 当前结果图片元素 `#watermarkRemovalResult`。
- Produces: `#watermarkRemovalZoomButton`、`#watermarkRemovalPreview`、`#watermarkRemovalPreviewImage`、`#watermarkRemovalPreviewClose`。

- [ ] **Step 1: 写入失败的页面结构测试**

在 `page exposes the AI removal tab and controls` 附近增加断言：

```js
assert.match(indexHtml, /id="watermarkRemovalZoomButton"/);
assert.match(indexHtml, /id="watermarkRemovalPreview"/);
assert.match(indexHtml, /role="dialog"/);
assert.match(indexHtml, /aria-modal="true"/);
assert.match(indexHtml, /id="watermarkRemovalPreviewImage"/);
assert.match(indexHtml, /id="watermarkRemovalPreviewClose"/);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test frontend/tests/watermark_removal_ui.test.js`

Expected: FAIL，缺少 `watermarkRemovalZoomButton` 或预览对话框。

- [ ] **Step 3: 添加最小 HTML**

将结果图片容器改为可交互区域，保留 `#watermarkRemovalResult`，加入放大按钮：

```html
<div class="watermark-removal-result-image watermark-removal-result-image-zoomable">
    <img id="watermarkRemovalResult" alt="AI 水印消除结果" tabindex="0"
        role="button" aria-label="放大查看 AI 消除结果">
    <button id="watermarkRemovalZoomButton" type="button"
        class="watermark-removal-zoom-button" aria-label="放大查看 AI 消除结果">
        <i class="ph ph-magnifying-glass-plus"></i>
    </button>
</div>
```

在 AI 消除视图末尾加入独立对话框：

```html
<div id="watermarkRemovalPreview" class="watermark-removal-preview" hidden
    role="dialog" aria-modal="true" aria-labelledby="watermarkRemovalPreviewTitle">
    <div class="watermark-removal-preview-panel">
        <h2 id="watermarkRemovalPreviewTitle" class="sr-only">AI 消除结果放大预览</h2>
        <button id="watermarkRemovalPreviewClose" type="button"
            class="watermark-removal-preview-close" aria-label="关闭放大预览">
            <i class="ph ph-x"></i>
        </button>
        <img id="watermarkRemovalPreviewImage" alt="放大的 AI 水印消除结果">
    </div>
</div>
```

- [ ] **Step 4: 添加最小 CSS**

实现以下行为：

```css
.watermark-removal-result-image-zoomable { position: relative; cursor: zoom-in; }
.watermark-removal-zoom-button { position: absolute; top: 12px; right: 12px; }
.watermark-removal-preview {
    position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
    padding: 24px; background: rgba(15, 23, 42, .88);
}
.watermark-removal-preview[hidden] { display: none; }
.watermark-removal-preview-panel { position: relative; max-width: 96vw; max-height: 92vh; }
.watermark-removal-preview img { max-width: 96vw; max-height: 92vh; object-fit: contain; }
.watermark-removal-preview-close { position: absolute; top: 12px; right: 12px; }
body.watermark-removal-preview-open { overflow: hidden; }
```

按钮颜色、圆角、阴影和焦点环使用现有靛蓝色设计变量。

- [ ] **Step 5: 运行结构测试**

Run: `node --test frontend/tests/watermark_removal_ui.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add frontend/index.html frontend/css/watermark_removal.css frontend/tests/watermark_removal_ui.test.js
git commit -m "feat: add watermark result preview structure"
```

---

### Task 2: 预览行为与状态清理

**Files:**
- Modify: `frontend/js/watermark_removal.js`
- Modify: `frontend/tests/watermark_removal_ui.test.js`

**Interfaces:**
- Consumes: Task 1 创建的四个 DOM 元素和当前 `state.result`。
- Produces: 模块内部 `openResultPreview(trigger)`、`closeResultPreview()`；不新增全局业务 API。

- [ ] **Step 1: 扩充测试运行环境**

在测试元素列表加入四个新 ID，并让假元素的 `focus()` 记录 `harnessState.focusedId`；给 `document.body.classList` 提供 `FakeClassList`。

- [ ] **Step 2: 写入失败的打开与关闭行为测试**

测试先通过历史结果恢复建立有效结果，再验证：

```js
elements.watermarkRemovalResult.emit("click", {});
assert.equal(elements.watermarkRemovalPreview.hidden, false);
assert.equal(elements.watermarkRemovalPreviewImage.src, "http://localhost:8000/static/result/sample.png");
assert.equal(state.focusedId, "watermarkRemovalPreviewClose");

elements.watermarkRemovalPreviewClose.emit("click", {});
assert.equal(elements.watermarkRemovalPreview.hidden, true);
assert.equal(elements.watermarkRemovalPreviewImage.src, "");
assert.equal(state.focusedId, "watermarkRemovalResult");
```

另测放大按钮可打开、遮罩自身点击可关闭、图片区域点击不关闭、`Escape` 可关闭、结果不存在时不打开。

- [ ] **Step 3: 运行测试并确认失败**

Run: `node --test frontend/tests/watermark_removal_ui.test.js`

Expected: FAIL，预览元素没有事件行为。

- [ ] **Step 4: 实现预览状态**

在 `state` 加入 `previewTrigger: null`，在 `cacheElements()` 缓存新元素。实现：

```js
function openResultPreview(trigger) {
    if (!state.result?.result_url || !state.elements.resultImage?.src) return;
    state.previewTrigger = trigger || state.elements.resultImage;
    state.elements.previewImage.src = state.elements.resultImage.src;
    state.elements.preview.hidden = false;
    document.body.classList.add("watermark-removal-preview-open");
    state.elements.previewClose.focus();
}

function closeResultPreview() {
    if (state.elements.preview.hidden) return;
    state.elements.preview.hidden = true;
    state.elements.previewImage.removeAttribute("src");
    document.body.classList.remove("watermark-removal-preview-open");
    const trigger = state.previewTrigger;
    state.previewTrigger = null;
    trigger?.focus();
}
```

在初始化阶段绑定：

- 结果图片点击与 `Enter`、空格；
- 放大按钮点击；
- 关闭按钮点击；
- 预览遮罩仅在 `event.target === preview` 时关闭；
- `window` 的 `keydown` 在预览打开且按下 `Escape` 时关闭。

- [ ] **Step 5: 把清理接入现有生命周期**

在 `resetResult()` 开头调用 `closeResultPreview()`，确保替换图片、清除结果和历史恢复覆盖旧结果时不会留下预览。`renderWatermarkRemovalResult()` 只负责设置当前结果，不自动打开预览。

- [ ] **Step 6: 运行前端完整测试**

Run: `node --test frontend/tests/*.test.js`

Expected: 现有 38 项和新增预览测试全部 PASS。

- [ ] **Step 7: 运行语法与差异检查**

Run:

```bash
node --check frontend/js/watermark_removal.js
git diff --check
```

Expected: 两条命令均退出码 0。

- [ ] **Step 8: 浏览器验证**

在 `http://localhost:8090/index.html` 恢复或生成一条 AI 消除结果，验证图片和按钮均能打开预览，三种关闭方式、焦点恢复、背景滚动锁定和下载按钮均正常。

- [ ] **Step 9: 提交**

```bash
git add frontend/js/watermark_removal.js frontend/tests/watermark_removal_ui.test.js
git commit -m "feat: add watermark result zoom behavior"
```
