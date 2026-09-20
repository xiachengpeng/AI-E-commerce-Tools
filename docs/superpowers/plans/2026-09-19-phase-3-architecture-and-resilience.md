# 阶段三：架构解耦与边缘防御 (Phase 3: Architecture, Error Recovery & Edge Resilience) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 针对系统审查报告中的 P2 级架构鲁棒性与边界防御问题，全面升级后端单品与竞品分析的非标准 JSON 容错与解析能力（杜绝 `json.loads` 异常击穿），引入商详长图导出的画布超高纹理（>16384px）自适应缩放降级与内存保护，以及构建全局 `safeLocalStorageSet` 防御性存储与 5MB 配额超限熔断清理机制。

**Architecture:**
- **后端容错升级**：在 `backend/main.py` 的单品分析与深度分析流程中，全面采用 `services.json_utils.safe_extract_and_parse_json` 替换原始的 `json.loads(ai_result_json_str)`，使解析链路具备自动剥离 Markdown 包裹块、修复末尾悬挂逗号（trailing comma）及转义不可见控制字符的能力。
- **长图导出保护**：在 `frontend/js/details.js` 的 `executeLongImageDownload` 中，动态计算画布元素高度与目标缩放比，当预期高度超出移动端与浏览器 WebGL/2D Canvas 硬件纹理安全阈值（16384px）时，自动线性下调渲染 `scale` 至安全尺寸，并增加空画布/尺寸为零检测与友好的错误提示。
- **本地存储配额熔断**：在 `frontend/js/utils.js` 封装 `safeLocalStorageSet(key, value)`，专门拦截处理 `QuotaExceededError`（错误码 22 / 1014），主动清理历史临时版本数据并重试，失败时静默降级并发出告警日志，杜绝抛出未捕获异常中断页面业务。

**Tech Stack:** Python 3.12, FastAPI, pytest, Vanilla JavaScript (ES2022), Node.js Test Runner.

**Spec:** 《项目全面系统审查报告》，涵盖问题 11 (模型非标准 JSON 输出容错)、问题 12 (超长商详 Canvas 纹理溢出保护)、问题 13 (LocalStorage 配额熔断与异常防御)。

## Global Constraints

- 不可改动或回滚当前工作区中正在进行中的未提交修改（特别是 Listing 局部更新相关文件）。
- 所有后端改动必须通过 `pytest backend/tests`。
- 所有前端改动必须通过 `node --test frontend/tests/*.test.js` 且通过 `node --check` 语法检查。
- 不引入重型外部依赖或第三方存储库，保持轻量级纯原生实现。

## Review Focus

1. **非标准 JSON 容错**：当 AI 返回包含 ```json 前后缀、末尾逗号 `[1, 2,]` 或换行符未转义时，`process_single_url_deep` 绝不能抛出 `JSONDecodeError`，必须平稳解析。
2. **极长详情页 Canvas 降级保护**：当详情页总高度达 9000px 且用户选择 PNG（scale: 2，预期 18000px）时，导出的 scale 必须自动降至 <= 1.8，使高度严格控制在 16384px 安全红线内。
3. **极小详情页不降级**：高度为 2000px 的正常详情页，PNG 导出 scale 必须保持原始 2.0，不损失高清画质。
4. **LocalStorage 配额超限不崩溃**：当 localStorage 写入触发 `QuotaExceededError` 时，`safeLocalStorageSet` 返回 `false` 并记录警告，绝不抛出未经处理的异常。
5. **历史冗余自动清理**：超配额时自动尝试移除已废弃的历史版本键（如 `xuanpin_last_result_v26` 等），清理空间后重试写入成功。

---

### Task 1: 后端 AI 结构化输出解析健壮化（全面替换脆弱 `json.loads`）

**Files:**
- Modify: `backend/main.py:525-565`
- Test: `backend/tests/test_analysis_json_resilience.py`

**Interfaces:**
- Consumes: `services.json_utils.safe_extract_and_parse_json`
- Produces: `process_single_url` 与 `process_single_url_deep` 解析鲁棒性增强，抗模型坏格式。

- [ ] **Step 1: Write failing test for resilient single-url JSON parsing**

```python
# backend/tests/test_analysis_json_resilience.py
import pytest
from unittest.mock import AsyncMock, patch
from main import process_single_url_deep

@pytest.mark.asyncio
async def test_process_single_url_deep_handles_trailing_comma_and_fences():
    # Model returns JSON with markdown fences, trailing commas, and prefix commentary
    malformed_ai_response = """Here is the competitive analysis:
```json
{
  "product_name": "Ergonomic Office Chair ||| 人体工学办公椅",
  "category": "Furniture ||| 家具",
  "price": "$199",
  "reviews_count": "1,250",
  "core_selling_points": [
    {"point": "Adjustable lumbar support ||| 自适应腰托", "confidence": "high"},
  ],
}
```
Hope this helps!"""

    with patch("main._safe_fetch_markdown", new_callable=AsyncMock) as mock_fetch, \
         patch("main.clean_content", return_value="cleaned markdown content"), \
         patch("main.check_block", return_value=False), \
         patch("main.is_amazon", return_value=False), \
         patch("main.parse_general", return_value={"product_data": {"price": "$199"}}), \
         patch("main.analyze_single_deep", new_callable=AsyncMock) as mock_ai:
        
        mock_fetch.return_value = "# Product Info"
        mock_ai.return_value = malformed_ai_response

        # Should NOT raise JSONDecodeError
        result = await process_single_url_deep("https://example.com/chair", mode="deep")

        assert result is not None
        assert "Ergonomic Office Chair" in result.get("product_name", "")
        assert len(result.get("core_selling_points", [])) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_analysis_json_resilience.py -v`  
Expected: FAIL with `json.decoder.JSONDecodeError`

- [ ] **Step 3: Update `backend/main.py` to use `safe_extract_and_parse_json`**

在 `backend/main.py` 的 `process_single_url` 和 `process_single_url_deep` 中：
```python
        ai_result_json_str = await analyze_single_extract(structured_data)
        parsed_data = normalize_ai_json_object(safe_extract_and_parse_json(ai_result_json_str))
```
以及
```python
        if mode == "quick":
            ai_result_json_str = await analyze_single_quick(structured_data)
        else:
            ai_result_json_str = await analyze_single_deep(structured_data)
        result = normalize_ai_json_object(safe_extract_and_parse_json(ai_result_json_str))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_analysis_json_resilience.py -v`  
Expected: PASS

- [ ] **Step 5: Run full backend test suite**

Run: `.venv/bin/python -m pytest backend/tests`  
Expected: All backend tests PASS

---

### Task 2: 前端商详长图导出 Canvas 纹理边界保护与自适应降级

**Files:**
- Modify: `frontend/js/details.js:4760-4805`
- Test: `frontend/tests/long_image_export_resilience.test.js`

**Interfaces:**
- Consumes: `calculateSafeLongImageScale(elementHeight, preferredScale, maxDimension)`
- Produces: `executeLongImageDownload()` 自动缩放自适应保护，防止 >16384px 硬件上限崩溃。

- [ ] **Step 1: Write failing test for safe scale calculation and canvas error handling**

```javascript
// frontend/tests/long_image_export_resilience.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createDetailsContext(overrides = {}) {
    const context = {
        console,
        setTimeout,
        clearTimeout,
        document: {
            getElementById: (id) => null
        },
        window: {},
        showToast: () => {}
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    
    // Load details.js
    const detailsCode = fs.readFileSync(path.join(__dirname, '../js/details.js'), 'utf8');
    vm.runInContext(detailsCode, context);
    return context;
}

test('calculateSafeLongImageScale maintains scale when height is within limit', () => {
    const ctx = createDetailsContext();
    assert.strictEqual(typeof ctx.window.calculateSafeLongImageScale, 'function');
    
    // 2000px height with scale 2 = 4000px <= 16384px -> stays 2.0
    const scale = ctx.window.calculateSafeLongImageScale(2000, 2.0, 16384);
    assert.strictEqual(scale, 2.0);
});

test('calculateSafeLongImageScale downscales when height exceeds maxDimension', () => {
    const ctx = createDetailsContext();
    
    // 10000px height with scale 2 = 20000px > 16384px -> downscales to <= 1.6
    const scale = ctx.window.calculateSafeLongImageScale(10000, 2.0, 16384);
    assert.ok(scale <= 1.63, `Expected scale <= 1.63, got ${scale}`);
    assert.ok(scale >= 1.0, `Scale should not drop below 1.0, got ${scale}`);
    assert.ok(10000 * scale <= 16384, 'Total rendered height must not exceed 16384');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/long_image_export_resilience.test.js`  
Expected: FAIL (`calculateSafeLongImageScale` not defined)

- [ ] **Step 3: Implement `calculateSafeLongImageScale` and update `executeLongImageDownload` in `details.js`**

在 `frontend/js/details.js` 中增加导出辅助函数：
```javascript
function calculateSafeLongImageScale(elementHeight, preferredScale = 2, maxDimension = 16384) {
    const height = Math.max(1, Number(elementHeight) || 1000);
    const expectedHeight = height * preferredScale;
    if (expectedHeight <= maxDimension) {
        return preferredScale;
    }
    const safeScale = Math.floor((maxDimension / height) * 100) / 100;
    return Math.max(1.0, safeScale);
}

if (typeof window !== 'undefined') {
    window.calculateSafeLongImageScale = calculateSafeLongImageScale;
}
```
并在 `executeLongImageDownload` 中：
```javascript
        const elHeight = canvasEl.offsetHeight || canvasEl.scrollHeight || 1000;
        const preferredScale = format === 'png' ? 2 : 1.5;
        const safeScale = calculateSafeLongImageScale(elHeight, preferredScale, 16384);
        if (safeScale < preferredScale) {
            console.warn(`[长图导出] 画布高度超出限制，自动下调渲染缩放: ${preferredScale} -> ${safeScale}`);
        }
        const finalCanvas = await html2canvas(canvasEl, {
            useCORS: true,
            scale: safeScale,
            backgroundColor: currentLongImageBgColor || '#ffffff',
            logging: false
        });
        if (!finalCanvas || finalCanvas.width === 0 || finalCanvas.height === 0) {
            throw new Error('Canvas 渲染结果异常，尺寸为 0');
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/long_image_export_resilience.test.js`  
Expected: PASS

- [ ] **Step 5: Syntax and regression checks**

Run: `node --check frontend/js/details.js`  
Run: `node --test frontend/tests/*.test.js`

---

### Task 3: 全局 LocalStorage 安全存储与超额配额熔断

**Files:**
- Modify: `frontend/js/utils.js:10-50`
- Modify: `frontend/js/analysis.js:1590-1605`
- Modify: `frontend/js/brand_context.js:30-100`
- Test: `frontend/tests/local_storage_quota.test.js`

**Interfaces:**
- Consumes: `safeLocalStorageSet(key, value, purgeKeys)`
- Produces: 5MB LocalStorage 满载安全拦截与自动重试，杜绝未捕获异常。

- [ ] **Step 1: Write failing test for safeLocalStorageSet**

```javascript
// frontend/tests/local_storage_quota.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createUtilsContext() {
    const store = new Map();
    let throwOnKey = null;

    const mockLocalStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => {
            if (throwOnKey === k || throwOnKey === '*') {
                const err = new Error('Quota exceeded');
                err.name = 'QuotaExceededError';
                err.code = 22;
                throw err;
            }
            store.set(k, String(v));
        },
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };

    const context = {
        console,
        localStorage: mockLocalStorage,
        window: {}
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);

    const utilsCode = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
    vm.runInContext(utilsCode, context);

    return {
        ctx: context,
        store,
        setThrowOnKey: (k) => { throwOnKey = k; }
    };
}

test('safeLocalStorageSet stores data normally when space is sufficient', () => {
    const { ctx, store } = createUtilsContext();
    assert.strictEqual(typeof ctx.window.safeLocalStorageSet, 'function');

    const success = ctx.window.safeLocalStorageSet('test_key', 'test_value');
    assert.strictEqual(success, true);
    assert.strictEqual(store.get('test_key'), 'test_value');
});

test('safeLocalStorageSet purges purgeKeys and retries successfully on QuotaExceededError', () => {
    const { ctx, store, setThrowOnKey } = createUtilsContext();

    // Populate old cache keys
    store.set('xuanpin_last_result_v26', 'heavy_old_data');
    store.set('temp_preview_cache', 'heavy_preview_data');

    // Simulate quota exceeded until purge happens
    let attempts = 0;
    ctx.localStorage.setItem = (k, v) => {
        attempts++;
        if (attempts === 1 && store.has('xuanpin_last_result_v26')) {
            const err = new Error('Quota exceeded');
            err.name = 'QuotaExceededError';
            throw err;
        }
        store.set(k, String(v));
    };

    const success = ctx.window.safeLocalStorageSet('new_key', 'new_value', ['xuanpin_last_result_v26']);
    assert.strictEqual(success, true);
    assert.strictEqual(store.get('new_key'), 'new_value');
    assert.strictEqual(store.has('xuanpin_last_result_v26'), false, 'Old key should have been purged');
});

test('safeLocalStorageSet returns false without throwing if quota still exceeded after purge', () => {
    const { ctx, setThrowOnKey } = createUtilsContext();
    setThrowOnKey('*');

    assert.doesNotThrow(() => {
        const result = ctx.window.safeLocalStorageSet('huge_key', 'huge_value');
        assert.strictEqual(result, false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/local_storage_quota.test.js`  
Expected: FAIL (`safeLocalStorageSet` not defined)

- [ ] **Step 3: Implement `safeLocalStorageSet` in `frontend/js/utils.js`**

在 `frontend/js/utils.js` 中新增：
```javascript
/**
 * 安全写入 localStorage，捕获并处理 QuotaExceededError，防止超出 5MB 配额崩溃
 * @param {string} key 
 * @param {string} value 
 * @param {string[]} [customPurgeKeys] 可选的淘汰清除键列表
 * @returns {boolean} 是否写入成功
 */
function safeLocalStorageSet(key, value, customPurgeKeys = []) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        const isQuotaError = e && (
            e.name === 'QuotaExceededError' ||
            e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
            e.code === 22 ||
            e.code === 1014
        );
        if (isQuotaError) {
            console.warn(`[Storage] localStorage 配额超限，尝试清理临时缓存: key=${key}`);
            const defaultPurgeKeys = [
                'xuanpin_last_result_v26',
                'xuanpin_last_result_v25',
                'xp_temp_preview',
                'dtc_typography_preview_cache'
            ];
            const allPurgeKeys = [...new Set([...customPurgeKeys, ...defaultPurgeKeys])];
            try {
                for (const pk of allPurgeKeys) {
                    localStorage.removeItem(pk);
                }
                localStorage.setItem(key, value);
                return true;
            } catch (retryErr) {
                console.error(`[Storage] 淘汰旧缓存后仍无法写入 localStorage: key=${key}`, retryErr);
                return false;
            }
        }
        console.warn(`[Storage] localStorage 写入失败: key=${key}`, e);
        return false;
    }
}

if (typeof window !== 'undefined') {
    window.safeLocalStorageSet = safeLocalStorageSet;
}
```
并在 `analysis.js` 与 `brand_context.js` 中关键位置接入 `safeLocalStorageSet`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/local_storage_quota.test.js`  
Expected: PASS

- [ ] **Step 5: Full test suite verification**

Run: `node --check frontend/js/utils.js`  
Run: `node --test frontend/tests/*.test.js`  
Run: `.venv/bin/python -m pytest backend/tests`  
Run: `git diff --check`
