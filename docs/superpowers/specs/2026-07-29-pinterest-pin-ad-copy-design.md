# Pinterest PIN 广告文案设计

## 目标

在“广告文案”功能中增加与 Facebook、Google 并列的第三种广告类型 `Pinterest PIN`。用户可以单独选择或与其他平台组合选择，并在现有 9 种创意角度下生成适用于 Pinterest Pin 的双语文案。

## 用户界面

- “广告类型”区域新增 `Pinterest PIN` 复选框，提交值为 `pinterest`。
- 默认选中状态与现有 Facebook、Google 一致。
- 选择 Pinterest 后，每个创意角度的结果卡片增加 `Pinterest PIN` 区块。
- Pinterest 区块展示标题、描述、标签和 Alt 文本。
- 没有选择 Pinterest 时，结果中不展示 Pinterest 区块。
- 现有 Facebook、Google 的选择、生成、展示和复制行为保持不变。

## 数据结构

每个创意角度可以包含以下 `pinterest` 对象：

```json
{
  "pinterest": {
    "title": {
      "target": "Target-language PIN title",
      "zh": "中文对照"
    },
    "description": {
      "target": "Target-language PIN description",
      "zh": "中文对照"
    },
    "tags": [
      {
        "target": "#HomeDecor",
        "zh": "#家居装饰"
      }
    ],
    "altText": {
      "target": "Objective description of the product image",
      "zh": "图片内容的中文客观描述"
    }
  }
}
```

## 内容规则

- 标题和描述使用用户选择的目标语言，并提供中文对照。
- 每个创意角度生成 5–8 个 Pinterest 标签。
- 每个目标语言标签必须以单个 `#` 开头，例如 `#HomeDecor`。
- 中文对照标签也以单个 `#` 开头。
- 标签不包含空标签，不重复输出同一标签。
- 后端标准化 AI 输出时，为缺少 `#` 的非空标签补齐前缀，并把多个连续 `#` 归一为一个。
- Alt 文本客观描述图片中可见的产品、外观和使用场景，不加入标签，不堆砌关键词，不写无法从图片确认的属性。
- 文案继续遵守现有的可验证声明、无医疗保证、无虚假紧迫感规则。

## 后端行为

- 请求模型允许的广告平台增加 `pinterest`。
- AI 提示词增加 Pinterest 字段、标签数量和 Alt 文本要求。
- 标准化结果仅在请求包含 `pinterest` 时加入 Pinterest 数据。
- AI 缺少 Pinterest 字段时返回相同结构的空值，而不是省略或报错。
- AI 将单个标签返回为字符串时，标准化层将其转换为列表。
- 不新增数据库字段或迁移；历史记录继续保存完整广告生成结果。

## 前端展示与复制

- Pinterest PIN 使用与现有结果卡片一致的双语字段样式。
- 标题、描述和 Alt 文本作为单值字段展示。
- 标签作为列表展示，每项显示目标语言标签和中文对照。
- 点击创意角度的“复制”按钮时，如果存在 Pinterest 数据，复制文本增加 `[Pinterest PIN]` 区块，按标题、描述、标签、Alt 文本顺序输出。
- 复制内容中的标签保持 `#标签` 形式。

## 验证与错误处理

- 前端仍要求至少选择一个广告类型。
- 后端拒绝除 `facebook`、`google`、`pinterest` 之外的平台值。
- Pinterest 与其他平台组合请求时，结果只包含所选平台。
- AI 返回缺失、字符串或部分错误的 Pinterest 字段时，标准化层提供稳定结构。

## 测试

- 请求模型测试覆盖 `pinterest` 为合法平台及未知平台仍被拒绝。
- 服务测试覆盖 Pinterest 字段标准化、空字段填充、标签列表转换、`#` 补齐、重复标签去除和未选择时省略。
- 提示词测试覆盖 Pinterest 字段和 5–8 个标签要求。
- 前端测试覆盖第三个复选框、请求中包含 `pinterest`、结果展示和复制文本。
- 回归测试确认 Facebook、Google 现有结构不变。

## 非目标

- 不增加 Pinterest 图片生成、Pin 发布或 Pinterest API 集成。
- 不增加独立 Pinterest 页面。
- 不增加 Pin 链接、Board、受众或预算配置。
- 不修改现有 9 种创意角度。
