# 统一 AI API 失败重试与容错系统设计规范 (Unified AI API Retry System Spec)

- **创建日期**: 2026-09-22
- **状态**: 设计已批准 / 待实施
- **对应阶段**: 系统级架构重构 (Architectural)

---

## 1. 背景与目标

当前系统中，各类外部 API（包括大模型推理、爬虫抓取、云存储上传、公网图片获取、第三方中转接口等）存在以下痛点：
1. **重试逻辑分散且标准不一**：部分服务在代码内部以简陋的 `for attempt in range(...)` 硬编码重试，部分服务完全无重试；
2. **缺乏科学退避与抖动机制**：重试间隔固定或简单翻倍，无随机 Jitter（抖动）保护，容易引发惊群效应（Thundering Herd）；且未适配服务商返回的 `Retry-After` Header；
3. **错误判别模糊**：没有区分“瞬态可恢复错误”（如超时、429限流、502网关错误）与“永久致命错误”（如 400 参数校验失败、401 密钥失效、404 模型不存在），导致遇到配置错误时仍然空耗数轮重试；
4. **缺少幂等性防重保障**：在网络丢包重试时，缺乏唯一的 `Idempotency-Key` / `request_id` 透传，存在上游已扣积分/已创建资源而客户端重复发起的风险；
5. **前端交互与状态割裂**：后台悄悄重试时前端处于长时间“转圈假死”状态，重试用尽失败后直接暴露底层堆栈或原始 HTTP 报错，体验极差。

### 核心建设目标
- **统一封装**：抽象全局唯一的重试引擎模块（`backend/services/retry_service.py`），全项目禁止单独硬编码重试；
- **自适应梯度**：支持首次请求 + 最多 5 次重试（共 6 次尝试），指数退避平滑递增至 120 秒封顶，支持 Full Jitter 与 `Retry-After` 优先权；
- **严密判决矩阵**：建立清晰的可重试白名单与即时熔断黑名单；
- **全链路幂等与审计**：自动生成并向支持的上游注入幂等标识，记录高密度结构化诊断日志；
- **双端状态协同**：重试发生时实时通知前端展示人话重试状态（如“接口响应异常，正在自动重试 (1/5)”），终态失败友好兜底并提供就地“重新生成”。

---

## 2. 总体架构设计

```
[ 用户操作 / 浏览器前端 ]
       │
       ▼
[ 前端统一 API 层: utils.js (apiFetch / fetchWithRetry) ]
  - 监听 HTTP 状态，捕获断网/502/504
  - 注入前端 request_id / idempotency_key
  - 回调驱动 UI 渲染: “正在自动重试 (n/5)”
       │ (HTTP JSON / Form)
       ▼
[ 本地 FastAPI 路由层 (backend/routes/...) ]
       │
       ▼
[ 统一重试引擎 (backend/services/retry_service.py) ] <────────────────┐
  - 指数退避调度 (4s -> 12s -> 30s -> 60s -> 120s)                   │
  - Full Jitter 随机抖动 & Retry-After Header 解析                   │ 驱动所有
  - 错误决策矩阵 (is_retryable_error)                                │ 外部调用
  - 幂等性 Header 注入 (Idempotency-Key, X-Request-Id)               │
  - 结构化日志输出 & SSE 事件广播                                    │
       ├───> AIRouter (Gemini / Vertex AI / OpenAI-compatible) ───────┤
       ├───> ImageResponseFetcher (抓取公网/CDN图片并校验) ───────────┤
       ├───> StorageService (WordPress / Shopify / Cloudflare R2) ────┤
       ├───> FirecrawlService (竞品页面抓取与解析) ───────────────────┤
       └───> AIBalanceService (服务商余额与 Quota 代理查询) ──────────┘
```

---

## 3. 核心引擎与算法规范 (`backend/services/retry_service.py`)

### 3.1 尝试次数与退避曲线
- **最大重试次数**：`max_retries = 5`（总共最多执行 6 次尝试）。
- **退避阶梯设计**：
  为使第 5 次重试等待时间平滑扩展至用户指定的 **120 秒上限**，采用如下校准梯度：

| 重试轮次 (Retry) | 尝试序号 (Attempt) | 标称延迟 (Nominal Delay) | 随机 Jitter 范围 | 实际休眠范围 |
| :--- | :--- | :--- | :--- | :--- |
| **Retry 1** | 第 2 次尝试 | **4.0 秒** | $\pm 0.5\text{s}$ | $3.5\text{s} \sim 4.5\text{s}$ |
| **Retry 2** | 第 3 次尝试 | **12.0 秒** | $\pm 1.5\text{s}$ | $10.5\text{s} \sim 13.5\text{s}$ |
| **Retry 3** | 第 4 次尝试 | **30.0 秒** | $\pm 3.0\text{s}$ | $27.0\text{s} \sim 33.0\text{s}$ |
| **Retry 4** | 第 5 次尝试 | **60.0 秒** | $\pm 5.0\text{s}$ | $55.0\text{s} \sim 65.0\text{s}$ |
| **Retry 5** | 第 6 次尝试 | **120.0 秒** | $-10.0\text{s} \sim 0\text{s}$ | $110.0\text{s} \sim 120.0\text{s}$ (硬封顶) |

- **封顶保护**：任何情况下 $\text{delay} \le 120.0\text{s}$。
- **`Retry-After` Header 优先规则**：
  - 若 HTTP 响应头包含 `Retry-After`（支持整数秒或 HTTP-Date），且值在 $(0, 120]$ 秒区间，优先使用 `Retry-After`；若其超过 120 秒，强制截断为 120 秒并触发警告日志。

### 3.2 错误判别决策树 (`is_retryable_error`)

在执行 `operation()` 发生异常或收到非 2xx 响应时，严格按以下规则仲裁：

```python
def is_retryable_error(exc: Exception, response: Optional[httpx.Response] = None) -> bool:
    # 1. 瞬态网络异常 (连接断开、重置、握手超时) -> 允许重试
    if isinstance(exc, (
        httpx.ConnectError,
        httpx.ConnectTimeout,
        httpx.ReadTimeout,
        httpx.WriteTimeout,
        httpx.PoolTimeout,
        httpx.RemoteProtocolError,
        ConnectionResetError,
        BrokenPipeError,
        TimeoutError,
        asyncio.TimeoutError,
    )):
        return True

    # 2. 检查 HTTP 状态码
    status_code = getattr(response, "status_code", None)
    if status_code is None and hasattr(exc, "response"):
        status_code = getattr(exc.response, "status_code", None)

    if status_code is not None:
        # 禁止重试黑名单 (不可恢复的配置或客户端错误，立即熔断)
        if status_code in {400, 401, 403, 404, 422}:
            return False
        # 允许重试白名单 (服务端瞬态繁忙或网关异常)
        if status_code in {408, 429, 500, 502, 503, 504}:
            return True

    # 3. 错误文本/消息模式匹配 (部分中转网关将限流封装为非标准异常)
    err_text = str(exc).lower()
    if any(k in err_text for k in ["econnreset", "etimedout", "connection reset", "rate limit", "resource exhausted"]):
        return True

    # 4. 其他未知异常默认不重试，避免无效死循环
    return False
```

---

## 4. 幂等性与全链路日志审计

### 4.1 幂等键与 Request ID 生成传播规范
1. **生成时机**：在前端或服务端发起业务级操作（生图、创建文案、上传媒体）的第一时间生成：
   - `request_id`: `req_` + 16位随机十六进制（如 `req_8f12a3bc4d5e6f70`）
   - `idempotency_key`: `idem_` + 业务标识 + 哈希或UUID（如 `idem_m1_8f12a3bc4d5e`）
2. **请求头注入**：
   通过 `retry_service` 发送下游 HTTP 请求时，自动附加：
   - `X-Request-Id: <request_id>`
   - `Idempotency-Key: <idempotency_key>`
3. **上游兼容性**：
   OpenAI、Shopify Admin API、Stripe 等均支持标准 `Idempotency-Key`。重试即使因网络超时重新到达上游，上游网关会通过该 Key 直接返回此前已执行完成的结果，彻底杜绝重复计费与重复数据插入。

### 4.2 结构化日志模型
每轮尝试（包括初始尝试与各次重试）均由 `app_logs` 输出标准 JSON 格式事件：
- `request_id` (str)
- `idempotency_key` (str)
- `provider` (str, e.g. "噜皮生图")
- `model` (str, e.g. "gpt-image-2.5-sunburst")
- `capability` (str, e.g. "image" / "text")
- `attempt` (int, 1-based)
- `max_attempts` (int, e.g. 6)
- `status_code` (int, 可选)
- `error_type` (str, e.g. "HTTPStatusError" / "ConnectTimeout")
- `response_time_ms` (int)
- `retry_delay_s` (float, 下一轮重试等待时间)
- `retry_reason` (str, e.g. "rate_limit_backoff" / "network_timeout")

---

## 5. 前端协同与交互降级

### 5.1 实时重试状态感知
长耗时任务（如详情页模块出图）：
1. **事件流**：后端 `retry_service` 触发重试休眠前，调用 `app_logs.emit(level="warning", source="ai", message={"summary": "AI 请求重试", ...})`。
2. **前端捕获**：前端通过 SSE 日志流（或专用通道）接收到与当前任务关联的 `request_id` 的重试事件。
3. **UI 动态反馈**：
   对应区块的 Loading 状态文字动态更新为：
   $$\text{⚠️ 接口响应异常，正在自动重试 (第 } n/5 \text{ 次，等待 } t \text{ 秒)...}$$
   让卖家清楚得知系统正在抗抖动自愈，而非网页卡死。

### 5.2 终态失败友好交互与就地“重新生成”
当 5 次重试全部用尽仍然失败：
1. **脱敏保护**：严格清洗底层 Python 报错、Traceback、文件路径与密钥片段，转换为人类可读的友好说明（例如：`“AI 提供商服务暂时繁忙（HTTP 429），已自动重试 5 次仍未恢复”`）；
2. **就地恢复入口**：
   - 区块卡片保留红色的错误标识，并高亮展示 **`[ 重新生成 ]`** 按钮；
   - 顶部工具栏显式激活“重试失败项”按钮；
   - 允许用户一键重试或在设置中切换模型后继续无缝生成，不破坏已生成的成功区块。

---

## 6. 全项目 API 改造清单

| 模块 / 文件 | 当前现状 | 改造方案 |
| :--- | :--- | :--- |
| **`backend/services/ai_router.py`** | 仅依赖 `snapshot.max_retries`，无 Jitter，未过滤 400/401，无 Retry-After | 彻底替换为 `retry_service.execute_with_retry`，注入 request_id 与 idempotency_key |
| **`backend/services/image_response_fetcher.py`** | 无统一退避，遇到 CDN 抖动直接抛错 | 接入 `retry_service`，对外部图片下载增加 3 次快速退避重试 |
| **`backend/services/storage_service.py`** | WordPress / Shopify / R2 上传失败直接报错中断 | 接入 `retry_service`，Shopify Admin 遇到 429/503 自动退避重试并注入幂等键 |
| **`backend/services/firecrawl.py`** | 竞品抓取偶发网络波动无重试 | 接入 `retry_service`，针对 502/504/超时进行退避重试 |
| **`backend/services/ai_balance_service.py`** | 余额查询偶发超时 | 接入统一轻量重试（最多 2 次快速退避） |
| **`frontend/js/utils.js` (`fetchWithRetry`)** | 固定数组延迟，无 Jitter，无状态广播，状态黑名单未统一 | 升级为与后端规范一致的退避算法、Jitter、Retry-After 解析与 `onRetry` 回调通知 |
| **`frontend/js/details.js` 等业务卡片** | 重试时无状态文字变化，失败直接抛 alert | 监听 `onRetry` 渲染动态倒计时，失败展示友好卡片与“重新生成”入口 |

---

## 7. 验证计划与测试矩阵

### 7.1 后端自动化测试 (`pytest backend/tests/test_retry_service.py`)
- **指数退避与梯度验证**：验证 5 次重试各轮延迟符合校准梯度，第 5 次延迟在 120s 封顶范围内；
- **Jitter 抖动验证**：连续多次计算延迟，验证输出非固定常数且符合全抖动区间；
- **Retry-After 优先验证**：Mock 返回带 `Retry-After: 45`，验证优先采用 45s；带超过 120s 时验证截断为 120s；
- **错误判别决策验证**：
  - 400 / 401 / 403 / 404 / 422 验证立即抛出，尝试次数为 1；
  - 408 / 429 / 500 / 502 / 503 / 504 / ConnectError / Timeout 验证按步长重试满 6 次后抛出终态异常；
- **幂等键注入验证**：验证发起请求时携带标准 `X-Request-Id` 与 `Idempotency-Key`；
- **全链路集成测试**：Mock `AIRouter` 经历 2 次 503 后在第 3 次成功返回，验证整体调用正常完成并记录完整日志。

### 7.2 前端自动化测试 (`node --test frontend/tests/fetch_with_retry_enhanced.test.js`)
- 验证 `fetchWithRetry` 在遇到 429/500/网络中断时按指数退避重试并触发 `onRetry(attempt, max, delay)`；
- 验证遇到 400/401/403/404 时立即中断不触发多余网络请求；
- 验证 `AbortController` 手动取消时立即终止重试不残留定时器。

### 7.3 全量回归测试
- 确保 `pytest backend/tests` 全量 603+ 用例 100% 通过；
- 确保 `node --test frontend/tests/*.test.js` 全量 491+ 用例 100% 通过；
- 确保 `git diff --check` 与 `node --check` 零告警。
