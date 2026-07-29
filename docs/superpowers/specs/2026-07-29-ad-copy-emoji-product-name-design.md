# 广告文案 Emoji、标签合并与产品名称辅助识别设计

## 目标

增强现有“广告文案”功能：

1. Facebook、Google 和 Pinterest PIN 的标题及描述类文案根据语义加入适量 Emoji。
2. Pinterest 标签不再单独展示，而是直接无空格拼接在对应语言的描述后面。
3. 增加可选“产品名称”输入框；未填写时仅识别图片，填写时结合图片和产品名称识别。

本次修改继续复用现有广告文案 AI 路由、模型配置、9 种创意角度和历史保存结构。

## 用户界面

### 产品名称输入

- 在“商品图片”区域下方增加“产品名称”输入框。
- 输入框为选填项，提示文字为“选填，填写后将结合图片识别”。
- 产品名称最多 200 个字符。
- 用户未填写或只输入空白字符时，按未提供产品名称处理。
- 用户填写后，前端去除首尾空格，并随广告生成请求提交。

### Pinterest PIN 结果布局

- 保留 `Title`、`Description` 和 `Alt Text`。
- 移除独立的 `TAGS` 展示卡片。
- 目标语言标签直接拼接在目标语言描述后：

```text
Description text#Tag1#Tag2
```

- 中文标签直接拼接在中文描述后：

```text
中文描述文案#标签1#标签2
```

- 描述与首个标签之间、标签与标签之间均不加入空格。
- 标签仍使用单个 `#` 前缀。

## Emoji 内容规则

Emoji 由 AI 根据文案语义选择，不由前端或后端使用固定映射强制补齐。

### 需要 Emoji 的字段

- Facebook：
  - `primaryText`
  - `headline`
  - `description`
- Google：
  - `headlines`
  - `descriptions`
- Pinterest PIN：
  - `title`
  - `description`

### 不使用 Emoji 的字段

- Facebook：`cta`、`creativeDirection`
- Google：`keywords`、`sitelinks`
- Pinterest PIN：`tags`、`altText`
- 产品名称和产品摘要结构不增加强制 Emoji 规则。

### 数量和质量要求

- 每个需要 Emoji 的单个文案字段使用 1–2 个 Emoji。
- Emoji 必须与字段语义相关。
- 不连续堆叠相同或无关 Emoji。
- Emoji 可以放在句首、句中自然位置或句尾，但不能破坏可读性。
- 目标语言和中文对照分别生成自然的 Emoji 文案；两种语言不要求 Emoji 位置完全一致，但语义应一致。

## 请求数据

广告文案请求增加可选字段：

```json
{
  "product_name": "Padel racket"
}
```

- 字段名固定为 `product_name`。
- 类型为可选字符串。
- 后端去除首尾空格。
- 空字符串或纯空白字符串规范化为 `null`。
- 非空值最多 200 个字符；超过限制时返回请求校验错误。
- 现有请求字段和平台标识保持不变。

## AI 识别行为

### 未提供产品名称

- AI 仅根据上传图片识别产品。
- 保持当前图片识别和文案生成逻辑。

### 提供产品名称

- AI 同时使用图片和 `product_name` 理解产品。
- 产品名称作为产品身份参考，降低图片误识别概率。
- 图片继续作为外观、颜色、数量、材质表现和使用场景的视觉依据。
- 产品名称不能授权 AI 编造图片中不可见或无法确认的属性、功效或承诺。
- 产品名称不要求原样出现在每一条广告文案中。

## 后端行为

- `AdCopyGenerateRequest` 增加可选 `product_name`。
- 产品名称沿用后端代理和现有 AI capability 路由，不增加浏览器直连或独立 AI 配置。
- `_ads_prompt` 根据是否提供产品名称输出不同指令：
  - 无名称：明确仅根据图片识别产品。
  - 有名称：在提示词中加入规范化后的产品名称，并明确“图片为视觉事实依据”。
- 提示词统一加入三个平台的 Emoji 字段规则和 1–2 个数量限制。
- Pinterest 的结构化结果继续保留独立 `description` 和 `tags` 字段。
- 标签的 `#` 修复、去空、去重和最多 8 项规范化保持不变。
- 不修改数据库结构；历史记录继续保存完整请求上下文和生成结果。如果当前历史请求摘要未保存 `product_name`，本次不增加数据库迁移。

## 前端行为

- `generateAdsCopy()` 读取并规范化产品名称输入。
- 非空产品名称作为 `product_name` 加入现有请求。
- Pinterest 渲染时构造两个展示值：
  - `targetDescription = description.target + targetTags.join('')`
  - `zhDescription = description.zh + zhTags.join('')`
- 标签只合并到对应语言描述，不跨语言混用。
- 动态文案继续通过安全文本节点插入，不使用模型内容拼接 `innerHTML`。
- Facebook 和 Google 的现有结果布局保持不变。

## 复制格式

Pinterest PIN 的复制区块改为：

```text
[Pinterest PIN]
Title: 🎾 Target title
标题: 🎾 中文标题
Description: Target description#Tag1#Tag2
描述: 中文描述#标签1#标签2
Alt Text: Objective alt text
替代文本: 客观中文 Alt 文本
```

- 不再输出独立 `Tags:` 或 `标签:` 行。
- 标签拼接规则与页面展示一致。
- Facebook 和 Google 继续使用现有复制结构，但生成文案中会包含 AI 返回的语义 Emoji。

## 验证与错误处理

- 商品图片仍为必填项。
- 产品名称为选填项。
- 空白名称不会改变原有仅图片识别行为。
- 超过 200 个字符的名称由后端返回 422 校验错误。
- AI 未正确遵守 Emoji 数量属于生成质量问题，不在后端使用固定 Emoji 二次改写，避免语义不匹配。
- AI 返回缺失 Pinterest 标签时，描述正常显示，不追加任何空标签。
- 部分标签仅存在一种语言时，只追加到存在值的对应语言描述。

## 测试

### 后端

- 请求模型接受缺省、空白和有效 `product_name`。
- 空白名称规范化为 `null`。
- 超过 200 个字符的名称被拒绝。
- 有名称时提示词包含规范化后的产品名称和图片事实约束。
- 无名称时提示词包含仅图片识别指令。
- 提示词覆盖三个平台对应的 Emoji 字段和每字段 1–2 个限制。
- 提示词明确 CTA、Creative Direction、Keywords、Sitelinks、Tags 和 Alt Text 不使用 Emoji。

### 前端

- 页面存在可选产品名称输入框和说明。
- 请求在有输入时包含去除首尾空格后的 `product_name`。
- 空白输入不作为有效产品名称提交。
- Pinterest 页面不渲染独立 `Tags` 字段。
- 目标语言描述无空格拼接目标语言标签。
- 中文描述无空格拼接中文标签。
- 复制内容不包含独立标签行，并保留标题、合并后的描述和 Alt Text 顺序。
- 恶意或 HTML 形式的描述、标签继续作为纯文本处理。

### 回归

- Facebook、Google、Pinterest 仍可单独或组合生成。
- 9 种创意角度和平台结果结构保持不变。
- 现有 AI 配置、能力路由、图片上传、历史保存和错误提示保持可用。

## 非目标

- 不为 Emoji 建立固定关键词映射表。
- 不在后端强制插入或替换 Emoji。
- 不让用户单独配置 Emoji 数量或开关。
- 不把 Pinterest 标签合并写回后端的 `description` 字段。
- 不增加数据库迁移。
- 不修改图片识别模型或新增 AI 提供商配置。
