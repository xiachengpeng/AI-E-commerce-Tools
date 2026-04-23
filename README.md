# AI 电商工具箱 - 合并版

## 项目结构

```
重构/
├── run.py                  # 一键启动脚本
├── frontend/               # 前端（静态文件）
│   ├── index.html          # 主页面（tools_4 + 竞品分析集成）
│   ├── xuanpin.css         # 竞品分析模块样式
│   └── xuanpin.js          # 竞品分析模块逻辑
└── backend/                # 竞品分析后端（FastAPI）
    ├── main.py             # API 入口
    ├── config.py           # 配置（API Key 等）
    ├── requirements.txt    # Python 依赖
    ├── models/
    │   └── request.py      # Pydantic 数据模型
    └── services/
        ├── firecrawl.py    # 网页抓取
        ├── cleaner.py      # 内容清洗
        ├── amazon_parser.py # Amazon 解析
        ├── ai_single.py    # 单品 AI 分析
        ├── ai_compare.py   # 多品对比 AI
        └── scoring.py      # 投资评分 AI
```

## 功能说明

### 左侧导航标签（从上到下）
1. **竞品分析** ← 新增，xuanpin 项目集成
2. **详情页** - 原 tools_4 详情页生成
3. **Listing** - 原 tools_4 Listing 生成
4. **图片翻译** - 原 tools_4 图片翻译

### 竞品分析功能
- 支持输入 1-5 个商品链接（Amazon / 独立站）
- 单链接：深度产品透视 + 投资评分
- 多链接：横向对比矩阵 + 市场分析
- 支持中英双语切换
- 支持导出 HTML 报告

## 运行方法

### 环境要求
- Python 3.9+
- 本地运行的 Firecrawl 服务（默认 http://localhost:3002）
- 有效的 Gemini API Key

### 安装依赖
```bash
cd 重构/backend
pip install -r requirements.txt
```

### 一键启动
```bash
cd 重构
python run.py
```

### 手动启动
```bash
# 终端 1：启动后端
cd 重构/backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# 终端 2：启动前端
cd 重构/frontend
python -m http.server 8080
```

访问：http://localhost:8080

## 配置说明

编辑 `backend/config.py` 修改：
- `FIRECRAWL_API_URL`：Firecrawl 服务地址
- `GEMINI_API_KEY`：Gemini API 密钥
- `GEMINI_MODEL_ID`：使用的模型版本
