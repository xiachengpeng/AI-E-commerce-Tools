import io
import base64
import pytest
from PIL import Image
from services.image_compression_service import compress_to_webp, compress_data_url_to_webp


def create_test_image_bytes(format="PNG", mode="RGB", size=(200, 200), color=(255, 100, 50)):
    im = Image.new(mode, size, color)
    buf = io.BytesIO()
    im.save(buf, format=format)
    return buf.getvalue()


def test_compress_to_webp_rgb():
    png_bytes = create_test_image_bytes("PNG", "RGB", (400, 400), (100, 150, 200))
    webp_bytes, stats = compress_to_webp(png_bytes, quality=90)

    assert stats["output_format"] == "WEBP"
    assert stats["mime_type"] == "image/webp"
    assert stats["width"] == 400
    assert stats["height"] == 400
    assert stats["original_size"] == len(png_bytes)
    assert stats["compressed_size"] == len(webp_bytes)
    assert len(webp_bytes) > 0

    # Verify Pillow can read output
    with Image.open(io.BytesIO(webp_bytes)) as out_im:
        assert out_im.format == "WEBP"
        assert out_im.size == (400, 400)


def test_compress_to_webp_rgba_transparency():
    # Test transparency preservation
    rgba_bytes = create_test_image_bytes("PNG", "RGBA", (300, 300), (255, 0, 0, 128))
    webp_bytes, stats = compress_to_webp(rgba_bytes, quality=85)

    assert stats["output_format"] == "WEBP"
    with Image.open(io.BytesIO(webp_bytes)) as out_im:
        assert out_im.format == "WEBP"
        assert out_im.mode == "RGBA"
        # Check alpha channel preserved
        pixel = out_im.getpixel((150, 150))
        assert len(pixel) == 4
        assert pixel[3] > 0


def test_compress_data_url_to_webp():
    png_bytes = create_test_image_bytes("PNG", "RGB", (200, 200), (50, 200, 50))
    b64 = base64.b64encode(png_bytes).decode("ascii")
    data_url = f"data:image/png;base64,{b64}"

    out_url, stats = compress_data_url_to_webp(data_url, quality=90)
    assert out_url.startswith("data:image/webp;base64,")
    assert stats["mime_type"] == "image/webp"
    assert stats["savings_percent"] >= 0


def test_compress_empty_or_invalid():
    with pytest.raises(ValueError, match="输入图片数据为空"):
        compress_to_webp(b"")

    with pytest.raises(ValueError, match="图片解码或压缩失败"):
        compress_to_webp(b"not an image bytes at all")

    with pytest.raises(ValueError, match="无效的图片 Data URL"):
        compress_data_url_to_webp("")

    with pytest.raises(ValueError, match="不是合法的 base64 Data URL 格式"):
        compress_data_url_to_webp("https://example.com/test.png")


def test_api_compress_webp_endpoint():
    from fastapi.testclient import TestClient
    from main import app

    client = TestClient(app)
    png_bytes = create_test_image_bytes("PNG", "RGB", (100, 100), (200, 100, 50))
    b64 = base64.b64encode(png_bytes).decode("ascii")

    resp = client.post("/api/image/compress-webp", json={
        "image_data": f"data:image/png;base64,{b64}",
        "quality": 85
    })

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["webp_data"].startswith("data:image/webp;base64,")
    assert data["stats"]["output_format"] == "WEBP"
    assert data["stats"]["width"] == 100
    assert data["stats"]["height"] == 100
