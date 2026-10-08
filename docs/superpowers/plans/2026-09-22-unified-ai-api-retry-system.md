# 统一 AI API 失败重试与容错系统实施计划 (Implementation Plan - v2 修订版)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立工业级统一且支持细分场景策略（Retry Policy）与服务商能力声明驱动的 API 重试与容错系统。通过显式锁定 SDK 单次尝试杜绝多层重试放大；在非幂等操作（生图、外部写）遇不可确定结果（`AMBIGUOUS_OUTCOME`）时严禁盲目重放以防二次扣费；将 SSE 定位为通知而非 SSOT 并由后端维护 execution 真实状态；前端关闭业务重放并提供就地恢复。

**Architecture:**
- 后端构建 `retry_service.py`（预算生命周期管理、`request_may_have_reached_upstream` 决策判断）与 `provider_capabilities.py`（服务商与 Operation/Mutation 级双层能力声明）；
- Google `genai.Client` 显式锁定 `HttpRetryOptions(attempts=1)` 并通过 Transport Mock 验证单次调用；
- Backend 负责分配全局唯一的 `operation_id` 与 `execution_id`，维护 execution 内存/存储状态作为 Source of Truth；
- WordPress/Shopify 外部写入建立严格的 Ambiguous Outcome 熔断机制；
- 前端 `fetchWithRetry` 移除对 AI 生成类操作的盲目重试，通过 SSE 接收通知、通过 Status API 恢复状态。

**Tech Stack:** Python 3.12 (FastAPI, httpx, google-genai, asyncio), Vanilla JavaScript (SSE, Fetch, DOM), Pytest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-22-unified-ai-api-retry-system-design.md`

## Global Constraints

- **Single Controller 铁律**：一次业务操作只存在一个主要 Retry Controller，禁止 `Frontend Retry × Backend Retry × SDK Retry`。
- **Capability 驱动 Header**：所有 Provider-specific Header（如 `X-Client-Request-Id`、`Idempotency-Key`）必须由 `ProviderCapability` 对应 Operation 明确声明后才能发送，第三方 OpenAI-compatible 不默认注入幂等头。
- **Budget 严格统算**：`max_elapsed_time` 涵盖 `Provider execution time + backoff sleep time`。若 `elapsed + planned_delay >= max_elapsed_time`，立即停止同步重试。
- **AMBIGUOUS 严密防线**：只要请求可能已到达上游且结果未知（ReadTimeout / WriteTimeout / RemoteProtocolError / 发送后连接重置），非幂等操作必须进入 `AMBIGUOUS_OUTCOME` 并停止自动重放，禁止自动切 Provider。
- **ID 严格分层**：
  - Frontend: `client_request_id`, `client_operation_key`（防双击与请求绑定）
  - Backend: `operation_id`（业务意图），`execution_id`（执行生命周期）
  - 自动 Retry: 同一 operation + 同一 execution + attempt++
  - 用户手动 Retry: 同一 operation + 新 execution
  - 用户重新生成: 全新 operation + 全新 execution
- **SSE 定位**：SSE 仅作为状态变化通知，不作为唯一状态真理（SSOT）。重连绝不重新提交生成请求。

## Review Focus

1. **Google SDK Transport 单次请求**：Mock Transport 确认 503 时 SDK 仅发出 1 次 HTTP 请求。
2. **生图等非幂等请求可能达上游防重放**：`request_may_have_reached_upstream=True` 时拒绝自动重放。
3. **WordPress 上传写超时防副本**：无原生幂等时，Write/Read 超时后进入 AMBIGUOUS_OUTCOME，禁止重新上传产生 `-1` 文件。
4. **Retry-After 与 Budget 冲突**：`Retry-After` 超过剩余 Budget 时不再同步睡眠重试，立即返回清晰的可恢复状态。
5. **并发 Execution 状态隔离**：多个任务并发重试时，各自的 `operation_id` / `execution_id` 状态绝对隔离不串线。

---

## Task Structure

### Task 1: 服务商与 Operation 级双层能力矩阵 (`provider_capabilities.py`)

**Files:**
- Create: `backend/services/provider_capabilities.py`
- Test: `backend/tests/test_provider_capabilities.py`

**Interfaces:**
- Produces:
  - `class IdempotencyMode(str, Enum)`: `NONE`, `HEADER`, `INPUT_FIELD`, `GRAPHQL_DIRECTIVE`, `PROVIDER_SPECIFIC`
  - `class ProviderCapability(NamedTuple)`: `supports_idempotency: bool`, `idempotency_mode: IdempotencyMode`, `header_name: Optional[str]`, `supports_retry_after: bool`, `sdk_retry_configurable: bool`, `has_side_effect_on_read_timeout: bool`, `operation_overrides: dict[str, Any]`
  - `get_provider_capability(provider_name: str, protocol: str, operation: Optional[str] = None) -> ProviderCapability`

- [x] **Step 1: 编写测试用例 `backend/tests/test_provider_capabilities.py`**
  - 验证官方 OpenAI 支持 `X-Client-Request-Id`，第三方 OpenAI-compatible 默认 `idempotency_mode=NONE`，不注入未声明 Header；
  - 验证 Shopify 支持 Provider 默认 + Mutation 级（如 `stagedUploadsCreate` vs `productCreate`）Override；
  - 验证 WordPress 声明 `idempotency_mode=NONE` 且 `has_side_effect_on_read_timeout=True`。
- [x] **Step 2: 运行测试验证失败**
  Run: `.venv/bin/python -m pytest backend/tests/test_provider_capabilities.py -v`
- [x] **Step 3: 实现 `backend/services/provider_capabilities.py`**
  实现双层能力字典与解析方法。
- [x] **Step 4: 运行测试确保通过**
  Run: `.venv/bin/python -m pytest backend/tests/test_provider_capabilities.py -v`
- [x] **Step 5: 提交代码**
  `git add backend/services/provider_capabilities.py backend/tests/test_provider_capabilities.py && git commit -m "feat: implement dual-layer provider and operation capability matrix"`

---

### Task 2: 统一重试引擎、预算追踪器与 AMBIGUOUS 判决 (`retry_service.py`)

**Files:**
- Create: `backend/services/retry_service.py`
- Test: `backend/tests/test_retry_service.py`

**Interfaces:**
- Produces:
  - `class ErrorCategory(str, Enum)`: `NETWORK_TIMEOUT`, `CONNECTION_RESET`, `TEMPORARY_RATE_LIMIT`, `QUOTA_EXHAUSTED`, `AUTH_ERROR`, `INVALID_REQUEST`, `INVALID_MODEL`, `PROVIDER_OVERLOADED`, `UPSTREAM_GATEWAY`, `AMBIGUOUS_OUTCOME`, `CLIENT_CANCELLED`, `UNKNOWN`
  - `class RetryPolicy`: `policy_name`, `operation_safety` (`SAFE`, `IDEMPOTENT`, `NON_IDEMPOTENT`), `max_attempts`, `max_elapsed_time`, `backoff_gradient`, `backoff_cap`, `retry_after_cap`, `jitter`
  - `class RetryDecision`: `retryable: bool`, `category: ErrorCategory`, `reason: str`, `delay_seconds: float`, `request_may_have_reached_upstream: bool`
  - `class ExecutionState`: `operation_id`, `execution_id`, `attempt`, `max_attempts`, `state`, `next_retry_at`, `error_category`
  - `class PolicyResolver`: `get_policy(scenario: str) -> RetryPolicy`
  - `async def execute_with_retry(operation, *, policy: RetryPolicy, context: dict, on_retry: Optional[Callable] = None) -> Any`

- [x] **Step 1: 编写测试用例 `backend/tests/test_retry_service.py`**
  - 测试 `request_may_have_reached_upstream` 语义：
    - `ReadTimeout` / `WriteTimeout` / `RemoteProtocolError` $\to$ `reached=True`；
    - `ConnectTimeout` / `ConnectError` $\to$ `reached=False`；
    - 对于 `NON_IDEMPOTENT` 操作，`reached=True` 时决策进入 `AMBIGUOUS_OUTCOME` 且 `retryable=False`；
  - 测试 `max_elapsed_time` 预算统算：`elapsed + planned_delay >= max_elapsed_time` 时立即终止，不执行睡眠；
  - 测试 `Retry-After` 高于预算时停止同步重试；
  - 测试 `CancelledError` 绝不重试，直接抛出。
- [x] **Step 2: 运行测试验证失败**
  Run: `.venv/bin/python -m pytest backend/tests/test_retry_service.py -v`
- [x] **Step 3: 实现 `backend/services/retry_service.py`**
  实现错误判决、预算时间计算、Full Jitter、Retry-After 解析与 `execute_with_retry`。
- [x] **Step 4: 运行测试确保通过**
  Run: `.venv/bin/python -m pytest backend/tests/test_retry_service.py -v`
- [x] **Step 5: 提交代码**
  `git add backend/services/retry_service.py backend/tests/test_retry_service.py && git commit -m "feat: implement retry engine with budget tracker and ambiguous outcome safety"`

---

### Task 3: Google SDK 单次尝试锁定与 Transport 验证 (`ai_adapters.py`)

**Files:**
- Modify: `backend/services/ai_adapters.py`
- Test: `backend/tests/test_ai_adapters.py`

**Interfaces:**
- Produces:
  - `GeminiAdapter._build_client` 配置 `http_options=types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1))`
  - `VertexAdapter._build_client` 配置 `http_options=types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1))`
  - `OpenAICompatibleAdapter` 依据 Provider Capability 声明可选注入 `X-Client-Request-Id`，第三方不默认注入 `Idempotency-Key`。

- [x] **Step 1: 编写测试用例 `test_google_sdk_locked_to_single_attempt_on_transport`**
  在 `backend/tests/test_ai_adapters.py` 中 Mock 底层 HTTP Transport 返回 503，验证 SDK 实际只触发了 1 次底层 HTTP 调用。
- [x] **Step 2: 编写测试用例 `test_openai_headers_governed_by_capability`**
  验证只有官方 OpenAI 且 Capability 声明支持时才注入客户端追踪头，第三方 OpenAI-compatible 不自动注入 Header。
- [x] **Step 3: 修改 `backend/services/ai_adapters.py`**
  设置 `HttpRetryOptions(attempts=1)` 并对接 `provider_capabilities`。
- [x] **Step 4: 运行测试确保通过**
  Run: `.venv/bin/python -m pytest backend/tests/test_ai_adapters.py -v`
- [x] **Step 5: 提交代码**
  `git add backend/services/ai_adapters.py backend/tests/test_ai_adapters.py && git commit -m "fix(adapters): lock Google SDK to single attempt and govern headers by capability"`

---

### Task 4: AI Router 核心重试接入、ID 分配与 SSE 广播 (`ai_router.py`)

**Files:**
- Modify: `backend/services/ai_router.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_ai_router_retry.py`

**Interfaces:**
- Produces:
  - Backend 生成 `operation_id`（若前端未提供）与每次调用的 `execution_id`
  - 维护内存 `ExecutionStateTracker`（状态真实 Source of Truth）
  - 生图应用 `ai_image_generation` (NON_IDEMPOTENT) Policy，遇 ReadTimeout 进入 `AMBIGUOUS_OUTCOME`，停止自动重发且**严禁自动 Provider Fallback**
  - 文本应用 `ai_text_generation` (IDEMPOTENT_SEMANTIC) Policy
  - 每次重试通过 `app_logs.emit` 发送结构化 `ai_retry` 事件

- [x] **Step 1: 编写 `backend/tests/test_ai_router_retry.py` 测试**
  - 测试生图遇 503 按阶梯重试；
  - 测试生图遇 ReadTimeout 进入 `AMBIGUOUS_OUTCOME`，不执行二次请求；
  - 测试 `ambiguous outcome` 下严禁触发 Provider Fallback；
  - 测试 401 立即退出并输出脱敏日志；
  - 测试并发 execution 状态独立。
- [x] **Step 2: 改造 `backend/services/ai_router.py`**
  移除旧有裸循环，完整接入 `execute_with_retry`，注入 execution 跟踪。
- [x] **Step 3: 运行测试确保通过**
  Run: `.venv/bin/python -m pytest backend/tests/test_ai_router_retry.py -v`
- [x] **Step 4: 提交代码**
  `git add backend/services/ai_router.py backend/tests/test_ai_router_retry.py && git commit -m "refactor(ai_router): integrate retry engine with execution tracker and ambiguous protection"`

---

### Task 5: 外部存储（WordPress / Shopify）防副本与安全重试 (`storage_service.py`)

**Files:**
- Modify: `backend/services/storage_service.py`
- Test: `backend/tests/test_storage_service.py`

- [x] **Step 1: 编写测试用例**
  - 验证 WordPress 上传在发送请求体后发生 ReadTimeout / WriteTimeout 时，标记 `AMBIGUOUS_OUTCOME` 并抛出可恢复提示，禁止直接二次 POST；
  - 验证 Shopify 遇到 Throttle (429) 时，尊重 `Retry-After` Header 重试；
  - 验证 Cloudflare R2 使用 S3 幂等覆盖策略。
- [x] **Step 2: 改造 `backend/services/storage_service.py`**
  接入 `retry_service`，设置特定操作策略与安全判定。
- [x] **Step 3: 运行测试确保通过**
  Run: `.venv/bin/python -m pytest backend/tests/test_storage_service.py -v`
- [x] **Step 4: 提交代码**
  `git add backend/services/storage_service.py backend/tests/test_storage_service.py && git commit -m "fix(storage): enforce safe retry policy for WordPress and Shopify"`

---

### Task 6: 次级服务（图片下载、余额、爬虫）轻量策略接入

**Files:**
- Modify: `backend/services/image_response_fetcher.py`
- Modify: `backend/services/ai_balance_service.py`
- Modify: `backend/services/firecrawl.py`
- Test: `backend/tests/test_image_response_fetcher.py`, `backend/tests/test_ai_balance.py`

- [x] **Step 1: 改造 `image_response_fetcher.py` 接入 `image_download` Policy**
- [x] **Step 2: 改造 `ai_balance_service.py` 接入 `lightweight_query` Policy**
- [x] **Step 3: 改造 `firecrawl.py` 接入 `crawler_scrape` Policy**
- [x] **Step 4: 运行测试验证全量通过**
  Run: `.venv/bin/python -m pytest backend/tests/test_image_response_fetcher.py backend/tests/test_ai_balance.py -v`
- [x] **Step 5: 提交代码**
  `git add backend/services/image_response_fetcher.py backend/services/ai_balance_service.py backend/services/firecrawl.py && git commit -m "feat: wire retry policies to image fetcher, balance query, and crawler"`

---

### Task 7: 前端请求层改造与重试风暴阻断 (`utils.js`, `app.js`)

**Files:**
- Modify: `frontend/js/utils.js`
- Modify: `frontend/js/app.js`
- Test: `frontend/tests/fetch_with_retry_enhanced.test.js`

- [x] **Step 1: 编写测试用例 `frontend/tests/fetch_with_retry_enhanced.test.js`**
  - 验证对 `/api/ai/generate` 等业务生成接口，前端遇到 502/504 **不自动重新执行 POST 业务生成**；
  - 验证前端仅在浏览器网络断开（Network Error）时尝试轻量状态重连；
  - 验证生成 `client_request_id` 与 `client_operation_key`；
  - 验证 SSE reconnect 不重新提交原有业务请求。
- [x] **Step 2: 改造 `frontend/js/utils.js` 与 `frontend/js/app.js`**
  实现上述防重复执行约束与状态重连机制。
- [x] **Step 3: 运行前端测试**
  Run: `node --test frontend/tests/fetch_with_retry_enhanced.test.js`
- [x] **Step 4: 提交代码**
  `git add frontend/js/utils.js frontend/js/app.js frontend/tests/fetch_with_retry_enhanced.test.js && git commit -m "feat(frontend): prevent duplicate business re-execution and add client operation keys"`

---

### Task 8: 前端 UI 实时重试状态感知、手动重试与重新生成交互 (`details.js`)

**Files:**
- Modify: `frontend/js/details.js`
- Test: `frontend/tests/detail_retry_ui_feedback.test.js`

- [x] **Step 1: 编写 UI 交互测试**
  - 验证接收到 SSE `ai_retry` 事件时卡片展示“⚠️ 接口响应异常，正在自动重试（1/3）”；
  - 验证自动重试保持相同 `operation_id` 与 `execution_id`；
  - 验证用户手动点击卡片“重试”触发相同 `operation_id` 但新 `execution_id`；
  - 验证用户点击“重新生成”触发全新 `operation_id`；
  - 验证终态失败隐藏 Traceback，展示友好脱敏说明。
- [x] **Step 2: 改造 `frontend/js/details.js`**
  对接 SSE 事件与状态机。
- [x] **Step 3: 运行前端测试与语法核查**
  Run: `node --test frontend/tests/detail_retry_ui_feedback.test.js`
  Run: `node --check frontend/js/details.js`
- [x] **Step 4: 提交代码**
  `git add frontend/js/details.js frontend/tests/detail_retry_ui_feedback.test.js && git commit -m "feat(ui): implement dynamic retry feedback, manual retry vs regenerate semantics"`

---

### Task 9: 全量回归与端到端系统验收

- [x] **Step 1: 运行全量后端测试套件**
  Run: `.venv/bin/python -m pytest backend/tests`
  预期：所有用例 100% 全部通过。
- [x] **Step 2: 运行全量前端测试套件**
  Run: `node --test frontend/tests/*.test.js`
  预期：所有用例 100% 全部通过。
- [x] **Step 3: 代码风格与格式检查**
  Run: `git diff --check`
- [x] **Step 4: 服务重启与生产级冒烟验证**
  重启 9503 后端，验证设置测试、出图与重试拦截正常。
