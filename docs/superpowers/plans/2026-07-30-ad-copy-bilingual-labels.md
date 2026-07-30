# Ad Copy Bilingual Result Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace English-only ad result headings and field labels with fixed Chinese/English labels across Product, Facebook, Google, and Pinterest sections.

**Architecture:** Define one immutable frontend label map and pass its values through the existing safe `appendAdsText`, `appendAdsPair`, and `appendAdsPairList` render paths. Keep clipboard strings and every backend/data interface independent from the UI label map.

**Tech Stack:** Vanilla JavaScript, Node.js built-in test runner

## Global Constraints

- UI label format is exactly `中文 / English`, with Chinese first and one space on each side of `/`.
- Product labels are exactly `产品 / Product`, `产品名称 / Name`, and `产品概述 / Summary`.
- Facebook labels are exactly `Facebook 广告 / Facebook Ads`, `主文案 / Primary Text`, `标题 / Headline`, `描述 / Description`, `行动按钮 / CTA`, and `创意方向 / Creative Direction`.
- Google labels are exactly `Google 广告 / Google Ads`, `标题 / Headlines`, `描述 / Descriptions`, `关键词 / Keywords`, and `附加链接 / Sitelinks`.
- Pinterest heading remains exactly `Pinterest PIN`; its labels are exactly `标题 / Title`, `描述 / Description`, and `替代文本 / Alt Text`.
- The mapping is centralized in one immutable `ADS_RESULT_LABELS` object.
- Existing label typography, capitalization utilities, spacing, card layout, and platform colors remain unchanged.
- Creative-angle titles and logic remain unchanged.
- Platform filter buttons, style filter, left form, navigation, and generation controls remain unchanged.
- Clipboard output remains byte-for-byte compatible with the current format.
- AI output, product-name hint, Emoji behavior, Pinterest inline tags, filters, history, backend interfaces, and database remain unchanged.
- Dynamic model content continues through text-only DOM insertion.

---

### Task 1: Centralize and Render All Bilingual Result Labels

**Files:**
- Modify: `frontend/js/ads.js:14-410`
- Modify: `frontend/tests/ads_pinterest.test.js`

**Interfaces:**
- Produces: immutable `ADS_RESULT_LABELS: Readonly<Record<string, string>>`.
- Consumes: existing `appendAdsText(parent, className, text)`, `appendAdsPair(parent, label, value)`, and `appendAdsPairList(parent, label, values)`.
- Preserves: `copyAdsStyleText(style, platformFilter)` strings and all data contracts.

- [ ] **Step 1: Write a failing exact-map test**

Append:

```javascript
test('ad result bilingual label map is complete and exact', () => {
    const { context } = loadAds();
    const labels = vm.runInContext(
        'Object.fromEntries(Object.entries(ADS_RESULT_LABELS))',
        context
    );
    assert.deepEqual(labels, {
        product: '产品 / Product',
        productName: '产品名称 / Name',
        productSummary: '产品概述 / Summary',
        facebook: 'Facebook 广告 / Facebook Ads',
        facebookPrimaryText: '主文案 / Primary Text',
        facebookHeadline: '标题 / Headline',
        facebookDescription: '描述 / Description',
        facebookCta: '行动按钮 / CTA',
        facebookCreativeDirection: '创意方向 / Creative Direction',
        google: 'Google 广告 / Google Ads',
        googleHeadlines: '标题 / Headlines',
        googleDescriptions: '描述 / Descriptions',
        googleKeywords: '关键词 / Keywords',
        googleSitelinks: '附加链接 / Sitelinks',
        pinterest: 'Pinterest PIN',
        pinterestTitle: '标题 / Title',
        pinterestDescription: '描述 / Description',
        pinterestAltText: '替代文本 / Alt Text',
    });
    assert.equal(
        vm.runInContext('Object.isFrozen(ADS_RESULT_LABELS)', context),
        true
    );
});
```

- [ ] **Step 2: Write a failing all-platform render test**

Reuse the real filter harness and render one style containing all platforms:

```javascript
test('all-platform result renders every fixed bilingual heading and field label', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData({
        product: {
            name: { target: 'Padel racket', zh: '板式网球拍' },
            summary: { target: 'Balanced sports gear', zh: '均衡运动装备' },
        },
        styles: [sampleAllPlatformStyle()],
    });
    harness.context.setAdsPlatformFilter('all');

    const renderedText = harness.results.innerHTML;
    [
        '产品 / Product',
        '产品名称 / Name',
        '产品概述 / Summary',
        'Facebook 广告 / Facebook Ads',
        '主文案 / Primary Text',
        '标题 / Headline',
        '描述 / Description',
        '行动按钮 / CTA',
        '创意方向 / Creative Direction',
        'Google 广告 / Google Ads',
        '标题 / Headlines',
        '描述 / Descriptions',
        '关键词 / Keywords',
        '附加链接 / Sitelinks',
        'Pinterest PIN',
        '标题 / Title',
        '替代文本 / Alt Text',
    ].forEach(label => assert.match(renderedText, new RegExp(label.replace('/', '\\/'))));
});
```

Because both Facebook and Pinterest use `描述 / Description`, assert its structural placement in each platform block rather than relying only on a global occurrence count.

- [ ] **Step 3: Write failing filtered-render tests**

Add:

```javascript
test('platform filtering preserves the platform bilingual labels', () => {
    const harness = loadAdsFilterHarness();
    harness.context.renderAdsData({
        product: {},
        styles: [sampleAllPlatformStyle()],
    });

    harness.context.setAdsPlatformFilter('google');
    let html = harness.styleCards()[0].innerHTML;
    assert.match(html, /Google 广告 \/ Google Ads/);
    assert.match(html, /标题 \/ Headlines/);
    assert.match(html, /描述 \/ Descriptions/);
    assert.doesNotMatch(html, /Facebook 广告|Pinterest PIN/);

    harness.context.setAdsPlatformFilter('pinterest');
    html = harness.styleCards()[0].innerHTML;
    assert.match(html, /Pinterest PIN/);
    assert.match(html, /标题 \/ Title/);
    assert.match(html, /描述 \/ Description/);
    assert.match(html, /替代文本 \/ Alt Text/);
    assert.doesNotMatch(html, /Facebook 广告|Google 广告/);
});
```

- [ ] **Step 4: Lock clipboard compatibility before implementation**

Use a full all-platform style and assert the exact current clipboard string:

```javascript
test('bilingual UI labels do not change clipboard labels', async () => {
    const { context, clipboardWrites } = loadAds();
    await context.copyAdsStyleText(sampleAllPlatformStyle(), 'all');
    const copied = clipboardWrites[0];

    assert.match(copied, /\[Facebook\]/);
    assert.match(copied, /Primary Text:/);
    assert.match(copied, /Headline:/);
    assert.match(copied, /\[Google\]/);
    assert.match(copied, /headlines 1:/);
    assert.match(copied, /\[Pinterest PIN\]/);
    assert.match(copied, /Title:/);
    assert.match(copied, /Description:/);
    assert.match(copied, /Alt Text:/);
    assert.doesNotMatch(
        copied,
        /主文案 \/ Primary Text|产品名称 \/ Name|替代文本 \/ Alt Text/
    );
});
```

Retain the existing exact Pinterest clipboard test unchanged.

- [ ] **Step 5: Run focused tests and verify failure**

Run:

```bash
node --test frontend/tests/ads_pinterest.test.js
```

Expected: FAIL because `ADS_RESULT_LABELS` does not exist and rendered labels remain English-only.

- [ ] **Step 6: Add the immutable label map**

Near the other ads constants, add exactly:

```javascript
const ADS_RESULT_LABELS = Object.freeze({
    product: '产品 / Product',
    productName: '产品名称 / Name',
    productSummary: '产品概述 / Summary',
    facebook: 'Facebook 广告 / Facebook Ads',
    facebookPrimaryText: '主文案 / Primary Text',
    facebookHeadline: '标题 / Headline',
    facebookDescription: '描述 / Description',
    facebookCta: '行动按钮 / CTA',
    facebookCreativeDirection: '创意方向 / Creative Direction',
    google: 'Google 广告 / Google Ads',
    googleHeadlines: '标题 / Headlines',
    googleDescriptions: '描述 / Descriptions',
    googleKeywords: '关键词 / Keywords',
    googleSitelinks: '附加链接 / Sitelinks',
    pinterest: 'Pinterest PIN',
    pinterestTitle: '标题 / Title',
    pinterestDescription: '描述 / Description',
    pinterestAltText: '替代文本 / Alt Text',
});
```

Do not reuse this object in clipboard generation.

- [ ] **Step 7: Replace Product and Facebook render labels**

Replace only the label arguments:

```javascript
appendAdsText(
    productBlock,
    'text-xs font-black text-orange-600 uppercase mb-2',
    ADS_RESULT_LABELS.product
);
appendAdsPair(productBlock, ADS_RESULT_LABELS.productName, product.name);
appendAdsPair(productBlock, ADS_RESULT_LABELS.productSummary, product.summary);
```

Facebook:

```javascript
appendAdsText(
    card,
    'text-sm font-black text-blue-700 mt-2 mb-3',
    ADS_RESULT_LABELS.facebook
);
appendAdsPair(grid, ADS_RESULT_LABELS.facebookPrimaryText, style.facebook.primaryText);
appendAdsPair(grid, ADS_RESULT_LABELS.facebookHeadline, style.facebook.headline);
appendAdsPair(grid, ADS_RESULT_LABELS.facebookDescription, style.facebook.description);
appendAdsPair(grid, ADS_RESULT_LABELS.facebookCta, style.facebook.cta);
appendAdsPair(
    grid,
    ADS_RESULT_LABELS.facebookCreativeDirection,
    style.facebook.creativeDirection
);
```

Do not change any other Facebook layout or class string.

- [ ] **Step 8: Replace Google and Pinterest render labels**

Google:

```javascript
appendAdsText(
    card,
    'text-sm font-black text-emerald-700 mt-5 mb-3',
    ADS_RESULT_LABELS.google
);
appendAdsPairList(grid, ADS_RESULT_LABELS.googleHeadlines, style.google.headlines);
appendAdsPairList(grid, ADS_RESULT_LABELS.googleDescriptions, style.google.descriptions);
appendAdsPairList(grid, ADS_RESULT_LABELS.googleKeywords, style.google.keywords);
appendAdsPairList(grid, ADS_RESULT_LABELS.googleSitelinks, style.google.sitelinks);
```

Pinterest:

```javascript
heading.textContent = ADS_RESULT_LABELS.pinterest;
appendAdsPair(grid, ADS_RESULT_LABELS.pinterestTitle, pinterest.title);
appendAdsPair(
    grid,
    ADS_RESULT_LABELS.pinterestDescription,
    pinterestDescriptionWithTags(pinterest)
);
appendAdsPair(grid, ADS_RESULT_LABELS.pinterestAltText, pinterest.altText);
```

Keep the existing Pinterest heading class exactly
`text-sm font-black text-red-700 mt-5 mb-3`.

- [ ] **Step 9: Strengthen text-node safety coverage**

In the existing fake-DOM tracker test, assert every mapping value used during an all-platform render appears in `textContentAssignments` and never in `innerHTMLAssignments`:

```javascript
for (const label of Object.values(expectedLabels)) {
    assert.ok(tracker.textContentAssignments.includes(label));
    assert.ok(
        tracker.innerHTMLAssignments.every(value => !value.includes(label))
    );
}
```

Exclude repeated mapping values only by using a `Set`; do not remove valid assertions.

- [ ] **Step 10: Run full verification**

Run:

```bash
node --test frontend/tests/*.test.js
node --check frontend/js/ads.js
.venv/bin/python -m pytest backend/tests -q
git diff --check
```

Expected: frontend and backend tests PASS; syntax and diff checks exit 0.

- [ ] **Step 11: Perform a local smoke check**

Start:

```bash
.venv/bin/python run.py
```

At `http://localhost:8080/index.html`, load an existing or newly generated multi-platform ad result and verify:

1. Product, Facebook, Google, and Pinterest field labels match the fixed bilingual mapping.
2. Platform filtering retains the correct bilingual labels.
3. Existing spacing, typography, colors, and cards are unchanged.
4. Copy output retains the previous format.

- [ ] **Step 12: Commit**

```bash
git add frontend/js/ads.js frontend/tests/ads_pinterest.test.js
git commit -m "feat: add bilingual ad result labels"
```
