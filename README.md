# 🚀 AI 电商全能工具箱 (AI E-commerce All-in-One Tools)

一款专为跨境电商（Amazon、TikTok Shop、Shopify 等）打造的本地 AI 效率工具集。集成竞品分析、详情页视觉生成、Listing 撰写、广告文案、图片翻译、文本本地化、批量方图重绘和水印消除等工作流。

---

## ✨ 核心模块

### 1. 📊 AI 竞品深度分析 (Competitor Insight)
*   **一键拆解**：输入独立站或亚马逊 URL，AI 自动抓取并分析卖点、受众、场景及优劣势。
*   **矩阵对比**：支持多 URL 批量粘贴，生成横向对比矩阵，直观展示竞品差异。
*   **智能评分**：基于机会与难度双维度打分，提供量化的入场建议与操盘策略。
*   **VOC 洞察**：深度解析用户评价，捕捉痛点与差异化机会。

### 2. 📝 Listing 智能撰写 (AI Listing Generator)
*   **多平台适配**：针对 Amazon、TikTok Shop 等不同平台生成符合 SEO 逻辑的标题、五点描述及详情。
*   **营销驱动**：支持选择不同的营销场景（如“清仓促销”、“新品上线”）和语言风格。
*   **可视化排版**：内置移动端效果模拟预览，支持一键导出高清长图。

### 3. 🖼️ AI 详情页生成 (AI Detail Page)
*   **产品真实性与一致性**：上传产品图作为唯一视觉基准，严格锁定产品外观、材质、构型与部件细节，杜绝 AI 凭空臆造。
*   **双展示模式与 5 大排版风格**：
    *   **独立站图文混排 (Hybrid PDP)** 与 **单图画廊 (Gallery)** 双视角自由切换。
    *   内置 5 大出海主流排版风格（🌟 经典杂志交错、🍏 苹果极简大图、🍱 便当盒磁贴风、🎨 优雅生活画册、⚙️ 硬核参数极客），免重新生成实时切换。
*   **品牌主色与自定义色调**：预置 7 种标准色，支持任意 Hex 色值及系统级拾色器实时微调；自动数学矩阵衍生背景微浅色、细边框与高对比可读文字色阶。
*   **精细化排版与字体定制弹窗**：
    *   支持 8 大出海精选字体（Inter、Plus Jakarta Sans、Poppins、Playfair Display 等，导出自动内嵌 Google Web Fonts）。
    *   可独立定制模块大标题（字号/字重/字符间距）、副标题文案与正文描述（字号/字重/行高），配备毫秒级实时排版预览卡片。
    *   内置 5 款精选排版场景预设，支持一键「另存为模板」持久化保存至本地存储，随时调取与管理。
*   **多源图床托管与链接一键替换 (PDP Asset Hosting)**：
    *   原生支持 WordPress (WP REST API)、Shopify (Admin GraphQL API)、Cloudflare R2 (S3 SigV4) 多目标图床。
    *   支持多子站点/多店铺独立配置与无缝切换。
    *   各目标空间与子站点上传状态完全物理隔离，切换空间即时动态刷新（已上传/未上传状态精准对齐，杜绝跨站点状态串扰）。
    *   具备零触碰保护机制（切换目标仅做本地视图刷新，绝不触发多余上传或覆盖）。
    *   一键将导出 HTML 中的本地 Base64/临时链接智能替换为 CDN 云端链接，并支持无损一键还原。
*   **WebP 视觉无损压缩**：
    *   内置 Pillow + libwebp 高性能压缩引擎（默认 Q=90, Method=6）。
    *   完整保留 Alpha 透明通道、ICC 颜色配置文件与 EXIF 元数据，兼顾极限压缩率与极致画质。
*   **双 CMS 平台免疫导出 (Shopify & WordPress)**：一键复制完整自包含 HTML，CSS 变量完全作用域隔离，内置防御性重置与 `wpautop` 单行清洗，免受外部主题（Astra、OceanWP、Shopify Dawn 等）样式篡改与空段落注入。
*   **长图拼接与历史恢复**：支持自定义画板间距、圆角与背景色导出超高清长图；项目状态与排版配置全要素持久化至 SQLite，随时一键还原回显。

### 4. 🏷️ 全局品牌与商品营销画像底座 (Brand & Product Context Hub)
*   **全链路营销上下文**：统一沉淀商品与品牌核心资产，包括目标客群 (ICP)、核心痛点、差异化卖点、VoC 口碑词、品牌调性与竞品针对劣势。
*   **四大核心模块全域复用**：贯穿 Listing、广告文案、AI 详情页与竞品分析，随时从画像库一键调取注入，保持全域品牌声音一致。
*   **智能类目推断**：规则启发式秒级识别 + AI 深度语义推断双重引擎，精准推导商品多级分类。
*   **竞品 VOC 转化与营销对抗卡**：从竞品深度分析一键提取商品画像草稿，自动提炼竞品差评劣势，生成精准打击的营销对抗卡 (Battle Cards)。

### 5. 📐 批量尺寸重绘 (Batch Square & Redraw)
*   **多比例适配**：支持 1:1 方图、3:4、4:3、9:16、16:9 等主流电商与社媒比例批量转换。
*   **智能填充与重绘**：智能扩展构图、保持原图主体完整清晰，支持单张重试、预览对比与批量 ZIP 打包下载。

### 6. 🧼 AI 水印与杂质消除 (Watermark & Object Removal)
*   **交互式涂抹与选区**：支持画布自由框选、移动、8 方向控点缩放与键盘快捷删除。
*   **高质量背景修复**：AI 消除指定区域水印、杂物或多余文案，智能还原背景纹理与光影。

### 7. 🖼️ AI 图片语境翻译 (Image Translation)
*   **抹除与重绘**：利用 AI 自动识别并擦除原图文字，保持背景自然。
*   **本地化重写**：结合电商语境，将文字翻译并重新排版，支持包括泰语在内的多语种覆盖。

### 8. 🔤 批量文本本地化 (Batch Text Translation)
*   **单次请求多语言**：采用 AI Batch 模式，一次请求提交多个目标语言，包括中文和泰语。
*   **智能聚合历史**：批量任务自动聚合为一条历史记录，支持一键全量还原回显。
*   **电商词库优化**：避开生硬翻译，自动使用目标市场的高转化电商词汇。

### 9. ⚙️ AI 线路与图床存储设置 (AI Routing & Storage Settings)
*   **按能力切换**：文本和图片能力分别绑定线路，支持 Gemini、Vertex AI 和 OpenAI Compatible。
*   **图片模式**：OpenAI Compatible 图片线路可选择文生图或图生图；图生图使用 `/v1/images/edits` 上传产品参考图，文生图使用 `/v1/images/generations`。
*   **图床与对象存储管理**：统一管理 WordPress 多站点凭证、Shopify 多店铺 Access Token 以及 Cloudflare R2 S3 兼容密钥，具备密钥掩码保护与连通性即时检测。
*   **立即生效**：线路和绑定保存到本地 SQLite，下一次请求立即使用新配置，无需重启。
*   **实时日志**：设置页展示当前进程最近 200 条脱敏日志，包含能力、线路、模型、耗时、重试、图片模式和端点信息。

---

## 🛠️ 技术架构

### 后端 (Backend)
*   **核心框架**：FastAPI (Python 3.10+，推荐 Python 3.12)
*   **AI 引擎**：Google Gemini Pro / Flash、Vertex AI、OpenAI Compatible 中转线路
*   **多源存储引擎**：WordPress REST API、Shopify Admin GraphQL API (Staged Uploads)、Cloudflare R2 (AWS SigV4)
*   **图像压缩引擎**：Pillow + libwebp 视觉无损 WebP 压缩管道
*   **爬虫引擎**：Firecrawl (智能 Markdown 提取)
*   **数据库**：SQLAlchemy + SQLite (支持完整的操作历史与存储配置持久化)
*   **并发处理**：基于 Asyncio 的高性能任务调度

### 前端 (Frontend)
*   **界面方案**：Vanilla JS + CSS + Tailwind (JIT 编译)
*   **设计系统**：现代玻璃拟态 (Glassmorphism)、微动效交互、响应式侧边导航
*   **品牌中心**：Brand Context Hub (多画像本地存储、跨模块分发、启发式/AI 类目识别)
*   **状态保持**：基于 LocalStorage 的标签页与画像状态持久化，刷新不丢失进度

---

## 🚀 快速启动

### 1. 环境配置
在 `backend/` 目录下创建 `.env` 文件并填入默认配置（设置页也可以直接管理线路）：
```env
# AI 配置
AI_PROVIDER=vertex # 或 gemini
GEMINI_API_KEY=your_google_api_key

# Vertex AI 专用 (可选)
VERTEX_PROJECT_ID=your_project_id
VERTEX_LOCATION=us-central1

# 爬虫配置
FIRECRAWL_API_KEY=your_firecrawl_api_key
```

### AI 线路设置

首次启动仍从 `backend/.env` 导入 Gemini 或 Vertex 默认配置。之后可在左侧
“设置”页面新增 Gemini、Vertex AI 或 OpenAI Compatible 线路，并分别为
文本 AI 和图片 AI 选择线路。保存后下一次请求立即生效，无需重启。

OpenAI Compatible 的 Base URL 填服务根地址；程序调用
`/v1/chat/completions`，图片模式按设置调用 `/v1/images/generations` 或
`/v1/images/edits`。首次启动使用的密钥可以
继续保留在 `backend/.env`，并会导入本地 SQLite；在“设置”中新建或更新的
API Key 保存在本地 SQLite。设置读取接口和实时日志不会向前端返回密钥原值。

“实时运行日志”仅展示当前后端进程内最近的应用事件（最多 200 条），包括
前端事件和 AI 调用的能力、线路、模型、耗时、重试和结果状态；它不是历史
业务记录，也不会跨重启保留。日志会脱敏 API Key、Authorization、提示词、
模型响应（含提供商响应）等带标签或结构化的敏感载荷，以及 `data:image/...`
形式的图片数据 URL；请勿把其他敏感信息写入前端自定义日志。

### 多源图床与对象存储配置

可在“设置”页面或“AI 详情页 -> 图床托管”抽屉中添加 WordPress、Shopify 及 Cloudflare R2 存储配置：
- **WordPress**：填写站点地址、管理员用户名与 Application Password（应用密码），通过 WP REST API 自动同步媒体库。
- **Shopify**：填写店铺域名（如 `your-store.myshopify.com`）与 Admin API Access Token，通过 GraphQL Staged Uploads 完成文件直传。
- **Cloudflare R2**：填写 Account ID、Bucket 名称、Access Key ID、Secret Access Key 及自定义公开域名，基于 AWS SigV4 算法进行安全鉴权直传。
- 所有存储密钥均由本地 SQLite 掩码安全保存，前端仅能读取掩码值；多子站点与多目标之间上传状态完全物理隔离，切换即时刷新。

### 2. 安装依赖
```bash
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/pip install pytest pytest-asyncio
cd frontend && npm install
```

后端业务接口按领域注册在 `backend/routes/`，前端语言选项统一维护在
`frontend/js/languages.js`；新增语言时优先修改该目录，再由各模块筛选支持范围。

### 3. 启动项目
根目录下运行：
```bash
.venv/bin/python run.py
```
*   **后端服务**：http://localhost:9503
*   **前端展示**：http://127.0.0.1:9502/index.html

---

## ✅ 当前验证

前端测试使用 `node --test frontend/tests/*.test.js`，后端测试使用
`.venv/bin/python -m pytest backend/tests`。本地修改应先通过
`git diff --check` 和对应 JavaScript 语法检查，再提交。

---

## 🤝 贡献与反馈
如有任何建议或问题，欢迎提交 Issue 或联系开发团队。

---
💡 *提示：本工具仅供学习与研究使用，抓取商业数据时请务必遵守相关法律法规及平台协议。*
