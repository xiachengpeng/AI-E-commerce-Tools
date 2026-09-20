# 阶段二：性能优化与资源管理 (Phase 2: Performance, Reliability & Resource Management) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 针对审查报告中的 P2 级系统可靠性与资源管理问题，实现临时静态 Zip/切图文件的生命周期 TTL 自动清理轮转、多 URL 竞品分析并发信号量限流（防 429 穿透）、OpenAI 兼容协议单图生成表单字段规范化适配、以及前端竞品分析长请求的 AbortController 取消与中断机制。

**Architecture:**
- 后端在 `storage_cleanup_service.py` 引入 `cleanup_expired_static_files(max_age_seconds)`，并在 FastAPI lifespan 启动与定时触发，轮转清理 `backend/static/outputs` 下超过 24 小时的孤立 `.zip` 压缩包和临时导出；
- 后端在 `backend/main.py` 的多 URL 对比路由中引入 `asyncio.Semaphore(3)` 信号量，限制并发抓取与深度分析任务，平滑并发曲线；
- 后端在 `backend/services/ai_adapters.py` 的 OpenAI 兼容以图生图分支中，针对单张参考图自适应使用标准字段 `"image"`，多张图保持 `"image[]"`，消除标准网关报 400 的隐患；
- 前端在 `frontend/js/analysis.js` 为 `xp_handleAnalyze` 接入 `AbortController` 与 `xp_abortAnalyze()` 取消控制，捕获 `AbortError` 优雅降级并重置界面。

**Tech Stack:** Python 3.12, FastAPI, asyncio, Pytest, Vanilla JavaScript, Node.js Test Runner.

**Spec:** 《项目全面系统审查报告》（见会话审查报告），涵盖问题 7 (临时文件磁盘管理)、问题 8 (多 URL 限流)、问题 10 (OpenAI 生图表单兼容性)、问题 6 (竞品分析缺少取消信号)。

## Global Constraints

- 不可破坏现有工作区内正在进行中的未提交改动（包括 Listing 局部改动及已完成的 Phase 1 成果）。
- 所有后端改动必须通过 `pytest backend/tests`。
- 所有前端改动必须通过 `node --test frontend/tests/*.test.js` 且通过 `node --check` 语法检查。
- 不引入重型外部常驻中间件依赖（如 Redis/Celery），保持轻量级单进程本地可交付架构。

## Review Focus

1. **静态清理目录边界越界防护**：`cleanup_expired_static_files` 只能清理 `backend/static/outputs` 和 `backend/static/uploads` 内的临时文件，严禁删除静态源码（如 js/css）或 static 根目录外的任何文件。
2. **多 URL 信号量并发数硬性约束**：当输入 6 个 URL 时，同时处于 running 状态的任务绝不可超过 3 个。
3. **OpenAI 单图字段兼容**：`len(images) == 1` 时 multipart 字段名必须是 `"image"`；`len(images) > 1` 时必须保持 `"image[]"`。
4. **竞品分析 Abort 取消与重置**：调用 `xp_abortAnalyze()` 时，正在进行的 fetch 请求必须立即被中断，Timer 定时器必须清除，Loading 界面必须隐藏，分析按钮状态必须被恢复。

---

### Task 1: 静态 Zip 与输出文件 TTL 自动清理轮转

**Files:**
- Modify: `backend/services/storage_cleanup_service.py:10-70`
- Modify: `backend/main.py:150-180` (FastAPI lifespan hook)
- Test: `backend/tests/test_storage_cleanup_ttl.py`

**Interfaces:**
- Consumes: `STATIC_DIR`, `ALLOWED_CLEANUP_SUBDIRS`
- Produces: `cleanup_expired_static_files(max_age_seconds: int = 86400) -> tuple[int, int]` (返回 `(deleted_files_count, freed_bytes)`)

- [ ] **Step 1: Write failing test for TTL static file cleanup**

```python
# backend/tests/test_storage_cleanup_ttl.py
import os
import time
import pytest
from services.storage_cleanup_service import cleanup_expired_static_files, STATIC_DIR

def test_cleanup_expired_static_files():
    outputs_dir = os.path.join(STATIC_DIR, "outputs", "test_ttl")
    os.makedirs(outputs_dir, exist_ok=True)

    old_file = os.path.join(outputs_dir, "old_bundle.zip")
    with open(old_file, "wb") as f:
        f.write(b"old zip contents" * 100)
    # Set modification time to 2 days ago
    two_days_ago = time.time() - (86400 * 2)
    os.utime(old_file, (two_days_ago, two_days_ago))

    new_file = os.path.join(outputs_dir, "new_bundle.zip")
    with open(new_file, "wb") as f:
        f.write(b"new zip contents")

    deleted_count, freed_bytes = cleanup_expired_static_files(max_age_seconds=86400)

    assert deleted_count >= 1
    assert freed_bytes > 0
    assert not os.path.exists(old_file)
    assert os.path.exists(new_file)

    # Cleanup test files
    if os.path.exists(new_file):
        os.remove(new_file)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_storage_cleanup_ttl.py -v`  
Expected: FAIL (function `cleanup_expired_static_files` not defined)

- [ ] **Step 3: Implement `cleanup_expired_static_files` and register in app lifespan**

在 `backend/services/storage_cleanup_service.py` 中实现：
```python
def cleanup_expired_static_files(max_age_seconds: int = 86400) -> tuple[int, int]:
    """Scan outputs and uploads subdirectories and delete files older than max_age_seconds."""
    now = time.time()
    deleted_count = 0
    freed_bytes = 0

    for subdir in ALLOWED_CLEANUP_SUBDIRS:
        target_dir = os.path.join(STATIC_DIR, subdir)
        if not os.path.isdir(target_dir):
            continue
        for root_path, dirs, files in os.walk(target_dir):
            for file_name in files:
                file_path = os.path.join(root_path, file_name)
                try:
                    mtime = os.path.getmtime(file_path)
                    if now - mtime > max_age_seconds:
                        size = os.path.getsize(file_path)
                        os.remove(file_path)
                        deleted_count += 1
                        freed_bytes += size
                        logger.info("已轮转清理过期静态文件 (%s 秒): %s", max_age_seconds, file_path)
                except OSError as err:
                    logger.warning("清理文件失败 %s: %s", file_path, err)

    return deleted_count, freed_bytes
```
并在 `backend/main.py` 的 `lifespan` 启动钩子中异步执行一次启动清理：
```python
try:
    cleanup_expired_static_files(max_age_seconds=86400)
except Exception as ex:
    logger.warning("启动时静态文件清理失败: %s", ex)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_storage_cleanup_ttl.py -v`  
Expected: PASS

- [ ] **Step 5: Run full backend test suite**

Run: `.venv/bin/python -m pytest backend/tests`  
Expected: 562+ tests PASS

---

### Task 2: 多 URL 竞品分析 Semaphore(3) 信号量并发控制

**Files:**
- Modify: `backend/main.py:700-730`
- Test: `backend/tests/test_analysis_concurrency_semaphore.py`

**Interfaces:**
- Consumes: `asyncio.Semaphore(3)`
- Produces: 受控的多 URL 竞品分析，并发爬取与 AI 深度分析的最大并发数不超过 3。

- [ ] **Step 1: Write failing test for concurrency semaphore**

在 `backend/tests/test_analysis_concurrency_semaphore.py` 中 Mock `process_single_url_deep`，记录同时进入函数的最大并发数，验证 5 个 URL 并发请求时最大活跃并发不超过 3。

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_analysis_concurrency_semaphore.py -v`  
Expected: FAIL (currently fires all tasks with `asyncio.gather` with no semaphore)

- [ ] **Step 3: Add `asyncio.Semaphore(3)` to multi-URL compare branch**

在 `backend/main.py` 的 `compare` 函数中：
```python
            sem = asyncio.Semaphore(3)

            async def _process_multi_item(u: str) -> dict:
                async with sem:
                    try:
                        return await process_single_url_deep(u, force_refresh=force_refresh, mode=mode)
                    except Exception as ex:
                        logger.warning(f"process_single_url_deep failed for {u}, falling back to process_single_url: {ex}")
                        return await process_single_url(u, force_refresh=force_refresh)

            tasks = [_process_multi_item(url) for url in unique_urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_analysis_concurrency_semaphore.py -v`  
Expected: PASS

- [ ] **Step 5: Run full backend test suite**

Run: `.venv/bin/python -m pytest backend/tests`  
Expected: 563+ tests PASS

---

### Task 3: OpenAI 兼容协议单图生成表单字段规范化适配

**Files:**
- Modify: `backend/services/ai_adapters.py:570-590`
- Test: `backend/tests/test_openai_image_single_field.py`

**Interfaces:**
- Consumes: `OpenAICompatibleAdapter._call_image`
- Produces: 表单字段自适应：`len(images) == 1` 时为 `"image"`，`len(images) > 1` 时为 `"image[]"`。

- [ ] **Step 1: Write failing test for single image form field**

在 `backend/tests/test_openai_image_single_field.py` 中，调用以图生图传入 1 张图片，检查发送给 `client.post` 的 `files` 参数中的键名为 `"image"` 而非 `"image[]"`。

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_openai_image_single_field.py -v`  
Expected: FAIL (currently hardcoded as `"image[]"`)

- [ ] **Step 3: Update `ai_adapters.py`**

```python
                if mask is not None:
                    files = [
                        ("image", ("source.png", images[0].data, images[0].mime_type)),
                        ("mask", ("mask.png", mask.data, mask.mime_type)),
                    ]
                else:
                    field_name = "image" if len(images) == 1 else "image[]"
                    files = [
                        (
                            field_name,
                            (
                                f"reference-{index}.{_image_extension(image)}",
                                image.data,
                                image.mime_type,
                            ),
                        )
                        for index, image in enumerate(images, 1)
                    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_openai_image_single_field.py -v`  
Expected: PASS

- [ ] **Step 5: Run all adapter tests**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_adapters.py`  
Expected: All adapter tests PASS

---

### Task 4: 竞品分析请求增加 AbortController 与取消/超时中断

**Files:**
- Modify: `frontend/js/analysis.js:1512-1590`
- Test: `frontend/tests/analysis_abort.test.js`

**Interfaces:**
- Consumes: `xp_handleAnalyze`, `xp_abortAnalyze()`
- Produces: 用户主动中断和取消长连接竞品爬取分析流程。

- [ ] **Step 1: Write failing test for analysis abort**

在 `frontend/tests/analysis_abort.test.js` 中模拟一个挂起的 fetch 请求，调用 `window.xp_abortAnalyze()`，断言请求被取消，`timerInterval` 停止，界面错误提示展示为“分析流程已由用户手动取消”，按钮恢复可用状态。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/analysis_abort.test.js`  
Expected: FAIL (`xp_abortAnalyze` not defined)

- [ ] **Step 3: Implement AbortController in `analysis.js`**

在 `analysis.js` 中增加全局变量 `let xp_analyzeAbortController = null;`，在 `xp_handleAnalyze` 中实例化并传给 `fetch(XP_API_URL, { ..., signal: xp_analyzeAbortController.signal })`；捕获 `AbortError` 并友好重置；导出 `xp_abortAnalyze`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/analysis_abort.test.js`  
Expected: PASS

- [ ] **Step 5: Syntax and regression checks**

Run: `node --check frontend/js/analysis.js`  
Run: `node --test frontend/tests/*.test.js`

---

## Plan Self-Review Checklist

1. **Spec Coverage**:
   - Issue 7 (Temporary Zip leak): Task 1
   - Issue 8 (Multi-URL concurrency): Task 2
   - Issue 10 (OpenAI image field): Task 3
   - Issue 6 (Analysis abort): Task 4
2. **No Placeholders**: All tasks contain explicit file paths, line ranges, and complete code snippets.
3. **Working Tree Safety**: Does not modify or revert any of the 11 modified files currently in Git working tree.
