# Ad Copy Result Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add platform and creative-angle filters that make generated ad-copy results easier to browse without re-requesting AI content.

**Architecture:** Keep the complete response in `currentAdsData`, derive available platforms and style options from that response, and maintain two frontend-only filter values. Separate new-result loading from filtered repainting so new data resets filters while user filter changes preserve state and scroll position.

**Tech Stack:** Vanilla JavaScript, HTML, Tailwind utility classes, Phosphor icons, Node.js built-in test runner

## Global Constraints

- Filtering is frontend-only and must not call the backend or AI.
- Platform filter values are exactly `all`, `facebook`, `google`, and `pinterest`.
- Platform choices show only platforms present in at least one returned style, plus `all`.
- Platform order is Facebook, Google, Pinterest PIN.
- A new result defaults to the first available platform in that order; if none exists, default to `all`.
- Creative-angle choices derive from the returned `styles` array, not a separate hardcoded name list.
- Creative-angle identity uses `style.id`, then `style.styleId`, then a stable index fallback for that result.
- A new result defaults creative angle to `all`.
- Product summary is always visible and unaffected by filters.
- A selected platform renders only that platform and omits styles that lack it; `all` renders all present platforms.
- Platform and creative-angle filters combine.
- Copy follows the visible platform filter; `all` copies all present platforms.
- Filter changes preserve result-pane scroll position and never issue `fetch`.
- Loading a new generated or restored result resets stale filters.
- Empty combinations show “当前筛选条件下没有结果” and a reset button without calling AI.
- Platform controls use buttons with `aria-pressed`; the style select has an accessible label.
- Dynamic style names and model content remain text-only; never interpolate them into `innerHTML`.
- Preserve existing AI requests, history restoration, product-name hint, Emoji rules, Pinterest description/tag composition, all platform field layouts, and backend behavior.
- No persistence, backend parameters, multi-select platforms, sorting, search, favorites, or pagination.

---

### Task 1: Filter State Model and Accessible Control Shell

**Files:**
- Modify: `frontend/index.html:734-760`
- Modify: `frontend/js/ads.js:1-55`
- Modify: `frontend/tests/ads_pinterest.test.js`

**Interfaces:**
- Produces state: `currentAdsPlatformFilter: "all" | "facebook" | "google" | "pinterest"` and `currentAdsStyleFilter: string`.
- Produces: `adsStyleKey(style: object, index: number) -> string`.
- Produces: `availableAdsPlatforms(data: object | null) -> string[]`.
- Produces DOM anchors: `#adsResultsScroll`, `#adsFilters`, `#adsPlatformFilters`, `#adsStyleFilter`.
- Consumed by Task 2 rendering and Task 3 copy/reset behavior.

- [ ] **Step 1: Write failing HTML contract tests**

Append:

```javascript
test('ads results expose an accessible sticky filter shell', () => {
    assert.match(html, /id="adsResultsScroll"/);
    assert.match(html, /id="adsFilters"/);
    assert.match(html, /id="adsPlatformFilters"/);
    assert.match(html, /id="adsStyleFilter"/);
    assert.match(html, /aria-label="创意角度筛选"/);
    assert.match(html, /广告平台/);
    assert.match(html, /创意角度/);
});
```

- [ ] **Step 2: Write failing filter-model tests**

Append:

```javascript
test('availableAdsPlatforms returns only present platforms in canonical order', () => {
    const { context } = loadAds();
    const result = Array.from(context.availableAdsPlatforms({
        styles: [
            { id: 'first', pinterest: {}, google: {} },
            { id: 'second', facebook: {} },
        ],
    }));
    assert.deepEqual(result, ['facebook', 'google', 'pinterest']);
    assert.deepEqual(
        Array.from(context.availableAdsPlatforms({ styles: [] })),
        []
    );
});


test('adsStyleKey uses id, styleId, then stable index fallback', () => {
    const { context } = loadAds();
    assert.equal(context.adsStyleKey({ id: 'problem_solution' }, 0), 'problem_solution');
    assert.equal(context.adsStyleKey({ styleId: 'emotional' }, 1), 'emotional');
    assert.equal(context.adsStyleKey({}, 2), 'style-index-2');
});
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
node --test frontend/tests/ads_pinterest.test.js
```

Expected: FAIL because the filter DOM and helper functions do not exist.

- [ ] **Step 4: Add the static filter shell**

Give the result scrolling pane an ID:

```html
<div id="adsResultsScroll" class="flex-1 overflow-y-auto bg-[#f8fafc] custom-scrollbar">
```

Immediately after the existing sticky result title bar, add:

```html
<div id="adsFilters"
    class="hidden sticky top-[57px] z-20 bg-[#f8fafc]/95 backdrop-blur px-8 py-3 border-b border-gray-200">
    <div class="max-w-5xl mx-auto flex flex-wrap items-end gap-4">
        <div>
            <div class="text-[10px] font-black text-gray-400 mb-1.5">广告平台</div>
            <div id="adsPlatformFilters" class="flex flex-wrap gap-2"></div>
        </div>
        <label class="block min-w-[190px]">
            <span class="block text-[10px] font-black text-gray-400 mb-1.5">创意角度</span>
            <select id="adsStyleFilter" aria-label="创意角度筛选"
                class="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs font-bold text-gray-700 outline-none focus:border-orange-500">
                <option value="all">全部创意角度</option>
            </select>
        </label>
    </div>
</div>
```

Keep `#adsFilters` hidden before any result loads.

- [ ] **Step 5: Add filter state and pure derivation helpers**

Near `currentAdsData`, add:

```javascript
let currentAdsPlatformFilter = 'all';
let currentAdsStyleFilter = 'all';

const ADS_PLATFORM_FILTERS = [
    { value: 'facebook', label: 'Facebook' },
    { value: 'google', label: 'Google' },
    { value: 'pinterest', label: 'Pinterest PIN' },
];

function adsStyleKey(style, index) {
    return String(style?.id || style?.styleId || `style-index-${index}`);
}

function availableAdsPlatforms(data) {
    const styles = Array.isArray(data?.styles) ? data.styles : [];
    return ADS_PLATFORM_FILTERS
        .map(item => item.value)
        .filter(platform => styles.some(style => Boolean(style?.[platform])));
}
```

Do not mutate `data` or any style object.

- [ ] **Step 6: Run focused and full frontend tests**

Run:

```bash
node --test frontend/tests/ads_pinterest.test.js
node --test frontend/tests/*.test.js
node --check frontend/js/ads.js
```

Expected: PASS and syntax exits 0.

- [ ] **Step 7: Commit the state model and shell**

```bash
git add frontend/index.html frontend/js/ads.js frontend/tests/ads_pinterest.test.js
git commit -m "feat: add ad result filter shell"
```

---

### Task 2: Dynamic Controls and Combined Result Rendering

**Files:**
- Modify: `frontend/js/ads.js:145-260`
- Modify: `frontend/tests/ads_pinterest.test.js`

**Interfaces:**
- Consumes: state, `ADS_PLATFORM_FILTERS`, `adsStyleKey`, DOM anchors, and `availableAdsPlatforms` from Task 1.
- Produces: `resetAdsFilters(data: object | null) -> void`.
- Produces: `renderAdsFilterControls() -> void`.
- Produces: `setAdsPlatformFilter(value: string) -> void`.
- Produces: `setAdsStyleFilter(value: string) -> void`.
- Produces: `renderFilteredAdsResults() -> void`.
- Changes: `renderAdsData(data)` becomes the new-result entry point that resets filters once, then delegates repainting.

- [ ] **Step 1: Extend the fake DOM controls**

Add controls used by filter tests:

```javascript
const filterControls = {
    adsFilters: fakeElement(),
    adsPlatformFilters: fakeElement(),
    adsStyleFilter: {
        ...fakeElement(),
        value: 'all',
        options: [],
        addEventListener() {},
    },
    adsResultsScroll: { scrollTop: 240 },
};
```

Enhance `fakeElement` only as needed to support `replaceChildren`, `dataset`, `setAttribute`, and button clicks. Keep production assertions behavioral rather than source-string based.

- [ ] **Step 2: Write failing default-control tests**

Add:

```javascript
test('new ads data builds only available platforms and defaults to the first', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData({
        product: {},
        styles: [{
            id: 'problem_solution',
            name: { target: 'Problem/Solution', zh: '痛点解决型' },
            google: {},
            pinterest: {},
        }],
    });

    assert.deepEqual(harness.filters(), { platform: 'google', style: 'all' });
    assert.deepEqual(
        harness.platformButtons().map(button => button.textContent),
        ['全部平台', 'Google', 'Pinterest PIN']
    );
    assert.equal(
        harness.platformButtons().find(button => button.textContent === 'Google')
            .getAttribute('aria-pressed'),
        'true'
    );
});
```

`loadAdsFilterHarness()` must use the real `renderAdsData`, return created platform buttons, expose rendered result nodes, and read lexical filter state through the VM:

```javascript
filters: () => ({
    platform: vm.runInContext('currentAdsPlatformFilter', context),
    style: vm.runInContext('currentAdsStyleFilter', context),
}),
```

- [ ] **Step 3: Write failing combined-filter tests**

Use two styles with different platform combinations:

```javascript
test('platform and style filters combine without issuing fetch', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('google');
    harness.context.setAdsStyleFilter('feature_benefit');

    const cards = harness.styleCards();
    assert.equal(cards.length, 1);
    assert.match(cards[0].innerHTML, /Feature Benefit/);
    assert.match(cards[0].innerHTML, /Google Ads/);
    assert.doesNotMatch(cards[0].innerHTML, /Facebook Ads/);
    assert.doesNotMatch(cards[0].innerHTML, /Pinterest PIN/);
    assert.equal(harness.fetchCalls.length, 0);
});


test('all platform filter restores all present platform sections', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('all');

    const html = harness.styleCards().map(card => card.innerHTML).join('');
    assert.match(html, /Facebook Ads/);
    assert.match(html, /Google Ads/);
    assert.match(html, /Pinterest PIN/);
});
```

- [ ] **Step 4: Write failing state-reset and scroll tests**

Add:

```javascript
test('filter repaint preserves scroll and new data resets stale filters', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.scrollPane.scrollTop = 240;
    harness.context.setAdsStyleFilter('feature_benefit');
    assert.equal(harness.scrollPane.scrollTop, 240);

    harness.context.renderAdsData({
        product: {},
        styles: [{
            id: 'new_style',
            name: { target: 'New Style', zh: '新角度' },
            pinterest: {},
        }],
    });
    assert.deepEqual(harness.filters(), { platform: 'pinterest', style: 'all' });
});
```

- [ ] **Step 5: Run tests and verify failure**

Run:

```bash
node --test frontend/tests/ads_pinterest.test.js
```

Expected: FAIL because dynamic controls and filtered repainting do not exist.

- [ ] **Step 6: Implement reset and dynamic controls**

Add:

```javascript
function resetAdsFilters(data) {
    const available = availableAdsPlatforms(data);
    currentAdsPlatformFilter = available[0] || 'all';
    currentAdsStyleFilter = 'all';
}
```

Implement `renderAdsFilterControls()`:

- Reveal `#adsFilters`.
- Clear `#adsPlatformFilters` with `replaceChildren()`.
- Create “全部平台” plus available platform buttons using `document.createElement('button')`.
- Use `textContent` for labels.
- Set `type="button"` and `aria-pressed` from current state.
- Apply neutral base classes plus these active classes:
  - all: orange.
  - facebook: blue.
  - google: emerald.
  - pinterest: red.
- Add `focus-visible:ring-2` focus styling.
- Button click calls `setAdsPlatformFilter(value)`.
- Rebuild `#adsStyleFilter` with “全部创意角度” plus every current style.
- Set option value with `adsStyleKey(style, index)`.
- Set option text with the preferred visible name: Chinese name, then target name, then key.
- Set select value to `currentAdsStyleFilter`.
- Attach the select’s change listener once in `initAdsControls()`, not once per repaint.

- [ ] **Step 7: Implement filter setters**

Add:

```javascript
function setAdsPlatformFilter(value) {
    const allowed = new Set(['all', ...availableAdsPlatforms(currentAdsData)]);
    currentAdsPlatformFilter = allowed.has(value) ? value : 'all';
    renderAdsFilterControls();
    renderFilteredAdsResults();
}

function setAdsStyleFilter(value) {
    const styles = Array.isArray(currentAdsData?.styles) ? currentAdsData.styles : [];
    const allowed = new Set(['all', ...styles.map(adsStyleKey)]);
    currentAdsStyleFilter = allowed.has(value) ? value : 'all';
    renderAdsFilterControls();
    renderFilteredAdsResults();
}
```

When using `.map(adsStyleKey)`, confirm the callback receives `(style, index)` as required.

- [ ] **Step 8: Split new-result loading from filtered repainting**

Refactor:

```javascript
function renderAdsData(data) {
    currentAdsData = data || null;
    resetAdsFilters(currentAdsData);
    renderAdsFilterControls();
    renderFilteredAdsResults();
}
```

Move product and style rendering into `renderFilteredAdsResults()`. At function start:

```javascript
const scrollPane = document.getElementById('adsResultsScroll');
const previousScrollTop = scrollPane?.scrollTop || 0;
const data = currentAdsData || {};
const styles = Array.isArray(data.styles) ? data.styles : [];
```

Filter styles by both conditions:

```javascript
const filteredStyles = styles.filter((style, index) => {
    const styleMatches =
        currentAdsStyleFilter === 'all'
        || adsStyleKey(style, index) === currentAdsStyleFilter;
    const platformMatches =
        currentAdsPlatformFilter === 'all'
        || Boolean(style?.[currentAdsPlatformFilter]);
    return styleMatches && platformMatches;
});
```

Always render the product block. For each filtered style, render a platform block only when:

```javascript
const showFacebook =
    style.facebook && ['all', 'facebook'].includes(currentAdsPlatformFilter);
const showGoogle =
    style.google && ['all', 'google'].includes(currentAdsPlatformFilter);
const showPinterest =
    style.pinterest && ['all', 'pinterest'].includes(currentAdsPlatformFilter);
```

Restore `scrollPane.scrollTop = previousScrollTop` after repaint.

- [ ] **Step 9: Run focused and full frontend tests**

Run:

```bash
node --test frontend/tests/ads_pinterest.test.js
node --test frontend/tests/*.test.js
node --check frontend/js/ads.js
```

Expected: PASS.

- [ ] **Step 10: Commit combined rendering**

```bash
git add frontend/js/ads.js frontend/tests/ads_pinterest.test.js
git commit -m "feat: filter ad results by platform and style"
```

---

### Task 3: Filter-Aware Copy, Empty State, and Final Regression

**Files:**
- Modify: `frontend/js/ads.js:116-285`
- Modify: `frontend/tests/ads_pinterest.test.js`

**Interfaces:**
- Changes: `copyAdsStyleText(style, platformFilter = "all") -> void`.
- Produces: `resetAdsResultFilters() -> void`.
- Consumes: current filters and available-platform derivation from Tasks 1–2.
- Preserves: existing platform-specific copy formats and Pinterest inline tags.

- [ ] **Step 1: Write failing filter-aware copy tests**

Add:

```javascript
test('copy includes only the selected visible platform', async () => {
    const { context, clipboardWrites } = loadAds();
    const style = sampleAllPlatformStyle();
    await context.copyAdsStyleText(style, 'google');
    const copied = clipboardWrites[0];
    assert.match(copied, /\[Google\]/);
    assert.doesNotMatch(copied, /\[Facebook\]/);
    assert.doesNotMatch(copied, /\[Pinterest PIN\]/);
    assert.match(copied, /Problem\/Solution/);
    assert.match(copied, /Logic:/);
});


test('copy all includes every present platform', async () => {
    const { context, clipboardWrites } = loadAds();
    await context.copyAdsStyleText(sampleAllPlatformStyle(), 'all');
    const copied = clipboardWrites[0];
    assert.match(copied, /\[Facebook\]/);
    assert.match(copied, /\[Google\]/);
    assert.match(copied, /\[Pinterest PIN\]/);
    assert.match(copied, /Description: .+#Tag1#Tag2/);
});
```

Use distinct fixture values so platform leakage cannot satisfy another assertion accidentally.

- [ ] **Step 2: Write failing empty-state/reset tests**

Add:

```javascript
test('empty filtered combinations show a reset action without fetch', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('google');
    harness.context.setAdsStyleFilter('pinterest_only_style');

    assert.equal(harness.styleCards().length, 0);
    assert.match(harness.results.innerHTML, /当前筛选条件下没有结果/);
    const reset = findElement(
        harness.results,
        element => element.textContent === '重置筛选'
    );
    assert.ok(reset);
    reset.click();
    assert.deepEqual(harness.filters(), { platform: 'facebook', style: 'all' });
    assert.equal(harness.fetchCalls.length, 0);
});
```

The sample data must make Facebook the first available platform and contain the selected style only under Pinterest.

- [ ] **Step 3: Verify copy buttons capture the current platform**

Add a behavioral test:

```javascript
test('rendered copy button captures the platform used for that repaint', async () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData(harness.sampleData);
    harness.context.setAdsPlatformFilter('pinterest');
    const copyButton = findElement(
        harness.styleCards()[0],
        element => element.textContent === '复制'
    );
    copyButton.click();
    await Promise.resolve();
    assert.match(harness.clipboardWrites[0], /\[Pinterest PIN\]/);
    assert.doesNotMatch(harness.clipboardWrites[0], /\[Facebook\]|\[Google\]/);
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
node --test frontend/tests/ads_pinterest.test.js
```

Expected: FAIL because copy ignores the filter and empty/reset behavior is absent.

- [ ] **Step 5: Make copying filter-aware**

Change:

```javascript
function copyAdsStyleText(style, platformFilter = 'all') {
```

Gate each block:

```javascript
if (style.facebook && ['all', 'facebook'].includes(platformFilter)) { ... }
if (style.google && ['all', 'google'].includes(platformFilter)) { ... }
if (style.pinterest && ['all', 'pinterest'].includes(platformFilter)) { ... }
```

When creating each card:

```javascript
const platformForCopy = currentAdsPlatformFilter;
copyBtn.addEventListener(
    'click',
    () => copyAdsStyleText(style, platformForCopy)
);
```

This captures the filter for the rendered card and avoids reading a changed global value after repaint.

- [ ] **Step 6: Implement reset and empty filtered state**

Add:

```javascript
function resetAdsResultFilters() {
    resetAdsFilters(currentAdsData);
    renderAdsFilterControls();
    renderFilteredAdsResults();
}
```

When `filteredStyles.length === 0`, create a container entirely with DOM methods:

```javascript
const empty = document.createElement('div');
empty.className = 'bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center';
appendAdsText(empty, 'text-sm font-bold text-gray-500', '当前筛选条件下没有结果');
const resetButton = document.createElement('button');
resetButton.type = 'button';
resetButton.className = 'mt-4 px-4 py-2 rounded-lg bg-orange-50 text-orange-600 text-xs font-bold hover:bg-orange-100 focus-visible:ring-2 focus-visible:ring-orange-400';
resetButton.textContent = '重置筛选';
resetButton.addEventListener('click', resetAdsResultFilters);
empty.appendChild(resetButton);
container.appendChild(empty);
```

Do not hide the product block and do not call `fetch`.

- [ ] **Step 7: Add malformed-data regression tests**

Add:

```javascript
test('filter rendering tolerates missing styles and missing platform blocks', () => {
    const harness = loadAdsFilterHarness();
    assert.doesNotThrow(() => harness.context.renderAdsData({ product: {}, styles: null }));
    assert.equal(harness.filters().platform, 'all');
    assert.doesNotThrow(() => harness.context.renderAdsData({
        product: {},
        styles: [{ name: { target: '<img onerror=alert(1)>', zh: '安全文本' } }],
    }));
    assert.ok(harness.tracker.textContentAssignments.includes('<img onerror=alert(1)>'));
});
```

- [ ] **Step 8: Run complete verification**

Run:

```bash
node --test frontend/tests/*.test.js
node --check frontend/js/ads.js
.venv/bin/python -m pytest backend/tests -q
git diff --check
```

Expected: all tests PASS; syntax and diff checks exit 0.

- [ ] **Step 9: Perform local smoke checks**

Start:

```bash
.venv/bin/python run.py
```

At `http://localhost:8080/index.html`, verify:

1. A new multi-platform result defaults to Facebook and all nine angles.
2. The sticky platform buttons include only generated platforms.
3. The style dropdown filters to one angle.
4. Platform and style filters combine without a loading state or network request.
5. “全部平台” restores every generated platform within each matching angle.
6. Copy contains only the visible platform, or all platforms under “全部平台”.
7. Product summary remains visible.
8. An empty combination shows the reset action.
9. Loading another generated or historical result resets both filters.

- [ ] **Step 10: Commit filter completion**

```bash
git add frontend/js/ads.js frontend/tests/ads_pinterest.test.js
git commit -m "feat: complete ad result filter behavior"
```
