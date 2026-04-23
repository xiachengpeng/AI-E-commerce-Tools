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

    try:
        response = requests.post(FIRECRAWL_API_URL, json=payload, headers=headers, timeout=90)
        response.raise_for_status()
        data = response.json()
        
        if "data" in data and "markdown" in data["data"]:
            md = data["data"]["markdown"]
        elif "markdown" in data:
            md = data["markdown"]
        else:
            raise ValueError("Markdown content not found in Firecrawl response.")
            
        if "captcha" in md.lower() or "robot check" in md.lower():
             raise Exception("Amazon detected bot behavior (CAPTCHA). Please check your Firecrawl settings or use a proxy.")
             
        return md
    except Exception as e:
        raise Exception(f"Failed to fetch content from Firecrawl: {str(e)}")
