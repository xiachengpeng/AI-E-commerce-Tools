import re
import logging

logger = logging.getLogger(__name__)

MAX_LIMIT = {
    "title": 500,
    "price": 100,
    "bullets": 3000,
    "description": 3000,
    "reviews": 8000,
    "qa": 3000
}

def extract_title(md: str) -> str:
    lines = md.split('\n')
    for line in lines[:20]:
        line = line.strip()
        if line.startswith('# '):
            return line[2:].strip()
        if len(line) > 30 and not line.startswith('[') and not line.startswith('!'):
            return line
    return "Unknown Title"

def extract_price(md: str) -> str:
    price_patterns = [
        r'\$\d+\.\d{2}',
        r'\$\s*\d+\.\d{2}',
        r'price:\s*\$\d+\.\d{2}',
        r'售价：?\s*\$\d+\.\d{2}'
    ]
    for pattern in price_patterns:
        match = re.search(pattern, md, re.IGNORECASE)
        if match:
            return match.group(0)
    return "Unknown Price"

def extract_section(md: str, start_keywords: list, end_keywords: list, max_len: int) -> str:
    md_lower = md.lower()
    start_idx = -1
    for kw in start_keywords:
        idx = md_lower.find(kw.lower())
        if idx != -1:
            start_idx = idx + len(kw)
            break
    
    if start_idx == -1:
        return ""
        
    end_idx = len(md)
    for kw in end_keywords:
        idx = md_lower.find(kw.lower(), start_idx)
        if idx != -1 and idx < end_idx:
            end_idx = idx
            break
            
    content = md[start_idx:end_idx].strip()
    return content[:max_len]

def parse_amazon(md: str) -> dict:
    logger.info("Starting structured parsing for Amazon Markdown...")
    
    title = extract_title(md)
    price = extract_price(md)
    
    bullets_raw = extract_section(md, 
        ["About this item", "Product details", "商品详情", "关于此商品"],
        ["Product description", "Customer reviews", "Compare with similar items", "产品描述"],
        MAX_LIMIT["bullets"]
    )
    bullets = [b.strip() for b in bullets_raw.split('\n') if b.strip() and len(b.strip()) > 10]
    
    description = extract_section(md,
        ["Product description", "From the manufacturer", "产品描述"],
        ["Customer reviews", "Customer questions & answers", "用户评论"],
        MAX_LIMIT["description"]
    )
    
    reviews_raw = extract_section(md,
        ["Customer reviews", "Top reviews", "用户评论", "精选评价"],
        ["Customer questions & answers", "Videos", "Looking for specific info"],
        MAX_LIMIT["reviews"]
    )
    reviews = list(set([r.strip() for r in reviews_raw.split('\n') if len(r.strip()) > 20]))
    reviews = reviews[:50]
    
    qa_raw = extract_section(md,
        ["Customer questions & answers", "Q&A", "常见问题"],
        ["Customer reviews", "Review this product"],
        MAX_LIMIT["qa"]
    )
    qa = [q.strip() for q in qa_raw.split('\n') if '?' in q or len(q.strip()) > 30]

    structured_data = {
        "product_data": {
            "title": title[:MAX_LIMIT["title"]],
            "price": price,
            "bullets": bullets,
            "description": description[:MAX_LIMIT["description"]]
        },
        "market_data": {
            "reviews": reviews,
            "qa": qa[:20]
        }
    }
    
    logger.info(f"Amazon parsing complete. Title: {title[:50]}..., Reviews count: {len(reviews)}")
    return structured_data

def parse_general(md: str) -> dict:
    return {
        "product_data": {
            "title": extract_title(md),
            "price": extract_price(md),
            "bullets": md[:3000],
            "description": ""
        },
        "market_data": {
            "reviews": [],
            "qa": []
        }
    }

def is_amazon(url: str) -> bool:
    return "amazon.com" in url.lower() or "amzn.to" in url.lower()
