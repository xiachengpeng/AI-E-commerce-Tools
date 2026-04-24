def clean_content(markdown: str) -> str:
    """
    Cleans the markdown content by:
    - Removing excessive empty lines
    - Keeping meaningful lines (avoiding tiny navigation fragments)
    - Truncating to stay within context limits
    """
    if not markdown:
        return ""
        
    lines = markdown.split('\n')
    cleaned_lines = []
    
    # Keywords to look for (important short lines)
    important_keywords = ['$', '€', '¥', '£', '元', 'price', '价格', 'rating', '评分', 'review', '评价', '评论']
    
    for line in lines:
        stripped_line = line.strip()
        
        is_short_but_important = any(kw in stripped_line.lower() for kw in important_keywords)
        is_list_item = stripped_line.startswith(('-', '*', '1.', '#'))
        
        if len(stripped_line) > 5 or is_short_but_important or is_list_item:
            cleaned_lines.append(stripped_line)
            
    cleaned_text = '\n'.join(cleaned_lines)
    
    if len(cleaned_text) > 30000:
        cleaned_text = cleaned_text[:10000] + "\n\n...[Middle Content Truncated]...\n\n" + cleaned_text[-20000:]
        
    return cleaned_text

def check_block(text: str) -> bool:
    """
    Checks if the content is an Amazon/General crawler block or captcha page.
    """
    if not text:
        return False
    
    # Common block signatures (lowercased)
    block_patterns = [
        "robot check",
        "captcha",
        "automated access",
        "click the button below to continue shopping",
        "sorry, we just need to make sure you're not a robot",
        "验证码",
        "如果你看到这条信息",
        "反爬",
        "click the button below"
    ]
    
    text_lower = text.lower()
    for pattern in block_patterns:
        if pattern in text_lower:
            return True
            
    return False
