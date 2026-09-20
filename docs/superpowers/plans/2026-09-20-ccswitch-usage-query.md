# CC Switch 风格独立用量查询配置面板与脚本引擎实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建与 CC Switch 100% 交互对齐的独立【配置用量查询】面板与脚本提取引擎，支持通用模板、New-API（完整版）、Token Plan、官方与自定义预设切换、代码高亮格式化、免跨域本地 HTTP 代理测试与持久化保存，为后续 APP 化打包奠定基础。

**Architecture:** 前后端协同的 APP-Ready 混合架构。前端在独立的 `frontend/js/usage_query_engine.js` 中管理预设模板库、模板插值与原生 JavaScript 安全沙箱提取；后端在 `backend/main.py` 提供无跨域限制的通用代理端点 `POST /api/settings/ai/providers/usage-query/proxy`，自动解密继承缺失凭据并抹除敏感日志；数据库持久化保存模板选型、参数与自定义脚本。

**Tech Stack:** Python 3.12, FastAPI, SQLite (SQLAlchemy), httpx, Vanilla JavaScript (ES2022+ Native Sandbox), Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-09-20-ccswitch-usage-query-design.md`

## Global Constraints

- 不引入任何需要 C 扩展编译的外部 Python JS 引擎（保证未来无论在 macOS 或 Windows 打包 APP 时零编译阻碍）。
- 所有对外网络请求由本地 Python 后端 `httpx` 发起，彻底消除浏览器的 CORS 跨域拦截。
- 提取器代码必须完全符合标准 JavaScript 规范（支持 `?.`、`??` 与数学运算）。
- 凭据脱敏严格遵循现有安全准则：日志中绝不暴露真实 API Key / Access Token。
- 保持全站 976 项已有单元测试 100% 通过，绝不破坏现有的基础余额查询功能。

## Review Focus

1. **缺失变量回退**: 当提取器代码中使用了 `{{accessToken}}` 或 `{{userId}}` 但用户未填且供应商未配置时，插值需平滑回退为空字符串或 API Key，不得导致脚本崩溃。
2. **非 JSON 响应拦截**: 当中转站返回 HTML 错误页（如 Cloudflare 502 / 504）时，代理与提取器需捕获并给出明确错误提示，而非抛出 JSON 语法解析未捕获异常。
3. **恶意/语法错误脚本防护**: 当用户在【自定义】模板中输入了非法语法或无限循环时，客户端沙箱需使用 `try...catch` 拦截并给出红色错误高亮，不得使前端界面白屏或失去响应。
4. **数字除零或 NaN 防护**: 在 New-API 模板中，若 `quota` 字段缺失或非数值，计算 `quota / 500000` 需防范 `NaN`，安全格式化为数字。
5. **并发与加载态锁定**: 在点击【▷ 测试脚本】时，按钮需进入 disabled loading 状态，测试中禁止重复点击。

---

### Task 1: 后端数据模型扩展与数据库迁移

**Files:**
- Modify: `backend/db.py:50-100`
- Modify: `backend/models/settings.py:50-80`
- Create: `backend/tests/test_ai_usage_query.py`

**Interfaces:**
- Consumes: `AIProviderConfig` (SQLAlchemy 模型)
- Produces: `balance_template`, `balance_script`, `balance_custom_key`, `balance_custom_url`, `balance_timeout`, `balance_auto_interval` 字段，以及 Pydantic 模型 `UsageQueryConfigRead`, `UsageQueryConfigWrite`, `UsageQueryProxyRequest`, `UsageQueryProxyResponse`。

- [ ] **Step 1: 编写数据库与数据模型失败单测 (RED)**

```python
# backend/tests/test_ai_usage_query.py
import pytest
from backend.models.settings import UsageQueryConfigWrite, UsageQueryConfigRead, UsageQueryProxyRequest
from backend.db import AIProviderConfig, SessionLocal

def test_usage_query_models_and_db_fields():
    cfg = UsageQueryConfigWrite(
        balance_template="newapi",
        balance_script="({ request: {}, extractor: function(r) { return {}; } })",
        balance_custom_key="sk-custom-key",
        balance_custom_url="https://api.test.com/v1",
        balance_timeout=15,
        balance_auto_interval=60,
    )
    assert cfg.balance_template == "newapi"
    assert cfg.balance_timeout == 15
```

- [ ] **Step 2: 运行测试验证失败 (RED)**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_usage_query.py -v`
Expected: FAIL with `ImportError: cannot import name 'UsageQueryConfigWrite'`

- [ ] **Step 3: 实现数据库字段扩展与模型定义 (GREEN)**

在 `backend/db.py` 的 `AIProviderConfig` 中增加：
```python
balance_template = Column(String, nullable=True, default="general")
balance_script = Column(Text, nullable=True)
balance_custom_key = Column(String, nullable=True)
balance_custom_url = Column(String, nullable=True)
balance_timeout = Column(Integer, nullable=True, default=10)
balance_auto_interval = Column(Integer, nullable=True, default=30)
```
并在 `init_db()` 中添加 SQLite 动态 `ALTER TABLE ADD COLUMN` 迁移逻辑。
在 `backend/models/settings.py` 中定义 Pydantic 请求与响应模型：
```python
class UsageQueryConfigWrite(BaseModel):
    balance_template: str | None = "general"
    balance_script: str | None = None
    balance_custom_key: str | None = None
    balance_custom_url: str | None = None
    balance_timeout: int | None = 10
    balance_auto_interval: int | None = 30

class UsageQueryConfigRead(UsageQueryConfigWrite):
    has_custom_key: bool = False
    custom_key_masked: str | None = None

class UsageQueryProxyRequest(BaseModel):
    provider_id: int | None = None
    url: str
    method: str = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None
    timeout_seconds: int = 10

class UsageQueryProxyResponse(BaseModel):
    ok: bool
    status_code: int
    data: dict | list | str | None = None
    message: str | None = None
    duration_ms: int = 0
```

- [ ] **Step 4: 运行测试验证通过 (GREEN)**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_usage_query.py -v`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add backend/db.py backend/models/settings.py backend/tests/test_ai_usage_query.py
git commit -m "feat(db): add usage query configuration fields and schemas"
```

---

### Task 2: 后端免跨域代理接口与用量配置 CRUD 端点

**Files:**
- Modify: `backend/main.py:1400-1500`
- Modify: `backend/tests/test_ai_usage_query.py`

**Interfaces:**
- Consumes: `UsageQueryProxyRequest`, `UsageQueryConfigWrite`, `AIProviderConfig`
- Produces: `POST /api/settings/ai/providers/usage-query/proxy`, `GET /api/settings/ai/providers/{id}/usage-query`, `PUT /api/settings/ai/providers/{id}/usage-query`

- [ ] **Step 1: 编写代理与 CRUD 失败单测 (RED)**

```python
# In backend/tests/test_ai_usage_query.py
from unittest.mock import MagicMock, patch
from starlette.testclient import TestClient
from backend.main import app

def test_usage_query_proxy_and_crud(test_client):
    # 1. Test proxy endpoint with mock httpx response
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"remaining": 10.5, "unit": "USD"}
    
    with patch("httpx.AsyncClient.request", return_value=mock_resp):
        res = test_client.post("/api/settings/ai/providers/usage-query/proxy", json={
            "url": "https://api.relay.com/v1/usage",
            "method": "GET",
            "headers": {"Authorization": "Bearer sk-test"}
        })
        assert res.status_code == 200
        assert res.json()["ok"] is True
        assert res.json()["data"]["remaining"] == 10.5
```

- [ ] **Step 2: 运行测试确认失败 (RED)**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_usage_query.py::test_usage_query_proxy_and_crud -v`
Expected: FAIL with 404/405 Not Found

- [ ] **Step 3: 实现代理端点与 CRUD (GREEN)**

在 `backend/main.py` 中挂载：
1. `POST /api/settings/ai/providers/usage-query/proxy`：
   - 检查 `provider_id`，若存在且请求头/URL 中含有 `{{apiKey}}`、`{{baseUrl}}`、`{{accessToken}}`、`{{userId}}` 则自动由后端真实凭据进行替换；
   - 使用 `httpx.AsyncClient` 发起网络请求，计算耗时 `duration_ms`；
   - 自动解析 JSON，若为非 JSON 则返回文本；
   - 敏感信息全面脱敏（若报错，错误信息抹除所有 Key）。
2. `GET /api/settings/ai/providers/{provider_id}/usage-query`：返回当前用量配置。
3. `PUT /api/settings/ai/providers/{provider_id}/usage-query`：更新用量配置。

- [ ] **Step 4: 运行测试验证通过 (GREEN)**

Run: `.venv/bin/python -m pytest backend/tests/test_ai_usage_query.py -v`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add backend/main.py backend/tests/test_ai_usage_query.py
git commit -m "feat(api): implement usage query proxy and config management endpoints"
```

---

### Task 3: 前端预设模板库与 JS 沙箱提取器引擎

**Files:**
- Create: `frontend/js/usage_query_engine.js`
- Create: `frontend/tests/usage_query_engine.test.js`

**Interfaces:**
- Consumes: raw JSON response from proxy
- Produces: `USAGE_QUERY_TEMPLATES`, `executeUsageExtractor(scriptStr, response, context)`, `interpolateTemplate(templateStr, vars)`, `formatExtractorScript(scriptStr)`

- [ ] **Step 1: 编写前端模板与提取沙箱测试 (RED)**

```javascript
// frontend/tests/usage_query_engine.test.js
const assert = require("node:assert/strict");
const test = require("node:test");
const {
    USAGE_QUERY_TEMPLATES,
    executeUsageExtractor,
    interpolateTemplate
} = require("../js/usage_query_engine.js");

test("USAGE_QUERY_TEMPLATES contains all 4 standard CC Switch presets", () => {
    assert.ok(USAGE_QUERY_TEMPLATES.general);
    assert.ok(USAGE_QUERY_TEMPLATES.newapi);
    assert.ok(USAGE_QUERY_TEMPLATES.token_plan);
    assert.ok(USAGE_QUERY_TEMPLATES.official);
});

test("New-API extractor extracts planName, remaining, used, total and unit", () => {
    const script = USAGE_QUERY_TEMPLATES.newapi;
    const mockResponse = {
        success: true,
        data: {
            group: "VIP套餐",
            quota: 5000000,
            used_quota: 1000000
        }
    };
    const result = executeUsageExtractor(script, mockResponse);
    assert.equal(result.isValid, true);
    assert.equal(result.planName, "VIP套餐");
    assert.equal(result.remaining, 10);
    assert.equal(result.used, 2);
    assert.equal(result.total, 12);
    assert.equal(result.unit, "USD");
});
```

- [ ] **Step 2: 运行测试验证失败 (RED)**

Run: `node --test frontend/tests/usage_query_engine.test.js`
Expected: FAIL with `MODULE_NOT_FOUND`

- [ ] **Step 3: 实现 `frontend/js/usage_query_engine.js` (GREEN)**

实现预设模板对象：
- `general`: 通用 `/v1/usage` 模板；
- `newapi`: 用户给出的完整 New-API 模板（带 `group`、`quota / 500000`、`used_quota`、`isValid: false`）；
- `token_plan`: One-API subscription 模板；
- `official`: DeepSeek / OpenRouter 模板。
实现函数：
- `interpolateTemplate(str, vars)`: 替换 `{{baseUrl}}`, `{{apiKey}}`, `{{accessToken}}`, `{{userId}}`；
- `executeUsageExtractor(scriptStr, response, context)`: 使用受保护作用域执行 `new Function('response', 'context', ...)` 提取字段并规范化输出；
- `formatExtractorScript(scriptStr)`: 格式化代码缩进；
- 支持 CommonJS 导出以供单元测试调用。

- [ ] **Step 4: 运行测试验证通过 (GREEN)**

Run: `node --test frontend/tests/usage_query_engine.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add frontend/js/usage_query_engine.js frontend/tests/usage_query_engine.test.js
git commit -m "feat(engine): add usage query template library and native JS sandbox extractor"
```

---

### Task 4: 前端 CC Switch 风格独立配置弹窗与样式

**Files:**
- Modify: `frontend/index.html:4350-4450`
- Modify: `frontend/css/settings.css:2300-2450`
- Create: `frontend/tests/settings_usage_query_ui.test.js`

**Interfaces:**
- Consumes: `#settingsUsageQueryModal`, `.settings-usage-query-*`
- Produces: 完整的 CC Switch 风格用量查询弹窗 DOM 与配套深色终端样式

- [ ] **Step 1: 编写 UI 结构失败单测 (RED)**

```javascript
// frontend/tests/settings_usage_query_ui.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const indexHtml = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");

test("index.html contains CC Switch usage query modal and elements", () => {
    assert.match(indexHtml, /id="settingsUsageQueryModal"/);
    assert.match(indexHtml, /id="settingsUsageTemplateGeneral"/);
    assert.match(indexHtml, /id="settingsUsageTemplateNewApi"/);
    assert.match(indexHtml, /id="settingsUsageScriptEditor"/);
    assert.match(indexHtml, /id="settingsUsageTestBtn"/);
    assert.match(indexHtml, /id="settingsUsageFormatBtn"/);
    assert.match(indexHtml, /id="settingsUsageSaveBtn"/);
});
```

- [ ] **Step 2: 运行测试验证失败 (RED)**

Run: `node --test frontend/tests/settings_usage_query_ui.test.js`
Expected: FAIL with missing elements

- [ ] **Step 3: 在 `index.html` 与 `settings.css` 中构建弹窗与视觉样式 (GREEN)**

在 `frontend/index.html` 中插入 `#settingsUsageQueryModal`：
- 顶部标题栏：`← 返回` 与 `配置用量查询 - <span id="settingsUsageProviderTitle"></span>`；
- 预设模板药丸组：`[自定义]`、`[通用模板]`、`[NewAPI]`、`[Token Plan]`、`[官方]`；
- 凭证与参数表单（API Key / 请求地址 / 超时时间 / 自动查询间隔）；
- 提取器代码区（深色等宽代码编辑器卡片）；
- 提取结果预览区域（支持渲染套餐名、剩余额度、总额度、已用额度、单位与状态标签）；
- 底部操作栏（测试脚本、格式化、取消、保存配置）。
在 `frontend/css/settings.css` 中编写 `.settings-usage-*` 系列响应式与暗黑卡片风格样式。

- [ ] **Step 4: 运行测试验证通过 (GREEN)**

Run: `node --test frontend/tests/settings_usage_query_ui.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add frontend/index.html frontend/css/settings.css frontend/tests/settings_usage_query_ui.test.js
git commit -m "feat(ui): add CC Switch style usage query modal and editor styles"
```

---

### Task 5: 前端控制器交互与线路卡片操作栏打通

**Files:**
- Modify: `frontend/js/settings.js:1350-1450, 2800-2900`
- Modify: `frontend/tests/settings_usage_query_ui.test.js`

**Interfaces:**
- Consumes: `openUsageQueryModal(providerId)`, `closeUsageQueryModal()`, `selectUsageTemplate(template)`, `testUsageQueryScript()`, `saveUsageQueryConfig()`
- Produces: 线路卡片右上角【💳 用量配置】操作按钮，及全流程弹窗交互

- [ ] **Step 1: 编写控制器交互逻辑单测 (RED)**

```javascript
// In frontend/tests/settings_usage_query_ui.test.js
const { providerUsageActionMarkup } = require("../js/settings.js");

test("provider card includes usage query action button for openai_compatible", () => {
    const provider = { id: 10, protocol: "openai_compatible", name: "Relay Hub" };
    const markup = providerUsageActionMarkup(provider);
    assert.match(markup, /openUsageQueryModal\(10\)/);
    assert.match(markup, /ph-sliders-horizontal|ph-wallet/);
});
```

- [ ] **Step 2: 运行测试确认失败 (RED)**

Run: `node --test frontend/tests/settings_usage_query_ui.test.js`
Expected: FAIL with `providerUsageActionMarkup is not defined`

- [ ] **Step 3: 实现控制器逻辑与卡片入口 (GREEN)**

在 `frontend/js/settings.js` 中：
1. `providerUsageActionMarkup(provider)`: 仅对 `openai_compatible` 线路渲染专属操作按钮；
2. `openUsageQueryModal(providerId)`: 读取当前线路配置并装填至弹窗；若已保存有自定义脚本则显示自定义，否则默认载入通用模板；
3. `selectUsageTemplate(templateKey)`: 联动切换代码编辑器内容；
4. `testUsageQueryScript()`:
   - 提取代码中的 `request` 配置；
   - 调用 `POST /api/settings/ai/providers/usage-query/proxy`；
   - 取得原始响应后调用 `executeUsageExtractor()` 沙箱执行；
   - 将返回的 `planName`、`remaining`、`used`、`total`、`unit` 动态渲染到结果卡片中。
5. `saveUsageQueryConfig()`: 提交保存至后端数据库，并更新前端线路卡片上的余额展示；
6. `formatUsageQueryScript()`: 美化代码。

- [ ] **Step 4: 运行测试验证通过 (GREEN)**

Run: `node --test frontend/tests/settings_usage_query_ui.test.js`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add frontend/js/settings.js frontend/tests/settings_usage_query_ui.test.js
git commit -m "feat(settings): connect usage query modal with provider cards and proxy pipeline"
```

---

### Task 6: 双端全量测试回归、缓存升级与服务重启

**Files:**
- Modify: `frontend/index.html` (bump Cache Buster)
- All test files

- [ ] **Step 1: 升级前端 Cache Buster**
  将 `settings.js`、`settings.css` 以及新增的 `usage_query_engine.js` 引用统一升级至最新版本戳 `?v=20260920-ccswitch-v1`。

- [ ] **Step 2: 语法合规检查**
  运行:
  ```bash
  node --check frontend/js/usage_query_engine.js
  node --check frontend/js/settings.js
  git diff --check
  ```
  Expected: 0 warnings, clean syntax.

- [ ] **Step 3: 前端全量测试套件执行**
  运行:
  ```bash
  node --test frontend/tests/*.test.js
  ```
  Expected: 395+ 项测试 100% 全部通过。

- [ ] **Step 4: 后端全量测试套件执行**
  运行:
  ```bash
  .venv/bin/python -m pytest backend/tests
  ```
  Expected: 588+ 项测试 100% 全部通过。

- [ ] **Step 5: 提交并重启服务**
  ```bash
  git commit -am "chore(release): full regression pass and asset cache bump for CC Switch usage query"
  ```
  通过清理端口并运行 `run.py` 完成热重启验证。
