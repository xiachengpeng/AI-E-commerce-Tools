# Phase P3: 全局视觉工具流打通与非专业卖家体验升级 Design Specification

## 1. 目标与背景

针对非专业跨境电商卖家的使用习惯与痛点，继续深化全系统的文案通俗化、空状态引导性、跨工具链路打通与低门槛配置体验：
1. **AI 图片翻译**：消除顶部硬编码的 `Gemini Active` 误导，纠正空状态文案（原描述形似水印擦除而非翻译），提供欧美/东南亚/日韩常用语言一键预设包，并在风格保真度参数旁提供通俗的防溢出与排版说明。
2. **AI 尺寸重绘**：将程序员黑话“重跑失败”全面升级为通俗的“重试失败项”；为纯数字比例（1:1, 4:5, 3:4, 9:16）标注匹配的电商平台（Amazon, Shopify, Shopee, TikTok）；并在重绘完成后增加一键流转至「AI 图片翻译」与「设为商详主图」的操作闭环。
3. **AI 设置中心**：在新增/编辑 AI 线路弹窗中，根据协议提供常用官方模型快捷药丸（如 `gemini-2.5-flash`, `gpt-4o-mini` 等），支持一键填入，免除普通卖家查阅 API 文档记忆模型代码的门槛。
4. **品牌营销画像底座**：针对 ICP、VoC、差异化优势等高门槛营销术语，在新建/空状态时提供「一键载入官方示范案例（人体工学椅）」功能，并为各输入框添加大白话启发式引导语。

---

## 2. 模块架构与变更细节

### 2.1 模块一：AI 图片翻译体验重塑与硬编码消除
- **涉及文件**：`frontend/index.html`, `frontend/js/translate.js`
- **UI 变更**：
  - 将 `view-translate` 顶部标题右侧的 `<span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Gemini Active</span>` 改造为 `<span id="transEngineStatus" class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">AI 翻译引擎就绪</span>`。
  - 修正 `transEmptyState` 中的说明文案，明确指出其翻译功能：
    - 标题：“拖拽或粘贴上传待翻译图片”
    - 描述：“AI 智能识别图片中的外文或中文文字，无损擦除并按目标语言排版无损回填，严格保留原图商品材质、光影背景与品牌细节。”
    - 增加场景标签：“包装标签本地化 · 详情多语言主图 · 跨境说明书翻译”。
  - 在语言选择下拉菜单 `langDropdownMenu` 顶部添加「快捷预设」操作条：
    - `欧美 5 国` (美英/德/法/西/意)
    - `东南亚 4 国` (泰/印尼/越/马)
    - `日韩常用` (日/韩)
    - 点击即可快速勾选对应的多语言并联动更新选中标签与开始按钮。
  - 风格保真度下拉框 (`styleStrength`) 旁边增加解释说明，让卖家知晓：
    - `极高 · 完全复原`：严格匹配原图字体、字号与原位；
    - `高 · 推荐`：平衡文字美观度与排版位置，避免长文本溢出；
    - `中 · 允许优化`：适当调整长句版式以提升可读性。

### 2.2 模块二：AI 尺寸重绘 (Square Redraw) 去技术黑话与闭环流转
- **涉及文件**：`frontend/index.html`, `frontend/js/square_redraw.js`
- **去技术黑话**：
  - 顶部按钮 `#squareRedrawRetryBtn` 文本由 `重跑失败` 统一重塑为 `重试失败项`；
  - 失败状态下预览弹窗提示由 `请重跑失败项` 优化为 `请点击顶部【重试失败项】或检查 AI 设置`；
  - 提示信息与微文案中杜绝一切“重跑”字眼。
- **场景化比例标注**：
  - `squareRedrawAspectSelect` 下拉选项丰富为包含业务平台的标注：
    - `1:1 (Amazon / 独立站正方形主图)`
    - `4:5 (Shopify / Instagram 推荐竖图)`
    - `3:4 (速卖通 / Shopee / 平台辅图)`
    - `2:3 (Pinterest / 服饰落地页)`
    - `9:16 (TikTok / Reels 竖屏视频)`
    - `16:9 (PC 端宽屏头图 / 横幅)`
    - 其余辅助比例保留。
- **视觉流转闭环**：
  - 在单张重绘成功卡片中，除了原有的上传图床与设为主图外，新增 `流转至图片翻译`（`sendSquareRedrawToTranslate(itemId)`）按钮；
  - 在预览弹窗的底部操作区，同样集成此按钮；
  - 点击后自动将当前重绘完成的图片推入 `transImages` 队列，并切换到 `translate` 视图，给出成功 Toast。

### 2.3 模块三：AI 设置中心小白配置指引与常用模型一键填入
- **涉及文件**：`frontend/index.html`, `frontend/js/settings.js`
- **快捷模型推荐药丸 (Quick Model Pills)**：
  - 在服务商编辑表单 `settingsProviderModal` 的文本模型输入框 (`settingsProviderTextModel`) 与图片模型输入框 (`settingsProviderImageModel`) 下方添加推荐药丸容器：
    - 当用户选择 `gemini` 协议时，呈现：`gemini-2.5-flash (推荐)`、`gemini-2.5-pro`、`gemini-2.0-flash`；
    - 当用户选择 `openai_compatible` 协议时，呈现：`gpt-4o`、`gpt-4o-mini (推荐)`、`claude-3-5-sonnet` 等常见模型标签；
    - 用户点击任一药丸，直接自动填入对应的模型输入框，并触发输入验证。
- **防呆与帮助文案**：
  - 在 Base URL 与 API Key 处提供小问号 Tooltip 或辅助文本，指导用户从官方开发者控制台获取密钥。

### 2.4 模块四：品牌营销画像官方示范范本一键载入
- **涉及文件**：`frontend/index.html`, `frontend/js/brand_context.js`
- **示范范本载入 (`loadOfficialDemoProfile`)**：
  - 在档案列表为空、或在编辑表单上方提供「载入官方示范（人体工学椅）」按钮；
  - 载入完整标准的优秀营销画像示例：
    - 名称：自适应动态护腰人体工学椅
    - 品牌：ErgoPro
    - 类目：办公家具 / 人体工学
    - 调性：专业严谨 / 值得信赖
    - ICP：每天伏案工作 8 小时以上的程序员、远程办公白领、腰肌劳损人群
    - 痛点：传统座椅腰部缺乏动态支撑、久坐腰酸背痛、夏季海绵垫闷热不透气
    - 差异化：双轴自适应动态追腰机构、航天级抗撕裂高弹透气网布、3秒4D联动调节扶手
    - VoC 词汇：久坐不累, 腰不酸了, 透气清爽, 支撑力强, 极速安装
    - 竞品针对策略：竞品多为固定硬塑料腰托易折断；差评集中在滚轮卡头发与网布半年塌陷
- **通俗化微文案**：
  - 为 ICP、痛点、差异化字段增加接地气的副标题引导语（如“简单说：谁最需要买？他们平时忍受了什么难受的问题？”）。

---

## 3. 验证与回归防护

1. **单测套件**：
   - `frontend/tests/translate_guidance.test.js`：验证硬编码消除、空状态文案与语言预设组行为。
   - `frontend/tests/square_redraw_guidance.test.js`：验证去黑话文案、场景化比例选项与流转至图片翻译的逻辑。
   - `frontend/tests/settings_quick_model_pills.test.js`：验证协议切换时推荐模型药丸的正确显示与点击填入。
   - `frontend/tests/brand_context_demo_profile.test.js`：验证一键载入官方示范的完整性与表单填充。
2. **全量回归**：
   - 保持 941 项既有前后端测试 100% 通过（366 Node.js + 575 Python）。
   - 保持 `git diff --check` 无违规空白字符。
