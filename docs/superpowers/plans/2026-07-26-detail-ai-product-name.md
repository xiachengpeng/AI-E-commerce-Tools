# Detail AI Product Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make detail-page AI writing infer and fill a localized product name when the name is empty, while using and preserving a user-entered name when present.

**Architecture:** Keep the existing single routed text-AI request. Add two small pure frontend functions: one parses structured or legacy model output, and one derives the next form state without touching the DOM. `generateSellingPoints()` supplies the selected output language, calls these functions, then applies the returned state to the existing inputs.

**Tech Stack:** Vanilla JavaScript, Node.js built-in `assert`/`vm` tests, existing `callAI("text", payload)` frontend proxy.

## Global Constraints

- Product names inferred from images must follow the detail page's currently selected output language.
- A user-entered product name must be included in the AI prompt and must never be overwritten by the AI response.
- Existing image, confirmed-fact, and forbidden-claim context must remain part of the request.
- Use one AI request; do not add a backend endpoint or a second model call.
- Accept strict JSON, fenced JSON, and legacy plain-text responses.
- Do not modify other detail-page generation modules or AI routing settings.

---

### Task 1: Structured Prompt and Response Parser

**Files:**
- Modify: `frontend/js/details.js:232-263`
- Test: `frontend/tests/detail_prompt.test.js`

**Interfaces:**
- Consumes: `compactDetailText(value, maxLength)` from `frontend/js/details.js`.
- Produces: `buildSellingPointsExtractionPrompt(imageCount, productFacts, forbiddenClaims, productName, outputLanguage) -> string`.
- Produces: `parseSellingPointsResponse(rawText) -> { productName: string, sellingPoints: string }`.

- [ ] **Step 1: Write failing tests for the language-aware JSON contract**

Add literal assertions proving that an empty-name prompt requests image identification in Chinese and that a supplied name is treated as confirmed input:

```js
const emptyNamePrompt = context.buildSellingPointsExtractionPrompt(
    1,
    productFacts,
    forbiddenClaims,
    '',
    'Chinese'
);
assert.match(emptyNamePrompt, /identify the product from the uploaded image/i);
assert.match(emptyNamePrompt, /product_name/i);
assert.match(emptyNamePrompt, /selling_points/i);
assert.match(emptyNamePrompt, /Chinese/);

const suppliedNamePrompt = context.buildSellingPointsExtractionPrompt(
    1,
    productFacts,
    forbiddenClaims,
    'Compact Under-Desk Walking Pad',
    'English'
);
assert.match(suppliedNamePrompt, /Compact Under-Desk Walking Pad/);
assert.match(suppliedNamePrompt, /combine the uploaded image evidence/i);
```

- [ ] **Step 2: Write failing parser tests**

Add tests whose hand-written fixtures cover strict JSON, fenced JSON, and bilingual legacy text:

```js
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.parseSellingPointsResponse(
        '{"product_name":"折叠式桌下走步机","selling_points":"产品类型：桌下走步机\\n核心卖点：便于收纳"}'
    ))),
    {
        productName: '折叠式桌下走步机',
        sellingPoints: '产品类型：桌下走步机\n核心卖点：便于收纳'
    }
);

assert.strictEqual(
    context.parseSellingPointsResponse(
        '```json\\n{"product_name":"Walking Pad","selling_points":"Core selling points:\\n- Compact"}\\n```'
    ).productName,
    'Walking Pad'
);

const legacyChinese = context.parseSellingPointsResponse(
    '产品名称：折叠式桌下走步机\\n产品类型：家用健身设备\\n核心卖点：小巧易收纳'
);
assert.strictEqual(legacyChinese.productName, '折叠式桌下走步机');
assert.match(legacyChinese.sellingPoints, /核心卖点：小巧易收纳/);

const legacyEnglish = context.parseSellingPointsResponse(
    'Product name: Compact Walking Pad\\nProduct type: Home fitness equipment'
);
assert.strictEqual(legacyEnglish.productName, 'Compact Walking Pad');
assert.match(legacyEnglish.sellingPoints, /Product type/);
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
```

Expected: FAIL because `parseSellingPointsResponse` is not defined and the prompt does not yet require the JSON contract or output language.

- [ ] **Step 4: Implement the minimal prompt and parser**

Update the prompt signature and add a pure parser with this behavior:

```js
function parseSellingPointsResponse(rawText = '') {
    const raw = String(rawText || '').trim();
    if (!raw) return { productName: '', sellingPoints: '' };

    const unfenced = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

    try {
        const parsed = JSON.parse(unfenced);
        return {
            productName: compactDetailText(parsed.product_name || parsed.productName || '', 160),
            sellingPoints: String(parsed.selling_points || parsed.sellingPoints || '').trim()
        };
    } catch (_) {
        const nameMatch = raw.match(
            /^(?:product\s*name|产品名称)\s*[:：]\s*(.+)$/im
        );
        return {
            productName: compactDetailText(nameMatch?.[1] || '', 160),
            sellingPoints: raw
        };
    }
}
```

Change `buildSellingPointsExtractionPrompt` to accept `outputLanguage = 'English'`, state that `product_name` must use that language, and require a JSON object with exactly `product_name` and `selling_points`.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add frontend/js/details.js frontend/tests/detail_prompt.test.js
git commit -m "feat: parse structured detail AI copy"
```

### Task 2: Preserve or Fill Product Name in the AI Write Flow

**Files:**
- Modify: `frontend/js/details.js:1114-1155`
- Test: `frontend/tests/detail_prompt.test.js`

**Interfaces:**
- Consumes: `parseSellingPointsResponse(rawText)` from Task 1.
- Produces: `resolveSellingPointsFormState(currentProductName, currentSellingPoints, parsedResult) -> { productName: string, sellingPoints: string, didFillProductName: boolean }`.
- Updates: `generateSellingPoints()` to apply the derived state to `productNameInput` and `sellingPointsText`.

- [ ] **Step 1: Write failing state-transition tests**

The production change caught by these tests is either failing to fill an empty name or overwriting a name the user supplied:

```js
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.resolveSellingPointsFormState(
        '',
        'old selling points',
        { productName: '折叠式桌下走步机', sellingPoints: '新的核心卖点' }
    ))),
    {
        productName: '折叠式桌下走步机',
        sellingPoints: '新的核心卖点',
        didFillProductName: true
    }
);

assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.resolveSellingPointsFormState(
        '用户确认的产品名',
        'old selling points',
        { productName: 'AI 返回的名称', sellingPoints: '新的核心卖点' }
    ))),
    {
        productName: '用户确认的产品名',
        sellingPoints: '新的核心卖点',
        didFillProductName: false
    }
);

assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.resolveSellingPointsFormState(
        '',
        '保留原卖点',
        { productName: 'Walking Pad', sellingPoints: '' }
    ))),
    {
        productName: '',
        sellingPoints: '保留原卖点',
        didFillProductName: false
    }
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
```

Expected: FAIL because `resolveSellingPointsFormState` is not defined.

- [ ] **Step 3: Implement the pure state resolver**

Add:

```js
function resolveSellingPointsFormState(currentProductName = '', currentSellingPoints = '', parsedResult = {}) {
    const existingName = String(currentProductName || '').trim();
    const nextSellingPoints = String(parsedResult.sellingPoints || '').trim();
    if (!nextSellingPoints) {
        return {
            productName: existingName,
            sellingPoints: String(currentSellingPoints || ''),
            didFillProductName: false
        };
    }
    const generatedName = compactDetailText(parsedResult.productName || '', 160);
    return {
        productName: existingName || generatedName,
        sellingPoints: nextSellingPoints,
        didFillProductName: !existingName && Boolean(generatedName)
    };
}
```

- [ ] **Step 4: Integrate the resolver into `generateSellingPoints()`**

Read `outputLanguage` from `getDetailConfig().language`, pass it to the prompt, parse the model text, and only apply a non-empty selling-points result:

```js
const productNameInput = document.getElementById('productNameInput');
const currentProductName = productNameInput?.value.trim() || '';
const currentSellingPoints = textArea?.value || '';
const outputLanguage = getDetailConfig().language || 'English';

// Pass currentProductName and outputLanguage to buildSellingPointsExtractionPrompt(...)

const parsed = parseSellingPointsResponse(text);
const nextState = resolveSellingPointsFormState(
    currentProductName,
    currentSellingPoints,
    parsed
);
if (!parsed.sellingPoints) {
    throw new Error('AI 返回内容缺少核心卖点');
}
if (productNameInput && nextState.didFillProductName) {
    productNameInput.value = nextState.productName;
}
textArea.value = nextState.sellingPoints;
remoteLog(
    nextState.didFillProductName
        ? `卖点提取成功，已自动识别产品名称: ${nextState.productName}`
        : '卖点提取成功，已保留现有产品名称'
);
```

Do not log image data or the full model response.

- [ ] **Step 5: Run focused and complete frontend tests**

Run:

```bash
node --test frontend/tests/detail_prompt.test.js
node --test frontend/tests/*.test.js
node --check frontend/js/details.js
```

Expected: all commands exit 0; frontend suite reports 7 passing tests or more.

- [ ] **Step 6: Run backend regression tests**

Run:

```bash
./.venv/bin/python -m pytest backend/tests
```

Expected: 400 tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add frontend/js/details.js frontend/tests/detail_prompt.test.js
git commit -m "feat: fill inferred detail product name"
```

### Task 3: Final Behavior Verification

**Files:**
- Verify: `frontend/index.html`
- Verify: `frontend/js/details.js`

**Interfaces:**
- Consumes the completed AI write flow from Tasks 1 and 2.
- Produces no new interface.

- [ ] **Step 1: Start the local app**

Run:

```bash
./.venv/bin/python run.py
```

Expected: backend listens on `http://localhost:8000` and frontend listens on `http://localhost:8080`.

- [ ] **Step 2: Verify the empty-name flow**

Open `http://localhost:8080/index.html`, upload a product image, leave the product-name field empty, choose Chinese as the output language, and click “AI 帮写”.

Expected: the product-name field receives a Chinese product name and the core-selling-points field receives the generated brief.

- [ ] **Step 3: Verify the supplied-name flow**

Enter a distinctive product name, click “AI 帮写” again, and wait for completion.

Expected: the selling points reflect both the image and supplied name, while the product-name field remains byte-for-byte unchanged.

- [ ] **Step 4: Stop the app and confirm a clean worktree**

Stop `run.py` with Ctrl+C, then run:

```bash
git status --short
```

Expected: no uncommitted files.
