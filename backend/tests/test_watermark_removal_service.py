import base64
import io
import time
from unittest.mock import AsyncMock, patch

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from models.request import WatermarkRegion, WatermarkRemovalRequest
from services.watermark_removal_service import (
    decode_data_url,
    remove_watermark,
    validate_mask,
)


def make_data_url(width=10, height=10):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def make_format_data_url(image_format, width=10, height=10):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format=image_format)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/{image_format.lower()};base64,{encoded}"


def make_mask_url(regions, width=10, height=10):
    buffer = io.BytesIO()
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for x, y, region_width, region_height in regions:
        draw.rectangle(
            (x, y, x + region_width - 1, y + region_height - 1),
            fill=255,
        )
    mask.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def make_sparse_mask_url(width, height):
    buffer = io.BytesIO()
    mask = Image.new("L", (width, height), 0)
    for y in range(height):
        for x in range(width):
            if (x + y) % 2 == 0:
                mask.putpixel((x, y), 255)
    mask.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def make_png_bytes(width=10, height=10):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def make_image_bytes(image_format, width=10, height=10):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format=image_format)
    return buffer.getvalue()


def make_pattern_png_bytes(width=10, height=10):
    image = Image.new("RGBA", (width, height))
    for y in range(height):
        for x in range(width):
            image.putpixel(
                (x, y),
                (
                    (x * 23 + y * 7) % 256,
                    (x * 11 + y * 29) % 256,
                    (x * 31 + y * 13) % 256,
                    80 + ((x * 17 + y * 19) % 176),
                ),
            )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def make_gray_transparent_mask_url(width=10, height=10):
    mask = Image.new("RGBA", (width, height), (128, 128, 128, 0))
    ImageDraw.Draw(mask).rectangle(
        (1, 1, 3, 3),
        fill=(255, 255, 255, 64),
    )
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def png_data_url(data):
    return f"data:image/png;base64,{base64.b64encode(data).decode('ascii')}"


def inline_image_response(data, mime_type="image/png"):
    return {
        "candidates": [{
            "content": {
                "parts": [{
                    "inlineData": {
                        "mimeType": mime_type,
                        "data": base64.b64encode(data).decode("ascii"),
                    }
                }]
            }
        }]
    }


def valid_request():
    region = WatermarkRegion(x=.1, y=.1, width=.3, height=.3)
    return WatermarkRemovalRequest(
        filename="product image.png",
        image_data=make_data_url(),
        mask_data=make_mask_url([(1, 1, 3, 3)]),
        regions=[region],
    )


def url_to_test_path(static_root, static_url):
    return static_root / static_url.removeprefix("/static/")


def test_request_rejects_empty_regions():
    with pytest.raises(ValidationError, match="至少框选一个"):
        WatermarkRemovalRequest(
            filename="sample.png",
            image_data=make_data_url(),
            mask_data=make_mask_url([(1, 1, 3, 3)]),
            regions=[],
        )


@pytest.mark.parametrize("region", [
    {"x": -0.1, "y": 0, "width": 0.2, "height": 0.2},
    {"x": 0, "y": 0, "width": 0, "height": 0.2},
    {"x": 0.9, "y": 0, "width": 0.2, "height": 0.2},
])
def test_request_rejects_invalid_region(region):
    with pytest.raises(ValidationError):
        WatermarkRegion(**region)


def test_validate_mask_rejects_size_mismatch():
    source = decode_data_url(make_data_url(10, 10))
    mask = decode_data_url(
        make_mask_url([(1, 1, 3, 3)], 8, 8),
        require_png=True,
    )
    with pytest.raises(ValueError, match="尺寸必须与原图一致"):
        validate_mask(
            source,
            mask,
            [WatermarkRegion(x=.1, y=.1, width=.3, height=.3)],
        )


def test_validate_mask_accepts_multiple_matching_regions():
    regions = [
        WatermarkRegion(x=.1, y=.1, width=.3, height=.3),
        WatermarkRegion(x=.6, y=.6, width=.2, height=.2),
    ]
    source = decode_data_url(make_data_url(10, 10))
    mask = decode_data_url(
        make_mask_url([(1, 1, 3, 3), (6, 6, 2, 2)]),
        require_png=True,
    )
    validate_mask(source, mask, regions)


def test_decode_data_url_rejects_source_formats_outside_jpg_png_webp():
    with pytest.raises(ValueError, match="仅支持 JPG、PNG 或 WebP"):
        decode_data_url(make_format_data_url("GIF"))


def test_output_extension_rejects_unknown_mime_type():
    from services.watermark_removal_service import _extension_for_mime_type

    with pytest.raises(ValueError, match="不支持的输出图片格式"):
        _extension_for_mime_type("image/gif")


def test_validate_mask_rejects_sparse_pixels_inside_selected_region():
    source = decode_data_url(make_data_url(20, 20))
    mask = decode_data_url(make_sparse_mask_url(20, 20), require_png=True)
    region = WatermarkRegion(x=0, y=0, width=1, height=1)

    with pytest.raises(ValueError, match="遮罩与框选区域不一致"):
        validate_mask(source, mask, [region])


def test_validate_mask_handles_100_overlapping_large_regions_efficiently():
    source = decode_data_url(make_data_url(512, 512))
    mask = decode_data_url(make_mask_url([(0, 0, 512, 512)], 512, 512), require_png=True)
    regions = [WatermarkRegion(x=0, y=0, width=1, height=1) for _ in range(100)]

    started_at = time.perf_counter()
    validate_mask(source, mask, regions)

    assert time.perf_counter() - started_at < 2


@pytest.mark.asyncio
async def test_remove_watermark_sends_source_and_mask_to_image_model(tmp_path, monkeypatch):
    import services.watermark_removal_service as watermark_service

    static_root = tmp_path / "static"
    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(static_root))
    ai_mock = AsyncMock(return_value=inline_image_response(make_png_bytes()))

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        await remove_watermark(valid_request())

    assert ai_mock.await_args.kwargs["capability"] == "image"
    payload = ai_mock.await_args.kwargs["payload"]
    parts = payload["contents"][0]["parts"]
    assert len([part for part in parts if "inlineData" in part]) == 2
    assert payload["generationConfig"]["imageConfig"]["aspectRatio"] == "1:1"
    prompt = parts[0]["text"]
    assert "context only" in prompt
    assert "must remain unchanged exactly" not in prompt
    assert "unmasked pixels" not in prompt


@pytest.mark.asyncio
async def test_remove_watermark_rejects_response_without_image(tmp_path, monkeypatch):
    import services.watermark_removal_service as watermark_service

    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(tmp_path / "static"))
    ai_mock = AsyncMock(return_value={"candidates": [{"content": {"parts": [{"text": "no image"}]}}]})

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        with pytest.raises(ValueError, match="未返回图片"):
            await remove_watermark(valid_request())


@pytest.mark.asyncio
async def test_remove_watermark_explains_image_recitation_rejection(
    tmp_path, monkeypatch
):
    import services.watermark_removal_service as watermark_service

    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(tmp_path / "static"))
    ai_mock = AsyncMock(
        return_value={
            "candidates": [
                {
                    "content": {"parts": []},
                    "finishReason": "IMAGE_RECITATION",
                    "finishMessage": "The model could not generate the image.",
                }
            ]
        }
    )

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        with pytest.raises(ValueError, match="图片复刻限制"):
            await remove_watermark(valid_request())


@pytest.mark.asyncio
async def test_remove_watermark_normalizes_changed_dimensions(tmp_path, monkeypatch):
    import services.watermark_removal_service as watermark_service

    static_root = tmp_path / "static"
    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(static_root))
    model_image = Image.new("RGB", (12, 10), (12, 34, 56))
    model_buffer = io.BytesIO()
    model_image.save(model_buffer, format="PNG")
    ai_mock = AsyncMock(return_value=inline_image_response(model_buffer.getvalue()))

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        result = await remove_watermark(valid_request())

    result_path = url_to_test_path(static_root, result["result_url"])
    with Image.open(result_path) as saved:
        assert saved.size == (10, 10)
        assert saved.convert("RGB").getpixel((1, 1)) == (12, 34, 56)
        assert saved.convert("RGB").getpixel((0, 0)) == (255, 255, 255)
    assert result["width"] == 10
    assert result["height"] == 10


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("image_format", "mime_type"),
    [("GIF", "image/gif"), ("TIFF", "image/tiff")],
)
async def test_remove_watermark_rejects_model_images_outside_jpg_png_webp(
    tmp_path,
    monkeypatch,
    image_format,
    mime_type,
):
    import services.watermark_removal_service as watermark_service

    static_root = tmp_path / "static"
    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(static_root))
    ai_mock = AsyncMock(return_value=inline_image_response(
        make_image_bytes(image_format),
        mime_type,
    ))

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        with pytest.raises(ValueError, match="仅支持 JPG、PNG 或 WebP 格式"):
            await remove_watermark(valid_request())

    assert not static_root.exists()


@pytest.mark.asyncio
async def test_remove_watermark_saves_source_mask_and_result(tmp_path, monkeypatch):
    import services.watermark_removal_service as watermark_service

    static_root = tmp_path / "static"
    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(static_root))
    ai_mock = AsyncMock(return_value=inline_image_response(make_png_bytes()))

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        result = await remove_watermark(valid_request())

    assert result["width"] == 10
    assert result["height"] == 10
    assert result["result_url"].startswith("/static/outputs/watermark-removal/")
    assert url_to_test_path(static_root, result["source_url"]).is_file()
    assert url_to_test_path(static_root, result["mask_url"]).is_file()
    assert url_to_test_path(static_root, result["result_url"]).is_file()
    assert result["filename"] == "product image.png"
    assert result["result_mime_type"] == "image/png"
    assert result["regions"] == [{"x": .1, "y": .1, "width": .3, "height": .3}]
    assert result["created_at"]


@pytest.mark.asyncio
async def test_remove_watermark_preserves_every_pixel_outside_canonical_mask(
    tmp_path,
    monkeypatch,
):
    import services.watermark_removal_service as watermark_service

    static_root = tmp_path / "static"
    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(static_root))
    source_data = make_pattern_png_bytes()
    model_image = Image.new("RGBA", (10, 10), (250, 3, 199, 17))
    model_buffer = io.BytesIO()
    model_image.save(model_buffer, format="PNG")
    request = WatermarkRemovalRequest(
        filename="pattern.png",
        image_data=png_data_url(source_data),
        mask_data=make_mask_url([(2, 2, 3, 3)]),
        regions=[WatermarkRegion(x=.2, y=.2, width=.3, height=.3)],
    )
    ai_mock = AsyncMock(return_value=inline_image_response(model_buffer.getvalue()))

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        result = await remove_watermark(request)

    result_path = url_to_test_path(static_root, result["result_url"])
    with Image.open(io.BytesIO(source_data)) as source_image, Image.open(result_path) as saved:
        source_pixels = source_image.convert("RGBA")
        saved_pixels = saved.convert("RGBA")
        for y in range(10):
            for x in range(10):
                expected = (
                    model_image.getpixel((x, y))
                    if 2 <= x < 5 and 2 <= y < 5
                    else source_pixels.getpixel((x, y))
                )
                assert saved_pixels.getpixel((x, y)) == expected, (x, y)

    assert result["result_mime_type"] == "image/png"
    assert result["result_url"].endswith("-result.png")


@pytest.mark.asyncio
async def test_remove_watermark_sends_and_saves_regions_as_opaque_binary_mask(
    tmp_path,
    monkeypatch,
):
    import services.watermark_removal_service as watermark_service

    static_root = tmp_path / "static"
    monkeypatch.setattr(watermark_service, "STATIC_DIR", str(static_root))
    request = WatermarkRemovalRequest(
        filename="gray-alpha.png",
        image_data=make_data_url(),
        mask_data=make_gray_transparent_mask_url(),
        regions=[WatermarkRegion(x=.1, y=.1, width=.3, height=.3)],
    )
    ai_mock = AsyncMock(return_value=inline_image_response(make_png_bytes()))

    with patch(
        "services.watermark_removal_service.AIService.generate_content",
        new=ai_mock,
    ):
        result = await remove_watermark(request)

    parts = ai_mock.await_args.kwargs["payload"]["contents"][0]["parts"]
    sent_mask_part = [part["inlineData"] for part in parts if "inlineData" in part][1]
    sent_mask_data = base64.b64decode(sent_mask_part["data"])
    saved_mask_data = url_to_test_path(static_root, result["mask_url"]).read_bytes()

    assert sent_mask_part["mimeType"] == "image/png"
    assert saved_mask_data == sent_mask_data
    with Image.open(io.BytesIO(sent_mask_data)) as canonical_mask:
        assert canonical_mask.mode == "L"
        assert canonical_mask.info.get("transparency") is None
        assert {
            canonical_mask.getpixel((x, y))
            for y in range(10)
            for x in range(10)
        } == {0, 255}
        for y in range(10):
            for x in range(10):
                expected = 255 if 1 <= x < 4 and 1 <= y < 4 else 0
                assert canonical_mask.getpixel((x, y)) == expected, (x, y)
