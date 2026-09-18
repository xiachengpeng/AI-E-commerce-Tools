import io
import json
import zipfile
import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_export_launch_kit_endpoint_and_download():
    # 1x1 transparent PNG data url
    sample_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

    payload = {
        "product_name": "Ergonomic Lumbar Cushion",
        "brand_name": "ErgoLife",
        "category": "Office Furniture",
        "listing": {
            "title": {
                "target": "Ergonomic Memory Foam Lumbar Support Cushion for Office Chair",
                "zh": "人体工学记忆棉办公室座椅腰靠垫"
            },
            "bullets": [
                {"target": "Contoured high-density memory foam", "zh": "高密度记忆棉，贴合腰椎曲线"},
                {"target": "Dual adjustable straps prevent sliding", "zh": "双重可调卡扣固定带，防止滑落"}
            ],
            "description": {
                "target": "Relieves lower back pain during long working hours.",
                "zh": "有效缓解久坐腰部酸痛。"
            },
            "searchTerms": {"target": "lumbar support cushion office chair back pillow"},
            "keywords": ["lumbar cushion", "back support", "desk accessories"]
        },
        "ads": [
            {
                "platform": "facebook",
                "angle": "pain_killer",
                "headline": "Stop Lower Back Pain Today",
                "primary_text": "Sitting for 8+ hours? Discover how ErgoLife supports your spine.",
                "call_to_action": "Shop Now"
            }
        ],
        "pdp_html": "<html><body><h1>ErgoLife Lumbar Cushion</h1><p>Ultimate comfort.</p></body></html>",
        "image_items": [
            {
                "name": "test_hero",
                "data_url": sample_png
            }
        ],
        "aspect_ratio_precheck": {
            "recommendations": [
                "1. Amazon 主图：1:1 正方形合规",
                "2. Shopify 独立站：横幅 16:9 推荐"
            ]
        },
        "manifest": {
            "source": "automated_test"
        }
    }

    # 1. POST export request
    res = client.post("/api/export/launch-kit", json=payload)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data.get("status") == "success"
    assert "kit_id" in data
    assert "download_url" in data
    assert "filename" in data
    assert "Ergonomic_Lumbar_Cushion" in data["filename"]

    kit_id = data["kit_id"]

    # 2. GET download request
    dl_res = client.get(f"/api/export/launch-kit/{kit_id}/download")
    assert dl_res.status_code == 200
    assert dl_res.headers.get("content-type") == "application/zip"

    # 3. Verify ZIP contents
    with zipfile.ZipFile(io.BytesIO(dl_res.content), "r") as archive:
        namelist = archive.namelist()

        assert "01_Listing/Listing.txt" in namelist
        assert "01_Listing/Listing.md" in namelist
        assert "02_Advertising/Ad_Campaigns.txt" in namelist
        assert "03_DTC_Shopify_PDP/standalone_pdp.html" in namelist
        assert "04_Images/test_hero.png" in namelist
        assert "LAUNCH_READINESS_CHECKLIST.md" in namelist
        assert "manifest.json" in namelist

        # Inspect Listing.txt
        listing_txt = archive.read("01_Listing/Listing.txt").decode("utf-8")
        assert "Ergonomic Memory Foam Lumbar Support Cushion" in listing_txt
        assert "高密度记忆棉" in listing_txt

        # Inspect Checklist
        checklist = archive.read("LAUNCH_READINESS_CHECKLIST.md").decode("utf-8")
        assert "Ergonomic Lumbar Cushion" in checklist
        assert "Listing 文本指标合规审计" in checklist

        # Inspect Manifest
        manifest_json = json.loads(archive.read("manifest.json").decode("utf-8"))
        assert manifest_json.get("product_name") == "Ergonomic Lumbar Cushion"
        assert manifest_json.get("has_listing") is True
        assert manifest_json.get("has_ads") is True
        assert manifest_json.get("has_pdp_html") is True
        assert manifest_json.get("images_count") == 1


def test_download_launch_kit_not_found():
    res = client.get("/api/export/launch-kit/nonexistent999/download")
    assert res.status_code == 404
