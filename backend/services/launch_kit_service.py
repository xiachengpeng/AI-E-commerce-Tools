"""
Launch Kit Service: Assembles all cross-module e-commerce assets
(Listing, Multi-platform Ads, DTC Standalone PDP HTML, Images, Manifest & Checklist)
into a structured, professional .ZIP delivery package.
"""

import base64
import json
import logging
import os
import re
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from models.request import LaunchKitExportRequest

logger = logging.getLogger(__name__)

STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(__file__)), "static"))
LAUNCH_KITS_DIR = os.path.join(STATIC_DIR, "outputs", "launch-kits")


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[\\/*?:"<>|\s]+', "_", (name or "Product").strip())
    return cleaned[:40] or "Product"


def _format_listing_txt(listing: Dict[str, Any], product_name: str) -> str:
    title_target = listing.get("title", {}).get("target") if isinstance(listing.get("title"), dict) else listing.get("title", "")
    title_zh = listing.get("title", {}).get("zh", "") if isinstance(listing.get("title"), dict) else ""

    bullets = listing.get("bullets", [])
    bullet_lines = []
    for i, b in enumerate(bullets, 1):
        if isinstance(b, dict):
            b_target = b.get("target", "")
            b_zh = b.get("zh", "")
            bullet_lines.append(f"{i}. {b_target}\n   (中文对照: {b_zh})")
        else:
            bullet_lines.append(f"{i}. {b}")

    desc_target = listing.get("description", {}).get("target") if isinstance(listing.get("description"), dict) else listing.get("description", "")
    desc_zh = listing.get("description", {}).get("zh", "") if isinstance(listing.get("description"), dict) else ""

    st_pair = listing.get("searchTerms") or listing.get("search_terms") or {}
    st_text = st_pair.get("target") if isinstance(st_pair, dict) else str(st_pair)

    kw_list = listing.get("keywords") or []
    if isinstance(kw_list, list):
        kw_text = ", ".join(kw_list)
    elif isinstance(kw_list, dict):
        kw_text = ", ".join([f"{k}: {', '.join(v) if isinstance(v, list) else v}" for k, v in kw_list.items()])
    else:
        kw_text = str(kw_list)

    return f"""================================================================================
E-COMMERCE LISTING EXPORT: {product_name}
Export Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
================================================================================

[PRODUCT TITLE / 标题]
Target Language:
{title_target}

Chinese Reference:
{title_zh}

================================================================================
[5 BULLET POINTS / 五点核心描述]
{chr(10).join(bullet_lines) if bullet_lines else 'None'}

================================================================================
[LONG DESCRIPTION / 产品长描述]
Target Language:
{desc_target}

Chinese Reference:
{desc_zh}

================================================================================
[SEARCH TERMS / 后台搜索词]
{st_text}

[KEYWORDS LIBRARY / 关键词库]
{kw_text}
================================================================================
"""


def _format_listing_md(listing: Dict[str, Any], product_name: str) -> str:
    title_target = listing.get("title", {}).get("target") if isinstance(listing.get("title"), dict) else listing.get("title", "")
    title_zh = listing.get("title", {}).get("zh", "") if isinstance(listing.get("title"), dict) else ""

    bullets = listing.get("bullets", [])
    bullet_items = []
    for i, b in enumerate(bullets, 1):
        if isinstance(b, dict):
            bullet_items.append(f"- **Bullet {i}**: {b.get('target', '')}\n  - *中文对照*: {b.get('zh', '')}")
        else:
            bullet_items.append(f"- **Bullet {i}**: {b}")

    desc_target = listing.get("description", {}).get("target") if isinstance(listing.get("description"), dict) else listing.get("description", "")
    st_pair = listing.get("searchTerms") or listing.get("search_terms") or {}
    st_text = st_pair.get("target") if isinstance(st_pair, dict) else str(st_pair)

    return f"""# E-Commerce Listing: {product_name}

> Exported by AI E-commerce Tools on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

---

## 1. Product Title (标题)
- **Target Language**: {title_target}
- **Chinese Reference**: {title_zh}

---

## 2. Key Product Features (五点描述)
{chr(10).join(bullet_items) if bullet_items else 'None'}

---

## 3. Product Description (长描述)
{desc_target}

---

## 4. Search Terms (后台搜索词)
```text
{st_text}
```
"""


def _format_ads_txt(ads_data: List[Any], product_name: str) -> str:
    sections = [
        f"================================================================================",
        f"MULTI-PLATFORM AD CAMPAIGN COPIES: {product_name}",
        f"Export Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"================================================================================\n"
    ]

    for idx, item in enumerate(ads_data, 1):
        platform = item.get("platform", "General").upper() if isinstance(item, dict) else f"ANGLE {idx}"
        angle = item.get("angle", "") if isinstance(item, dict) else ""
        headline = item.get("headline", "") if isinstance(item, dict) else ""
        primary_text = item.get("primary_text") or item.get("text", "") if isinstance(item, dict) else str(item)
        cta = item.get("call_to_action") or item.get("cta", "") if isinstance(item, dict) else ""

        sections.append(f"--- [CAMPAIGN {idx}: {platform} - {angle}] ---")
        if headline:
            sections.append(f"Headline: {headline}")
        if primary_text:
            sections.append(f"Primary Text / Copy:\n{primary_text}")
        if cta:
            sections.append(f"Call to Action: {cta}")
        sections.append("")

    return "\n".join(sections)


def _generate_readiness_checklist(payload: LaunchKitExportRequest) -> str:
    title = (payload.listing or {}).get("title", {})
    title_str = title.get("target", "") if isinstance(title, dict) else str(title)
    st = (payload.listing or {}).get("searchTerms") or (payload.listing or {}).get("search_terms") or {}
    st_str = st.get("target", "") if isinstance(st, dict) else str(st)

    title_len = len(title_str)
    st_bytes = len(st_str.encode("utf-8"))

    title_check = "✅ 合规 (<= 200 字符)" if title_len <= 200 else f"⚠️ 超长 ({title_len}/200 字符，建议精简)"
    st_check = "✅ 合规 (<= 249 字节)" if st_bytes <= 249 else f"⚠️ 超标 ({st_bytes}/249 字节，需剔除多余词)"

    aspect_info = payload.aspect_ratio_precheck or {}
    aspect_recommendations = aspect_info.get("recommendations") or [
        "1. Amazon 货架主图：强制 1:1 正方形纯白底无杂质图",
        "2. Shopify / 独立站英雄横幅：推荐 16:9 或 21:9 宽屏视觉图",
        "3. 移动端买家秀/社交种草：推荐 3:4 或 9:16 沉浸竖版图"
    ]

    return f"""# 🚀 电商上架就绪度审查清单 (Launch Readiness Checklist)

**产品名称**: {payload.product_name}
**品牌归属**: {payload.brand_name or '默认品牌'}
**品类分类**: {payload.category or '未分类'}
**物料包生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

---

## 1. Listing 文本指标合规审计
- **标题字符长度**: {title_len} 字符 -> {title_check}
- **Search Terms 字节数**: {st_bytes} 字节 -> {st_check}
- **五点描述数量**: {len((payload.listing or {}).get('bullets', []))} 项

## 2. 图像视觉与比例规范预检 (Aspect Ratio Precheck)
{chr(10).join([f"- {r}" for r in aspect_recommendations])}

## 3. 渠道投放就绪核对清单
- [ ] **Amazon / 平台卖家后台**:
  - [ ] 复制 `01_Listing/Listing.txt` 中的标题与五点卖点
  - [ ] 复制后台搜索词到 Generic Keywords 字段
  - [ ] 上传 `04_Images/` 中的高清切图并确认主图 1:1
- [ ] **Shopify / WooCommerce 独立站**:
  - [ ] 打开 `03_DTC_Shopify_PDP/standalone_pdp.html`
  - [ ] 将 HTML 代码或切图区块直接粘贴至产品详细描述编辑器
  - [ ] 检查品牌主色与字体显示是否与整店风格保持协调
- [ ] **Meta / Google 广告投放**:
  - [ ] 参考 `02_Advertising/Ad_Campaigns.txt` 选择高转化文案角度
  - [ ] 搭配物料包中的场景图与功能解析图进行 A/B 测试

---
*Generated automatically by AI E-commerce Tools Launch Kit Engine.*
"""


def build_launch_kit_zip(payload: LaunchKitExportRequest) -> Tuple[str, str]:
    """
    Builds the launch kit zip package and returns (absolute_zip_path, filename).
    """
    os.makedirs(LAUNCH_KITS_DIR, exist_ok=True)
    kit_id = uuid.uuid4().hex[:10]
    safe_name = sanitize_filename(payload.product_name)
    zip_filename = f"{safe_name}_Launch_Kit_{kit_id}.zip"
    zip_filepath = os.path.join(LAUNCH_KITS_DIR, zip_filename)

    with zipfile.ZipFile(zip_filepath, "w", zipfile.ZIP_DEFLATED) as archive:
        # 1. Listing Files
        if payload.listing:
            listing_txt = _format_listing_txt(payload.listing, payload.product_name)
            archive.writestr("01_Listing/Listing.txt", listing_txt.encode("utf-8"))
            listing_md = _format_listing_md(payload.listing, payload.product_name)
            archive.writestr("01_Listing/Listing.md", listing_md.encode("utf-8"))

        # 2. Ads Files
        if payload.ads and isinstance(payload.ads, list):
            ads_txt = _format_ads_txt(payload.ads, payload.product_name)
            archive.writestr("02_Advertising/Ad_Campaigns.txt", ads_txt.encode("utf-8"))

        # 3. PDP HTML File
        if payload.pdp_html:
            archive.writestr("03_DTC_Shopify_PDP/standalone_pdp.html", payload.pdp_html.encode("utf-8"))

        # 4. Images
        if payload.image_items and isinstance(payload.image_items, list):
            for idx, item in enumerate(payload.image_items, 1):
                if not isinstance(item, dict):
                    continue
                img_name = sanitize_filename(item.get("name") or f"module_image_{idx}")
                data_str = item.get("data") or item.get("data_url") or item.get("url") or ""

                if data_str.startswith("data:image"):
                    try:
                        header, base64_str = data_str.split(",", 1)
                        ext = "jpg"
                        if "png" in header:
                            ext = "png"
                        elif "webp" in header:
                            ext = "webp"
                        raw_bytes = base64.b64decode(base64_str)
                        archive.writestr(f"04_Images/{img_name}.{ext}", raw_bytes)
                    except Exception as e:
                        logger.warning(f"Failed to decode launch kit image {img_name}: {e}")
                elif data_str.startswith("/static/"):
                    rel = data_str.replace("/static/", "", 1)
                    local_path = os.path.join(STATIC_DIR, rel)
                    if os.path.isfile(local_path):
                        ext = Path(local_path).suffix or ".jpg"
                        archive.write(local_path, f"04_Images/{img_name}{ext}")

        # 5. Manifest & Readiness Checklist
        checklist = _generate_readiness_checklist(payload)
        archive.writestr("LAUNCH_READINESS_CHECKLIST.md", checklist.encode("utf-8"))

        manifest = {
            "kit_id": kit_id,
            "product_name": payload.product_name,
            "brand_name": payload.brand_name,
            "category": payload.category,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "has_listing": bool(payload.listing),
            "has_ads": bool(payload.ads),
            "has_pdp_html": bool(payload.pdp_html),
            "images_count": len(payload.image_items or []),
            "manifest_details": payload.manifest or {}
        }
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))

    return zip_filepath, zip_filename
