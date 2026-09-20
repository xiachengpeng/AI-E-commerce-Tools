# 全量文案与流程深度重塑 (Phase P1: 商详引导预设、全站空状态升级、去工程师黑话、Listing精修对比) Design Spec

## 1. Background & Pain Points
1. **商详首屏体验空洞**：
   用户初次进入详情页时，左侧模块默认全部未勾选，右侧画布为空白的 `showcaseArea`（仅有一句简短标题），用户不知道从何入手，不知道有哪些经典组合，也未把底层的 6 大高转化预设（Amazon 7图、独立站视觉流、TikTok 爆款等）直观呈现在首屏中心。
2. **消极空状态与死胡同**：
   全站存在多处“暂无记录”、“尚未生成任何详情页模块内容”的死胡同。缺乏 Onboarding 引导卡片和快速触发动作（例如一键选用模版或引导上传）。
3. **技术黑话与专业名词晦涩**：
   如“零变形约束”、“物理不变量封印”、“DTC 混合模式”等术语让非专业电商卖家理解困难，需要更直观、更有说服力的业务化表述（如“100% 外观一致性锁定 (零变形约束)”、“独立站富文本组件落地页”）。
4. **Listing 局部精修单向强行覆盖**：
   当用户点击五点描述“换一换”或重新润色标题时，系统直接覆盖原数据，若新生成的文案不及原版本，用户无法回滚，造成强烈挫败感。

## 2. Detailed Technical Design

### Feature 1: 商详首屏 Onboarding Hub 引导与 6 大高转化预设卡片
- 在 `frontend/index.html` 的 `showcaseArea` 中，设计整洁高质感的 Onboarding Hub：
  1. **3 步快速出图指引**：
     - Step 1: 上传商品原图（左侧上传区）
     - Step 2: 挑选策划模块或一键套用热门组合
     - Step 3: 点击“开始生成详情页”，即刻获得多模态视觉大图与高转化图文落地页
  2. **6 大高转化预设组合快捷卡片**：
     - Amazon 7图套餐 (`amazon_seven`)
     - 独立站视觉流 (`shopify_dtc`)
     - TikTok 爆款流 (`tiktok_viral`)
     - 套装大礼包流 (`bundle_suite`)
     - 3C 硬核工匠流 (`tech_hardware`)
     - 社交种草爆款流 (`social_ugc`)
  3. 卡片点击直接调用 `applyModulePreset(presetKey)`，并平滑反馈。
  4. 当 `dtcHybridContainer` 空状态时，同样提供快速选用预设模版的行动按钮。

### Feature 2: 全站冷冰冰消极空状态升级
- **全局历史记录抽屉 (`history_manager.js`)**：
  升级为温和的空状态卡片：包含时光时钟图标、说明文字（“暂无历史快照，在任意模块生成后将自动安全归档”），去除单行冰冷纯文字。
- **Listing 结果预览区 (`listing.js`)**：
  未生成时展示清晰的 Onboarding 状态，指引用户填写左侧信息或从竞品分析一键导入。
- **详情页模块分类切换 (`details.js`)**：
  当前分类暂无已选模块时，提示点击具体分类标签挑选模块或一键应用预设。

### Feature 3: 全站微文案去黑话优化
- “零变形约束”统一显示为包含通俗解释的徽章：`100% 外观一致性锁定 (零变形约束)`，鼠标悬停提示 `严格锁定商品真实外观与结构，严禁 AI 改变按键、接口、材质及结构`。
- “DTC 混合模式”副标题明确为 `独立站富文本落地页 (免重绘切版，图文自适应)`。

### Feature 4: Listing 局部定向精修原版对比与采纳/保留机制
- 在 `frontend/js/listing.js` 中：
  - 当调用 `regenerateListingSection` 成功返回新数据时，不立即强行覆盖 `currentListingDataText`。
  - 在当前条目下方展开【版本对比卡片】：
    - 左侧/上方展示：【原版本】
    - 右侧/下方展示：【精修版】
    - 提供【采纳新版】按钮：将新版写入 `currentListingDataText`，存入历史快照，并关闭对比卡片。
    - 提供【保留原版】按钮：放弃新版，保留原版，关闭对比卡片。
- 支持五点描述 (`bullet`) 与标题 (`title`) 的局部精修对比。

## 3. Verification Plan
- 自动化单测覆盖率 100%：
  - `frontend/tests/detail_onboarding_hub.test.js`
  - `frontend/tests/empty_state_onboarding.test.js`
  - `frontend/tests/microcopy_clarity.test.js`
  - `frontend/tests/listing_regeneration_comparison.test.js`
- 现有 919+ 前后端测试 100% 回归通过。
