import base64
import io
import re
from pathlib import Path

from PIL import Image


MAX_SQUARE_REDRAW_BATCH_SIZE = 100
SQUARE_REDRAW_PROMPT = """Redraw the uploaded image into a perfect 1:1 square format.

Keep the original subject, clothing, composition, lighting, colors, textures, and visual style unchanged.

Extend or intelligently reconstruct the missing areas if necessary to fit the square canvas.

Do not crop important elements.
Do not cut off the model, clothing, accessories, or product.

Maintain:
- original outfit details
- fabric texture
- colors and patterns
- lighting and shadows
- photography style
- commercial quality

The final image should look like the original image was naturally photographed in a 1:1 square composition.

High-end ecommerce photography, ultra realistic, Pinterest advertising quality."""


def decode_image_data_url(image_data: str) -> tuple[str, bytes]:
    if not isinstance(image_data, str) or not image_data.startswith("data:image") or "," not in image_data:
        raise ValueError("请上传有效的图片 data URL")
    header, encoded = image_data.split(",", 1)
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64$", header)
    if not match:
        raise ValueError("请上传有效的图片 data URL")
    try:
        return match.group(1), base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("图片 base64 数据无效") from exc


def image_size_from_bytes(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as image:
        return image.size


def safe_output_basename(filename: str) -> str:
    stem = Path(filename or "image").stem
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-").lower()
    return stem if re.search(r"[a-z]", stem) else "image"


def mime_extension(mime_type: str) -> str:
    mapping = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
    }
    return mapping.get((mime_type or "").lower(), "png")
