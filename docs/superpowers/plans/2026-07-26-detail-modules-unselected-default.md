# Detail Modules Unselected Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize the detail-page generator with every module unselected.

**Architecture:** Change the `active` defaults at the single source of truth, `MODULES_CONFIG`. Reuse the existing module toggle UI and empty-selection generation guard.

**Tech Stack:** Vanilla JavaScript, Node.js built-in `assert`/`vm` tests.

## Global Constraints

- All 12 module `active` defaults must be `false`.
- Module count and `includeText` defaults must remain unchanged.
- History rendering must remain unchanged.
- No new controls or backend changes.

---

### Task 1: Remove Default Module Selection

**Files:**
- Modify: `frontend/js/config.js:5-17`
- Test: `frontend/tests/detail_prompt.test.js`

**Interfaces:**
- Changes only `MODULES_CONFIG[*].active`.
- Existing `toggleModule(id)` remains the selection mechanism.

- [ ] **Step 1: Change the expected default in the test**

Replace the active-default assertion with:

```js
const activeDefaults = context.MODULES_CONFIG
    .filter(mod => mod.active)
    .map(mod => mod.id);
assert.strictEqual(JSON.stringify(activeDefaults), JSON.stringify([]));
assert(context.MODULES_CONFIG.every(mod => mod.count === 1));
assert(context.MODULES_CONFIG.every(mod => mod.includeText === true));
```

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
```

Expected: FAIL because six modules are still active by default.

- [ ] **Step 3: Set all active defaults to false**

In `frontend/js/config.js`, change `active: true` to `active: false` for `m1`, `m2`, `m3`, `m9`, `m10`, and `m11`. Do not change any other field.

- [ ] **Step 4: Run complete verification**

Run:

```bash
node --test frontend/tests/*.test.js
node --check frontend/js/config.js
node --check frontend/js/details.js
git diff --check
```

Expected: frontend reports 8 passing tests and every command exits 0.

- [ ] **Step 5: Refresh and inspect the running page**

Reload `http://127.0.0.1:8080/index.html`, open the detail-page generator, and verify:

- `#moduleGrid` contains 12 cards.
- No card contains the active blue/check styling.
- No count or copy controls appear until a module is clicked.
- Clicking one module activates only that module and displays its controls.

- [ ] **Step 6: Commit**

```bash
git add frontend/js/config.js frontend/tests/detail_prompt.test.js
git commit -m "feat: leave detail modules unselected by default"
```
