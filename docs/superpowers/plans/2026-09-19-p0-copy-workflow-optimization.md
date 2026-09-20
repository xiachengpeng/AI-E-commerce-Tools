# P0 级全链路业务流程与文案规则优化实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底解决跨模块流转死锁（支持广告纯文本生成与图文继承）、消除 Google RSA 广告超限拒审（严格 30/90 字符上限）、纠偏竞品分析转 Listing 关键词语义倒错。

**Architecture:** 
- 后端将 `AdCopyGenerateRequest` 改造为支持纯文本与多模态双轨运行，并在 `_ads_prompt` 注入 Google RSA 30/90 字符与 Meta 125 字符刚性约束；
- 前端解除广告生成前的无图硬性拦截，支持纯文本生成并提供友好的多模态上传引导；
- 跨模块流转重构：竞品转 Listing 提取真正的搜索品类关键词，流转广告时全量透传标题、卖点与已有图片资产。

**Tech Stack:** FastAPI, Pydantic v2, Python asyncio, Vanilla JavaScript (ES2022), Node test runner (`node:test`), Pytest.

**Spec:** [`docs/superpowers/specs/2026-09-19-p0-copy-workflow-optimization-design.md`](file:///Users/xiachengpeng/code/AI%20E-commerce%20Tools/docs/superpowers/specs/2026-09-19-p0-copy-workflow-optimization-design.md)

## Global Constraints

- 无论用户是否上传图片，后端生成的广告数据结构保持 100% 相同（包含 9 种营销风格、5 种黄金钩子、分镜头脚本）。
- Google RSA 标题严格 ≤ 30 字符，描述严格 ≤ 90 字符，附加链接标题 ≤ 25 字符，描述 ≤ 35 字符。
- `image_data` 和 `product_name` 至少有一个非空；若两者皆空，抛出 422 验证错误。
- 竞品分析流转 Listing 时，严禁将场景标签与受众标签填入关键词输入框。
- 现有历史记录结构与 SQLite 数据模型保持向前兼容。

## Review Focus

1. 既没有上传图片，也没有输入商品名称时的边界触发：应优雅提示，不可抛出未捕获异常。
2. 只有商品名称没有卖点和图片时的纯文本生成：Prompt 必须能稳健生成完整的 9 种风格与黄金钩子。
3. 带有超长商品名称（超过 200 字符）时的截断与处理：避免注入攻击与 Token 浪费。
4. Google RSA 字符严格计算包含空格：确保提示词中强调 `including spaces`。
5. 跨模块流转在目标输入框已有内容时的防误触确认机制：保留已有的确认弹窗。

---

### Task 1: 后端数据模型与广告双模态服务升级 (Backend Ad Models & Dual-Mode Service)

**Files:**
- Modify: `backend/models/request.py:350-385`
- Modify: `backend/services/ads_service.py:320-432`
- Test: `backend/tests/test_ads_dual_mode.py`

**Interfaces:**
- Consumes: `AIService.generate_content`, `app_logs`
- Produces: `AdCopyGenerateRequest(image_data: str | None, product_name: str | None, selling_points: str | None, keywords: str | None)`
- Produces: `generate_ad_copy(request: AdCopyGenerateRequest) -> dict`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_ads_dual_mode.py
import pytest
from pydantic import ValidationError
from models.request import AdCopyGenerateRequest
from services.ads_service import _ads_prompt

def test_ad_copy_request_supports_text_only():
    req = AdCopyGenerateRequest(
        image_data=None,
        platforms=["google", "facebook"],
        region="United States",
        product_name="Ergonomic Lumbar Support Cushion",
        selling_points="Memory foam, breathable mesh cover"
    )
    assert req.image_data is None
    assert req.product_name == "Ergonomic Lumbar Support Cushion"
    assert req.selling_points == "Memory foam, breathable mesh cover"

def test_ad_copy_request_rejects_both_image_and_name_empty():
    with pytest.raises(ValidationError):
        AdCopyGenerateRequest(
            image_data=None,
            platforms=["google"],
            region="United States",
            product_name=""
        )

def test_ads_prompt_contains_google_rsa_character_limits():
    req = AdCopyGenerateRequest(
        image_data=None,
        platforms=["google", "facebook"],
        region="United States",
        product_name="Ergonomic Pillow"
    )
    prompt = _ads_prompt(req)
    assert "strictly <= 30 characters" in prompt or "<= 30 characters" in prompt
    assert "strictly <= 90 characters" in prompt or "<= 90 characters" in prompt
    assert "FIRST 125 CHARACTERS" in prompt
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_ads_dual_mode.py -v`
Expected: FAIL (ValidationError due to required `image_data`, missing prompt rules)

- [ ] **Step 3: Implement minimal code**

1. In `backend/models/request.py`:
   - Change `image_data: str` to `image_data: str | None = None`
   - Add `selling_points: str | None = None` and `keywords: str | None = None`
   - Add root_validator / model_validator to ensure at least one of `image_data` or `product_name` has non-empty content.

2. In `backend/services/ads_service.py`:
   - In `_ads_prompt`:
     - If `request.image_data` is None, state clearly: "Generate high-converting ad copy based on the product name, core selling points, and target market provided below."
     - Under Rule 6: add `Front-load the core hook and benefit within the FIRST 125 CHARACTERS before the mobile fold line.`
     - Under Rule 7: add `Google Responsive Search Ads (RSA) HARD CAPS: Every single headline MUST be strictly <= 30 characters (including spaces). Every single description MUST be strictly <= 90 characters (including spaces). Sitelink title <= 25 chars, descriptions <= 35 chars.`
   - In `generate_ad_copy(request)`:
     - If `request.image_data`: keep current `_validate_image_data` and `inlineData`.
     - Else: construct contents with only `{"text": _ads_prompt(request)}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_ads_dual_mode.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/models/request.py backend/services/ads_service.py backend/tests/test_ads_dual_mode.py
git commit -m "feat(ads): add dual-mode ad copy generation and Google RSA character limits"
```

---

### Task 2: 前端广告交互解脱与双模态适配 (Frontend Ads Interaction & Dual-Mode UI)

**Files:**
- Modify: `frontend/js/ads.js:665-720`
- Modify: `frontend/index.html:1800-1860`
- Test: `frontend/tests/ads_dual_mode_ui.test.js`

**Interfaces:**
- Consumes: `generateAdsCopy`, `showToast`, `callAI` / `api/ads/generate`
- Produces: `receiveAdsTransferData({ productName, sellingPoints, imageBase64, region })`

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/tests/ads_dual_mode_ui.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('ads.js supports text-only generation check and transfer receive', () => {
    const code = fs.readFileSync(path.join(__dirname, '../js/ads.js'), 'utf8');
    // Verify that generateAdsCopy doesn't unconditionally block when image is missing if product name is provided
    assert.ok(code.includes('receiveAdsTransferData'), 'ads.js must expose receiveAdsTransferData');
    assert.ok(!code.includes("if (!currentAdsUploadedBase64) {\n        showToast('请先上传商品图片', 'error');\n        return;\n    }"),
        'ads.js must not unconditionally reject missing image');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/ads_dual_mode_ui.test.js`
Expected: FAIL

- [ ] **Step 3: Implement minimal code**

1. In `frontend/js/ads.js`:
   - In `generateAdsCopy()`:
     - Check:
       ```javascript
       const productName = document.getElementById('adsProductNameInput')?.value.trim() || '';
       if (!currentAdsUploadedBase64 && !productName) {
           showToast('请上传商品图片或输入商品名称', 'warning');
           return;
       }
       ```
     - In payload construction: pass `image_data: currentAdsUploadedBase64 || null`, pass `product_name: productName`, pass `selling_points: currentAdsSellingPoints || null`.
   - Expose `window.receiveAdsTransferData = function(data) { ... }` that populates `adsProductNameInput`, stores `sellingPoints`, sets region, and if `imageBase64` is provided, renders the preview image.
2. In `frontend/index.html`:
   - Update image upload box hint to: `"支持上传商品实拍图 (可选，上传可分析细节材质；未上传则基于商品名称生成)"`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/ads_dual_mode_ui.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/js/ads.js frontend/index.html frontend/tests/ads_dual_mode_ui.test.js
git commit -m "feat(ads): allow text-only ad copy generation and support cross-module transfer injection"
```

---

### Task 3: 竞品分析与 Listing 跨模块流转语义纠偏 (Cross-Module Transfer & Keyword Semantic Fix)

**Files:**
- Modify: `frontend/js/analysis.js:710-778`
- Modify: `frontend/js/listing.js:1038-1078`
- Test: `frontend/tests/cross_module_transfer_semantics.test.js`

**Interfaces:**
- Consumes: `xp_transferToListing`, `xp_transferToAds`, `transferListingToAds`
- Produces: Normalized keywords strictly without demographic tags like '程序员'/'宝妈'

- [ ] **Step 1: Write the failing test**

```javascript
// frontend/tests/cross_module_transfer_semantics.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('xp_transferToListing extracts pure product keywords, not audience/scenarios', () => {
    const analysisCode = fs.readFileSync(path.join(__dirname, '../js/analysis.js'), 'utf8');
    // Verify that use_scenarios and target_audience are no longer mapped into listingKeywords
    const kwExtractSection = analysisCode.substring(
        analysisCode.indexOf('function xp_transferToListing'),
        analysisCode.indexOf('function xp_transferToAds')
    );
    assert.ok(!kwExtractSection.includes('(d.target_audience || []).forEach(a => {\n                const text = typeof a === \'object\' ? (a.audience || a.item || \'\') : String(a);\n                const t = xp_getI18nText(text).trim();\n                if (t && !kwList.includes(t)) kwList.push(t);\n            });'),
        'listingKeywords must not be populated with target audience tags');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/cross_module_transfer_semantics.test.js`
Expected: FAIL

- [ ] **Step 3: Implement minimal code**

1. In `frontend/js/analysis.js`:
   - In `xp_transferToListing`:
     - Clean `listingKeywords`: Extract from `d.category` and `d.product_name` keywords (e.g. split by commas or slashes, remove stop words).
     - Keep `use_scenarios` and `target_audience` inside `listingPoints` under `【适用人群与场景】`.
   - In `xp_transferToAds`:
     - Call `receiveAdsTransferData` if available, passing `product_name`, `selling_points` (from `core_selling_points`), and image if available.
2. In `frontend/js/listing.js`:
   - In `transferListingToAds`:
     - Extract title, concatenate bullets 1-3 as `selling_points`, pass along any uploaded listing image via `receiveAdsTransferData`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/cross_module_transfer_semantics.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/js/analysis.js frontend/js/listing.js frontend/tests/cross_module_transfer_semantics.test.js
git commit -m "fix(analysis): correct keyword extraction semantics and enrich ads transfer data"
```

---

### Task 4: 全量测试双端回归与代码洁净度验证 (Full Double-Suite Regression)

- [ ] **Step 1: Run full backend pytest suite**
  Run: `.venv/bin/python -m pytest backend/tests`
  Expected: 571+ passed, 0 failures.

- [ ] **Step 2: Run full frontend node test suite**
  Run: `node --test frontend/tests/*.test.js`
  Expected: 339+ passed, 0 failures.

- [ ] **Step 3: Syntax check modified frontend JS files**
  Run: `node --check frontend/js/ads.js && node --check frontend/js/analysis.js && node --check frontend/js/listing.js`
  Expected: Clean (exit code 0).

- [ ] **Step 4: Git diff check**
  Run: `git diff --check`
  Expected: Clean output.
