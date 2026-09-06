import os
from dotenv import load_dotenv

# 加载 .env 文件（优先级低于系统环境变量）
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)

# Firecrawl 默认配置
FIRECRAWL_API_URL = os.getenv("FIRECRAWL_API_URL", "http://localhost:3002/v1/scrape")

# AI 提供商配置仅作为首次启动导入来源。
AI_PROVIDER = (os.getenv("AI_PROVIDER") or "gemini").strip().lower()

# Gemini 默认配置
GEMINI_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
GEMINI_MODEL_ID = (
    (os.getenv("GEMINI_MODEL_ID") or "").strip()
    or "gemini-3.1-pro-preview"
)

# Vertex AI 默认配置
# 仅作为首次启动导入来源，真实值应通过 backend/.env 或系统环境变量提供。
VERTEX_PROJECT_ID = os.getenv("VERTEX_PROJECT_ID", "")
VERTEX_LOCATION = os.getenv("VERTEX_LOCATION", "global")
VERTEX_KEY_PATH = os.getenv("VERTEX_KEY_PATH", "")

# CORS 配置
# 开发环境默认放行本地前端；生产环境应通过环境变量显式指定域名
_CORS_DEFAULT = os.getenv("CORS_ORIGINS", "http://localhost:8080,http://127.0.0.1:8080")
CORS_ORIGINS = [o.strip() for o in _CORS_DEFAULT.split(",") if o.strip()]

# 前端并发配置
FRONTEND_CONCURRENCY_LIMIT = int(os.getenv("FRONTEND_CONCURRENCY_LIMIT", "2"))
FRONTEND_STAGGER_DELAY = int(os.getenv("FRONTEND_STAGGER_DELAY", "2000"))

# URL 校验
MAX_URL_LENGTH = int(os.getenv("MAX_URL_LENGTH", "2048"))
