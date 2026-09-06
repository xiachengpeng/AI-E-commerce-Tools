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
*   **产品一致性**：上传产品图后生成首屏、卖点、场景、材质、规格等详情页模块，产品外观以原图为唯一视觉来源。
*   **按需生成**：模块默认不选中，用户可以独立选择模块张数和是否包含文案。
*   **产品信息提取**：产品名称为空时，AI 可根据上传图片推断并回填产品名称；已有名称不会被覆盖。
*   **降级保护**：图片接口失败时使用本地 HTML/CSS 方案，不自动发起第二次图片 AI 请求。

### 4. 🖼️ AI 图片语境翻译 (Image Translation)
*   **抹除与重绘**：利用 AI 自动识别并擦除原图文字，保持背景自然。
*   **本地化重写**：结合电商语境，将文字翻译并重新排版，支持包括泰语在内的多语种覆盖。

### 5. 🔤 批量文本本地化 (Batch Text Translation)
*   **单次请求多语言**：采用 AI Batch 模式，一次请求提交多个目标语言，包括中文和泰语。
*   **智能聚合历史**：批量任务自动聚合为一条历史记录，支持一键全量还原回显。
*   **电商词库优化**：避开生硬翻译，自动使用目标市场的高转化电商词汇。

### 6. ⚙️ AI 线路设置与运行日志
*   **按能力切换**：文本和图片能力分别绑定线路，支持 Gemini、Vertex AI 和 OpenAI Compatible。
*   **图片模式**：OpenAI Compatible 图片线路可选择文生图或图生图；图生图使用 `/v1/images/edits` 上传产品参考图，文生图使用 `/v1/images/generations`。
*   **立即生效**：线路和绑定保存到本地 SQLite，下一次请求立即使用新配置，无需重启。
*   **实时日志**：设置页展示当前进程最近 200 条脱敏日志，包含能力、线路、模型、耗时、重试、图片模式和端点信息。

---

## 🛠️ 技术架构

### 后端 (Backend)
*   **核心框架**：FastAPI (Python 3.10+，推荐 Python 3.12)
*   **AI 引擎**：Google Gemini Pro / Flash、Vertex AI、OpenAI Compatible 中转线路
*   **爬虫引擎**：Firecrawl (智能 Markdown 提取)
*   **数据库**：SQLAlchemy + SQLite (支持完整的操作历史持久化)
*   **并发处理**：基于 Asyncio 的高性能任务调度

### 前端 (Frontend)
*   **界面方案**：Vanilla JS + CSS + Tailwind (JIT 编译)
*   **设计系统**：现代玻璃拟态 (Glassmorphism)、微动效交互、响应式侧边导航
*   **状态保持**：基于 LocalStorage 的标签页状态持久化，刷新不丢失进度

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
*   **后端服务**：http://localhost:8000
*   **前端展示**：http://127.0.0.1:8080/index.html

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
