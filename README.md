# 🚀 AI 电商全能工具箱 (AI E-commerce All-in-One Tools)

一款专为跨境电商（Amazon, TikTok Shop, Shopify 等）打造的 AI 驱动效率工具集。集成竞品深度分析、Listing 智能撰写、图片语境翻译及批量文本本地化等核心功能，助力卖家实现数据驱动的决策与高效率运营。

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

### 3. 🖼️ AI 图片语境翻译 (Image Translation)
*   **抹除与重绘**：利用 AI 自动识别并擦除原图文字，保持背景自然。
*   **本地化重写**：结合电商语境，将文字翻译并重新排版，支持多语种覆盖。

### 4. 🔤 批量文本本地化 (Batch Text Translation)
*   **单次请求多语言**：采用高度优化的 AI Batch 模式，一次请求即可获得 6+ 种语言的本地化译文。
*   **智能聚合历史**：批量任务自动聚合为一条历史记录，支持一键全量还原回显。
*   **电商词库优化**：避开生硬翻译，自动使用目标市场的高转化电商词汇。

---

## 🛠️ 技术架构

### 后端 (Backend)
*   **核心框架**：FastAPI (Python 3.10+)
*   **AI 引擎**：Google Gemini Pro / Flash (支持 Vertex AI 企业级接入)
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
在 `backend/` 目录下创建 `.env` 文件并填入以下配置：
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

### 2. 安装依赖
```bash
cd backend
pip install -r requirements.txt
```

### 3. 启动项目
根目录下运行：
```bash
python run.py
```
*   **后端服务**：http://localhost:8000
*   **前端展示**：http://localhost:8080/index.html

---

## 📅 更新日志
*   **V2.5** (最新): 
    *   重构文本翻译为“批量本地化”模式，提升 5 倍效率。
    *   实现侧边栏与标签页的 LocalStorage 状态持久化。
    *   优化竞品分析加载动画与 UI 响应速度。
*   **V2.0**: 引入矩阵对比模板与智能投资打分系统。

---

## 🤝 贡献与反馈
如有任何建议或问题，欢迎提交 Issue 或联系开发团队。

---
💡 *提示：本工具仅供学习与研究使用，抓取商业数据时请务必遵守相关法律法规及平台协议。*
