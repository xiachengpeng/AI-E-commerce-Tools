# Pinterest PIN Ad Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pinterest PIN as the third advertising-copy type, producing bilingual title, description, `#标签` tags, and alt text within every existing creative style.

**Architecture:** Extend the existing ads request contract and backend normalization so Pinterest uses the same AI route and nine-style response as Facebook and Google. Add Pinterest-specific prompt rules and a stable normalized result shape, then extend the existing vanilla-JavaScript selector, renderer, and copy action without creating a separate page or configuration path.

**Tech Stack:** Python 3, FastAPI, Pydantic, pytest, vanilla JavaScript, Node.js built-in test runner, HTML/Tailwind utility classes

## Global Constraints

- The request platform identifier is exactly `pinterest`; the UI label is exactly `Pinterest PIN`.
- Pinterest is a third peer type beside Facebook and Google and is selected by default.
- Reuse all nine existing `AD_STYLE_DEFINITIONS`; do not add a Pinterest-only style system.
- Each Pinterest result contains `title`, `description`, `tags`, and `altText`.
- `title`, `description`, and `altText` use the existing bilingual `{target, zh}` shape.
- `tags` is a bilingual pair list with 5–8 items, and both values in every item have exactly one leading `#`.
- Empty and duplicate tags are removed; a model-returned tag string is accepted and normalized into a list.
- Alt text objectively describes visible image, product, and scene content; it must not contain tags, keyword stuffing, or unverifiable attributes.
- Missing Pinterest model fields normalize to stable empty values rather than disappearing or breaking rendering.
- Unknown platform identifiers continue to be rejected by request validation.
- AI calls continue through `backend/services/ads_service.py` and the existing capability route; no browser-to-provider call or new AI configuration is added.
- Copy output order is `[Pinterest PIN]`, `Title`, `Description`, `Tags`, `Alt Text`.
- No database migration, API publishing integration, image generation, or separate Pinterest page is in scope.

---

### Task 1: Pinterest Request Contract and Result Normalization

**Files:**
- Modify: `backend/models/request.py:188-214`
- Modify: `backend/services/ads_service.py:35-100`
- Test: `backend/tests/test_ads_service.py`
- Test: `backend/tests/test_main.py`

**Interfaces:**
- Consumes: `AdCopyGenerateRequest.platforms: list[str]` and model output accepted by `normalize_ad_copy_result(data: Any, platforms: list[str]) -> dict`.
- Produces: accepted platform set `{"facebook", "google", "pinterest"}` and `style["pinterest"]` with keys `title`, `description`, `tags`, and `altText`.
- Produces helper `_normalize_pinterest_tags(value: Any) -> list[dict[str, str]]`, returning at most eight unique bilingual tag pairs.

- [ ] **Step 1: Write failing backend normalization tests**

Append focused tests to `backend/tests/test_ads_service.py`:

```python
def test_normalize_ad_copy_result_adds_stable_pinterest_block():
    result = normalize_ad_copy_result(
        {
            "styles": [{
                "styleId": "emotional",
                "pinterest": {
                    "title": {"target": "A calm home", "zh": "宁静之家"},
                    "description": {"target": "Make room to breathe.", "zh": "为呼吸留出空间。"},
                    "tags": [
                        {"target": "HomeDecor", "zh": "#家居装饰"},
                        {"target": "##CalmHome", "zh": "宁静之家"},
                        {"target": "#HomeDecor", "zh": "#家居装饰"},
                        {"target": "", "zh": ""},
                    ],
                    "altText": {"target": "Neutral chair beside a window", "zh": "窗边的中性色座椅"},
                },
            }]
        },
        ["pinterest"],
    )

    pinterest = result["styles"][0]["pinterest"]
    assert pinterest["title"] == {"target": "A calm home", "zh": "宁静之家"}
    assert pinterest["tags"] == [
        {"target": "#HomeDecor", "zh": "#家居装饰"},
        {"target": "#CalmHome", "zh": "#宁静之家"},
    ]
    assert pinterest["altText"]["target"] == "Neutral chair beside a window"


def test_normalize_ad_copy_result_accepts_string_tags_and_fills_missing_fields():
    result = normalize_ad_copy_result(
        {"styles": [{"styleId": "pain_point", "pinterest": {"tags": "#Sale, New Arrival  #Gift"}}]},
        ["pinterest"],
    )

    pinterest = result["styles"][1]["pinterest"]
    assert pinterest == {
        "title": {"target": "", "zh": ""},
        "description": {"target": "", "zh": ""},
        "tags": [
            {"target": "#Sale", "zh": ""},
            {"target": "#New", "zh": ""},
            {"target": "#Arrival", "zh": ""},
            {"target": "#Gift", "zh": ""},
        ],
        "altText": {"target": "", "zh": ""},
    }


def test_normalize_ad_copy_result_omits_unselected_pinterest():
    result = normalize_ad_copy_result({}, ["facebook"])
    assert all("pinterest" not in style for style in result["styles"])
```

- [ ] **Step 2: Add failing request validation tests**

Add API tests beside the existing ad-copy validation cases in `backend/tests/test_main.py`:

```python
def test_ads_generate_accepts_pinterest_platform():
    image = "data:image/png;base64," + base64.b64encode(b"fake").decode()
    result = {"product": {"name": {"target": "Lamp", "zh": "灯"}}, "styles": []}

    with patch("main.generate_ad_copy", new=AsyncMock(return_value=result)), \
         patch("main.persist_ads_history"):
        response = client.post("/api/ads/generate", json={
            "image_data": image,
            "platforms": ["pinterest"],
            "region": "US Market",
            "target_language": "English",
        })

    assert response.status_code == 200


def test_ads_generate_rejects_unknown_platform():
    image = "data:image/png;base64," + base64.b64encode(b"fake").decode()
    response = client.post("/api/ads/generate", json={
        "image_data": image,
        "platforms": ["pinterest", "unknown"],
        "region": "US Market",
        "target_language": "English",
    })
    assert response.status_code == 422
```

These tests use the existing module-level `client`, `base64`, `patch`, and `AsyncMock` imports already present in `backend/tests/test_main.py`.

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
.venv/bin/python -m pytest backend/tests/test_ads_service.py backend/tests/test_main.py -k "pinterest or unknown_platform" -q
```

Expected: FAIL because `pinterest` is not accepted and normalization does not emit a Pinterest block.

- [ ] **Step 4: Extend request validation and implement Pinterest normalization**

In `backend/models/request.py`, extend the existing allowed set:

```python
allowed = {"facebook", "google", "pinterest"}
```

In `backend/services/ads_service.py`, add:

```python
def _normalize_hashtag(value: Any) -> str:
    text = str(value or "").strip()
    text = text.lstrip("#").strip()
    return f"#{text}" if text else ""


def _normalize_pinterest_tags(value: Any) -> list[dict[str, str]]:
    if isinstance(value, str):
        value = value.replace(",", " ").split()
    if not isinstance(value, list):
        return []

    result = []
    seen = set()
    for item in value:
        if isinstance(item, dict):
            target = _normalize_hashtag(item.get("target"))
            zh = _normalize_hashtag(item.get("zh"))
        else:
            target = _normalize_hashtag(item)
            zh = ""
        key = (target.casefold(), zh.casefold())
        if (not target and not zh) or key in seen:
            continue
        seen.add(key)
        result.append({"target": target, "zh": zh})
        if len(result) == 8:
            break
    return result


def _pinterest_block(value: Any) -> dict:
    source = value if isinstance(value, dict) else {}
    return {
        "title": _text_pair(source.get("title")),
        "description": _text_pair(source.get("description")),
        "tags": _normalize_pinterest_tags(source.get("tags")),
        "altText": _text_pair(source.get("altText")),
    }
```

Inside `normalize_ad_copy_result`, conditionally add:

```python
if "pinterest" in platforms:
    normalized_style["pinterest"] = _pinterest_block(source_style.get("pinterest"))
```

Keep Facebook and Google behavior unchanged. If the existing style lookup uses a different local name than `source_style`, insert the same expression using that established name.

- [ ] **Step 5: Run backend tests**

Run:

```bash
.venv/bin/python -m pytest backend/tests/test_ads_service.py backend/tests/test_main.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit the contract and normalization**

```bash
git add backend/models/request.py backend/services/ads_service.py backend/tests/test_ads_service.py backend/tests/test_main.py
git commit -m "feat: normalize Pinterest PIN ad copy"
```

---

### Task 2: Pinterest AI Prompt Schema and Content Rules

**Files:**
- Modify: `backend/services/ads_service.py:131-191`
- Test: `backend/tests/test_ads_service.py`

**Interfaces:**
- Consumes: `_ads_prompt(request) -> str`, with `request.platforms` possibly containing `pinterest`.
- Produces: a prompt requiring `pinterest.title`, `pinterest.description`, `pinterest.tags`, and `pinterest.altText` for every style only when Pinterest is selected.
- Preserves: the existing `generate_ad_copy(request) -> dict` capability routing and result parsing.

- [ ] **Step 1: Expose the prompt helper to the test and write failing assertions**

Update the test import and append:

```python
from services.ads_service import _ads_prompt, generate_ad_copy, normalize_ad_copy_result


def test_ads_prompt_defines_pinterest_schema_and_rules():
    request = SimpleNamespace(
        platforms=["pinterest"],
        region="US",
        target_language="English",
        marketing_theme="Launch",
        marketing_theme_label="Product launch",
    )

    prompt = _ads_prompt(request)

    assert '"pinterest"' in prompt
    assert '"title": {"target": "...", "zh": "..."}' in prompt
    assert '"description": {"target": "...", "zh": "..."}' in prompt
    assert '"tags": [{"target": "#...", "zh": "#..."}]' in prompt
    assert '"altText": {"target": "...", "zh": "..."}' in prompt
    assert "5–8" in prompt
    assert "exactly one leading #" in prompt
    assert "visible" in prompt
    assert "unverifiable" in prompt


def test_ads_prompt_does_not_request_unselected_pinterest():
    request = SimpleNamespace(
        platforms=["facebook"],
        region="US",
        target_language="English",
        marketing_theme="Launch",
        marketing_theme_label="Product launch",
    )
    assert '"pinterest"' not in _ads_prompt(request)
```

Import `SimpleNamespace` from `types` if it is not already present.

- [ ] **Step 2: Run the prompt tests and verify failure**

Run:

```bash
.venv/bin/python -m pytest backend/tests/test_ads_service.py -k "ads_prompt" -q
```

Expected: FAIL because the prompt has no Pinterest schema or constraints.

- [ ] **Step 3: Build the selected-platform schema and Pinterest instructions**

In `_ads_prompt`, preserve the existing Facebook and Google fragments and add the Pinterest fragment only when selected:

```python
if "pinterest" in request.platforms:
    platform_schema.append(
        '"pinterest": {'
        '"title": {"target": "...", "zh": "..."}, '
        '"description": {"target": "...", "zh": "..."}, '
        '"tags": [{"target": "#...", "zh": "#..."}], '
        '"altText": {"target": "...", "zh": "..."}'
        "}"
    )
```

Add these exact behavioral requirements to the prompt:

```text
Pinterest PIN rules:
- Return a title, description, 5–8 relevant tags, and alt text for every creative style.
- Every target and Chinese tag must have exactly one leading #; never return empty or duplicate tags.
- Alt text must objectively describe visible image, product, and scene content.
- Alt text must not contain hashtags, keyword stuffing, or unverifiable attributes.
```

Ensure the JSON example is assembled from selected platform fragments so an unselected Pinterest key is not requested. Do not change provider selection, model configuration, retry behavior, or the image input.

- [ ] **Step 4: Run service tests**

Run:

```bash
.venv/bin/python -m pytest backend/tests/test_ads_service.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the prompt change**

```bash
git add backend/services/ads_service.py backend/tests/test_ads_service.py
git commit -m "feat: prompt for Pinterest PIN ad copy"
```

---

### Task 3: Pinterest Selection, Rendering, and Copying

**Files:**
- Modify: `frontend/index.html:678-692`
- Modify: `frontend/js/ads.js:50-190`
- Create: `frontend/tests/ads_pinterest.test.js`

**Interfaces:**
- Consumes: normalized `data.styles[].pinterest` from Task 1.
- Produces: a checked `.ads-platform-checkbox` with value `pinterest`.
- Produces: visible Pinterest PIN result sections with bilingual Title, Description, Tags, and Alt Text.
- Produces: `copyAdsStyleText(style)` clipboard output ordered as `[Pinterest PIN]`, `Title`, `Description`, `Tags`, `Alt Text`.

- [ ] **Step 1: Add a failing HTML contract test**

Create `frontend/tests/ads_pinterest.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend/js/ads.js'), 'utf8');

test('Pinterest PIN is a checked peer ad type', () => {
  assert.match(
    html,
    /class="ads-platform-checkbox[^"]*" value="pinterest"[\s\S]*?checked/
  );
  assert.match(html, /Pinterest PIN/);
});
```

- [ ] **Step 2: Add failing behavior tests for Pinterest rendering and copy order**

Append a minimal browser harness that evaluates the classic script:

```javascript
function loadAds(overrides = {}) {
  const clipboardWrites = [];
  const context = {
    console,
    setTimeout,
    URL,
    Blob,
    FileReader: class {},
    navigator: {
      clipboard: {
        writeText: async text => clipboardWrites.push(text),
      },
    },
    document: {
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({
        className: '',
        innerHTML: '',
        addEventListener() {},
      }),
      body: { appendChild() {}, removeChild() {} },
    },
    window: {},
    showToast() {},
    escapeHtml: value => String(value ?? ''),
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, clipboardWrites };
}

test('copyAdsStyleText copies Pinterest fields in the required order', async () => {
  const { context, clipboardWrites } = loadAds();
  await context.copyAdsStyleText({
    name: { target: 'Emotional', zh: '情感共鸣' },
    pinterest: {
      title: { target: 'Title', zh: '标题' },
      description: { target: 'Description', zh: '描述' },
      tags: [
        { target: '#HomeDecor', zh: '#家居装饰' },
        { target: '#CalmHome', zh: '#宁静之家' },
      ],
      altText: { target: 'Chair by window', zh: '窗边座椅' },
    },
  });

  const copied = clipboardWrites[0];
  const labels = ['[Pinterest PIN]', 'Title', 'Description', 'Tags', 'Alt Text'];
  labels.reduce((previous, label) => {
    const position = copied.indexOf(label);
    assert.ok(position > previous, `${label} should follow the previous section`);
    return position;
  }, -1);
  assert.match(copied, /#HomeDecor #CalmHome/);
  assert.match(copied, /#家居装饰 #宁静之家/);
});

test('renderAdsData includes the four Pinterest fields', () => {
  const children = [];
  const results = { innerHTML: '', classList: { remove() {} }, appendChild(node) { children.push(node); } };
  const { context } = loadAds({
    document: {
      querySelectorAll: () => [],
      getElementById: id => id === 'adsResults' ? results : null,
      createElement: () => ({
        className: '',
        innerHTML: '',
        addEventListener() {},
      }),
      body: { appendChild() {}, removeChild() {} },
    },
  });

  context.renderAdsData({
    styles: [{
      styleId: 'emotional',
      name: { target: 'Emotional', zh: '情感共鸣' },
      pinterest: {
        title: { target: 'Title', zh: '标题' },
        description: { target: 'Description', zh: '描述' },
        tags: [{ target: '#HomeDecor', zh: '#家居装饰' }],
        altText: { target: 'Chair by window', zh: '窗边座椅' },
      },
    }],
  });

  assert.equal(children.length, 1);
  assert.match(children[0].innerHTML, /Pinterest PIN/);
  assert.match(children[0].innerHTML, /Title/);
  assert.match(children[0].innerHTML, /Description/);
  assert.match(children[0].innerHTML, /Tags/);
  assert.match(children[0].innerHTML, /Alt Text/);
});
```

If `ads.js` reads additional globals during evaluation, add inert equivalents to `loadAds`; do not weaken the assertions.

- [ ] **Step 3: Run the frontend test and verify failure**

Run:

```bash
node --test frontend/tests/ads_pinterest.test.js
```

Expected: FAIL because the selector and Pinterest rendering/copy blocks do not exist.

- [ ] **Step 4: Add the checked Pinterest PIN selector**

In `frontend/index.html`, add a third peer label in the existing platform checkbox container:

```html
<label class="flex items-center gap-2 text-sm text-slate-700">
    <input type="checkbox" class="ads-platform-checkbox accent-orange-600" value="pinterest" checked>
    Pinterest PIN
</label>
```

Keep the existing card, spacing, and typography. Do not add a separate settings panel or route.

- [ ] **Step 5: Render the Pinterest result block**

In `renderAdsData`, append a Pinterest section only when `style.pinterest` exists. Reuse the existing bilingual field markup/helper pattern, with labels in this order:

```javascript
const pinterest = style.pinterest;
const pinterestTagsTarget = (pinterest.tags || []).map(item => item.target).filter(Boolean).join(' ');
const pinterestTagsZh = (pinterest.tags || []).map(item => item.zh).filter(Boolean).join(' ');
```

The rendered section must include:

```html
<h5>Pinterest PIN</h5>
<div>Title</div>
<div>Description</div>
<div>Tags</div>
<div>Alt Text</div>
```

Render both target-language and Chinese values under each label, following the same visual hierarchy used by the existing Facebook and Google sections. Pass every interpolated model value through the file's existing `escapeHtml` path.

- [ ] **Step 6: Extend the copy action**

Inside `copyAdsStyleText`, append this block when Pinterest is present:

```javascript
if (style.pinterest) {
  const pin = style.pinterest;
  const targetTags = (pin.tags || []).map(item => item.target).filter(Boolean).join(' ');
  const zhTags = (pin.tags || []).map(item => item.zh).filter(Boolean).join(' ');
  blocks.push([
    '[Pinterest PIN]',
    `Title: ${pin.title?.target || ''}`,
    `标题: ${pin.title?.zh || ''}`,
    `Description: ${pin.description?.target || ''}`,
    `描述: ${pin.description?.zh || ''}`,
    `Tags: ${targetTags}`,
    `标签: ${zhTags}`,
    `Alt Text: ${pin.altText?.target || ''}`,
    `替代文本: ${pin.altText?.zh || ''}`,
  ].join('\n'));
}
```

Retain the existing Facebook and Google copy output and use their existing block join separator.

- [ ] **Step 7: Run frontend tests and syntax checks**

Run:

```bash
node --test frontend/tests/*.test.js
node --check frontend/js/ads.js
```

Expected: all tests PASS and syntax check exits 0.

- [ ] **Step 8: Run the full backend suite**

Run:

```bash
.venv/bin/python -m pytest backend/tests -q
```

Expected: PASS.

- [ ] **Step 9: Perform a local smoke test**

Start the application:

```bash
.venv/bin/python run.py
```

Open `http://localhost:8080/index.html`, enter 广告文案, and verify:

1. Facebook、Google、Pinterest PIN appear as three peer choices and all are checked.
2. Generating with Pinterest selected returns nine style cards.
3. Each Pinterest section shows Title、Description、Tags、Alt Text in target language and Chinese.
4. Every displayed tag starts with one `#`.
5. Copying a style includes Pinterest fields in the required order.
6. Deselecting Pinterest leaves Facebook and Google behavior unchanged.

- [ ] **Step 10: Commit the frontend**

```bash
git add frontend/index.html frontend/js/ads.js frontend/tests/ads_pinterest.test.js
git commit -m "feat: add Pinterest PIN ad copy UI"
```
