# OpenAI Compatible 图片生成模式设计

## 背景

当前所有 OpenAI Compatible 图片请求都以 JSON 发送到 `/v1/images/generations`，并把上传图片放在非标准的 `input_images` 字段中。部分中转站会忽略该字段但仍返回一张文生图结果，导致详情页提示词虽然要求产品一致，生成图却没有真正使用产品参考图。

本功能为每条 OpenAI Compatible 线路新增固定的图片生成模式，让用户明确选择文生图或图生图，并据此访问对应接口。Google Gemini 与 Vertex AI 继续使用原生多模态调用，不受该设置影响。

## 目标

- 每条 OpenAI Compatible 线路独立选择并持久保存图片生成模式。
- 文生图固定调用 `/v1/images/generations`。
- 图生图固定调用 `/v1/images/edits`，以标准 multipart 图片字段提交参考图。
- 设置保存后立即生效，无需重启服务。
- 图生图缺少参考图或接口不兼容时保持失败关闭，不偷偷改走文生图。
- 详情页保留现有本地 HTML/CSS 降级，不新增第二次图片 AI 请求。
- 旧配置、旧历史、Google/Vertex 和当前前端标准响应保持兼容。

## 非目标

- 不自动探测中转站支持哪种图片接口。
- 不在同一次失败请求中自动切换文生图或图生图。
- 不为同一条线路分别配置自定义生成和编辑路径。
- 不改变各业务模块的提示词、产品锁定规则或本地降级视觉。
- 不修改文本能力路由。

## 配置模型

### 持久化字段

在 `AIProviderConfig` 新增 `image_generation_mode` 字段，允许值：

- `text_to_image`
- `image_to_image`

数据库字段非空，默认值为 `image_to_image`。启动时的幂等数据库升级负责为旧数据库补列；已有记录在缺少该列时统一得到 `image_to_image`，以优先保证包含产品参考图的业务一致性。

该字段加入提供商的：

- 写入与读取模型。
- 校验和序列化。
- 运行时相关字段。
- 连接测试快照。
- `ProviderSnapshot`。

更改模式会递增 `config_version`、清除旧连接测试状态，并使下一次请求立即使用新模式。

### 协议范围

- OpenAI Compatible：字段参与运行时行为。
- Gemini/Vertex：设置页隐藏此字段，适配器忽略该字段。
- API 仍返回一个规范化值，避免前端编辑旧记录时出现空状态。

## 设置页交互

当协议为 OpenAI Compatible 且启用图片能力时，在图片模型配置附近显示“图片生成方式”，使用两个互斥选项：

1. `文生图`
   - 说明：调用 `/v1/images/generations`，不使用上传图片作为参考。
2. `图生图`
   - 说明：调用 `/v1/images/edits`，上传图片作为产品参考。

交互规则：

- 新建 OpenAI Compatible 图片线路默认选择图生图。
- 编辑缺少该字段的旧线路时显示图生图。
- 切换到 Gemini/Vertex 时隐藏该选项。
- 切回 OpenAI Compatible 时恢复当前草稿或已保存值。
- 线路列表增加“文生图”或“图生图”徽标，仅对支持图片的 OpenAI Compatible 线路显示。
- 表单保存、草稿连接测试和已保存线路连接测试都携带该模式。

## 请求路由

### 文生图模式

当 `image_generation_mode == text_to_image`：

- 请求：`POST {base_url}/v1/images/generations`
- Content-Type：`application/json`
- 请求体包含模型、提示词、响应格式以及中转站支持的尺寸参数。
- 即使上游业务 payload 包含参考图，也不把图片发送到生成接口；用户选择文生图即明确选择只使用文字提示词。

### 图生图模式

当 `image_generation_mode == image_to_image`：

- 先从 Gemini 风格业务 payload 的 `inlineData` / `inline_data` 中提取一张或多张参考图。
- 没有有效参考图时，在发出外部 HTTP 请求之前抛出明确的协议错误。
- 请求：`POST {base_url}/v1/images/edits`
- Content-Type：`multipart/form-data`
- 每张参考图作为重复的 `image[]` 文件字段上传。
- 表单字段包含模型、提示词、响应格式以及可安全映射的尺寸参数。
- 不在失败后改走 `/images/generations`。

适配器必须验证 Base64、MIME 类型和图片大小，文件名使用安全的内部分配名称，不信任浏览器文件名。

## 响应归一化

两种模式都保持当前前端期望的 Gemini 风格响应：

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "inlineData": {
              "mimeType": "image/png",
              "data": "..."
            }
          }
        ]
      }
    }
  ]
}
```

中转站响应支持：

- `data[0].b64_json`：验证并直接归一化。
- `data[0].url`：后端仅允许 HTTP/HTTPS，并在首次请求和每次重定向前拒绝环回、私网、链路本地及其他非公网目标；使用受限超时、重定向次数和响应大小下载，验证为真实图片后转为 Base64，再归一化。

不把不可信 URL 直接交给浏览器。响应缺少图片、图片无效或下载失败时按提供商协议错误处理。

## 连接测试

### 文生图

沿用现有最小图片生成提示词，调用 `/v1/images/generations`，验证返回值可解码为真实图片。

### 图生图

后端生成一张体积极小、格式确定的测试图片作为输入，调用 `/v1/images/edits`，验证：

- 目标接口可访问。
- multipart 图片字段被接受。
- 返回值可解码为真实图片。

连接成功仅表示接口契约和图片返回可用，不宣称模型一定能达到业务层面的产品一致性。

## 错误与降级

- 图生图缺少参考图：请求前失败，图片提供商收到零次外部请求。
- 中转站不支持 `/images/edits`、拒绝 multipart、返回格式异常：返回明确诊断，不切换接口。
- 详情页捕获图片错误后沿用现有本地 HTML/CSS 模块降级；降级本身不调用第二个图片接口。
- 详情页 SEO 元数据仍可通过独立文本能力调用，不与图片降级耦合。
- 其他业务模块保留各自现有错误或降级逻辑。
- 已发出的中转站请求如果超时或失败，随后进入降级并不能撤销已经发生的外部调用。

## 日志与安全

AI 日志增加安全的结构化字段：

- `image_generation_mode`
- 目标接口类型，例如 `images.generations` 或 `images.edits`

继续禁止记录：

- API Key 和 Authorization。
- 图片 Base64、multipart 文件内容或图片 URL 中的敏感查询参数。
- 完整提示词和提供商敏感响应。

日志清洗继续保持失败关闭。

## 兼容性与迁移

- 启动升级幂等，多次启动不会重复迁移或覆盖用户选择。
- 旧数据库的 OpenAI Compatible 线路默认图生图。
- 新建 OpenAI Compatible 线路默认图生图。
- Google/Vertex 运行路径不改变。
- 旧业务历史不需要增加该字段；恢复历史后产生的新请求使用当前线路模式。
- 当前标准化响应结构保持不变，业务前端无需针对协议分支。

## 测试策略

### 后端

- 数据库升级为旧表补充字段且可重复运行。
- 提供商创建、更新、读取、默认值和非法枚举校验。
- 模式变化递增配置版本并清除旧测试状态。
- Snapshot 正确携带模式。
- 文生图发送 `/images/generations` JSON，且不发送参考图字段。
- 图生图发送 `/images/edits` multipart，包含一张及多张 `image[]`。
- 图生图缺图时外部 HTTP 客户端零调用。
- Base64 和 URL 两种响应都被安全归一化。
- URL 响应下载覆盖非公网地址、恶意重定向、超时、超大响应和伪造图片的拒绝测试。
- 图生图连接测试携带内置测试图。
- Gemini/Vertex 回归测试保持通过。

### 前端

- 选项只在 OpenAI Compatible 图片线路显示。
- 新建和旧配置默认图生图。
- 编辑、保存和草稿测试携带正确模式。
- 协议切换隐藏或恢复选项。
- 提供商卡片显示模式徽标且转义不可信文本。

### 完整验证

- `python -m pytest backend/tests`
- `node --test frontend/tests/*.test.js`
- 对修改的 JavaScript 文件执行 `node --check`。
- `git diff --check`

## 验收标准

- 用户可以为每条 OpenAI Compatible 图片线路选择文生图或图生图，并在保存后立即生效。
- 文生图只访问 `/v1/images/generations`。
- 图生图只访问 `/v1/images/edits` 并真正上传业务参考图。
- 图生图缺少参考图时没有外部图片请求，并由业务模块进入现有降级逻辑。
- 接口失败不会静默切换模式。
- 现有 Google/Vertex、历史恢复、日志脱敏和前端响应兼容性不回归。
