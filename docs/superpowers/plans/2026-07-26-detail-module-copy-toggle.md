# Detail Module Copy Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each enabled detail-page module independently generate with or without added visible copy while preserving every uploaded product detail.

**Architecture:** Add `includeText` to module and task state, expose a per-card Yes/No control, and centralize the prompt branch in `buildModuleTextPolicy()`. Persist the flag in detail-project snapshots and normalize missing legacy values to `true`.

**Tech Stack:** Vanilla JavaScript, HTML generated from JavaScript templates, Node.js built-in `assert`/`vm` tests.

## Global Constraints

- Each module controls its own setting.
- Every module defaults to `includeText: true`.
- No-copy mode forbids all newly generated visible text but preserves original product markings exactly.
- Both modes must keep product category, silhouette, structure, parts, color, material, texture, proportions, logo, controls, ports, labels, and component placement faithful to uploaded images.
- SEO title and Alt metadata remain enabled because they are not rendered into the image.
- Old history without `includeText` must behave as `true`.

---

### Task 1: Module State, Task Propagation, and Card Control

**Files:**
- Modify: `frontend/js/config.js:5-17`
- Modify: `frontend/js/details.js:932-965, 1070-1082, 511-530`
- Test: `frontend/tests/detail_prompt.test.js`

**Interfaces:**
- Produces: `setModuleIncludeText(moduleList, moduleId, includeText) -> boolean`.
- Produces: `updateModuleIncludeText(moduleId, includeText) -> void`.
- Extends each module/task with `includeText: boolean`.

- [ ] **Step 1: Write failing defaults, isolation, and propagation tests**

Add tests with literal expected values:

```js
assert(context.MODULES_CONFIG.every(mod => mod.includeText === true));
assert.strictEqual(typeof context.setModuleIncludeText, 'function');

const moduleToggleFixture = [
    { id: 'm1', active: true, count: 2, includeText: true },
    { id: 'm2', active: true, count: 1, includeText: true }
];
assert.strictEqual(context.setModuleIncludeText(moduleToggleFixture, 'm2', false), true);
assert.strictEqual(moduleToggleFixture[0].includeText, true);
assert.strictEqual(moduleToggleFixture[0].count, 2);
assert.strictEqual(moduleToggleFixture[0].active, true);
assert.strictEqual(moduleToggleFixture[1].includeText, false);
assert.strictEqual(context.setModuleIncludeText(moduleToggleFixture, 'missing', false), false);

const textModeTasks = context.buildStrategyTasks([
    { id: 'm1', title: 'Hero', subtitle: 'Hero', prompt: 'hero', count: 1, includeText: true },
    { id: 'm3', title: 'Scene', subtitle: 'Scene', prompt: 'scene', count: 1, includeText: false }
], sellingPoints, factConfig);
assert.strictEqual(textModeTasks[0].includeText, true);
assert.strictEqual(textModeTasks[1].includeText, false);
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
```

Expected: FAIL because defaults and `setModuleIncludeText` do not exist.

- [ ] **Step 3: Add module defaults and state setter**

Add `includeText: true` to every `MODULES_CONFIG` item. Add:

```js
function setModuleIncludeText(moduleList = [], moduleId = '', includeText = true) {
    const mod = Array.isArray(moduleList) ? moduleList.find(item => item.id === moduleId) : null;
    if (!mod) return false;
    mod.includeText = includeText !== false;
    return true;
}

function updateModuleIncludeText(moduleId, includeText) {
    if (setModuleIncludeText(modules, moduleId, includeText)) initModules();
}
```

- [ ] **Step 4: Render the per-module Yes/No control**

Extend the active module card below the count row:

```html
<div class="mt-2 flex items-center justify-between" onclick="event.stopPropagation()">
    <span class="text-[10px] text-gray-500">包含文案</span>
    <div class="flex rounded border border-gray-200 overflow-hidden bg-white">
        <button onclick="updateModuleIncludeText('${mod.id}', true)" class="...">是</button>
        <button onclick="updateModuleIncludeText('${mod.id}', false)" class="...">否</button>
    </div>
</div>
```

Use blue active styling for the selected value and neutral styling for the other value. Both click handlers must stop propagation through the wrapping control.

- [ ] **Step 5: Verify focused test and syntax**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
node --check frontend/js/details.js
node --check frontend/js/config.js
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add frontend/js/config.js frontend/js/details.js frontend/tests/detail_prompt.test.js
git commit -m "feat: add per-module detail copy state"
```

### Task 2: Copy Policy and Strict Product Lock

**Files:**
- Modify: `frontend/js/details.js:150-205, 456-497`
- Test: `frontend/tests/detail_prompt.test.js`

**Interfaces:**
- Produces: `buildModuleTextPolicy(task, config) -> string`.
- Consumes: `task.includeText`, defaulting missing values to `true`.
- Strengthens: `buildProductLockPrompt(config) -> string`.

- [ ] **Step 1: Write failing prompt-policy tests**

Add:

```js
assert.strictEqual(typeof context.buildModuleTextPolicy, 'function');

const withCopyPrompt = context.buildModuleGenerationPrompt(
    { ...firstBenefit, includeText: true },
    sellingPoints,
    factConfig
);
assert.match(withCopyPrompt, /VISIBLE TEXT/);
assert.match(withCopyPrompt, /max 1 headline/i);

const withoutCopyPrompt = context.buildModuleGenerationPrompt(
    { ...firstBenefit, includeText: false },
    sellingPoints,
    factConfig
);
assert.match(withoutCopyPrompt, /NO ADDED TEXT/);
assert.match(withoutCopyPrompt, /no headlines, subheadlines, callouts, captions, specifications, dimensions, labels, badges, watermarks, letters, numbers, or typographic elements/i);
assert.match(withoutCopyPrompt, /original product markings/i);
assert.match(withoutCopyPrompt, /do not rewrite, translate, replace, or redesign/i);
assert.doesNotMatch(withoutCopyPrompt, /Text density: max 1 headline/i);

for (const prompt of [withCopyPrompt, withoutCopyPrompt]) {
    assert.match(prompt, /uploaded reference product as the only source of truth/i);
    assert.match(prompt, /logo, controls, buttons, ports, labels, texture, and component placement/i);
    assert.match(prompt, /do not alter or invent/i);
}
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
```

Expected: FAIL because `buildModuleTextPolicy` and strict lock phrases do not exist.

- [ ] **Step 3: Implement the centralized text policy**

Add a function with two explicit branches:

```js
function buildModuleTextPolicy(task = {}, config = {}) {
    if (task.includeText === false) {
        return `NO ADDED TEXT
- Do not add any headlines, subheadlines, callouts, captions, specifications, dimensions, labels, badges, watermarks, letters, numbers, or typographic elements.
- Ignore any module request that asks for text, tables, measurement labels, step labels, badges, or written callouts; communicate the module goal through composition, objects, lighting, and scene only.
- Original product markings visible in the uploaded reference may remain only when reproduced exactly. Do not rewrite, translate, replace, or redesign them.`;
    }
    return `VISIBLE TEXT
- All visible text must be ${config.language || 'English'}.
- Text density: max 1 headline, max 1 subheadline, maximum 3 bullets/callouts, no dense fine print.`;
}
```

Make `buildModuleExecutionBrief()` omit its current `VISIBLE TEXT` block when `includeText` is false, and inject `buildModuleTextPolicy()` into `buildModuleGenerationPrompt()`. Remove the unconditional text-density hard rule so no-copy prompts cannot contradict themselves.

- [ ] **Step 4: Strengthen product lock**

Update `buildProductLockPrompt()` to state:

- Uploaded reference product is the only source of truth.
- Do not alter or invent product category, silhouette, structure, parts, accessories, color, material, finish, texture, proportions, logo, controls, buttons, ports, labels, packaging, or component placement.
- Unclear details must be omitted or left simple rather than guessed.
- Background and lighting may change, but the product may not be redesigned or obscured.

- [ ] **Step 5: Verify focused and complete frontend tests**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
node --test frontend/tests/*.test.js
node --check frontend/js/details.js
```

Expected: all commands exit 0, with the complete frontend suite reporting 8 tests.

- [ ] **Step 6: Commit Task 2**

```bash
git add frontend/js/details.js frontend/tests/detail_prompt.test.js
git commit -m "feat: enforce detail copy and product lock policies"
```

### Task 3: History Persistence and Legacy Compatibility

**Files:**
- Modify: `frontend/js/details.js:1627-1644, 1726-1730`
- Test: `frontend/tests/detail_prompt.test.js`

**Interfaces:**
- Produces: `normalizeRestoredDetailTask(task) -> object`.
- Persists: `includeText` in each `modulesSnapshot` item.
- Defaults: missing history value to `true`.

- [ ] **Step 1: Write failing history normalization tests**

Add:

```js
assert.strictEqual(typeof context.normalizeRestoredDetailTask, 'function');
assert.strictEqual(
    context.normalizeRestoredDetailTask({ id: 'm1_0' }).includeText,
    true
);
assert.strictEqual(
    context.normalizeRestoredDetailTask({ id: 'm3_0', includeText: false }).includeText,
    false
);
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
```

Expected: FAIL because `normalizeRestoredDetailTask` is not defined.

- [ ] **Step 3: Implement persistence and normalization**

Add:

```js
function normalizeRestoredDetailTask(task = {}) {
    return { ...task, includeText: task.includeText !== false };
}
```

Add `includeText: task.includeText !== false` to each snapshot item. In `renderRestoredDetailProject()`, construct each task from `normalizeRestoredDetailTask(mod)` so old history defaults to copy-enabled and regenerated images use the saved mode.

- [ ] **Step 4: Run complete verification**

Run:

```bash
node --test frontend/tests/*.test.js
node --check frontend/js/details.js
node --check frontend/js/config.js
"/Users/xiachengpeng/code/AI E-commerce Tools/.venv/bin/python" -m pytest backend/tests
git diff --check
```

Expected: frontend reports 8 passing tests, backend reports 400 passing tests, and all other commands exit 0.

- [ ] **Step 5: Refresh the local app and inspect the control**

Reload `http://localhost:8080/index.html`, switch to the detail-page generator, and verify:

- Every enabled module shows “包含文案” under “张数”.
- “是” is selected by default.
- Switching one module to “否” leaves other modules, active state, and count unchanged.

- [ ] **Step 6: Commit Task 3**

```bash
git add frontend/js/details.js frontend/tests/detail_prompt.test.js
git commit -m "feat: persist detail module copy preference"
```
