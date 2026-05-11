import re
import logging
from urllib.parse import urlparse, unquote

logger = logging.getLogger(__name__)

MAX_LIMIT = {
    "title": 500,
    "price": 100,
    "bullets": 3000,
    "description": 3000,
    "reviews": 8000,
    "qa": 3000,
    "general_context": 24000,
    "general_before_title": 1200,
    "general_after_title": 22000,
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

_BOILERPLATE_PATTERNS = [
    r"sign in",
    r"register",
    r"forgot password",
    r"password is required",
    r"email is required",
    r"please enter a valid email",
    r"reset password",
    r"subscribe to get latest offers",
    r"location\.reload",
    r"class\s+\w+\s+extends\s+",
    r"SPZ\.defineElement",
    r"@private",
]


def _slug_terms(url: str | None) -> list[str]:
    if not url:
        return []
    path = unquote(urlparse(url).path)
    slug = path.rstrip("/").split("/")[-1]
    terms = [t.lower() for t in re.split(r"[-_\W]+", slug) if len(t) > 2]
    return terms


def _clean_general_lines(md: str) -> list[str]:
    lines = []
    for raw in md.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("*   [") or line.startswith("[!["):
            continue
        if len(line) > 1000:
            continue
        lowered = line.lower()
        if any(re.search(pattern, lowered, re.IGNORECASE) for pattern in _BOILERPLATE_PATTERNS):
            continue
        lines.append(line)
    return lines


def _score_title_candidate(line: str, terms: list[str]) -> int:
    normalized = re.sub(r"[^a-z0-9]+", " ", line.lower())
    score = sum(1 for term in terms if term in normalized)
    if line.startswith("#"):
        score += 2
    if 8 <= len(line) <= 120:
        score += 1
    if line.startswith("!") or line.startswith("[") or "http" in normalized:
        score -= 2
    return score


def _find_general_title(lines: list[str], url: str | None) -> tuple[str, int]:
    terms = _slug_terms(url)
    best_title = ""
    best_idx = -1
    best_score = 0

    for idx, line in enumerate(lines):
        candidate = line.lstrip("#").strip()
        if not candidate or candidate.lower() in {"home", "shop", "contact", "about"}:
            continue
        score = _score_title_candidate(line, terms)
        if score > best_score:
            best_title = candidate
            best_idx = idx
            best_score = score

    if best_title and best_score >= max(2, min(3, len(terms))):
        return best_title, best_idx

    for idx, line in enumerate(lines):
        candidate = line.lstrip("#").strip()
        if 20 <= len(candidate) <= 140 and not candidate.startswith(("!", "[")):
            return candidate, idx

    return extract_title(md="\n".join(lines)), 0


def _build_general_context(lines: list[str], title_idx: int) -> str:
    if title_idx < 0:
        text = "\n".join(lines)
        return text[:MAX_LIMIT["general_context"]]

    prefix = "\n".join(lines[:title_idx])
    product_and_after = "\n".join(lines[title_idx:])
    prefix = prefix[-MAX_LIMIT["general_before_title"]:]
    product_and_after = product_and_after[:MAX_LIMIT["general_after_title"]]
    return f"{prefix}\n{product_and_after}".strip()[:MAX_LIMIT["general_context"]]


def parse_general(md: str, url: str | None = None) -> dict:
    lines = _clean_general_lines(md)
    title, title_idx = _find_general_title(lines, url)
    context = _build_general_context(lines, title_idx)

    return {
        "product_data": {
            "title": title[:MAX_LIMIT["title"]],
            "price": extract_price(context)[:MAX_LIMIT["price"]],
            "bullets": context,
            "description": context,
            "source_url": url or "",
        },
        "market_data": {
            "reviews": [],
            "qa": []
        }
    }

def is_amazon(url: str) -> bool:
    return "amazon.com" in url.lower() or "amzn.to" in url.lower()
