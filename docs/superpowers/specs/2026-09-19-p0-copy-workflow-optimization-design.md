# P0 级全链路业务流程与文案规则优化设计规范 (Design Spec)

- **创建日期**: 2026-09-19
- **阶段目标**: 解决跨模块流转死锁、Google RSA 广告字符超限拒审、竞品分析关键词语义倒错等致命业务阻塞与合规红线问题。
- **状态**: 待确认评审 (Draft for Review)

---

## 1. 背景与问题陈述 (Context & Problem Statement)

在用户实际的跨境电商选品与营销运营中，现存系统存在三项阻断正常流转与平台合规的 P0 级严重问题：

1. **跨模块“带入广告”引发生成死锁**：
   - 用户从【竞品分析】或【Listing 模块】点击“带入广告文案”后，页面跳转并填入商品名称，但因前端与后端强制要求上传图片，点击“生成广告文案”时直接弹红字报错 `请先上传商品图片`。若用户暂无白底图，整个广告文案模块完全瘫痪。
2. **Google 响应式搜索广告 (RSA) 字符超限导致平台拒审**：
   - Google 搜索广告规范严格限定：标题 (Headlines) 不得超过 30 字符（含空格），描述 (Descriptions) 不得超过 90 字符。当前 AI 提示词没有任何字数硬性限制，经常生成 40~50 字符的标题，导致卖家复制到 Google Ads 投放后台时直接报错被拒。
3. **竞品分析 -> Listing 关键词提取语义严重倒错**：
   - 竞品分析向 Listing 传递关键词时，将“使用场景”和“目标人群标签”（如：`办公室午休, 程序员, 宝妈`）塞入了主打关键词输入框。在跨境电商搜索算法（如亚马逊 A9、Walmart 搜索）中，这些是人群标签而非买家搜索词，严重污染搜索词权重。

---

## 2. 目标与非目标 (Goals & Non-Goals)

### 目标 (Goals)
1. **广告模块双模态生成**：支持“纯文本快速生成”与“图文多模态生成”双轨运行；有图时结合实物细节，无图时基于商品名、卖点与关键词生成。
2. **跨模块图文资产全量继承**：从竞品分析或 Listing 带入广告时，同步带入商品名、核心卖点，若已有图片资产则自动无缝继承，无需重复上传。
3. **Google RSA 30/90 字符刚性约束**：在 AI 提示词中建立铁律，严格限制 5 组标题每组 ≤ 30 字符、3 组描述每组 ≤ 90 字符、附加链接 ≤ 25/35 字符。
4. **Meta/Instagram 125 字符移动端黄金折叠线前置**：主文案核心 Hook 与痛点在前 125 字符内爆发。
5. **关键词语义归位**：竞品分析转 Listing 时，关键词精准提取核心类目词与属性词，人群/场景归入卖点背景。

### 非目标 (Non-Goals)
- 本阶段不修改商详 18 模块预设布局与 UI 样式（此为 P1 阶段任务）。
- 本阶段不增加新的第三方存储或图像生成模型。

---

## 3. 详细架构与实现方案 (Detailed Design)

### 3.1 后端模型更新 (`backend/models/request.py`)
更新 `AdCopyGenerateRequest`：
- `image_data: str | None = None`：将图片字段改为可选（原为必填 `str`）。
- 新增可选字段：
  - `selling_points: str | None = None`
  - `keywords: str | None = None`
- 校验器逻辑：当 `image_data` 为空时，校验 `product_name` 不得为空白；若两者均为空，抛出 422 验证异常。

### 3.2 广告服务增强 (`backend/services/ads_service.py`)
1. **`generate_ad_copy(request)` 双模态调度**：
   - 若 `request.image_data` 存在且非空：执行 `_validate_image_data` 并组装 `inlineData` 多模态 payload（保留现有视觉分析优势）。
   - 若 `request.image_data` 为空：组装纯文本 payload（仅含 `_ads_prompt(request)`），调用文本生成模型。
2. **`_ads_prompt(request)` 规则强化**：
   - 适配纯文本与图文模式描述。
   - 规则 6（Meta）：
     `6. Facebook / Instagram copy: Front-load the core hook and customer benefit within the FIRST 125 CHARACTERS of primary text before the mobile "...See more" fold line. Keep headlines punchy (25-40 chars).`
   - 规则 7（Google RSA 刚性字符硬顶）：
     `7. Google Responsive Search Ads (RSA) STRICT CHARACTER CAPS: Provide 5 headlines, 3 descriptions, 8 keywords, and 4 sitelinks. MANDATORY LIMITS: Every single headline MUST be strictly <= 30 characters (including spaces). Every single description MUST be strictly <= 90 characters (including spaces). Sitelink title <= 25 chars, descriptions <= 35 chars. ABSOLUTELY NEVER EXCEED THESE LIMITS.`

### 3.3 前端广告交互优化 (`frontend/js/ads.js`)
1. **解除硬性无图拦截**：
   - 改造 `generateAdsCopy()`：
     - 如果既无图片，又无商品名称（`productName.trim() === ''`），弹出轻提示：`showToast('请上传商品图片或输入商品名称', 'warning')`；
     - 只要有图片或有商品名称其中之一，即可正常发起生成请求。
2. **上传框微文案与视觉优化**：
   - 提示文案调整为：`"上传商品图片 (可选，上传可分析实物材质细节；未上传则基于商品信息与卖点生成)"`。
3. **跨模块接收函数升级**：
   - 提供 `window.receiveAdsTransferData(data)`，支持同时接收 `product_name`、`selling_points`、`image_base64`，并动态填充到广告界面中。

### 3.4 跨模块流转语义纠偏 (`frontend/js/analysis.js` & `frontend/js/listing.js`)
1. **`analysis.js: xp_transferToListing`**：
   - 修正关键词生成逻辑：优先从 `d.category`（类目词，如 `Ergonomic Office Chair`）以及 `d.product_name` 提取 3-5 个高频电商搜索词。
   - `use_scenarios` 和 `target_audience` 严禁填入 `listingKeywords`，而是规范排版后写入 `listingPoints`（【目标人群与核心场景】小节）。
2. **`analysis.js: xp_transferToAds`**：
   - 传递 `product_name`、`core_selling_points`、`target_audience`，若有商品图 URL/Base64 则传递。
3. **`listing.js: transferListingToAds`**：
   - 提取当前 Listing 标题、前 3 个 Bullets 拼接作为核心卖点，一并注入广告模块输入框；若 Listing 存在解析原图，一并传递。

---

## 4. 验证计划 (Verification Plan)

### 4.1 自动化测试
1. **后端 pytest**：
   - 编写 `backend/tests/test_ads_dual_mode.py`：
     - 测试纯文本模式（无 `image_data`）的请求与 Prompt 结构；
     - 测试同时提供图片的多模态请求；
     - 测试完全无图且无商品名时的 422 拒绝机制；
     - 测试 Google RSA 提示词中包含 30/90 字符强约束。
2. **前端 node --test**：
   - 编写 `frontend/tests/ads_and_transfer_p0.test.js`：
     - 验证 `xp_transferToListing` 提取关键词时不包含人群标签（如程序员、宝妈）；
     - 验证 `generateAdsCopy` 在纯文本输入下允许调用；
     - 验证 `transferListingToAds` 能够将标题和卖点共同带入。
3. **全量回归测试**：
   - 确保现有 571 个后端单测与 339 个前端单测 100% 通过。
   - `git diff --check` 无格式异常。

---

## 5. 影响范围与向前兼容性 (Compatibility)
- 现存所有保存的历史记录和数据库模型保持 100% 兼容。
- 无论用户上传图片还是纯文本输入，生成的广告数据结构完全一致（包含 9 种营销风格、5 种黄金钩子、分镜头脚本）。
