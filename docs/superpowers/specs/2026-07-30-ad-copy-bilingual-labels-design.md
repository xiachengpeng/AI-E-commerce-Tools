# 广告文案结果双语字段标签设计

## 目标

将“广告文案结果”中的产品、平台区块和字段标题统一改为中英文对照，解决当前字段标签只显示英文、不便于中文用户快速识别的问题。

本次只调整页面展示标签，不修改 AI 输出、后端字段、复制文本或历史数据。

## 展示格式

- 所有双语标签使用同一行展示。
- 中文在前，英文在后。
- 中文与英文之间固定使用空格、斜杠、空格：

```text
中文 / English
```

- 保持现有标签字号、字重、颜色、间距和大写样式。
- 不增加第二行副标题、悬浮提示或额外图标。

## 固定标签映射

### 产品区块

| 当前标签 | 新标签 |
|---|---|
| Product | 产品 / Product |
| Name | 产品名称 / Name |
| Summary | 产品概述 / Summary |

### Facebook 区块

| 当前标签 | 新标签 |
|---|---|
| Facebook Ads | Facebook 广告 / Facebook Ads |
| Primary Text | 主文案 / Primary Text |
| Headline | 标题 / Headline |
| Description | 描述 / Description |
| CTA | 行动按钮 / CTA |
| Creative Direction | 创意方向 / Creative Direction |

### Google 区块

| 当前标签 | 新标签 |
|---|---|
| Google Ads | Google 广告 / Google Ads |
| Headlines | 标题 / Headlines |
| Descriptions | 描述 / Descriptions |
| Keywords | 关键词 / Keywords |
| Sitelinks | 附加链接 / Sitelinks |

### Pinterest 区块

| 当前标签 | 新标签 |
|---|---|
| Pinterest PIN | Pinterest PIN |
| Title | 标题 / Title |
| Description | 描述 / Description |
| Alt Text | 替代文本 / Alt Text |

Pinterest 平台名称本身已经是正式产品名称，不添加重复中文翻译。

## 不变的标题

- 创意角度标题已经同时显示中文名称和英文名称，保持不变。
- 创意逻辑正文保持现有语言和样式。
- 平台筛选按钮继续显示：
  - 全部平台
  - Facebook
  - Google
  - Pinterest PIN
- 创意角度筛选标签和下拉选项保持现状。
- 左侧生成表单、按钮和页面导航不属于本次修改范围。

## 前端结构

在 `frontend/js/ads.js` 增加集中式不可变映射：

```javascript
const ADS_RESULT_LABELS = Object.freeze({
    product: '产品 / Product',
    productName: '产品名称 / Name',
    productSummary: '产品概述 / Summary',
    facebook: 'Facebook 广告 / Facebook Ads',
    facebookPrimaryText: '主文案 / Primary Text',
    facebookHeadline: '标题 / Headline',
    facebookDescription: '描述 / Description',
    facebookCta: '行动按钮 / CTA',
    facebookCreativeDirection: '创意方向 / Creative Direction',
    google: 'Google 广告 / Google Ads',
    googleHeadlines: '标题 / Headlines',
    googleDescriptions: '描述 / Descriptions',
    googleKeywords: '关键词 / Keywords',
    googleSitelinks: '附加链接 / Sitelinks',
    pinterest: 'Pinterest PIN',
    pinterestTitle: '标题 / Title',
    pinterestDescription: '描述 / Description',
    pinterestAltText: '替代文本 / Alt Text',
});
```

所有结果渲染分支从该映射读取标签，不在调用点重复拼接中文和英文。

## 数据与行为

- `appendAdsPair()` 和 `appendAdsPairList()` 的接口保持不变，继续接收已格式化的标签字符串。
- Product、Facebook、Google、Pinterest 渲染调用改为传入映射值。
- 映射仅包含可信的静态界面文案。
- 模型返回内容继续通过安全文本节点插入。
- 页面重新筛选或重新渲染时使用相同映射。

## 复制行为

剪贴板格式保持现状：

- Facebook 复制字段名称仍使用当前英文格式。
- Google 复制字段名称仍使用当前英文格式。
- Pinterest 复制字段名称仍使用当前中英文行结构。
- 不把页面双语 UI 标签直接复用到复制输出。

保持复制格式不变可避免影响已依赖当前文本结构的用户和下游流程。

## 错误处理与兼容

- 缺失模型字段时仍显示稳定的双语字段标签和现有空值占位。
- 平台筛选只改变可见区块，不改变标签映射。
- 创意角度筛选只改变卡片集合，不改变标签映射。
- 异常历史结果中的动态名称继续作为纯文本处理。
- 不增加后端接口、数据库字段、请求参数或历史迁移。

## 测试

### 映射完整性

- `ADS_RESULT_LABELS` 包含产品、Facebook、Google 和 Pinterest 的全部区块及字段标签。
- 映射值与本规格中的固定文案逐字一致。

### 页面渲染

- 产品区块显示 3 个规定的双语标签。
- Facebook 区块显示 6 个规定的双语标签。
- Google 区块显示 5 个规定的双语标签。
- Pinterest 区块显示平台名称和 3 个规定的双语字段标签。
- 同一创意卡片包含多个平台时，每个平台使用自己的正确标签。

### 回归

- 平台筛选后的区块继续显示正确双语标签。
- 创意角度筛选不改变标签内容。
- 复制文本保持修改前格式。
- Pinterest 描述与标签无空格合并逻辑保持不变。
- 动态正文继续通过安全文本插入。
- 后端完整测试不受影响。

## 非目标

- 不翻译 AI 生成正文。
- 不修改复制文本的标签格式。
- 不修改平台筛选按钮。
- 不修改创意角度名称。
- 不调整字段卡片布局或视觉样式。
- 不修改后端模型、提示词、响应结构或数据库。
