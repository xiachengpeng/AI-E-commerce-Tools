# Ad Copy Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a left-sidebar "广告文案" feature that turns a product image into 9 bilingual Facebook and/or Google ad copy sets.

**Architecture:** Add a focused backend ads service and `/api/ads/generate` route, mirroring the existing Listing backend proxy pattern. Add a standalone frontend page and `frontend/js/ads.js` module so the workflow stays separate from Listing while reusing existing config, toast, API provider, and copy utilities.

**Tech Stack:** FastAPI, Pydantic, existing `AIService`, vanilla JavaScript, existing Tailwind/Phosphor-based frontend, pytest, Node syntax checks.

---

## File Structure

- Create `backend/services/ads_service.py`: image validation, prompt construction, AI call, JSON parsing, and result normalization for ad copy generation.
- Modify `backend/models/request.py`: add `AdCopyGenerateRequest` with validation for image data and platform selection.
- Modify `backend/main.py`: import the new request/service and expose `POST /api/ads/generate`.
- Create `backend/tests/test_ads_service.py`: unit tests for normalization and service behavior.
- Modify `backend/tests/test_main.py`: route tests for success and validation failure.
- Create `frontend/js/ads.js`: upload state, platform selection validation, API call, result rendering, and copy helpers.
- Modify `frontend/index.html`: add sidebar tab, `view-ads`, controls, result containers, and script include.
- Modify `frontend/js/app.js`: initialize reused selects for the ads page.

---

### Task 1: Backend Request Model

**Files:**
- Modify: `backend/models/request.py`
- Test: `backend/tests/test_main.py`

- [ ] **Step 1: Add failing route validation test**

Append this test to `backend/tests/test_main.py`:

```python
def test_ads_generate_rejects_missing_platforms():
    image = "data:image/png;base64," + base64.b64encode(b"fake").decode()
    resp = client.post("/api/ads/generate", json={
        "image_data": image,
        "platforms": [],
        "region": "US Market",
        "target_language": "English",
    })

    assert resp.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_ads_generate_rejects_missing_platforms -v
```

Expected: FAIL because `/api/ads/generate` does not exist yet or `AdCopyGenerateRequest` is not defined.

- [ ] **Step 3: Add request model**

In `backend/models/request.py`, after `ListingComplianceRequest`, add:

```python
class AdCopyGenerateRequest(BaseModel):
    image_data: str
    platforms: List[str]
    region: str
    target_language: str | None = None
    marketing_theme: str | None = None
    marketing_theme_label: str | None = None
    ai_provider: str | None = None

    @field_validator("image_data", "region")
    @classmethod
    def strip_required_text(cls, v: str) -> str:
        return v.strip()

    @field_validator("target_language", "marketing_theme", "marketing_theme_label", mode="before")
    @classmethod
    def strip_optional_text(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v

    @field_validator("platforms")
    @classmethod
    def validate_platforms(cls, v: List[str]) -> List[str]:
        allowed = {"facebook", "google"}
        normalized = []
        for item in v:
            platform = str(item).strip().lower()
            if platform:
                normalized.append(platform)
        if not normalized:
            raise ValueError("至少选择一个广告平台")
        invalid = [item for item in normalized if item not in allowed]
        if invalid:
            raise ValueError(f"不支持的广告平台: {', '.join(invalid)}")
        return list(dict.fromkeys(normalized))
```

- [ ] **Step 4: Temporarily import model in main**

In `backend/main.py`, add `AdCopyGenerateRequest` to the existing models import:

```python
from models.request import (
    CompareRequest, CompareResponse, CompareResponseData, ProductCompareData,
    ComparisonSummary, ScoreCard, EvalDetail, RecItem,
    TranslationRequest,
    ListingGenerateRequest, ListingImageExtractRequest, ListingComplianceRequest,
    AdCopyGenerateRequest,
)
```

The route is implemented in Task 3; this step keeps the type available.

- [ ] **Step 5: Commit**

```bash
git add backend/models/request.py backend/main.py backend/tests/test_main.py
git commit -m "test: cover ad platform validation"
```

---

### Task 2: Ads Service

**Files:**
- Create: `backend/services/ads_service.py`
- Test: `backend/tests/test_ads_service.py`

- [ ] **Step 1: Write failing normalization tests**

Create `backend/tests/test_ads_service.py`:

```python
from services.ads_service import normalize_ad_copy_result


def test_normalize_ad_copy_result_fills_all_styles_and_selected_platforms():
    result = normalize_ad_copy_result(
        {
            "product": {"name": {"target": "Bamboo Basket", "zh": "竹篮"}},
            "styles": [
                {
                    "id": "problem_solution",
                    "facebook": {
                        "headline": {"target": "Tidy Your Kitchen", "zh": "整理厨房"}
                    },
                }
            ],
        },
        platforms=["facebook"],
    )

    assert len(result["styles"]) == 9
    first = result["styles"][0]
    assert first["id"] == "problem_solution"
    assert first["facebook"]["headline"]["target"] == "Tidy Your Kitchen"
    assert first["facebook"]["primaryText"] == {"target": "", "zh": ""}
    assert "google" not in first


def test_normalize_ad_copy_result_supports_google_lists():
    result = normalize_ad_copy_result(
        {
            "styles": [
                {
                    "id": "feature_benefit",
                    "google": {
                        "headlines": ["Absorbent Bath Mat"],
                        "descriptions": [{"target": "Dries fast", "zh": "快速干燥"}],
                        "keywords": [{"keyword": "bath mat", "zh": "浴室垫"}],
                        "sitelinks": [{"text": "Shop Now", "zh": "立即购买"}],
                    },
                }
            ],
        },
        platforms=["google"],
    )

    style = result["styles"][1]
    assert style["id"] == "feature_benefit"
    assert style["google"]["headlines"][0] == {"target": "Absorbent Bath Mat", "zh": ""}
    assert style["google"]["descriptions"][0] == {"target": "Dries fast", "zh": "快速干燥"}
    assert style["google"]["keywords"][0] == {"target": "bath mat", "zh": "浴室垫"}
    assert style["google"]["sitelinks"][0] == {"target": "Shop Now", "zh": "立即购买"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python -m pytest backend/tests/test_ads_service.py -v
```

Expected: FAIL with import error because `services.ads_service` does not exist.

- [ ] **Step 3: Create ads service**

Create `backend/services/ads_service.py`:

```python
import base64
import json
import os
import re
from typing import Any

from config import GEMINI_MODEL_ID
from services.ai_service import AIService
from services.listing_service import parse_ai_json_object, first_text_from_response


AD_STYLE_DEFINITIONS = [
    ("problem_solution", "Problem/Solution", "痛点解决型", "放大痛点，引入产品作为解决方案，展示轻松状态。"),
    ("feature_benefit", "Feature & Benefit", "卖点直击型", "直接展示核心功能、材质、设计差异与用户收益。"),
    ("emotional_appeal", "Emotional Appeal", "情感共鸣型", "弱化产品参数，突出生活状态、情绪价值和品牌认同。"),
    ("social_proof", "Social Proof / UGC", "社会认同 / 背书型", "用评价、UGC、口碑和真实反馈建立信任。"),
    ("us_vs_them", "Us vs. Them", "对比竞争型", "将产品与传统方案或劣质竞品对比，制造清晰优势。"),
    ("how_to_demo", "How-to / Demonstration", "教程 / 场景演示型", "展示安装、使用过程、前后对比和最终效果。"),
    ("offer_promotion", "Offer / Promotion Driven", "利益 / 促销驱动型", "用折扣、免邮、买赠等利益点推动行动。"),
    ("scarcity_urgency", "Scarcity / Urgency", "稀缺 / 紧迫感型", "制造合理的限量、限时、补货或库存紧迫感。"),
    ("curiosity_entertainment", "Curiosity / Entertainment", "猎奇 / 趣味型", "用反常识、测试、幽默或反转吸引冷流量。"),
]


def _ads_model_id() -> str:
    return os.getenv("FRONTEND_VISION_MODEL") or os.getenv("FRONTEND_TEXT_MODEL") or GEMINI_MODEL_ID


def _text_pair(value: Any) -> dict:
    if isinstance(value, str):
        return {"target": value, "zh": ""}
    if isinstance(value, dict):
        target = (
            value.get("target")
            or value.get("English")
            or value.get("english")
            or value.get("text")
            or value.get("copy")
            or value.get("headline")
            or value.get("keyword")
            or ""
        )
        zh = (
            value.get("zh")
            or value.get("Chinese")
            or value.get("chinese")
            or value.get("cn")
            or value.get("translation")
            or value.get("translation_zh")
            or ""
        )
        return {"target": str(target), "zh": str(zh)}
    return {"target": "", "zh": ""}


def _text_pair_list(value: Any) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]
    pairs = [_text_pair(item) for item in value]
    return [pair for pair in pairs if pair["target"] or pair["zh"]]


def _facebook_block(value: Any) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "primaryText": _text_pair(data.get("primaryText") or data.get("primary_text")),
        "headline": _text_pair(data.get("headline")),
        "description": _text_pair(data.get("description")),
        "cta": _text_pair(data.get("cta")),
        "creativeDirection": _text_pair(data.get("creativeDirection") or data.get("creative_direction")),
    }


def _google_block(value: Any) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "headlines": _text_pair_list(data.get("headlines")),
        "descriptions": _text_pair_list(data.get("descriptions")),
        "keywords": _text_pair_list(data.get("keywords")),
        "sitelinks": _text_pair_list(data.get("sitelinks") or data.get("sitelinkIdeas")),
    }


def normalize_ad_copy_result(data: Any, platforms: list[str]) -> dict:
    data = data if isinstance(data, dict) else {}
    platform_set = set(platforms)
    incoming_styles = {
        str(item.get("id") or "").strip(): item
        for item in data.get("styles", [])
        if isinstance(item, dict)
    }

    styles = []
    for style_id, target_name, zh_name, zh_logic in AD_STYLE_DEFINITIONS:
        raw = incoming_styles.get(style_id, {})
        style = {
            "id": style_id,
            "name": _text_pair(raw.get("name")) if raw.get("name") else {"target": target_name, "zh": zh_name},
            "logic": _text_pair(raw.get("logic")) if raw.get("logic") else {"target": "", "zh": zh_logic},
        }
        if "facebook" in platform_set:
            style["facebook"] = _facebook_block(raw.get("facebook"))
        if "google" in platform_set:
            style["google"] = _google_block(raw.get("google"))
        styles.append(style)

    product = data.get("product") if isinstance(data.get("product"), dict) else {}
    return {
        "product": {
            "name": _text_pair(product.get("name")),
            "summary": _text_pair(product.get("summary")),
        },
        "styles": styles,
    }


def _validate_image_data(image_data: str) -> tuple[str, str]:
    if not image_data.startswith("data:image") or "," not in image_data:
        raise ValueError("图片格式无效")

    header, encoded = image_data.split(",", 1)
    if len(encoded) > 8_000_000:
        raise ValueError("图片过大，请压缩后再上传")

    mime_match = re.search(r"data:([^;]+);base64", header)
    if not mime_match:
        raise ValueError("图片 MIME 类型无效")

    base64.b64decode(encoded, validate=True)
    return mime_match.group(1), encoded


def _ads_prompt(request) -> str:
    selected_platforms = ", ".join(request.platforms)
    theme = ""
    if request.marketing_theme and request.marketing_theme != "none":
        theme = f"Campaign theme: {request.marketing_theme_label or request.marketing_theme}"

    style_schema = [
        {"id": style_id, "target_name": target, "zh_name": zh, "logic_zh": logic}
        for style_id, target, zh, logic in AD_STYLE_DEFINITIONS
    ]

    return f"""You are a senior cross-border performance marketing strategist.

Analyze the product image and generate bilingual ad copy for the selected platforms.

Selected platforms: {selected_platforms}
Target market: {request.region}
Target language: {request.target_language or "English"}
{theme}

Creative styles to generate exactly once:
{json.dumps(style_schema, ensure_ascii=False)}

Rules:
1. Return pure JSON only, no markdown fences.
2. Generate all 9 style objects in the same order as provided.
3. Only include selected platform keys.
4. Every copy field must include target-language text and Chinese back-translation.
5. Keep claims specific and defensible. Avoid medical claims, safety guarantees, unverifiable superlatives, and false urgency.
6. Facebook copy should fit feed/social ads and include primary text, headline, description, CTA, and creative direction.
7. Google copy should fit search ads and include 5 concise headlines, 3 descriptions, 8 keywords, and 4 sitelink ideas.

JSON schema:
{{
  "product": {{
    "name": {{"target": "Product name", "zh": "中文产品名"}},
    "summary": {{"target": "Short positioning", "zh": "中文定位"}}
  }},
  "styles": [
    {{
      "id": "problem_solution",
      "name": {{"target": "Problem/Solution", "zh": "痛点解决型"}},
      "logic": {{"target": "Creative logic", "zh": "中文创意逻辑"}},
      "facebook": {{
        "primaryText": {{"target": "Primary text", "zh": "中文对照"}},
        "headline": {{"target": "Headline", "zh": "中文对照"}},
        "description": {{"target": "Description", "zh": "中文对照"}},
        "cta": {{"target": "CTA", "zh": "中文对照"}},
        "creativeDirection": {{"target": "Creative direction", "zh": "中文对照"}}
      }},
      "google": {{
        "headlines": [{{"target": "Headline", "zh": "中文对照"}}],
        "descriptions": [{{"target": "Description", "zh": "中文对照"}}],
        "keywords": [{{"target": "Keyword", "zh": "中文对照"}}],
        "sitelinks": [{{"target": "Sitelink", "zh": "中文对照"}}]
      }}
    }}
  ]
}}
"""


async def generate_ad_copy(request) -> dict:
    mime_type, encoded = _validate_image_data(request.image_data)
    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": _ads_prompt(request)},
                {"inlineData": {"mimeType": mime_type, "data": encoded}},
            ],
        }],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    response = await AIService.generate_content(
        model_id=_ads_model_id(),
        payload=payload,
        provider=request.ai_provider,
    )
    text = first_text_from_response(response)
    return normalize_ad_copy_result(parse_ai_json_object(text), request.platforms)
```

- [ ] **Step 4: Run service tests**

Run:

```bash
python -m pytest backend/tests/test_ads_service.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/ads_service.py backend/tests/test_ads_service.py
git commit -m "feat: add ad copy service"
```

---

### Task 3: Ads API Route

**Files:**
- Modify: `backend/main.py`
- Test: `backend/tests/test_main.py`

- [ ] **Step 1: Add failing success route test**

Append this test to `backend/tests/test_main.py`:

```python
def test_ads_generate_endpoint():
    image = "data:image/png;base64," + base64.b64encode(b"fake").decode()
    result = {"product": {"name": {"target": "Lamp", "zh": "灯"}}, "styles": []}

    with patch("main.generate_ad_copy", new=AsyncMock(return_value=result)) as mock_generate:
        resp = client.post("/api/ads/generate", json={
            "image_data": image,
            "platforms": ["facebook", "google"],
            "region": "US Market",
            "target_language": "English",
        })

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"]["product"]["name"]["target"] == "Lamp"
    mock_generate.assert_awaited_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_ads_generate_endpoint -v
```

Expected: FAIL because `generate_ad_copy` is not imported and the route is not defined.

- [ ] **Step 3: Wire route**

In `backend/main.py`, import the service:

```python
from services.ads_service import generate_ad_copy
```

Add this route after the Listing routes:

```python
@app.post("/api/ads/generate")
async def api_ads_generate(request: AdCopyGenerateRequest):
    try:
        data = await generate_ad_copy(request)
        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"❌ [广告文案] 生成失败: {e}")
        return {"status": "error", "message": str(e)}
```

- [ ] **Step 4: Run API route tests**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_ads_generate_endpoint backend/tests/test_main.py::test_ads_generate_rejects_missing_platforms -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_main.py
git commit -m "feat: expose ad copy API"
```

---

### Task 4: Frontend Ads Page Markup

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/app.js`

- [ ] **Step 1: Add sidebar tab**

In `frontend/index.html`, add this button after the Listing tab:

```html
<button id="tab-ads" onclick="switchMainTab('ads')" class="side-tab" title="广告文案">
    <i class="ph ph-megaphone"></i><span>广告文案</span>
</button>
```

- [ ] **Step 2: Add ads view**

In `frontend/index.html`, add this view after `view-listing`:

```html
<div id="view-ads" class="hidden flex-1 overflow-hidden flex bg-[#f8fafc]">
    <div class="w-[360px] bg-white border-r border-gray-200 flex flex-col h-full shrink-0 shadow-sm z-10">
        <div class="p-5 border-b border-gray-100">
            <div class="flex items-center gap-2">
                <div class="bg-orange-100 p-1.5 rounded-lg text-orange-600"><i class="ph ph-megaphone text-lg"></i></div>
                <h2 class="text-base font-black text-gray-800 tracking-tight">广告文案生成</h2>
            </div>
        </div>
        <div class="flex-1 overflow-y-auto p-5 custom-scrollbar">
            <div class="flex items-center text-xs font-bold text-gray-700 mb-2">商品图片 <span class="text-red-500 ml-1">*</span></div>
            <div class="flex gap-3 mb-5">
                <div id="adsImagePreviewContainer" class="w-[72px] h-[72px] rounded-lg border border-gray-200 bg-gray-50 overflow-hidden relative group hidden shadow-inner">
                    <img id="adsUploadedImagePreview" src="" class="w-full h-full object-cover">
                    <button onclick="removeAdsImage()" class="absolute top-1 right-1 bg-black/50 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"><i class="ph ph-x text-[10px]"></i></button>
                </div>
                <label for="adsImageUpload" class="w-[72px] h-[72px] rounded-lg border border-dashed border-gray-300 bg-gray-50 flex items-center justify-center cursor-pointer hover:bg-gray-100 hover:border-orange-400 transition-all">
                    <i class="ph ph-image text-gray-400 text-xl"></i>
                    <input type="file" id="adsImageUpload" class="hidden" accept="image/*" onchange="handleAdsImageUpload(event)">
                </label>
            </div>

            <label class="block text-xs font-bold text-gray-700 mb-2">广告类型</label>
            <div class="grid grid-cols-2 gap-2 mb-5">
                <label class="flex items-center gap-2 text-xs font-bold text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-2.5 cursor-pointer">
                    <input type="checkbox" class="ads-platform-checkbox accent-orange-600" value="facebook" checked> Facebook
                </label>
                <label class="flex items-center gap-2 text-xs font-bold text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-2.5 cursor-pointer">
                    <input type="checkbox" class="ads-platform-checkbox accent-orange-600" value="google" checked> Google
                </label>
            </div>

            <label class="block text-[10px] font-bold text-gray-500 mb-1">目标市场</label>
            <select id="adsRegionSelect" class="w-full text-xs border border-gray-200 rounded-lg p-2.5 outline-none focus:border-orange-500 bg-gray-50 mb-3"></select>
            <label class="block text-[10px] font-bold text-gray-500 mb-1">目标语言</label>
            <select id="adsLanguageSelect" class="w-full text-xs border border-gray-200 rounded-lg p-2.5 outline-none focus:border-orange-500 bg-gray-50 mb-3"></select>
            <label class="block text-[10px] font-bold text-gray-500 mb-1">营销节点/主题</label>
            <select id="adsMarketingThemeSelect" class="w-full text-xs border border-orange-200 rounded-lg p-2.5 outline-none focus:border-orange-500 bg-orange-50 text-orange-700 font-medium mb-3 shadow-sm"></select>
        </div>
        <div class="p-4 bg-white border-t border-gray-200 shadow-[0_-4px_10px_rgba(0,0,0,0.02)]">
            <button id="btnGenerateAds" onclick="generateAdsCopy()" class="w-full bg-orange-600 hover:bg-orange-700 text-white font-medium py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2 shadow-md">
                <i class="ph ph-magic-wand text-lg"></i> 生成广告文案
            </button>
        </div>
    </div>

    <div class="flex-1 overflow-y-auto bg-[#f8fafc] custom-scrollbar">
        <div class="w-full sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-gray-200 shadow-sm flex justify-between items-center px-8 py-3.5">
            <div class="flex items-center gap-3">
                <h2 class="text-lg font-black text-gray-800">广告文案结果</h2>
                <div class="flex items-center gap-1.5 text-[10px] font-bold text-orange-600 bg-orange-50 px-2 py-0.5 rounded border border-orange-100">
                    <i class="ph-fill ph-sparkle"></i> 9种创意角度
                </div>
            </div>
        </div>
        <div id="adsEmpty" class="flex-1 flex flex-col items-center justify-center text-gray-400 opacity-80 min-h-[400px]">
            <i class="ph ph-megaphone text-6xl mb-4 text-orange-200"></i>
            <p class="text-sm font-medium">上传商品图片，选择平台后生成广告文案</p>
        </div>
        <div id="adsResults" class="hidden flex-col gap-5 max-w-5xl mx-auto p-8 pb-10 fade-in w-full"></div>
    </div>
</div>
```

- [ ] **Step 3: Include script**

In `frontend/index.html`, add before `translate.js`:

```html
<script src="js/ads.js"></script>
```

- [ ] **Step 4: Initialize selects**

In `frontend/js/app.js`, inside `initApp`, after Listing select initialization, add:

```javascript
fillSelect('adsMarketingThemeSelect', MARKETING_THEMES);
fillSelect('adsRegionSelect', REGION_OPTIONS);
fillSelect('adsLanguageSelect', LANGUAGE_OPTIONS);
```

After the existing `initListingControls` call, add:

```javascript
if (typeof initAdsControls === 'function') initAdsControls();
```

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/js/app.js
git commit -m "feat: add ad copy page"
```

---

### Task 5: Frontend Ads JavaScript

**Files:**
- Create: `frontend/js/ads.js`

- [ ] **Step 1: Create frontend module**

Create `frontend/js/ads.js`:

```javascript
const ADS_REGION_LANGUAGE_MAP = {
    'US Market': 'English',
    'European Market': 'English',
    'UK Market': 'English',
    'Japan Market': 'Japanese',
    'Southeast Asia Market': 'English',
    'Middle East Market': 'English',
    'Australian Market': 'English',
    'Global Market': 'English'
};

let currentAdsUploadedBase64 = null;
let currentAdsData = null;

function adsTextPair(value) {
    if (typeof value === 'string') return { target: value, zh: '' };
    return {
        target: value?.target || value?.English || value?.english || value?.text || value?.copy || value?.keyword || '',
        zh: value?.zh || value?.Chinese || value?.chinese || value?.cn || value?.translation || value?.translation_zh || ''
    };
}

function initAdsControls() {
    const regionSelect = document.getElementById('adsRegionSelect');
    const languageSelect = document.getElementById('adsLanguageSelect');
    if (!regionSelect || !languageSelect) return;
    regionSelect.addEventListener('change', syncAdsLanguageToRegion);
    syncAdsLanguageToRegion();
}

function syncAdsLanguageToRegion() {
    const regionSelect = document.getElementById('adsRegionSelect');
    const languageSelect = document.getElementById('adsLanguageSelect');
    if (!regionSelect || !languageSelect) return;
    const recommendedLanguage = ADS_REGION_LANGUAGE_MAP[regionSelect.value];
    const option = Array.from(languageSelect.options).find(item => item.value === recommendedLanguage);
    if (option) languageSelect.value = recommendedLanguage;
}

async function postAdsApi(payload) {
    const res = await fetch(`${API_BASE}/api/ads/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ai_provider: AI_PROVIDER })
    });
    const data = await res.json();
    if (data.status !== 'success') {
        throw new Error(data.message || '请求失败');
    }
    return data.data;
}

function selectedAdsPlatforms() {
    return Array.from(document.querySelectorAll('.ads-platform-checkbox:checked')).map(item => item.value);
}

function handleAdsImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
        showToast('图片过大，请选择 6MB 以内的图片', 'error');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        currentAdsUploadedBase64 = e.target.result;
        document.getElementById('adsUploadedImagePreview').src = currentAdsUploadedBase64;
        document.getElementById('adsImagePreviewContainer').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

function removeAdsImage() {
    currentAdsUploadedBase64 = null;
    document.getElementById('adsImageUpload').value = '';
    document.getElementById('adsImagePreviewContainer').classList.add('hidden');
}

function appendAdsText(parent, className, text) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text || '';
    parent.appendChild(el);
    return el;
}

function appendAdsPair(parent, label, value) {
    const pair = adsTextPair(value);
    const block = document.createElement('div');
    block.className = 'rounded-lg border border-gray-100 bg-gray-50/80 p-3';
    appendAdsText(block, 'text-[10px] font-black text-gray-400 uppercase mb-1', label);
    appendAdsText(block, 'target-text text-sm text-gray-800 whitespace-pre-wrap', pair.target);
    appendAdsText(block, 'zh-text text-xs text-gray-400 mt-2 border-t border-gray-200/70 pt-2 whitespace-pre-wrap', pair.zh);
    parent.appendChild(block);
}

function appendAdsPairList(parent, label, values) {
    const block = document.createElement('div');
    block.className = 'rounded-lg border border-gray-100 bg-gray-50/80 p-3';
    appendAdsText(block, 'text-[10px] font-black text-gray-400 uppercase mb-2', label);
    const list = document.createElement('div');
    list.className = 'space-y-2';
    (values || []).forEach(value => {
        const pair = adsTextPair(value);
        const item = document.createElement('div');
        appendAdsText(item, 'target-text text-sm text-gray-800', pair.target);
        appendAdsText(item, 'zh-text text-xs text-gray-400', pair.zh);
        list.appendChild(item);
    });
    if (!list.children.length) appendAdsText(list, 'text-xs text-gray-400', '-');
    block.appendChild(list);
    parent.appendChild(block);
}

function copyAdsStyleText(style) {
    const lines = [];
    const pushPair = (label, value) => {
        const pair = adsTextPair(value);
        if (pair.target || pair.zh) lines.push(`${label}: ${pair.target}${pair.zh ? `\n中文: ${pair.zh}` : ''}`);
    };
    lines.push(`${adsTextPair(style.name).target} / ${adsTextPair(style.name).zh}`);
    pushPair('Logic', style.logic);
    if (style.facebook) {
        lines.push('\n[Facebook]');
        pushPair('Primary Text', style.facebook.primaryText);
        pushPair('Headline', style.facebook.headline);
        pushPair('Description', style.facebook.description);
        pushPair('CTA', style.facebook.cta);
        pushPair('Creative Direction', style.facebook.creativeDirection);
    }
    if (style.google) {
        lines.push('\n[Google]');
        ['headlines', 'descriptions', 'keywords', 'sitelinks'].forEach(key => {
            (style.google[key] || []).forEach((item, index) => pushPair(`${key} ${index + 1}`, item));
        });
    }
    navigator.clipboard.writeText(lines.join('\n')).then(
        () => showToast('已复制该风格文案', 'success'),
        () => showToast('复制失败', 'error')
    );
}

function renderAdsData(data) {
    currentAdsData = data || null;
    document.getElementById('adsEmpty').classList.add('hidden');
    const container = document.getElementById('adsResults');
    container.textContent = '';
    container.classList.remove('hidden');
    container.classList.add('flex');

    const product = data?.product || {};
    const productBlock = document.createElement('div');
    productBlock.className = 'bg-white rounded-2xl shadow-sm border border-gray-200 p-5';
    appendAdsText(productBlock, 'text-xs font-black text-orange-600 uppercase mb-2', 'Product');
    appendAdsPair(productBlock, 'Name', product.name);
    appendAdsPair(productBlock, 'Summary', product.summary);
    container.appendChild(productBlock);

    (data?.styles || []).forEach(style => {
        const card = document.createElement('div');
        card.className = 'bg-white rounded-2xl shadow-sm border border-gray-200 p-5';
        const header = document.createElement('div');
        header.className = 'flex items-start justify-between gap-3 mb-4';
        const titleWrap = document.createElement('div');
        const name = adsTextPair(style.name);
        appendAdsText(titleWrap, 'text-base font-black text-gray-900', `${name.zh || ''} ${name.target ? `(${name.target})` : ''}`.trim());
        appendAdsText(titleWrap, 'text-xs text-gray-500 mt-1', adsTextPair(style.logic).zh || adsTextPair(style.logic).target);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'text-xs bg-gray-100 hover:bg-orange-100 text-gray-500 hover:text-orange-600 px-2 py-1 rounded font-bold transition-colors flex items-center gap-1';
        copyBtn.innerHTML = '<i class="ph ph-copy"></i> 复制';
        copyBtn.addEventListener('click', () => copyAdsStyleText(style));
        header.append(titleWrap, copyBtn);
        card.appendChild(header);

        if (style.facebook) {
            appendAdsText(card, 'text-sm font-black text-blue-700 mt-2 mb-3', 'Facebook Ads');
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
            appendAdsPair(grid, 'Primary Text', style.facebook.primaryText);
            appendAdsPair(grid, 'Headline', style.facebook.headline);
            appendAdsPair(grid, 'Description', style.facebook.description);
            appendAdsPair(grid, 'CTA', style.facebook.cta);
            appendAdsPair(grid, 'Creative Direction', style.facebook.creativeDirection);
            card.appendChild(grid);
        }

        if (style.google) {
            appendAdsText(card, 'text-sm font-black text-emerald-700 mt-5 mb-3', 'Google Ads');
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
            appendAdsPairList(grid, 'Headlines', style.google.headlines);
            appendAdsPairList(grid, 'Descriptions', style.google.descriptions);
            appendAdsPairList(grid, 'Keywords', style.google.keywords);
            appendAdsPairList(grid, 'Sitelinks', style.google.sitelinks);
            card.appendChild(grid);
        }

        container.appendChild(card);
    });
}

async function generateAdsCopy() {
    if (!currentAdsUploadedBase64) {
        showToast('请先上传商品图片', 'error');
        return;
    }
    const platforms = selectedAdsPlatforms();
    if (!platforms.length) {
        showToast('请至少选择一个广告类型', 'error');
        return;
    }

    const regionOpt = document.getElementById('adsRegionSelect');
    const languageOpt = document.getElementById('adsLanguageSelect');
    const themeOpt = document.getElementById('adsMarketingThemeSelect');
    const btn = document.getElementById('btnGenerateAds');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="loader w-4 h-4 mr-2 border-2 border-white border-t-transparent"></span> 生成中...';
    btn.disabled = true;

    try {
        const data = await postAdsApi({
            image_data: currentAdsUploadedBase64,
            platforms,
            region: regionOpt.options[regionOpt.selectedIndex].value,
            target_language: languageOpt.options[languageOpt.selectedIndex].value,
            marketing_theme: themeOpt.value,
            marketing_theme_label: themeOpt.options[themeOpt.selectedIndex].text
        });
        renderAdsData(data);
    } catch (err) {
        showToast('广告文案生成失败: ' + err.message, 'error');
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}
```

- [ ] **Step 2: Run syntax check**

Run:

```bash
node --check frontend/js/ads.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/js/ads.js
git commit -m "feat: render ad copy results"
```

---

### Task 6: Full Verification and Polish

**Files:**
- Modify only files needed to fix verification failures.

- [ ] **Step 1: Run backend tests**

Run:

```bash
python -m pytest backend/tests
```

Expected: PASS.

- [ ] **Step 2: Run frontend syntax checks**

Run:

```bash
node --check frontend/js/ads.js
node --check frontend/js/listing.js
node --check frontend/js/app.js
```

Expected: PASS.

- [ ] **Step 3: Start local app**

Run:

```bash
python run.py
```

Expected: backend starts at `http://localhost:8000` and frontend at `http://localhost:8080/index.html`.

- [ ] **Step 4: Manual browser check**

Open `http://localhost:8080/index.html` and verify:

- Sidebar shows "广告文案".
- Clicking it opens the ads page.
- Upload preview appears and remove button clears it.
- Generate without image shows a toast.
- Unchecking both platforms and generating shows a toast.
- Existing Listing tab still opens and displays its controls.

- [ ] **Step 5: Commit final fixes**

If any fixes were required:

```bash
git add backend frontend
git commit -m "fix: polish ad copy generator"
```

If no fixes were required, do not create an empty commit.
