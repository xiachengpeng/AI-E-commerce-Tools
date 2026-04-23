import os
from dotenv import load_dotenv

# 加载 .env 文件（优先级低于系统环境变量）
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)

# Firecrawl 默认配置
FIRECRAWL_API_URL = os.getenv("FIRECRAWL_API_URL", "http://localhost:3002/v1/scrape")

# Gemini 默认配置
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL_ID = os.getenv("GEMINI_MODEL_ID", "gemini-3.1-pro-preview")
GEMINI_API_URL = f"https://aiplatform.googleapis.com/v1/publishers/google/models/{GEMINI_MODEL_ID}:generateContent"

if not GEMINI_API_KEY:
    raise EnvironmentError("GEMINI_API_KEY 未配置，请在 backend/.env 文件中设置。")
