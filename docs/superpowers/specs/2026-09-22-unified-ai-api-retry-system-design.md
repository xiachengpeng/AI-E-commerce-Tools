# 统一 AI API 失败重试与容错系统设计规范 (Unified AI API Retry System Spec - v2)

- **创建日期**: 2026-09-22
- **状态**: 设计已审查修订 / 正式实施阶段
- **对应阶段**: 系统级架构重构 (Architectural)

---

## 1. 核心设计原则

**“统一 Retry Engine，但不等于所有请求使用同一 Retry Policy；一次业务操作只能存在一个主要 Retry Controller；严防副作用与不可控重复。”**

1. **先建立 Retry Budget，再讨论重试**：单次重试策略必须受 `max_attempts`（最大尝试数）、`max_elapsed_time`（全局耗时上限，包含执行时间与睡眠等待）、`backoff_cap`（退避单次封顶）、`retry_after_cap`（服务商建议等待封顶）、`operation_safety` 联合约束，达到任一阈值立即停止同步重试。
2. **阻断三层乘积放大**：
   - 目标：一次业务操作只存在一个主要 Retry Controller。
   - 适配器显式将 Google `genai.Client` 的重试锁定为单次尝试（`attempts=1`）；
   - 前端移除对 AI 业务生成类接口的盲目多次重放（遇 502/504 等由后端 Controller 调度，前端仅作网络断连状态恢复）；
   - 严禁出现 `Frontend Retry × Backend Retry × SDK Retry`。
3. **副作用与非幂等安全防线 (`AMBIGUOUS_OUTCOME`)**：
   - `AMBIGUOUS_OUTCOME` 绝不只依赖 `ReadTimeout`，而是引入 `request_may_have_reached_upstream` 语义；
   - 涵盖 `ReadTimeout`、`WriteTimeout`、`RemoteProtocolError`、发送请求体后的连接重置（Connection Reset）；
   - 对于 `NON_IDEMPOTENT` 操作（如 AI 生图、外部媒体创建），只要请求可能已到达上游且结果未知，立即标记 `AMBIGUOUS_OUTCOME` 并**停止自动重发，严禁自动 Provider Fallback**，杜绝二次扣费与垃圾文件生成；
   - 仅当明确发生在连接建立前（`ConnectTimeout`, `ConnectError`）方可按 Policy 重试。
4. **Provider Capability 细粒度驱动**：
   - 不假设所有上游支持 `Idempotency-Key`；第三方 OpenAI-compatible 默认不注入未声明 Header；
   - 支持 Provider 默认 + Operation / Mutation 级覆盖（如 Shopify 区分不同 GraphQL 操作的幂等模式：`NONE`, `HEADER`, `INPUT_FIELD`, `GRAPHQL_DIRECTIVE`）。
5. **ID 严格分层与生命周期定义**：
   - 前端生成：`client_request_id`, `client_operation_key`（用于防双击与请求绑定）；
   - 后端生成：`operation_id`（业务意图），`execution_id`（单次执行生命周期）；
   - 自动 Retry：同一 operation + 同一 execution + attempt++；
   - 用户手动 Retry：同一 operation + 新 execution；
   - 用户点击重新生成：全新 operation + 全新 execution。
6. **SSE 作为通知机制而非唯一 SSOT**：
   - 后端维护 execution 的真实内存/持久化状态；
   - 前端通过 SSE 接收实时进度；断连或页面恢复后通过 Status API 同步真实状态，重连绝不重新提交生成请求。
7. **WordPress 媒体防副本策略**：
   - 无原生幂等支持；Body 发送后超时进入 `AMBIGUOUS_OUTCOME`，禁止直接重新 POST，必须通过前次结果检查或报错提示，严禁仅凭同名假设。

---

## 2. 策略定义与矩阵配置

### 2.1 RetryPolicy 结构定义
```python
@dataclass(frozen=True)
class RetryPolicy:
    policy_name: str
    operation_safety: str      # "SAFE", "IDEMPOTENT", "NON_IDEMPOTENT"
    max_attempts: int          # 包含首次请求的最大总尝试数
    max_elapsed_time: float    # 包含执行时间与睡眠延迟的总耗时预算 (秒)
    backoff_gradient: tuple[float, ...] # 阶梯标称延迟 (秒)
    backoff_cap: float         # 单次普通退避上限 (秒)
    retry_after_cap: float     # 单次 Retry-After 最大等待 (秒)
    jitter: str = "full"       # "full" | "none"
```

### 2.2 核心 Policy 细分矩阵

| Policy 名称 | 业务场景 | 安全性 | max_attempts | max_elapsed_time | 标称梯度与上限 | Ambiguous 处理 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`ai_image_generation`** | 详情页生图、局部重绘、方图生成 | `NON_IDEMPOTENT` | **3 次** | **120.0s** | $[4.0\text{s}, 15.0\text{s}]$, 封顶 30s | 遇可能到达上游异常立即停止自动重发，标记 `AMBIGUOUS_OUTCOME`，禁止自动切 Provider |
| **`ai_text_generation`** | 文案生成、Listing、Ads、翻译 | `IDEMPOTENT_SEMANTIC` | **4 次** | **60.0s** | $[2.0\text{s}, 6.0\text{s}, 15.0\text{s}]$, 封顶 20s | 安全重试 |
| **`image_download`** | 公网图片转存、CDN 拉取校验 | `SAFE` | **3 次** | **25.0s** | $[1.0\text{s}, 3.0\text{s}]$, 封顶 5s | 快速重试 |
| **`lightweight_query`** | 余额查询、模型列表、连通性测试 | `SAFE` | **2 次** | **10.0s** | $[1.5\text{s}]$, 封顶 3s | 快速恢复 |
| **`ecommerce_shopify`** | Shopify 商品创建、stagedUpload | `IDEMPOTENT` (GraphQL) | **3 次** | **45.0s** | $[2.0\text{s}, 8.0\text{s}]$, 封顶 15s | 依 Mutation Capability 安全重试 |
| **`storage_wordpress`** | WordPress 媒体上传 | `NON_IDEMPOTENT` | **2 次** | **30.0s** | $[3.0\text{s}]$, 仅握手期重试 | 发送后超时即熔断，禁止产生垃圾副本 |
| **`crawler_scrape`** | Firecrawl 竞品抓取 | `IDEMPOTENT` | **3 次** | **90.0s** | $[5.0\text{s}, 15.0\text{s}]$, 封顶 30s | 安全重试 |

---

## 3. 错误分类与决策树 (`RetryDecision`)

```python
class ErrorCategory(str, Enum):
    NETWORK_TIMEOUT = "NETWORK_TIMEOUT"
    CONNECTION_RESET = "CONNECTION_RESET"
    TEMPORARY_RATE_LIMIT = "TEMPORARY_RATE_LIMIT"
    QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"
    AUTH_ERROR = "AUTH_ERROR"
    INVALID_REQUEST = "INVALID_REQUEST"
    INVALID_MODEL = "INVALID_MODEL"
    PROVIDER_OVERLOADED = "PROVIDER_OVERLOADED"
    UPSTREAM_GATEWAY = "UPSTREAM_GATEWAY"
    AMBIGUOUS_OUTCOME = "AMBIGUOUS_OUTCOME"
    CLIENT_CANCELLED = "CLIENT_CANCELLED"
    UNKNOWN = "UNKNOWN"

@dataclass
class RetryDecision:
    retryable: bool
    category: ErrorCategory
    reason: str
    delay_seconds: float
    request_may_have_reached_upstream: bool
```

### 判决逻辑：
1. **取消中断**：`asyncio.CancelledError` 永远不捕获、不重试，直接向上冒泡；
2. **上游到达性分析 (`request_may_have_reached_upstream`)**：
   - `ConnectTimeout`, `ConnectError` $\to$ `reached = False`；
   - `ReadTimeout`, `WriteTimeout`, `RemoteProtocolError`, 发送中/后断开 $\to$ `reached = True`；
   - 若 `policy.operation_safety == "NON_IDEMPOTENT"` 且 `reached == True`，决策直接返回 `category = AMBIGUOUS_OUTCOME`, `retryable = False`。
3. **状态码分类**：
   - 400, 401, 403, 404, 422 $\to$ `retryable = False`；
   - 429 检查是否为 Quota Exhausted / Balance Insufficient（若是则 `retryable = False`），若是 Temporary Rate Limit 则 `retryable = True`；
   - 500, 502, 503, 504 $\to$ `retryable = True`。
4. **预算核算**：
   - 检查 `elapsed_time + planned_delay >= policy.max_elapsed_time`；
   - 若超预算，立即设 `retryable = False`，停止睡眠与重试。
