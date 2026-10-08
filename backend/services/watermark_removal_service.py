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
from services.ai_service import AIService, first_text_from_normalized_response
from services.json_utils import safe_extract_and_parse_json
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
WATERMARK_REMOVAL_PROMPT = """TASK: Instruct inpainting / localized image editing.

INPUTS: The first image is the ORIGINAL photograph, including the unwanted overlay and the surrounding physical structure. The second image is a binary edit mask: white is the repair area, black is protected context. (For native edit APIs the white area is encoded as transparent mask pixels.)

TARGET: Remove only the superimposed text/Logo watermark or user-selected unwanted object in the repair area. A watermark is an overlay, not the underlying physical product. Edit only the white masked regions. Preserve all unmasked content exactly.

RECONSTRUCTION:
- Use only visual evidence from the ORIGINAL photograph to infer what the overlay obscures. Do not assume a material or object category; do not introduce a surface finish, structure or texture absent from the source.
- Continue the visible contours, boundaries, curvature, seams and patterns through the obscured area with the same geometry, scale and perspective. Keep foreground subjects separate from the background; never replace a subject boundary with background texture.
- Reconstruct each obscured surface according to its own surrounding texture, color, lighting, highlights, reflections and shadows, only where these features are present in the source.
- Where a selection crosses several objects or surfaces, repair each independently and preserve their existing boundaries and occlusion order. Do not fill the whole selected rectangle with a single texture.
- Preserve real physical details, original markings, natural dark texture and structural edges. Remove watermark lettering and its translucent halo; do not interpret every dark pixel as a mark to erase.

HARD RULES: No product morphing, missing parts, blurred smears, rectangular patches, new objects, invented text, logos or watermarks. Do not change framing, viewpoint, scale, colors or lighting. Output ONLY the edited first image on the same pixel canvas, with the same dimensions and aspect ratio. Do not return the mask, a collage, or a zoomed/reframed result."""


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
    soft = expanded.filter(ImageFilter.GaussianBlur(radius))
    # Gaussian tails must never modify protected pixels; selected pixels must
    # be fully replaced so translucent watermark remnants are not blended back.
    return ImageChops.lighter(mask, ImageChops.multiply(soft, expanded))


def _repair_crop_box(mask: Image.Image, padding: int) -> tuple[int, int, int, int]:
    """返回包含修复区和上下文的局部处理框，避免无关整图重绘。"""
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("遮罩至少需要包含一个白色像素")
    context = max(32, padding * 2, math.ceil(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 2))
    left = max(0, bbox[0] - context)
    top = max(0, bbox[1] - context)
    right = min(mask.width, bbox[2] + context)
    bottom = min(mask.height, bbox[3] + context)
    # A square edit canvas avoids stretching narrow corner repairs to the
    # model's supported aspect ratio, which bends reconstructed product edges.
    side = max(right - left, bottom - top)
    if side <= min(mask.size):
        left = max(0, min(mask.width - side, (left + right - side) // 2))
        top = max(0, min(mask.height - side, (top + bottom - side) // 2))
        return left, top, left + side, top + side
    return 0, 0, mask.width, mask.height


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


async def _verify_repair(source: ValidatedImage, result_data: bytes, mask: Image.Image) -> str:
    """Fail closed when visual review finds missing structure or residual overlays."""
    prompt = """Compare image 1 (original), image 2 (edited result), and image 3 (white edit selection).
Evaluate ONLY the requested cleanup; do not reward a clean background if real subject structure has been erased.
Check the full subject silhouette AND its continuation through the selected area: boundaries, curves, component thickness, seams, holes, proportions and foreground/background separation. All underlying objects and surfaces must remain; only the selected overlay or unwanted object may disappear. Judge using the actual photograph; do not assume any material or object category.
Set geometry_preserved=false if subject contours/components are missing, flattened, shifted, replaced with background, or distorted, even if the watermark is gone. Set watermark_removed=false if the selected overlay remains. When uncertain, return false rather than approve.
Return JSON only: {"geometry_preserved": true/false, "watermark_removed": true/false}."""
    parts = [{"text": prompt}]
    for data, mime in [(source.data, source.mime_type), (result_data, "image/png"), (_png_bytes(mask), "image/png")]:
        parts.append({"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode("ascii")}})
    try:
        response = await AIService.generate_content(
            payload={
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": 1024},
            },
            capability="text",
        )
        verdict = safe_extract_and_parse_json(first_text_from_normalized_response(response))
    except Exception:
        # A review outage must not discard the already-paid image or pretend
        # that its geometry was verified. Expose the pending state to the UI.
        return "pending_review"
    if not isinstance(verdict, dict) or verdict.get("geometry_preserved") is not True or verdict.get("watermark_removed") is not True:
        raise ValueError("消除结果验收未通过：主体结构可能被改变或水印仍有残留，请缩小选区后重试")
    return "verified"


async def remove_watermark(request: WatermarkRemovalRequest) -> dict:
    source = decode_data_url(request.image_data)
    mask = decode_data_url(request.mask_data, require_png=True)
    regions = validate_regions(request.regions)
    validate_mask(source, mask, regions)
    canonical_mask = _expected_mask(source.width, source.height, regions)
    # Keep the whole scene as the editing canvas. A cropped patch loses the
    # global silhouette needed to reconstruct connected subject contours.
    with Image.open(BytesIO(source.data)) as source_image:
        source_canvas_data = _image_bytes(source_image, "PNG")
    model_mask = canonical_mask
    model_mask_data = _png_bytes(model_mask)

    parts = [
        {"text": WATERMARK_REMOVAL_PROMPT},
        {
            "inlineData": {
                "mimeType": "image/png",
                "data": base64.b64encode(source_canvas_data).decode("ascii"),
            }
        },
        {
            "inlineData": {
                "mimeType": "image/png",
                "data": base64.b64encode(model_mask_data).decode("ascii"),
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
                        source.width,
                        source.height,
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
        canvas_size = (source.width, source.height)
        if normalized_result.size != canvas_size:
            normalized_result = normalized_result.resize(
                canvas_size,
                Image.Resampling.LANCZOS,
            )
        source_rgba = source_image.convert("RGBA")
        # Copy original pixels back everywhere outside the exact user mask.
        # Do not expand/feather the output into intact surrounding structure.
        composited = Image.composite(normalized_result, source_rgba, canonical_mask)
        result_data = _png_bytes(composited)

    quality_status = await _verify_repair(source, result_data, canonical_mask)

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
        "quality_status": quality_status,
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
