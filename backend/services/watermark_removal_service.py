import math
import re
from io import BytesIO

from PIL import Image

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
        return grayscale.point(lambda value: 255 if value == 255 else 0, "1")


def _expected_mask(width: int, height: int, regions: list[WatermarkRegion]) -> Image.Image:
    expected = Image.new("1", (width, height), 0)
    for region in regions:
        left = math.floor(region.x * width)
        top = math.floor(region.y * height)
        right = math.ceil((region.x + region.width) * width)
        bottom = math.ceil((region.y + region.height) * height)
        for y in range(top, bottom):
            for x in range(left, right):
                expected.putpixel((x, y), 1)
    return expected


def _dilate_one_pixel(mask: Image.Image) -> Image.Image:
    width, height = mask.size
    dilated = Image.new("1", mask.size, 0)
    for y in range(height):
        for x in range(width):
            if not mask.getpixel((x, y)):
                continue
            for neighbor_y in range(max(0, y - 1), min(height, y + 2)):
                for neighbor_x in range(max(0, x - 1), min(width, x + 2)):
                    dilated.putpixel((neighbor_x, neighbor_y), 1)
    return dilated


def _is_subset(mask: Image.Image, allowed: Image.Image) -> bool:
    return all(
        not mask.getpixel((x, y)) or allowed.getpixel((x, y))
        for y in range(mask.height)
        for x in range(mask.width)
    )


def validate_mask(
    source: ValidatedImage,
    mask: ValidatedImage,
    regions: list[WatermarkRegion],
) -> None:
    if (mask.width, mask.height) != (source.width, source.height):
        raise ValueError("遮罩尺寸必须与原图一致")

    normalized_regions = validate_regions(regions)
    actual = _binary_mask(mask)
    if not any(actual.get_flattened_data()):
        raise ValueError("遮罩至少需要包含一个白色像素")

    expected = _expected_mask(source.width, source.height, normalized_regions)
    if not (
        _is_subset(actual, _dilate_one_pixel(expected))
        and _is_subset(expected, _dilate_one_pixel(actual))
    ):
        raise ValueError("遮罩与框选区域不一致")
