# OpenAI Compatible 图片生成模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每条 OpenAI Compatible 图片线路增加持久化的文生图/图生图模式，并分别路由到 `/v1/images/generations` JSON 与 `/v1/images/edits` multipart 接口。

**Architecture:** 模式存放在 `AIProviderConfig` 并进入不可变的 `ProviderSnapshot`。OpenAI 适配器按模式选择请求编码和端点，统一验证输入/输出图片并保持现有 Gemini 风格响应；设置页只对支持图片的 OpenAI Compatible 线路展示选项。连接测试复用同一适配器路径，图生图测试由后端提供最小 PNG 参考图。

**Tech Stack:** Python 3.14、FastAPI、SQLAlchemy、Pydantic、httpx、Pillow、pytest、vanilla JavaScript、Node test runner。

## Global Constraints

- `image_generation_mode` 只允许 `text_to_image` 或 `image_to_image`。
- 旧线路和新线路默认 `image_to_image`，保存后下一次请求立即生效。
- 文生图只访问 `/v1/images/generations`，不发送参考图。
- 图生图只访问 `/v1/images/edits`；缺图时在外部 HTTP 请求前失败，不自动改走文生图。
- 详情页沿用本地 HTML/CSS 降级，不新增第二次图片 AI 请求；SEO 文本调用保持独立。
- Google/Vertex、旧历史和标准化前端响应保持兼容。
- URL 图片响应必须阻止 SSRF、限制重定向/超时/大小，并验证真实图片内容。
- 不记录 API Key、Authorization、图片内容、敏感 URL、完整提示词或提供商敏感响应。
- 保留用户未跟踪的 `json.txt`，不得读取、修改、暂存或提交。

---

## File Structure

- `backend/db.py`: 新字段与幂等 SQLite 迁移。
- `backend/models/settings.py`: 设置 API 枚举字段。
- `backend/services/ai_config_service.py`: 默认值、校验、快照和运行时版本变化。
- `backend/services/ai_adapters.py`: 文生图 JSON、图生图 multipart、输入验证与输出归一化。
- `backend/services/image_response_fetcher.py`: 受限公网 URL 图片下载，隔离 SSRF 与响应限制。
- `backend/services/ai_router.py`: 图片模式与接口类型日志上下文。
- `backend/services/app_log_service.py`: 安全日志字段白名单和输出字段。
- `backend/main.py`: 设置序列化、连接测试快照和图生图测试图片。
- `frontend/index.html`: 图片生成方式控件。
- `frontend/js/settings.js`: 默认值、显隐、保存、测试和线路徽标。
- `frontend/css/settings.css`: 模式控件和说明样式。
- `backend/tests/test_startup_regressions.py`: 旧表迁移。
- `backend/tests/test_ai_config_service.py`: 配置生命周期。
- `backend/tests/test_ai_adapters.py`: 两种请求模式和响应归一化。
- `backend/tests/test_image_response_fetcher.py`: URL 下载安全边界。
- `backend/tests/test_ai_router.py`: 日志上下文。
- `backend/tests/test_settings_api.py`: 设置 API 与连接测试。
- `backend/tests/test_app_log_service.py`: 新日志字段脱敏。
- `frontend/tests/settings.test.js`: 表单 payload 与显隐。
- `frontend/tests/settings_provider_cards.test.js`: 模式徽标。
- `AGENTS.md`: 同步新的图片路由约束。

---

### Task 1: 持久化字段和配置快照

**Files:**
- Modify: `backend/db.py`
- Modify: `backend/models/settings.py`
- Modify: `backend/services/ai_config_service.py`
- Test: `backend/tests/test_startup_regressions.py`
- Test: `backend/tests/test_ai_config_service.py`

**Interfaces:**
- Produces: `AIProviderConfig.image_generation_mode: str`
- Produces: `ProviderSnapshot.image_generation_mode: str`
- Produces: `IMAGE_GENERATION_MODES = {"text_to_image", "image_to_image"}`

- [ ] **Step 1: 写旧数据库迁移失败测试**

创建只有旧列的 `ai_provider_configs` 表，调用 `migrate_ai_settings_tables()` 两次，并断言：

```python
columns = {item[1] for item in connection.exec_driver_sql(
    "PRAGMA table_info(ai_provider_configs)"
)}
assert "image_generation_mode" in columns
mode = connection.exec_driver_sql(
    "SELECT image_generation_mode FROM ai_provider_configs WHERE id = 1"
).scalar_one()
assert mode == "image_to_image"
```

- [ ] **Step 2: 运行迁移测试并确认因字段缺失而失败**

Run: `.venv/bin/python -m pytest backend/tests/test_startup_regressions.py -k image_generation_mode -v`

Expected: FAIL，因为迁移尚未增加 `image_generation_mode`。

- [ ] **Step 3: 实现模型字段与幂等迁移**

在 `AIProviderConfig` 添加：

```python
image_generation_mode = Column(
    String(32), nullable=False, default="image_to_image"
)
```

在 SQLite 迁移中添加：

```python
if "image_generation_mode" not in existing_columns:
    connection.execute(text(
        "ALTER TABLE ai_provider_configs "
        "ADD COLUMN image_generation_mode VARCHAR(32) "
        "NOT NULL DEFAULT 'image_to_image'"
    ))
```

- [ ] **Step 4: 写配置创建、非法值、更新版本和快照失败测试**

覆盖：默认值为 `image_to_image`、显式保存 `text_to_image`、非法字符串被拒绝、模式变化清除连接状态并递增版本、`get_snapshot()` 携带所选模式。

- [ ] **Step 5: 运行配置测试并确认因字段未贯通而失败**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_config_service.py -k image_generation_mode -v`

Expected: FAIL，缺少验证、默认值或 Snapshot 字段。

- [ ] **Step 6: 最小实现配置字段贯通**

将字段加入 `AIProviderWrite`、`AIProviderRead`、`PROVIDER_FIELDS`、`STRING_FIELDS`、`PROVIDER_DEFAULTS`、`CONNECTION_TEST_RELEVANT_FIELDS` 和 `ProviderSnapshot`。验证逻辑：

```python
mode = values.get("image_generation_mode") or "image_to_image"
if mode not in IMAGE_GENERATION_MODES:
    raise ValueError("图片生成方式无效")
values["image_generation_mode"] = mode
```

所有 Snapshot 构造点显式传入该字段。

- [ ] **Step 7: 运行 Task 1 测试并提交**

Run: `.venv/bin/python -m pytest backend/tests/test_startup_regressions.py backend/tests/test_ai_config_service.py -q`

Commit:

```bash
git add backend/db.py backend/models/settings.py backend/services/ai_config_service.py backend/tests/test_startup_regressions.py backend/tests/test_ai_config_service.py
git commit -m "feat: persist OpenAI image generation mode"
```

---

### Task 2: 设置 API 和连接测试上下文

**Files:**
- Modify: `backend/main.py`
- Test: `backend/tests/test_settings_api.py`

**Interfaces:**
- Consumes: `ProviderSnapshot.image_generation_mode`
- Produces: provider JSON field `image_generation_mode`
- Produces: `_connection_payload(capability, image_generation_mode)`

- [ ] **Step 1: 写设置 API 失败测试**

断言创建、读取、更新和草稿测试都保留模式：

```python
response = client.post("/api/settings/ai/providers", json={
    **openai_provider_payload,
    "image_generation_mode": "text_to_image",
})
assert response.json()["image_generation_mode"] == "text_to_image"
```

同时断言缺省 payload 返回 `image_to_image`。

- [ ] **Step 2: 运行测试并确认响应字段缺失**

Run: `.venv/bin/python -m pytest backend/tests/test_settings_api.py -k image_generation_mode -v`

Expected: FAIL，序列化或连接 Snapshot 缺少模式。

- [ ] **Step 3: 实现 API 序列化和 Snapshot 构造**

`serialize_provider()` 返回规范化字段；`_connection_test_snapshot()` 从验证后的 values 传入模式。

- [ ] **Step 4: 写图生图连接测试 payload 失败测试**

替换适配器为捕获 payload 的测试双，断言图生图测试包含一个可由 `validate_image_payload()` 验证的 PNG `inlineData`，文生图测试不包含图片。

- [ ] **Step 5: 运行连接测试并确认缺少测试图**

Run: `.venv/bin/python -m pytest backend/tests/test_settings_api.py -k 'connection and image_generation_mode' -v`

Expected: FAIL，当前连接测试只有文本 part。

- [ ] **Step 6: 实现内置最小 PNG 连接 payload**

新增模块级 Base64 常量（固定 1×1 PNG），并使：

```python
def _connection_payload(capability, image_generation_mode="text_to_image"):
    parts = [{"text": prompt}]
    if capability == "image" and image_generation_mode == "image_to_image":
        parts.append({"inlineData": {
            "mimeType": "image/png",
            "data": CONNECTION_TEST_PNG_BASE64,
        }})
```

连接测试将 Snapshot 的模式传入 payload 构造器。

- [ ] **Step 7: 运行 Task 2 测试并提交**

Run: `.venv/bin/python -m pytest backend/tests/test_settings_api.py -q`

Commit:

```bash
git add backend/main.py backend/tests/test_settings_api.py
git commit -m "feat: expose image generation mode settings"
```

---

### Task 3: 安全下载 URL 图片响应

**Files:**
- Create: `backend/services/image_response_fetcher.py`
- Create: `backend/tests/test_image_response_fetcher.py`

**Interfaces:**
- Produces: `async fetch_public_image(url: str, client, *, timeout_seconds: int, max_redirects: int = 3, max_bytes: int = MAX_IMAGE_BYTES, resolver=resolve_host_addresses) -> ValidatedImage`

- [ ] **Step 1: 写 URL 安全边界失败测试**

覆盖字面 IP 与 DNS 解析结果中的环回、RFC1918、链路本地、保留地址；每次重定向重新校验；超出重定向、Content-Length、流式读取大小、超时和伪造 MIME 均失败。公网测试使用注入的解析器/transport，不访问真实互联网。

代表性断言：

```python
with pytest.raises(ValueError, match="公网"):
    await fetch_public_image(
        "http://127.0.0.1/private.png",
        client,
        timeout_seconds=5,
    )
```

- [ ] **Step 2: 运行测试并确认模块不存在**

Run: `.venv/bin/python -m pytest backend/tests/test_image_response_fetcher.py -v`

Expected: ERROR/FAIL，`image_response_fetcher` 尚不存在。

- [ ] **Step 3: 实现受限下载器**

要求：

- 只允许 `http`/`https` 且禁止 URL 用户名密码。
- 解析所有地址并要求每个地址都是公网地址。
- `follow_redirects=False`，最多手动跟随 3 次并重新验证目标。
- 流式读取，超过 `MAX_IMAGE_BYTES` 立即中止。
- Content-Type 必须为 `image/*`，最终调用 `validate_image_payload(bytes, content_type)`。
- 所有对外错误使用不包含完整敏感 URL 的稳定中文消息。

- [ ] **Step 4: 运行下载器测试并提交**

Run: `.venv/bin/python -m pytest backend/tests/test_image_response_fetcher.py -q`

Commit:

```bash
git add backend/services/image_response_fetcher.py backend/tests/test_image_response_fetcher.py
git commit -m "feat: safely fetch provider image responses"
```

---

### Task 4: OpenAI Compatible 两种图片接口

**Files:**
- Modify: `backend/services/ai_adapters.py`
- Test: `backend/tests/test_ai_adapters.py`

**Interfaces:**
- Consumes: `ProviderSnapshot.image_generation_mode`
- Consumes: `fetch_public_image(...)`
- Produces: `extract_validated_inline_images(payload) -> list[ValidatedImage]`
- Produces: `async normalize_openai_image_item(item, snapshot, client) -> dict`

- [ ] **Step 1: 写文生图请求失败测试**

给 payload 同时放提示词和参考图，Snapshot 选择 `text_to_image`，断言请求为：

```python
assert request.args[0] == "https://api.example.com/v1/images/generations"
assert request.kwargs["json"] == {
    "model": "test-model",
    "prompt": "Redraw",
    "response_format": "b64_json",
}
assert "files" not in request.kwargs
```

- [ ] **Step 2: 写图生图 multipart 与缺图零请求失败测试**

断言 `/v1/images/edits` 使用 `data` 和重复 `image[]` files；一张和多张图顺序不变。缺图时：

```python
with pytest.raises(ValueError, match="缺少参考图"):
    await adapter.generate(image_to_image_snapshot, text_only_payload)
transport.post.assert_not_awaited()
```

- [ ] **Step 3: 运行请求测试并确认仍固定 generations JSON**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_adapters.py -k 'openai and image' -v`

Expected: FAIL，当前实现未按模式分支且未使用 multipart。

- [ ] **Step 4: 实现输入验证和两种请求分支**

- `text_to_image` 忽略 payload 图片，仅发送 JSON generations。
- `image_to_image` 先通过 `validate_image_payload()` 验证所有 inlineData，再组装：

```python
files = [
    ("image[]", (f"reference-{index}.{extension}", image.data, image.mime_type))
    for index, image in enumerate(images, 1)
]
data = {
    "model": snapshot.model,
    "prompt": extract_text_prompt(payload),
    "response_format": "b64_json",
}
```

将 `1:1` 映射为 `1024x1024`，横向比例映射为 `1536x1024`，纵向比例映射为 `1024x1536`，作为 `size` 表单字段；无法解析的比例不发送 size。

- [ ] **Step 5: 写 Base64/URL 响应失败测试**

断言有效 `b64_json` 被验证并保留真实 MIME；`url` 调用安全下载器；空 data、无效 Base64、伪造图片和非公网 URL 返回错误。

- [ ] **Step 6: 实现统一响应归一化**

Base64 分支根据响应 `mime_type` 或实际图片验证结果归一化；URL 分支调用 `fetch_public_image()`。最终只返回通过 `validate_image_payload()` 的图片。

- [ ] **Step 7: 运行 Task 4 测试并提交**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_adapters.py -q`

Commit:

```bash
git add backend/services/ai_adapters.py backend/tests/test_ai_adapters.py
git commit -m "feat: route OpenAI image generation modes"
```

---

### Task 5: 安全运行日志上下文

**Files:**
- Modify: `backend/services/app_log_service.py`
- Modify: `backend/services/ai_router.py`
- Test: `backend/tests/test_app_log_service.py`
- Test: `backend/tests/test_ai_router.py`

**Interfaces:**
- Produces: log fields `image_generation_mode` and `image_endpoint`

- [ ] **Step 1: 写图片日志字段失败测试**

构造 image Snapshot 并运行 router，断言开始、成功、重试和失败事件带有：

```python
assert entry["image_generation_mode"] == "image_to_image"
assert entry["image_endpoint"] == "images.edits"
```

文本与 Google/Vertex 事件对应字段为 `None`。注入含 URL 查询参数的恶意值时不能泄漏。

- [ ] **Step 2: 运行测试并确认字段不存在**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_router.py backend/tests/test_app_log_service.py -k 'image_generation_mode or image_endpoint' -v`

Expected: FAIL，日志 schema 尚未支持字段。

- [ ] **Step 3: 实现安全日志字段**

扩展 `AppLogService.emit()` 的可选参数和安全元数据白名单；Router 仅从已验证枚举派生：

```python
mode = snapshot.image_generation_mode if capability == "image" and snapshot.protocol == "openai_compatible" else None
endpoint = {"text_to_image": "images.generations", "image_to_image": "images.edits"}.get(mode)
```

把两个值传给同一请求生命周期的所有事件。

- [ ] **Step 4: 运行 Task 5 测试并提交**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_router.py backend/tests/test_app_log_service.py -q`

Commit:

```bash
git add backend/services/app_log_service.py backend/services/ai_router.py backend/tests/test_app_log_service.py backend/tests/test_ai_router.py
git commit -m "feat: log OpenAI image endpoint mode"
```

---

### Task 6: 设置页模式控件与线路徽标

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/settings.js`
- Modify: `frontend/css/settings.css`
- Test: `frontend/tests/settings.test.js`
- Test: `frontend/tests/settings_provider_cards.test.js`

**Interfaces:**
- Consumes/produces provider JSON `image_generation_mode`
- Produces DOM controls `settingsImageGenerationModeFields` and `settingsImageGenerationMode`

- [ ] **Step 1: 写表单默认值、显隐和 payload 失败测试**

覆盖：新建默认 `image_to_image`；旧 provider 缺字段默认同值；只有 OpenAI Compatible 且勾选图片能力时显示；协议切换恢复选择；payload 包含规范化模式。

代表性断言：

```javascript
assert.equal(context.providerFormValues().image_generation_mode, "image_to_image");
assert.equal(elements.settingsImageGenerationModeFields.classList.contains("hidden"), false);
```

- [ ] **Step 2: 写线路卡片徽标失败测试**

OpenAI Compatible 图片线路显示“图生图”或“文生图”；Google/Vertex 和纯文本线路不显示模式徽标。

- [ ] **Step 3: 运行前端测试并确认控件/字段缺失**

Run: `node --test frontend/tests/settings.test.js frontend/tests/settings_provider_cards.test.js`

Expected: FAIL，DOM 控件和 payload 字段尚不存在。

- [ ] **Step 4: 实现 HTML 控件和 CSS**

在图片模型附近增加 select/radio 控件，固定 value 为 `image_to_image`、`text_to_image`，说明文字明确对应接口和参考图行为；沿用设置页现有 field、hint、badge 样式，仅增加必要的模式容器样式。

- [ ] **Step 5: 实现设置脚本行为**

- `openProviderEditor()` 设置 provider 值或默认 `image_to_image`。
- `updateProviderProtocolFields()` 与 `updateProviderCapabilityFields()` 共同决定模式容器显隐和 disabled。
- `providerFormValues()` 返回模式。
- `buildProviderPayload()` 规范化未知值为 `image_to_image`。
- provider card 对符合条件的线路渲染转义后的固定模式徽标。

- [ ] **Step 6: 运行 Task 6 测试、语法检查并提交**

Run:

```bash
node --test frontend/tests/settings.test.js frontend/tests/settings_provider_cards.test.js
node --check frontend/js/settings.js
```

Commit:

```bash
git add frontend/index.html frontend/js/settings.js frontend/css/settings.css frontend/tests/settings.test.js frontend/tests/settings_provider_cards.test.js
git commit -m "feat: add image generation mode setting"
```

---

### Task 7: 文档同步与完整验证

**Files:**
- Modify: `AGENTS.md`
- Verify: all changed files

**Interfaces:**
- No new runtime interface.

- [ ] **Step 1: 更新项目指南**

在 AI Routing And Settings 中记录：OpenAI Compatible 图片线路具有持久化的 `text_to_image`/`image_to_image` 模式，分别访问 generations/edits，图生图不得静默降级为文生图。

- [ ] **Step 2: 执行前端完整测试和语法检查**

Run:

```bash
node --test frontend/tests/*.test.js
node --check frontend/js/settings.js
```

Expected: 全部 PASS。

- [ ] **Step 3: 执行后端完整测试**

Run: `.venv/bin/python -m pytest backend/tests`

Expected: 全部 PASS。

- [ ] **Step 4: 构建 CSS 并检查 diff**

Run:

```bash
cd frontend && npm run build:css
cd ..
git diff --check
git status --short
```

Expected: 构建成功；除本功能文件和用户原有 `json.txt` 外没有意外改动，`frontend/dist/` 保持忽略。

- [ ] **Step 5: 提交文档与最终整理**

```bash
git add AGENTS.md
git commit -m "docs: document OpenAI image generation modes"
```

- [ ] **Step 6: 最终证据核对**

确认分支日志包含所有任务提交，`git diff main...HEAD --check` 通过，工作树仅允许用户原有的未跟踪文件出现在主工作区而不出现在隔离 worktree。
