# AI Watermark Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-image AI removal tool with multiple editable rectangle regions, result-only download, and global history restoration.

**Architecture:** The browser owns rectangle editing and renders an original-size black/white PNG mask. A focused FastAPI service validates the original image, mask, and normalized regions, calls the configured backend image route with both images, verifies the returned dimensions, and persists generated assets. Existing tab routing and history APIs are extended with the `watermark-removal` module key.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy/SQLite, Pillow, existing AI router/service, vanilla JavaScript, Canvas 2D, Node built-in test runner, pytest.

## Global Constraints

- First release supports one JPG, PNG, or WebP image and multiple rectangle regions.
- Output pixel dimensions must exactly equal the source dimensions.
- Only the processed result image is downloadable; source and mask have no download controls.
- Download filename uses the source stem plus `-removed` and the returned result extension.
- Failed requests preserve the source image and all regions.
- AI requests go through the backend `image` capability route; the browser never calls a provider directly.
- Base64 images, masks, provider secrets, and full model responses must not enter normal logs.
- Generated files live below `backend/static/outputs/watermark-removal/` and remain untracked.

---

### Task 1: Request Models and Pure Validation

**Files:**
- Modify: `backend/models/request.py`
- Create: `backend/services/watermark_removal_service.py`
- Create: `backend/tests/test_watermark_removal_service.py`

**Interfaces:**
- Produces: `WatermarkRegion(x: float, y: float, width: float, height: float)`.
- Produces: `WatermarkRemovalRequest(filename: str, image_data: str, mask_data: str, regions: list[WatermarkRegion])`.
- Produces: `decode_data_url(data_url: str, *, require_png: bool = False) -> ValidatedImage`.
- Produces: `validate_regions(regions: list[WatermarkRegion]) -> list[WatermarkRegion]`.
- Produces: `validate_mask(source: ValidatedImage, mask: ValidatedImage, regions: list[WatermarkRegion]) -> None`.

- [ ] **Step 1: Read the shared test rules before writing tests**

Run:

```bash
sed -n '1,260p' /Users/xiachengpeng/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/test-driven-development/writing-good-tests.md
```

- [ ] **Step 2: Write failing model and validation tests**

Add tests that construct real 10×10 Pillow images and assert:

```python
def test_request_rejects_empty_regions():
    with pytest.raises(ValidationError, match="至少框选一个"):
        WatermarkRemovalRequest(
            filename="sample.png",
            image_data=make_data_url(),
            mask_data=make_mask_url([(1, 1, 3, 3)]),
            regions=[],
        )


@pytest.mark.parametrize("region", [
    {"x": -0.1, "y": 0, "width": 0.2, "height": 0.2},
    {"x": 0, "y": 0, "width": 0, "height": 0.2},
    {"x": 0.9, "y": 0, "width": 0.2, "height": 0.2},
])
def test_request_rejects_invalid_region(region):
    with pytest.raises(ValidationError):
        WatermarkRegion(**region)


def test_validate_mask_rejects_size_mismatch():
    source = decode_data_url(make_data_url(10, 10))
    mask = decode_data_url(make_mask_url([(1, 1, 3, 3)], 8, 8), require_png=True)
    with pytest.raises(ValueError, match="尺寸必须与原图一致"):
        validate_mask(source, mask, [WatermarkRegion(x=.1, y=.1, width=.3, height=.3)])


def test_validate_mask_accepts_multiple_matching_regions():
    regions = [
        WatermarkRegion(x=.1, y=.1, width=.3, height=.3),
        WatermarkRegion(x=.6, y=.6, width=.2, height=.2),
    ]
    source = decode_data_url(make_data_url(10, 10))
    mask = decode_data_url(make_mask_url([(1, 1, 3, 3), (6, 6, 2, 2)]), require_png=True)
    validate_mask(source, mask, regions)
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `python -m pytest backend/tests/test_watermark_removal_service.py -q`

Expected: collection fails because the request classes and service do not exist.

- [ ] **Step 4: Implement the Pydantic models**

Add finite-number and bounds validation. `x`, `y` must be at least zero; `width`, `height` must be greater than zero; `x + width` and `y + height` must be at most one. Strip and require `filename`, `image_data`, and `mask_data`. Require between 1 and 100 regions.

- [ ] **Step 5: Implement image and mask validation**

Reuse `services.image_validation.validate_image_payload` after parsing a strict base64 data URL. For `require_png=True`, reject non-PNG content. Convert the mask to grayscale, require at least one white pixel, render the declared normalized regions into an expected 1-bit mask using the same floor/ceil rule, and compare masks with one-pixel boundary tolerance only.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `python -m pytest backend/tests/test_watermark_removal_service.py -q`

Expected: all Task 1 tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/models/request.py backend/services/watermark_removal_service.py backend/tests/test_watermark_removal_service.py
git commit -m "feat: validate watermark removal inputs"
```

---

### Task 2: AI Processing and Asset Persistence

**Files:**
- Modify: `backend/services/watermark_removal_service.py`
- Modify: `backend/tests/test_watermark_removal_service.py`

**Interfaces:**
- Consumes: Task 1 request and validation functions.
- Produces: `async remove_watermark(request: WatermarkRemovalRequest) -> dict`.
- Produces response keys: `processing_id`, `filename`, `source_url`, `mask_url`, `result_url`, `result_mime_type`, `width`, `height`, `regions`, `created_at`.

- [ ] **Step 1: Write failing processing tests**

Patch `AIService.generate_content` with `AsyncMock` and use a temporary static root. Assert the call has `capability="image"` and includes two inline images. Add separate tests for:

```python
async def test_remove_watermark_rejects_response_without_image(...):
    ai_mock.return_value = {"candidates": [{"content": {"parts": [{"text": "no image"}]}}]}
    with pytest.raises(ValueError, match="未返回图片"):
        await remove_watermark(valid_request())


async def test_remove_watermark_rejects_changed_dimensions(...):
    ai_mock.return_value = inline_image_response(make_png_bytes(12, 10))
    with pytest.raises(ValueError, match="尺寸与原图不一致"):
        await remove_watermark(valid_request())


async def test_remove_watermark_saves_source_mask_and_result(...):
    result = await remove_watermark(valid_request())
    assert result["width"] == 10
    assert result["height"] == 10
    assert result["result_url"].startswith("/static/outputs/watermark-removal/")
    assert Path(url_to_test_path(result["result_url"])).is_file()
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python -m pytest backend/tests/test_watermark_removal_service.py -q`

Expected: processing tests fail because `remove_watermark` is absent.

- [ ] **Step 3: Implement the constrained AI request**

Build a prompt that explicitly states white is editable, black must remain unchanged, no text or new objects may be added, and the result must retain exact dimensions. Send the original and mask as separate inline-data parts through:

```python
await AIService.generate_content(
    payload={
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    },
    capability="image",
)
```

Use the same inline image extraction and `validate_image_payload` conventions as `square_redraw_service.py`.

- [ ] **Step 4: Implement persistence and response serialization**

Generate a UUID processing ID, save source/mask/result beneath `STATIC_DIR/outputs/watermark-removal/<processing_id>/`, sanitize the source stem, and return only URLs and metadata. On validation or model failure, do not claim success and do not log payload bodies.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `python -m pytest backend/tests/test_watermark_removal_service.py -q`

Expected: all service tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/services/watermark_removal_service.py backend/tests/test_watermark_removal_service.py
git commit -m "feat: process watermark removal images"
```

---

### Task 3: FastAPI Endpoint and History Storage

**Files:**
- Modify: `backend/db.py`
- Modify: `backend/main.py`
- Modify: `backend/tests/test_main.py`
- Create: `backend/tests/test_watermark_removal_api.py`

**Interfaces:**
- Consumes: `WatermarkRemovalRequest` and `remove_watermark`.
- Produces: `POST /api/watermark-removal`.
- Produces: history module key `watermark-removal`.
- Produces: `WatermarkRemovalHistory(filename: str, result: JSON)`.

- [ ] **Step 1: Write failing API and history tests**

Use FastAPI’s test client and dependency override for the test database. Patch `main.remove_watermark` for the endpoint test:

```python
def test_watermark_removal_endpoint_returns_service_result(client):
    payload = valid_payload()
    expected = {"processing_id": "abc", "result_url": "/static/result.png"}
    with patch("main.remove_watermark", new=AsyncMock(return_value=expected)):
        response = client.post("/api/watermark-removal", json=payload)
    assert response.status_code == 200
    assert response.json() == {"status": "success", "data": expected}


def test_watermark_removal_history_round_trip(client):
    result = valid_history_result()
    saved = client.post("/api/history/watermark-removal", json={
        "filename": "shoe.png",
        "result": result,
    })
    assert saved.json()["status"] == "success"
    items = client.get("/api/history/watermark-removal").json()
    assert items[0]["filename"] == "shoe.png"
    assert items[0]["result"]["result_url"] == result["result_url"]
    assert client.delete(f"/api/history/watermark-removal/{items[0]['id']}").json()["status"] == "success"
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python -m pytest backend/tests/test_watermark_removal_api.py backend/tests/test_main.py -q`

Expected: the endpoint and history mapping tests fail.

- [ ] **Step 3: Add the database model**

Create `WatermarkRemovalHistory` with `id`, `timestamp`, `filename`, and JSON `result`. `init_db()` already uses `Base.metadata.create_all`, so no destructive migration is needed for the new table.

- [ ] **Step 4: Add the endpoint and history mappings**

Import the request, service, and history model in `main.py`. The endpoint should return the project’s existing `{status, data}` envelope and a cleaned `{status: "error", message}` envelope on expected failures. Add `watermark-removal` to save/get/delete history branches.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `python -m pytest backend/tests/test_watermark_removal_api.py backend/tests/test_main.py -q`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/db.py backend/main.py backend/tests/test_main.py backend/tests/test_watermark_removal_api.py
git commit -m "feat: expose watermark removal API and history"
```

---

### Task 4: Rectangle Editor and Mask Generation

**Files:**
- Create: `frontend/js/watermark_removal_core.js`
- Create: `frontend/tests/watermark_removal_core.test.js`

**Interfaces:**
- Produces: `normalizeRegion(rect, imageRect) -> {x, y, width, height}`.
- Produces: `denormalizeRegion(region, imageRect) -> {left, top, width, height}`.
- Produces: `canSubmitRemoval(state) -> boolean`.
- Produces: `renderMask(ctx, imageWidth, imageHeight, regions) -> void`.
- Browser exports are assigned to `window.WatermarkRemovalCore`; Node exports use `module.exports`.

- [ ] **Step 1: Write failing pure frontend tests**

Use `node:test` and `node:assert/strict`:

```javascript
test('normalizes a rectangle against displayed image bounds', () => {
  assert.deepEqual(
    core.normalizeRegion(
      { left: 30, top: 40, width: 50, height: 20 },
      { left: 10, top: 20, width: 200, height: 100 }
    ),
    { x: 0.1, y: 0.2, width: 0.25, height: 0.2 }
  );
});

test('submit requires image, region, and idle state', () => {
  assert.equal(core.canSubmitRemoval({ hasImage: true, regions: [{}], busy: false }), true);
  assert.equal(core.canSubmitRemoval({ hasImage: true, regions: [], busy: false }), false);
  assert.equal(core.canSubmitRemoval({ hasImage: true, regions: [{}], busy: true }), false);
});

test('renders every region as a white rectangle', () => {
  const calls = [];
  const ctx = fakeMaskContext(calls);
  core.renderMask(ctx, 100, 50, [
    { x: .1, y: .2, width: .3, height: .4 },
    { x: .7, y: .1, width: .2, height: .2 },
  ]);
  assert.deepEqual(calls.filter(call => call[0] === 'fillRect'), [
    ['fillRect', 0, 0, 100, 50],
    ['fillRect', 10, 10, 30, 20],
    ['fillRect', 70, 5, 20, 10],
  ]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test frontend/tests/watermark_removal_core.test.js`

Expected: FAIL because the core module is absent.

- [ ] **Step 3: Implement pure geometry and mask helpers**

Clamp normalized values to `[0, 1]`, round mask pixel boundaries consistently with the backend, paint a black full canvas followed by white regions, and keep DOM access out of this file.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test frontend/tests/watermark_removal_core.test.js`

Expected: all core tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/watermark_removal_core.js frontend/tests/watermark_removal_core.test.js
git commit -m "feat: add watermark selection geometry"
```

---

### Task 5: AI Removal Page, Download, and Request State

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/app.js`
- Create: `frontend/css/watermark_removal.css`
- Create: `frontend/js/watermark_removal.js`
- Create: `frontend/tests/watermark_removal_ui.test.js`

**Interfaces:**
- Consumes: `window.WatermarkRemovalCore`.
- Produces: `initWatermarkRemoval()`, `handleWatermarkUpload(event)`, `submitWatermarkRemoval()`, `downloadWatermarkRemovalResult()`, `restoreWatermarkRemovalHistory(result)`.

- [ ] **Step 1: Write failing source-level UI contract tests**

Read `index.html`, `app.js`, and `watermark_removal.js` as text and assert:

```javascript
test('page exposes the AI removal tab and controls', () => {
  assert.match(indexHtml, /id="tab-watermark-removal"/);
  assert.match(indexHtml, /id="view-watermark-removal"/);
  assert.match(indexHtml, /id="watermarkRemovalCanvas"/);
  assert.match(indexHtml, /id="watermarkRemovalSubmit"/);
  assert.match(indexHtml, /id="watermarkRemovalDownload"/);
});

test('download is result-only and uses removed suffix', () => {
  assert.match(script, /result_url/);
  assert.match(script, /-removed/);
  assert.doesNotMatch(script, /downloadWatermarkRemovalSource/);
  assert.doesNotMatch(script, /downloadWatermarkRemovalMask/);
});

test('failure does not clear regions', () => {
  assert.match(script, /catch[\s\S]*setWatermarkRemovalBusy\(false\)/);
  assert.doesNotMatch(script, /catch[\s\S]{0,300}regions\s*=\s*\[\]/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test frontend/tests/watermark_removal_ui.test.js`

Expected: FAIL because the page and script are absent.

- [ ] **Step 3: Add the page shell and styling**

Add the sidebar button, upload state, responsive editor canvas, selected-region overlay, clear/delete buttons, submit state, original/result comparison, and one result download button. Load the new stylesheet in `<head>` and load `watermark_removal_core.js` before `watermark_removal.js`.

- [ ] **Step 4: Implement pointer editing**

Support drag-to-create, pointer capture, moving, eight resize handles, selected-region deletion via button or Delete/Backspace, and clear-all. Keep regions normalized after every edit and redraw overlays when the image or viewport changes.

- [ ] **Step 5: Implement request and result behavior**

Generate the original-size PNG mask with `renderMask`, submit JSON to `/api/watermark-removal`, disable mutations while busy, and retain image/regions on errors. On success render comparison and call:

```javascript
saveToHistory('watermark-removal', {
  filename: state.filename,
  result: response.data,
});
```

- [ ] **Step 6: Implement result-only download**

Fetch `result_url` as a blob, derive the extension from `result_mime_type`, sanitize the source stem, and click a temporary anchor named `<stem>-removed.<ext>`. Do not render source or mask download buttons.

- [ ] **Step 7: Run tests and syntax checks**

Run:

```bash
node --test frontend/tests/watermark_removal_core.test.js frontend/tests/watermark_removal_ui.test.js
node --check frontend/js/watermark_removal_core.js
node --check frontend/js/watermark_removal.js
node --check frontend/js/app.js
```

Expected: all tests pass and all checks exit zero.

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html frontend/js/app.js frontend/css/watermark_removal.css frontend/js/watermark_removal.js frontend/tests/watermark_removal_ui.test.js
git commit -m "feat: add AI watermark removal editor"
```

---

### Task 6: Global History UI and End-to-End Verification

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/history_manager.js`
- Create: `frontend/tests/watermark_removal_history.test.js`

**Interfaces:**
- Consumes: `restoreWatermarkRemovalHistory(result)`.
- Produces: a `watermark-removal` history tab, thumbnail/summary rendering, restore dispatch, and deletion through the existing generic endpoint.

- [ ] **Step 1: Write failing history UI tests**

Assert the history manager includes `watermark-removal` in active-tab mapping, uses `result.result_url` for the thumbnail, labels the filename, and calls:

```javascript
switchMainTab('watermark-removal');
restoreWatermarkRemovalHistory(responseObj);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test frontend/tests/watermark_removal_history.test.js`

Expected: FAIL because history rendering does not know the new module.

- [ ] **Step 3: Implement history list and restoration**

Add the history tab in `index.html`. Extend the map, item title, thumbnail, summary, and restore branch in `history_manager.js`. Restore source/result comparison and regions without starting an AI request. The restored state exposes only the result download action.

- [ ] **Step 4: Run frontend tests and verify GREEN**

Run:

```bash
node --test frontend/tests/*.test.js
node --check frontend/js/history_manager.js
```

Expected: all frontend tests pass and syntax check exits zero.

- [ ] **Step 5: Run the complete backend suite**

Run: `python -m pytest backend/tests`

Expected: zero failures.

- [ ] **Step 6: Build CSS**

Run: `cd frontend && npm run build:css`

Expected: Tailwind build exits zero. Confirm generated output changes are consistent with the repository’s tracked-file policy before staging anything.

- [ ] **Step 7: Perform browser acceptance**

Start with `python run.py`, then verify at `http://localhost:8080/index.html`:

1. Upload a JPG or PNG.
2. Create two rectangles, move one, resize the other, and delete/recreate one.
3. Submit and confirm the source remains visible while processing.
4. Confirm result dimensions match the source.
5. Download and confirm the filename ends in `-removed` and only the result has a download control.
6. Open global history, restore the record, and download the result again.
7. Force one failed request and confirm the source and both regions remain editable.

- [ ] **Step 8: Inspect the final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: no whitespace errors, no secrets, no `backend/static/` files, no database, and no unrelated user files staged.

- [ ] **Step 9: Commit**

```bash
git add frontend/index.html frontend/js/history_manager.js frontend/tests/watermark_removal_history.test.js
git commit -m "feat: restore watermark removal history"
```
