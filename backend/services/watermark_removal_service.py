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
SUPPORTED_GENERATION_ASPECT_RATIOS = (
    ("1:1", 1 / 1),
    ("2:3", 2 / 3),
    ("3:2", 3 / 2),
    ("3:4", 3 / 4),
    ("4:3", 4 / 3),
    ("4:5", 4 / 5),
    ("5:4", 5 / 4),
    ("9:16", 9 / 16),
    ("16:9", 16 / 9),
    ("21:9", 21 / 9),
)
MASK_PADDING_RATIO = 0.012
MASK_FEATHER_RATIO = 0.006
WATERMARK_REMOVAL_PROMPT = """Create one edited image using the first image as visual context.

The second image is a binary edit mask: white means the area MUST be repaired, black means the area MUST be preserved. Edit only the white masked regions and reconstruct them as a seamless continuation of nearby colors, lighting, texture, perspective, and geometry.

CRITICAL MASK RULE: remove every watermark, logo, letter, number, symbol, or dark mark that lies inside a white masked region, even if it looks like printed packaging or a label. Do not preserve any content inside the white mask. Preserve all unmasked content exactly, including the subject, composition, objects, colors, lighting, shadows, perspective, texture, logos, labels, and background structure.

Do not add text, logos, symbols, watermarks, or new objects. Return one image only with the same dimensions and aspect ratio."""


def _closest_generation_aspect_ratio(width: int, height: int) -> str:
    ratio = width / height
    return min(
        SUPPORTED_GENERATION_ASPECT_RATIOS,
        key=lambda item: abs(math.log(ratio / item[1])),
    )[0]


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


def _mask_padding(width: int, height: int) -> int:
    return max(2, round(min(width, height) * MASK_PADDING_RATIO))


def _expanded_mask(mask: Image.Image, padding: int) -> Image.Image:
    """扩大修复范围，覆盖水印边缘的半透明像素和压缩残留。"""
    size = max(3, padding * 2 + 1)
    if size % 2 == 0:
        size += 1
    return mask.filter(ImageFilter.MaxFilter(size))


def _feathered_mask(mask: Image.Image, padding: int) -> Image.Image:
    """把扩大后的修复范围羽化，避免贴图式硬边。"""
    expanded = _expanded_mask(mask, padding)
    radius = max(1, round(padding * MASK_FEATHER_RATIO / MASK_PADDING_RATIO))
    return expanded.filter(ImageFilter.GaussianBlur(radius))


def _repair_crop_box(mask: Image.Image, padding: int) -> tuple[int, int, int, int]:
    """返回包含修复区和上下文的局部处理框，避免无关整图重绘。"""
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("遮罩至少需要包含一个白色像素")
    context = max(16, padding * 2)
    left = max(0, bbox[0] - context)
    top = max(0, bbox[1] - context)
    right = min(mask.width, bbox[2] + context)
    bottom = min(mask.height, bbox[3] + context)
    return left, top, right, bottom


def _image_bytes(image: Image.Image, image_format: str = "PNG") -> bytes:
    buffer = BytesIO()
    image.save(buffer, format=image_format)
    return buffer.getvalue()


def _redact_repair_area(image: Image.Image, mask: Image.Image) -> Image.Image:
    """在送入模型前遮掉原始文字，避免模型直接照抄待删除内容。"""
    redacted = image.convert("RGBA").copy()
    placeholder = Image.new("RGBA", redacted.size, (255, 255, 255, 255))
    return Image.composite(placeholder, redacted, mask)


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
    padding = _mask_padding(source.width, source.height)
    model_mask = _expanded_mask(canonical_mask, padding)
    crop_box = _repair_crop_box(model_mask, padding)
    with Image.open(BytesIO(source.data)) as source_image:
        source_crop_data = _image_bytes(source_image.crop(crop_box), "PNG")
    model_mask_crop_data = _png_bytes(model_mask.crop(crop_box))

    parts = [
        {"text": WATERMARK_REMOVAL_PROMPT},
        {
            "inlineData": {
                "mimeType": "image/png",
                "data": base64.b64encode(source_crop_data).decode("ascii"),
            }
        },
        {
            "inlineData": {
                "mimeType": "image/png",
                "data": base64.b64encode(model_mask_crop_data).decode("ascii"),
            }
        },
    ]
    response = await AIService.generate_content(
        payload={
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "imageConfig": {
                    "aspectRatio": _closest_generation_aspect_ratio(
                        crop_box[2] - crop_box[0],
                        crop_box[3] - crop_box[1],
                    )
                },
            },
            "imageEdit": {"maskIndex": 1},
        },
        capability="image",
    )
    result = _model_image(response)

    with Image.open(BytesIO(source.data)) as source_image, Image.open(BytesIO(result.data)) as result_image:
        normalized_result = result_image.convert("RGBA")
        crop_size = (crop_box[2] - crop_box[0], crop_box[3] - crop_box[1])
        if normalized_result.size != crop_size:
            normalized_result = normalized_result.resize(
                crop_size,
                Image.Resampling.LANCZOS,
            )
        source_rgba = source_image.convert("RGBA")
        source_crop = source_rgba.crop(crop_box)
        composited_crop = Image.composite(
            normalized_result,
            source_crop,
            _feathered_mask(canonical_mask.crop(crop_box), padding),
        )
        composited = source_rgba.copy()
        composited.paste(composited_crop, crop_box[:2])
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
    mask_path.write_bytes(_png_bytes(model_mask))
    result_path.write_bytes(result_data)

    return {
        "processing_id": processing_id,
        "filename": request.filename,
        "source_url": _static_url(source_path),
        "mask_url": _static_url(mask_path),
        "result_url": _static_url(result_path),
        "result_mime_type": "image/png",
        "width": source.width,
        "height": source.height,
        "regions": [region.model_dump() for region in regions],
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
