# CC Switch 风格独立用量查询配置面板与脚本引擎设计规范

## 1. 业务背景与问题分析 (Background & Problem)

系统已初步具备基础的 AI 中转站余额查询能力，支持 New-API 访问令牌和自动探测。但在实际使用中：
1. **中转站接口多样性与非标性**: 跨国外各中转站、聚合站、私有 API Gateway 的余额接口路径与响应结构千差万别（有的用 `/v1/usage`，有的用 `/api/user/self`，有的返回 `quota` 需除以 500,000，有的用 `remaining`，有的返回套餐名 `group`）。
2. **缺乏可视化脚本自由度**: 无法让高阶用户或站长根据特定中转站文档自由定义提取逻辑。
3. **CC Switch 成熟设计范式**: 知名开源工具 CC Switch 的【配置用量查询】面板提供了公认最佳的 UX 交互（预设模板切换、参数配置覆盖、深色代码编辑器、格式化与测试脚本运行）。
4. **面向未来 APP 打包的轻量架构诉求**: 用户明确提出后续可能将本项目打包为桌面端或移动端 APP（如 Tauri / Electron 等）。因此，系统架构必须保持后端纯净，避免在 Python 中编译 C 扩展 JS 运行时，同时彻底规避浏览器端的 CORS 跨域拦截。

---

## 2. 系统架构与交互设计 (Architecture & Design)

### 2.1 整体架构：APP-Ready 混合式执行模型

```text
┌─────────────────────────────────────────────────────────────┐
│ 前端 / 客户端 (Browser / Future Tauri / Electron Webview)   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ CC Switch 风格【配置用量查询】弹窗                  │   │
│   │  - 预设模板: [自定义] [通用模板] [NewAPI] ...       │   │
│   │  - 凭证与参数: API Key / 请求地址 / 超时 / 自动间隔 │   │
│   │  - 提取器代码: request + extractor(response)         │   │
│   └──────────────────────────┬──────────────────────────┘   │
│                              │ 1. 触发测试或保存            │
│                              ▼                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ 客户端 JS 沙箱运行环境 (Native Web Sandbox)         │   │
│   │  - 解析 request 结构与提取器函数                    │   │
│   │  - 变量插值: {{baseUrl}}, {{apiKey}}, {{accessToken}}│   │
│   │  - 执行 extractor(response) 获取 balance 数据       │   │
│   └──────────────▲──────────────────────────┬───────────┘   │
└──────────────────┼──────────────────────────┼───────────────┘
                   │ 4. 原始 JSON 数据        │ 2. 免跨域代理请求
                   │                          ▼
┌──────────────────┴──────────────────────────────────────────┐
│ 本地 Python FastAPI 后端 (Local Daemon / Backend Server)     │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ POST /api/settings/ai/providers/usage-query/proxy   │   │
│   │  - 凭证继承: 若参数留空，自动安全装配已保存的 Key   │   │
│   │  - 安全无 CORS 发起 HTTP 请求 (httpx)               │   │
│   │  - 敏感信息抹除与诊断日志输出                       │   │
│   └──────────────────────────┬──────────────────────────┘   │
│                              │ 3. 发起外部网络请求          │
│                              ▼                              │
│                ┌───────────────────────────┐                │
│                │ 目标中转站 / 官方 API 接口│                │
│                └───────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

---

### 2.2 交互规范与界面组件 (`#settingsUsageQueryModal`)

在设置中心中，将入口无缝融入现有的 AI 线路卡片：

1. **入口设计 (Entry Point)**:
   - 在每张 OpenAI 兼容协议线路卡片的右上角操作区（【测试】与【编辑】按钮旁），提供专属的【💳 用量配置】操作按钮 (`.settings-provider-usage-action`)。
   - 点击即可呼出对应线路的专属大弹窗《配置用量查询 - 线路名称》。
2. **顶部导航与标题栏**:
   - 左侧返回箭头 `←` + 标题 `配置用量查询 - {{provider.name}}`。
   - 点击返回箭头或右上角关闭均可平滑退出。
3. **预设模板分段切换器 (Segmented Pills)**:
   - 按钮组：`[自定义]`、`[通用模板]`、`[NewAPI]`、`[Token Plan]`、`[官方]`。
   - 点击任一预设模板，编辑器代码区平滑载入对应的标准模板，并自动调整参数配置。
4. **凭证配置 (Credentials Config)**:
   - 提示微标：`留空则自动使用供应商配置`。
   - `API Key (可选)`：支持覆盖默认 Key。
   - `请求地址 (可选)`：支持覆盖默认 Base URL。
   - `超时时间 (秒)`：默认 `10`。
   - `自动查询间隔 (分钟, 0 表示不自动查询)`：默认 `30`。
5. **提取器代码区 (Extractor Code Editor)**:
   - 包含等宽字体、深色终端背景、行号或缩进辅助的只读/编辑区域。
   - 标题副文案：`返回对象需包含剩余额度等字段`。
6. **底部操作栏**:
   - `▷ 测试脚本`: 调用本地免跨域代理，在浏览器执行提取器，展示提取结果卡片（`套餐名`、`剩余额度`、`已用额度`、`总额度`、`货币`、`有效性`）及原始 JSON 响应折叠。
   - `🪄 格式化`: 对代码进行规范的缩进与美化排版。
   - `取消` 与 `💾 保存配置`。

---

## 3. 预设模板代码库 (Pre-configured Templates)

### 3.1 通用模板 (`general`) — 只需要 API Key
```javascript
({
  request: {
    url: "{{baseUrl}}/v1/usage",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    const remaining = response?.remaining ?? response?.quota?.remaining ?? response?.balance;
    const unit = response?.unit ?? response?.quota?.unit ?? "USD";
    return {
      isValid: response?.is_active ?? response?.isValid ?? true,
      remaining,
      unit
    };
  }
})
```

### 3.2 New-API 模板 (`newapi`) — 完整版（支持 Access Token 与 User ID）
```javascript
({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "User-Agent": "cc-switch/1.0",
      "New-Api-User": "{{userId}}"
    },
  },
  extractor: function (response) {
    if (response.success && response.data) {
      return {
        planName: response.data.group || "默认套餐",
        remaining: response.data.quota / 500000,
        used: response.data.used_quota / 500000,
        total: (response.data.quota + response.data.used_quota) / 500000,
        unit: "USD",
      };
    }
    return {
      isValid: false,
      invalidMessage: response.message || "查询失败"
    };
  },
})
```

### 3.3 Token Plan 模板 (`token_plan`) — One-API 订阅模式
```javascript
({
  request: {
    url: "{{baseUrl}}/v1/dashboard/billing/subscription",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    const hardLimit = response?.hard_limit_usd ?? response?.hard_limit ?? 0;
    return {
      isValid: response?.is_active ?? true,
      remaining: Number(hardLimit).toFixed(2),
      unit: "USD"
    };
  }
})
```

### 3.4 官方直连模板 (`official`) — DeepSeek / OpenRouter / SiliconFlow 自适应
```javascript
({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    if (response?.balance_infos && response.balance_infos.length > 0) {
      const info = response.balance_infos[0];
      return {
        remaining: parseFloat(info.total_balance || 0),
        unit: info.currency || "CNY",
        isValid: true
      };
    }
    return {
      remaining: response?.data?.balance ?? response?.total_available,
      unit: "USD",
      isValid: true
    };
  }
})
```

---

## 4. 数据存储与 API 规范 (Data Schema & API Endpoints)

### 4.1 数据库字段扩展 (`AIProviderConfig` in `backend/db.py`)
- `balance_template`: `str | None`，记录当前启用的模板标识（`general` / `newapi` / `token_plan` / `official` / `custom`）。
- `balance_script`: `str | None`，存储提取器脚本代码全文。
- `balance_custom_key`: `str | None`，可选独立 API Key 覆盖。
- `balance_custom_url`: `str | None`，复用或映射 `custom_balance_url`。
- `balance_timeout`: `int | None`，超时秒数（默认 10）。
- `balance_auto_interval`: `int | None`，自动查询间隔分钟（默认 30，0 表示关闭）。

### 4.2 后端免跨域代理与保存端点 (`backend/main.py`)
1. **免跨域代理请求端点**:
   - `POST /api/settings/ai/providers/usage-query/proxy`
   - 请求体:
     ```json
     {
       "provider_id": 1,
       "url": "https://api.relay.com/v1/usage",
       "method": "GET",
       "headers": {
         "Authorization": "Bearer {{apiKey}}"
       },
       "timeout_seconds": 10
     }
     ```
   - 后端逻辑：将 `{{apiKey}}`、`{{accessToken}}`、`{{baseUrl}}`、`{{userId}}` 替换为线路对应存储的值；由 `httpx` 发起请求，返回状态码与原始响应数据。
2. **保存配置端点**:
   - `PUT /api/settings/ai/providers/{provider_id}/usage-query`
   - 更新数据库并同步返回更新后的配置。

---

## 5. 验证与回归体系 (Testing & Verification Plan)

1. **后端单元测试 (`backend/tests/test_ai_usage_query.py`)**:
   - 验证免跨域代理接口在缺失凭据时的自动继承与安全脱敏。
   - 验证配置保存、字段向下兼容性与非法 URL 校验。
2. **前端单元测试 (`frontend/tests/settings_usage_query.test.js`)**:
   - 验证各预设模板（通用、NewAPI、Token Plan、官方）代码语法有效性。
   - 验证沙箱执行器对 `extractor(response)` 的提取正确性（包含 New-API 的 `quota / 500000` 运算与 `isValid: false` 错误拦截）。
   - 验证弹窗 DOM 结构、模板切换联动与代码格式化函数。
3. **双端全量回归**:
   - 运行前端 `node --test` 与后端 `pytest`，确保所有现有 976 项测试及新增用例 100% 通过。
