import base64
import datetime
import math
import os
import re
import uuid
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from models.request import WatermarkRegion, WatermarkRemovalRequest
from services.ai_service import AIService
from services.image_validation import ValidatedImage, validate_image_payload


DATA_URL_PATTERN = re.compile(
    r"^data:(image/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$"
)
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
SUPPORTED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}
WATERMARK_REMOVAL_PROMPT = """Create one new edited image using the first image as visual context.

The second image is a guide: reconstruct the area shown in white with a plausible continuation of nearby colors, lighting, and texture.
Avoid text, logos, symbols, or watermarks. You may freely regenerate the rest of the canvas because it is context only.
Return one image only."""


def decode_data_url(data_url: str, *, require_png: bool = False) -> ValidatedImage:
    if not isinstance(data_url, str):
        raise ValueError("请上传有效的图片 data URL")
    match = DATA_URL_PATTERN.fullmatch(data_url)
    if not match:
        raise ValueError("请上传有效的图片 data URL")

    image = validate_image_payload(match.group(2), match.group(1))
    if image.image_format not in SUPPORTED_IMAGE_FORMATS:
        raise ValueError("仅支持 JPG、PNG 或 WebP 格式")
    if require_png and image.image_format != "PNG":
        raise ValueError("遮罩图片必须为 PNG 格式")
    return image


def validate_regions(regions: list[WatermarkRegion]) -> list[WatermarkRegion]:
    if not isinstance(regions, list) or not regions:
        raise ValueError("至少框选一个水印区域")
    if len(regions) > 100:
        raise ValueError("最多框选 100 个水印区域")
    return [WatermarkRegion.model_validate(region) for region in regions]


def _binary_mask(image: ValidatedImage) -> Image.Image:
    with Image.open(BytesIO(image.data)) as decoded:
        grayscale = decoded.convert("L")
        return grayscale.point(lambda value: 255 if value == 255 else 0)


def _expected_mask(width: int, height: int, regions: list[WatermarkRegion]) -> Image.Image:
    rectangles = [
        (
            math.floor(region.x * width),
            math.floor(region.y * height),
            math.ceil((region.x + region.width) * width),
            math.ceil((region.y + region.height) * height),
        )
        for region in regions
    ]
    expected = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(expected)
    for y in range(height):
        intervals = sorted(
            (left, right)
            for left, top, right, bottom in rectangles
            if top <= y < bottom
        )
        if not intervals:
            continue
        start, end = intervals[0]
        for left, right in intervals[1:]:
            if left <= end:
                end = max(end, right)
                continue
            draw.line((start, y, end - 1, y), fill=255)
            start, end = left, right
        draw.line((start, y, end - 1, y), fill=255)
    return expected


def _png_bytes(image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _has_pixels(mask: Image.Image) -> bool:
    return mask.getbbox() is not None


def validate_mask(
    source: ValidatedImage,
    mask: ValidatedImage,
    regions: list[WatermarkRegion],
) -> None:
    if (mask.width, mask.height) != (source.width, source.height):
        raise ValueError("遮罩尺寸必须与原图一致")

    normalized_regions = validate_regions(regions)
    actual = _binary_mask(mask)
    if not _has_pixels(actual):
        raise ValueError("遮罩至少需要包含一个白色像素")

    expected = _expected_mask(source.width, source.height, normalized_regions)
    outer_tolerance = expected.filter(ImageFilter.MaxFilter(3))
    required_interior = expected.filter(ImageFilter.MinFilter(3))
    if (
        _has_pixels(ImageChops.subtract(actual, outer_tolerance))
        or _has_pixels(ImageChops.subtract(required_interior, actual))
    ):
        raise ValueError("遮罩与框选区域不一致")


def _safe_stem(filename: str) -> str:
    stem = Path(filename or "image").stem
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-").lower()
    return stem or "image"


def _extension_for_mime_type(mime_type: str) -> str:
    extensions = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
    }
    try:
        return extensions[mime_type]
    except KeyError as exc:
        raise ValueError("不支持的输出图片格式") from exc


def _static_url(path: Path) -> str:
    relative_path = path.relative_to(Path(STATIC_DIR)).as_posix()
    return f"/static/{relative_path}"


def _model_image(response: dict) -> ValidatedImage:
    candidates = response.get("candidates", []) if isinstance(response, dict) else []
    parts = (
        candidates[0].get("content", {}).get("parts", [])
        if candidates and isinstance(candidates[0], dict)
        else []
    )
    inline_data = next(
        (
            part.get("inlineData")
            for part in parts
            if isinstance(part, dict) and part.get("inlineData")
        ),
        None,
    )
    if not isinstance(inline_data, dict):
        finish_reason = candidates[0].get("finishReason") if candidates else None
        if finish_reason == "IMAGE_RECITATION":
            raise ValueError(
                "模型因图片复刻限制未返回图片，请缩小框选范围或稍后重试"
            )
        raise ValueError("模型未返回图片")
    image = validate_image_payload(
        inline_data.get("data"),
        inline_data.get("mimeType") or inline_data.get("mime_type") or "",
    )
    if image.image_format not in SUPPORTED_IMAGE_FORMATS:
        raise ValueError("仅支持 JPG、PNG 或 WebP 格式")
    return image


async def remove_watermark(request: WatermarkRemovalRequest) -> dict:
    source = decode_data_url(request.image_data)
    mask = decode_data_url(request.mask_data, require_png=True)
    regions = validate_regions(request.regions)
    validate_mask(source, mask, regions)
    canonical_mask = _expected_mask(source.width, source.height, regions)
    canonical_mask_data = _png_bytes(canonical_mask)

    parts = [
        {"text": WATERMARK_REMOVAL_PROMPT},
        {
            "inlineData": {
                "mimeType": source.mime_type,
                "data": base64.b64encode(source.data).decode("ascii"),
            }
        },
        {
            "inlineData": {
                "mimeType": "image/png",
                "data": base64.b64encode(canonical_mask_data).decode("ascii"),
            }
        },
    ]
    response = await AIService.generate_content(
        payload={
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["IMAGE"]},
        },
        capability="image",
    )
    result = _model_image(response)
    if (result.width, result.height) != (source.width, source.height):
        raise ValueError("模型返回图片尺寸与原图不一致")

    with (
        Image.open(BytesIO(source.data)) as source_image,
        Image.open(BytesIO(result.data)) as result_image,
    ):
        composited = Image.composite(
            result_image.convert("RGBA"),
            source_image.convert("RGBA"),
            canonical_mask,
        )
        result_data = _png_bytes(composited)

    processing_id = uuid.uuid4().hex
    output_dir = (
        Path(STATIC_DIR)
        / "outputs"
        / "watermark-removal"
        / processing_id
    )
    output_dir.mkdir(parents=True, exist_ok=False)
    stem = _safe_stem(request.filename)
    source_path = output_dir / f"{stem}-source.{_extension_for_mime_type(source.mime_type)}"
    mask_path = output_dir / f"{stem}-mask.png"
    result_path = output_dir / f"{stem}-result.png"
    source_path.write_bytes(source.data)
    mask_path.write_bytes(canonical_mask_data)
    result_path.write_bytes(result_data)

    return {
        "processing_id": processing_id,
        "filename": request.filename,
        "source_url": _static_url(source_path),
        "mask_url": _static_url(mask_path),
        "result_url": _static_url(result_path),
        "result_mime_type": "image/png",
        "width": result.width,
        "height": result.height,
        "regions": [region.model_dump() for region in regions],
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
