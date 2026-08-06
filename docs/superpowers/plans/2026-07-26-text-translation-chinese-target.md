# Text Translation Chinese Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Simplified Chinese as a selectable target in the text-translation language picker.

**Architecture:** Add one static checkbox to the existing HTML language list. Reuse the generic checkbox collection, API payload, result-card, and history logic without backend changes.

**Tech Stack:** HTML, vanilla JavaScript, Node.js built-in test runner.

## Global Constraints

- Display label must be `中文 (ZH)`.
- Submitted value must be `Chinese`.
- Chinese must support both single and multi-language selection.
- Do not modify backend translation APIs or other feature language lists.

---

### Task 1: Add and Verify the Chinese Language Option

**Files:**
- Modify: `frontend/index.html:1138-1147`
- Create: `frontend/tests/text_translate_language_options.test.js`

**Interfaces:**
- Consumes: the existing `.lang-checkbox` selector used by `executeBatchTextTranslation()`.
- Produces: one checkbox with `value="Chinese"` and the visible label `中文 (ZH)`.

- [ ] **Step 1: Write the failing rendered-option test**

Create a test that loads `frontend/index.html`, scopes to `#langOptionsList`, and checks the literal user-visible contract:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const listStart = html.indexOf('id="langOptionsList"');
const listEnd = html.indexOf('</div>\\n                            </div>', listStart);
const languageList = html.slice(listStart, listEnd);

assert.ok(listStart >= 0, 'text translation language list must exist');
assert.strictEqual(
    (languageList.match(/value="Chinese"/g) || []).length,
    1,
    'text translation language list must contain one Chinese target'
);
assert.match(languageList, /value="Chinese"[\\s\\S]*?中文 \\(ZH\\)/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test frontend/tests/text_translate_language_options.test.js
```

Expected: FAIL because the text-translation picker has no Chinese checkbox.

- [ ] **Step 3: Add the minimal HTML option**

Insert immediately after English:

```html
<label class="lang-option-item p-4 flex items-center gap-3 hover:bg-indigo-50 cursor-pointer border-b border-gray-50 transition-colors">
    <input type="checkbox" value="Chinese" class="lang-checkbox w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
    <span class="text-sm font-bold text-gray-600">中文 (ZH)</span>
</label>
```

- [ ] **Step 4: Verify focused and complete frontend tests**

Run:

```bash
node --test frontend/tests/text_translate_language_options.test.js
node --test frontend/tests/*.test.js
node --check frontend/js/text_translate.js
```

Expected: all commands exit 0, with the complete frontend suite reporting 8 tests.

- [ ] **Step 5: Refresh the running page and verify the DOM**

Reload `http://localhost:8080/index.html` and evaluate:

```js
document.querySelectorAll('#langOptionsList input.lang-checkbox[value="Chinese"]').length
```

Expected: `1`, with adjacent label text `中文 (ZH)`.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/tests/text_translate_language_options.test.js
git commit -m "feat: add Chinese text translation target"
```
