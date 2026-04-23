import os
from dotenv import load_dotenv

# 加载 .env 文件（优先级低于系统环境变量）
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)

# Firecrawl 默认配置
FIRECRAWL_API_URL = os.getenv("FIRECRAWL_API_URL", "http://localhost:3002/v1/scrape")

# AI 提供商配置 (gemini 或 vertex)
AI_PROVIDER = os.getenv("AI_PROVIDER", "gemini")

# Gemini 默认配置
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL_ID = os.getenv("GEMINI_MODEL_ID", "gemini-3.1-pro-preview")
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL_ID}:generateContent"

# Vertex AI 默认配置 (参考 world_concurrent.py)
VERTEX_PROJECT_ID = os.getenv("VERTEX_PROJECT_ID", "ornate-rarity-493511-p5")
VERTEX_LOCATION = os.getenv("VERTEX_LOCATION", "us-central1")
VERTEX_KEY_PATH = os.getenv("VERTEX_KEY_PATH", r"D:\Workspace\miyao\hezihua0215 Gemini API Key\ornate-rarity-493511-p5-6759bce81d52.json")

# 前端并发配置
FRONTEND_CONCURRENCY_LIMIT = int(os.getenv("FRONTEND_CONCURRENCY_LIMIT", "2"))
FRONTEND_STAGGER_DELAY = int(os.getenv("FRONTEND_STAGGER_DELAY", "2000"))

if not GEMINI_API_KEY and AI_PROVIDER == "gemini":
    raise EnvironmentError("GEMINI_API_KEY 未配置，请在 backend/.env 文件中设置。")
