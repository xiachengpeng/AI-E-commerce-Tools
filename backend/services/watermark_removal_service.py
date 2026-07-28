import math
import re
from io import BytesIO

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from models.request import WatermarkRegion
from services.image_validation import ValidatedImage, validate_image_payload


DATA_URL_PATTERN = re.compile(
    r"^data:(image/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$"
)


def decode_data_url(data_url: str, *, require_png: bool = False) -> ValidatedImage:
    if not isinstance(data_url, str):
        raise ValueError("请上传有效的图片 data URL")
    match = DATA_URL_PATTERN.fullmatch(data_url)
    if not match:
        raise ValueError("请上传有效的图片 data URL")

    image = validate_image_payload(match.group(2), match.group(1))
    if image.image_format not in {"JPEG", "PNG", "WEBP"}:
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
