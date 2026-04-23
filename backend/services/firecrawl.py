import requests
from config import FIRECRAWL_API_URL

def fetch_markdown(url: str) -> str:
    """
    Calls the local Firecrawl API to scrape the given URL and return markdown content.
    """
    payload = {
        "url": url,
        "formats": ["markdown"]
    }
    
    headers = {
        "Content-Type": "application/json"
    }

    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"🕸️ [爬虫] 正在通过 Firecrawl 抓取页面: {url}...")
    try:
        response = requests.post(FIRECRAWL_API_URL, json=payload, headers=headers, timeout=90)
        response.raise_for_status()
        data = response.json()
        
        if "data" in data and "markdown" in data["data"]:
            md = data["data"]["markdown"]
        elif "markdown" in data:
            md = data["markdown"]
        else:
            logger.error(f"❌ [爬虫] 未在 Firecrawl 响应中找到 Markdown 内容")
            raise ValueError("Markdown content not found in Firecrawl response.")
            
        if "captcha" in md.lower() or "robot check" in md.lower():
             logger.warning(f"⚠️ [爬虫] 检测到机器人验证 (CAPTCHA)，抓取质量可能受损: {url}")
             raise Exception("Amazon detected bot behavior (CAPTCHA).")
             
        logger.info(f"✅ [爬虫] 页面抓取成功: {url} (长度: {len(md)})")
        return md
    except Exception as e:
        logger.error(f"❌ [爬虫] 抓取失败: {str(e)}")
        raise Exception(f"Failed to fetch content from Firecrawl: {str(e)}")
