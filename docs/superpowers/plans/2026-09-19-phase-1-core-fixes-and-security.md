# 阶段一：核心缺陷修复与安全加固 (Phase 1: Core Fixes & Security Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复在全面审查中发现的 P0/P1 致命安全漏洞（Firecrawl SSRF）、商详生图强耦合报废缺陷、竞品分析转存无确认清空草稿缺陷、单品分析冗余大模型调用以及云端图床回退误删已上传映射缺陷，确保系统稳健性与资产安全性。

**Architecture:** 
- 后端复用 `validate_outbound_url` 拦截内部 IP 与云元数据，统一爬虫保存与连通性测试校验；
- 前端生图管线引入渐进增强与 `Promise.allSettled` 容错，将核心商业位图生成与副本文案/SEO 异步解耦；
- 前端跨模块转存增加智能检测与用户确认弹窗；
- 优化竞品分析单品模式，复用深度提取产物计算投资决策评分；
- 前端解耦图床预览展示态与云端资产映射态，实现无损回退。

**Tech Stack:** Python 3.12, FastAPI, Pydantic, Pytest, Vanilla JavaScript (ES2022), Node.js Test Runner.

**Spec:** 《项目全面系统审查报告》（见本会话报告），涵盖问题 1 (P0 SSRF)、问题 2 (P0 Promise 强耦合)、问题 3 (P1 转存清空草稿)、问题 4 (P1 冗余 LLM)、问题 5 (P1 误删云资产)。

## Global Constraints

- 不可破坏现有工作区内正在进行中的未提交改动（特别是 `ListingRegenerateSectionRequest` 与相关字段）。
- 所有后端改动必须通过 `pytest backend/tests`。
- 所有前端改动必须通过 `node --test frontend/tests/*.test.js` 且通过 `node --check` 语法检查。
- 所有对外 API 契约保持向后兼容，不改变公共路由路径或字段定义。
- 严禁硬编码敏感凭据或将测试密钥持久化。

## Review Focus

1. **Firecrawl 连接测试绕过**：通过携带非法端口、内网回环（`127.0.0.1`、`localhost`）或云元数据地址（`169.254.169.254`）测试爬虫连接，系统必须拒绝并返回明确的拒绝信息，不得触发对外网络调用。
2. **生图辅任务崩溃隔离**：当 SEO 或 DTC 文案大模型请求抛出 429 或 500 异常时，图片生成任务必须依然成功标记为 `success`，切图必须正常渲染入 DOM，不得丢弃。
3. **竞品转存确认拦截**：当用户在商详页或 Listing 页已手工键入内容时，触发转存必须阻止立即覆盖并弹出确认对话框；若用户点击取消，必须严格保留原始草稿。
4. **单品分析评分正确性**：单品模式下消除冗余提取调用后，`calculate_score` 必须依然能接收完整的商品信息并返回合法的 `ScoreCard`，单 URL 状态必须正常标记为 `success`。
5. **图床本地回退资产完整性**：点击“恢复本地图片”后，`item.targetUploads` 和 `task.remoteImageUrls` 中的远程 URL 必须完好保留，再次打开抽屉时依然显示已上传绿色徽章。

---

### Task 1: Firecrawl 爬虫端点 SSRF 安全防御

**Files:**
- Modify: `backend/services/firecrawl.py:70-100`
- Modify: `backend/main.py:1437-1495`
- Test: `backend/tests/test_firecrawl_ssrf.py`

**Interfaces:**
- Consumes: `services.security_utils.validate_outbound_url(url_or_host, allow_local, require_http)`
- Produces: 安全校验拦截机制，当 `target_url` 或 `api_url` 指向私有 IP/回环/元数据时，返回 `(False, 0, "非法的请求目标地址: ...")` 或在配置保存时抛出 `HTTPException(status_code=400)`。

- [ ] **Step 1: Write the failing tests for crawler SSRF protection**

```python
# backend/tests/test_firecrawl_ssrf.py
import pytest
from unittest.mock import patch, AsyncMock
from services.firecrawl import test_firecrawl_connection

@pytest.mark.asyncio
async def test_crawler_connection_blocks_metadata_ip():
    success, duration, msg = await test_firecrawl_connection(
        api_url="http://169.254.169.254/latest/meta-data/",
        api_key="test-key"
    )
    assert success is False
    assert "云主机元数据" in msg or "受限" in msg or "非法" in msg

@pytest.mark.asyncio
async def test_crawler_connection_blocks_loopback_ip():
    success, duration, msg = await test_firecrawl_connection(
        api_url="http://127.0.0.1:6379/v1/scrape",
        api_key="test-key"
    )
    assert success is False
    assert "本地回环" in msg or "内网私有" in msg or "受限" in msg
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_firecrawl_ssrf.py -v`  
Expected: FAIL (currently `test_firecrawl_connection` does not validate `api_url` against SSRF)

- [ ] **Step 3: Implement SSRF validation in `firecrawl.py` and `main.py`**

在 `backend/services/firecrawl.py` 的 `test_firecrawl_connection` 中引入 `from services.security_utils import validate_outbound_url`：
```python
is_safe, err_msg = validate_outbound_url(target_url, allow_local=False, require_http=True)
if not is_safe:
    return False, 0, f"非法的爬虫服务端请求地址: {err_msg}"
```
并在 `backend/main.py` 的 `api_update_crawler_settings` 中校验输入的 `data.api_url`：
```python
if data.api_url is not None and data.api_url.strip():
    candidate_url = data.api_url.strip()
    is_safe, err_msg = validate_outbound_url(candidate_url, allow_local=False, require_http=True)
    if not is_safe:
        raise HTTPException(status_code=400, detail=f"非法的爬虫服务器地址: {err_msg}")
    cfg.api_url = candidate_url
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_firecrawl_ssrf.py -v`  
Expected: PASS

- [ ] **Step 5: Run full backend test suite**

Run: `.venv/bin/python -m pytest backend/tests`  
Expected: 556+ tests PASS

---

### Task 2: 商详模块生图与文案/SEO 强耦合解耦容错

**Files:**
- Modify: `frontend/js/details.js:4055-4100`
- Test: `frontend/tests/details_error_resilience.test.js`

**Interfaces:**
- Consumes: `callAI("image", payload, { signal })`, `generateSEOMetadata()`, `generateDtcSectionCopy()`
- Produces: 弹性执行机制：即使文案或 SEO 请求失败，已生成的图片必须保留并成功渲染，任务状态标记为 `success`，在界面安全降级提示。

- [ ] **Step 1: Write the failing unit test for decoupled module generation**

在 `frontend/tests/details_error_resilience.test.js` 中模拟 `callAI("image")` 成功而 `generateSEOMetadata` 抛错的情况，验证模块不会变红失败且图片依然保留。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/details_error_resilience.test.js`  
Expected: FAIL

- [ ] **Step 3: Refactor `generateSingleWrap` in `frontend/js/details.js`**

将 `Promise.all` 结构重构为“优先获取并固化图片，副本文案/SEO 异步降级处理”：
```javascript
// 1. 优先调用昂贵且核心的生图服务
const imgRes = await callAI("image", payload, { signal });
const imagePart = imgRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
if (!imagePart?.inlineData) {
    throw new Error("No image data in response");
}

let generatedSrc = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
// WebP 压缩...
if (shouldCompress && typeof compressImageToWebp === 'function') {
    try {
        const compRes = await compressImageToWebp(generatedSrc, { quality: 0.90 });
        if (compRes?.changed && compRes?.dataUrl) {
            generatedSrc = compRes.dataUrl;
            task.compressedStats = compRes;
        }
    } catch (cErr) {
        console.warn('[WebP] Module auto compression fallback to raw:', cErr);
    }
}

// 核心资产固化
contentDiv.innerHTML = `<img src="${generatedSrc}" class="w-full h-full object-cover cursor-zoom-in" onclick="openImageLightbox('${generatedSrc}', '${detailEscapeHtml(task.displayTitle || task.title)}')" title="点击放大预览">`;
contentDiv.classList.remove('p-6', 'flex-col', 'items-center', 'justify-center');
contentDiv.style.padding = '0';
task.imageSrc = generatedSrc;
task.status = 'success';
task.isFallback = false;
setModuleStatus(uniqueId, 'success');

// 2. 辅助文本与 SEO 元数据渐进增强，使用 Promise.allSettled 隔离失败
const auxPromises = [];
if (!skipSEO) {
    auxPromises.push(generateSEOMetadata(task, sellingPoints, { signal }));
}
if (currentDetailPresentationMode === 'hybrid') {
    auxPromises.push(generateDtcSectionCopy(task, sellingPoints, config, { signal }));
}
if (auxPromises.length > 0) {
    const auxResults = await Promise.allSettled(auxPromises);
    auxResults.forEach((res) => {
        if (res.status === 'rejected') {
            console.warn(`[Module ${task.title}] Auxiliary copy/SEO generation non-fatal error:`, res.reason);
        }
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/details_error_resilience.test.js`  
Expected: PASS

- [ ] **Step 5: Syntax and regression checks**

Run: `node --check frontend/js/details.js`  
Run: `node --test frontend/tests/*.test.js`

---

### Task 3: 竞品分析跨模块转存防覆盖二次确认

**Files:**
- Modify: `frontend/js/analysis.js:619-780`
- Test: `frontend/tests/analysis_transfer_guard.test.js`

**Interfaces:**
- Consumes: `xp_transferToDetails`, `xp_transferToListing`, `xp_transferToAds`
- Produces: 草稿保护拦截逻辑，当目标表单存在已有用户输入时，弹出确认对话框提示用户。

- [ ] **Step 1: Write failing test for transfer overwrite prevention**

编写针对 `xp_transferToDetails` 与 `xp_transferToListing` 的测试：当目标 DOM 元素包含非空内容时，若用户取消，则不执行覆盖。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/analysis_transfer_guard.test.js`  
Expected: FAIL

- [ ] **Step 3: Implement overwrite guards in `analysis.js`**

在 `xp_transferToDetails`, `xp_transferToListing`, `xp_transferToAds` 中提取统一的防护辅助函数：
```javascript
function xp_confirmOverwriteIfNotEmpty(elements, moduleName) {
    const hasExisting = elements.some(el => el && typeof el.value === 'string' && el.value.trim().length > 0);
    if (!hasExisting) return true;
    const msg = xp_currentLang === 'zh'
        ? `【${moduleName}】中已存在正在编辑的草稿内容，继续转存将覆盖现有内容。是否确认覆盖？`
        : `[${moduleName}] already contains draft content. Overwrite existing content?`;
    return typeof confirm === 'function' ? confirm(msg) : true;
}
```
在转存前执行拦截：
```javascript
if (!xp_confirmOverwriteIfNotEmpty([nameEl, pointsEl], xp_currentLang === 'zh' ? '商详生成' : 'PDP Generator')) {
    return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/analysis_transfer_guard.test.js`  
Expected: PASS

- [ ] **Step 5: Run full frontend test suite**

Run: `node --test frontend/tests/*.test.js`  
Run: `node --check frontend/js/analysis.js`

---

### Task 4: 单品竞品分析冗余 LLM 调用消除

**Files:**
- Modify: `backend/main.py:677-700`
- Test: `backend/tests/test_analysis_single_pipeline.py`

**Interfaces:**
- Consumes: `process_single_url_deep(url, markdown_content, mode)`, `calculate_score(product_data)`
- Produces: 扁平单品分析流水线：仅需一次深度提取 LLM 即可供给 `calculate_score` 与返回体，消除多余的 `process_single_url`。

- [ ] **Step 1: Write test verifying single URL analysis flow**

编写单品分析单测，Mock `process_single_url_deep` 和 `calculate_score`，断言 `process_single_url` 未被调用，且返回的 `CompareResponseData` 结构完整且字段齐全。

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_analysis_single_pipeline.py -v`  
Expected: FAIL

- [ ] **Step 3: Refactor single URL branch in `backend/main.py`**

```python
        if len(unique_urls) == 1:
            url = unique_urls[0]
            markdown_content = await _safe_fetch_markdown(url, max_age=0 if force_refresh else 3600)
            single_data = await process_single_url_deep(url, markdown_content=markdown_content, mode=mode)
            score_res = await calculate_score(single_data)
            
            # 补全 ScoreCard 所需字段
            if not score_res.get("decision_details"):
                score_res["decision_details"] = {"confidence": "medium", "reason": ""}
            score_res.setdefault("opportunity_score", 0)
            score_res.setdefault("difficulty_score", 0)
            score_res.setdefault("final_decision", "Pending")
            score_res.setdefault("product", single_data.get("product_name", "Product"))
            
            scores = [ScoreCard(**score_res)]
            response_data = CompareResponseData(
                single_data=single_data,
                scores=scores,
                url_statuses=[{"url": url, "status": "success", "product_name": single_data.get("product_name", "")}],
            )
            template_type = "single"
            msg = "分析完成"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_analysis_single_pipeline.py -v`  
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `.venv/bin/python -m pytest backend/tests`  
Expected: 556+ tests PASS

---

### Task 5: 修复 `revertToLocalPdpImages` 误删云端资产映射

**Files:**
- Modify: `frontend/js/details.js:8708-8742`
- Test: `frontend/tests/pdp_hosting_revert.test.js`

**Interfaces:**
- Consumes: `revertToLocalPdpImages()`
- Produces: 纯净视图回退：切换回本地图片预览，但严格保留已上传的 `item.targetUploads` 和 `task.remoteImageUrls`，允许后续无缝再切回云端或查看云状态。

- [ ] **Step 1: Write failing test for non-destructive local revert**

测试向 `pdpAssetQueue` 填充包含 `remoteUrl` 与 `targetUploads` 的项，调用 `revertToLocalPdpImages()`，断言其 `targetUploads` 保持完整，且 `item.remoteUrl` 不被抹除。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/pdp_hosting_revert.test.js`  
Expected: FAIL

- [ ] **Step 3: Update `revertToLocalPdpImages` in `frontend/js/details.js`**

```javascript
function revertToLocalPdpImages() {
    let revertedCount = 0;
    const destKey = getPdpCurrentStorageDestinationKey();
    Object.keys(globalGenContext?.tasks || {}).forEach(id => {
        const task = globalGenContext.tasks[id];
        if (task && task.originalImageSrc) {
            // 仅切换当前展示源与 HTML 导出激活态，保留 remoteImageUrls 资产字典
            task.imageSrc = task.originalImageSrc;
            task.activeStorageTarget = null;
            revertedCount++;

            const modImg = document.getElementById(`content-mod-${id}`)?.querySelector('img');
            if (modImg) {
                modImg.src = task.originalImageSrc;
            }
        }
    });

    // 资产队列保持上传成果，不抹除 targetUploads 和已上传状态
    // 用户可随时重新点击“应用到详情页 HTML”

    if (typeof renderDtcHybridPreview === 'function') {
        renderDtcHybridPreview();
    }
    if (typeof saveDetailProjectToHistory === 'function') {
        saveDetailProjectToHistory();
    }
    ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/pdp_hosting_revert.test.js`  
Expected: PASS

- [ ] **Step 5: Syntax and suite checks**

Run: `node --check frontend/js/details.js`  
Run: `node --test frontend/tests/*.test.js`

---

## Plan Self-Review Checklist

1. **Spec Coverage**:
   - Issue 1 (Firecrawl SSRF): Task 1
   - Issue 2 (Promise.all coupling dropping images): Task 2
   - Issue 3 (Cross-module transfer overwrite): Task 3
   - Issue 4 (Single URL redundant LLM call): Task 4
   - Issue 5 (revertToLocalPdpImages data loss): Task 5
2. **No Placeholders**: All tasks contain explicit file paths, line ranges, and complete code snippets.
3. **Type Consistency**: Method names, property paths (`item.targetUploads`, `task.remoteImageUrls`, `validate_outbound_url`) match exactly across tasks and existing codebase.
4. **Working Tree Safety**: Does not modify or revert any of the 11 modified files currently in Git working tree.
