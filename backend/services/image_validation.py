import base64
import warnings
from dataclasses import dataclass
from io import BytesIO

from PIL import Image


MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_DIMENSION = 8192
MAX_IMAGE_PIXELS = 20_000_000


@dataclass(frozen=True)
class ValidatedImage:
    data: bytes
    mime_type: str
    image_format: str
    width: int
    height: int


def validate_image_payload(
    data,
    mime_type,
    *,
    max_bytes: int = MAX_IMAGE_BYTES,
    max_dimension: int = MAX_IMAGE_DIMENSION,
    max_pixels: int = MAX_IMAGE_PIXELS,
) -> ValidatedImage:
    if not isinstance(mime_type, str):
        raise ValueError("图片 MIME 类型无效")
    declared_mime = mime_type.split(";", 1)[0].strip().lower()
    declared_mime = {
        "image/jpg": "image/jpeg",
        "image/x-png": "image/png",
    }.get(declared_mime, declared_mime)
    if not declared_mime.startswith("image/"):
        raise ValueError("图片 MIME 类型无效")

    try:
        if isinstance(data, str):
            max_encoded_length = 4 * ((max_bytes + 2) // 3)
            if len(data) > max_encoded_length:
                raise ValueError("图片数据超过大小限制")
            image_bytes = base64.b64decode(data, validate=True)
        elif isinstance(data, bytes):
            image_bytes = data
        else:
            raise ValueError("图片数据无效")

        if not image_bytes:
            raise ValueError("图片数据无效")
        if len(image_bytes) > max_bytes:
            raise ValueError("图片数据超过大小限制")

        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(image_bytes)) as image:
                image_format = image.format
                width, height = image.size
                if (
                    width <= 0
                    or height <= 0
                    or width > max_dimension
                    or height > max_dimension
                    or width * height > max_pixels
                ):
                    raise ValueError("图片尺寸超过限制")
                image.verify()

            if (
                image_format == "PNG"
                and not image_bytes.endswith(
                    b"\x00\x00\x00\x00IEND\xaeB`\x82"
                )
            ):
                raise ValueError("PNG 图片数据不完整")
            if (
                image_format == "JPEG"
                and not image_bytes.endswith(b"\xff\xd9")
            ):
                raise ValueError("JPEG 图片数据不完整")

            with Image.open(BytesIO(image_bytes)) as decoded:
                if (
                    decoded.format != image_format
                    or decoded.size != (width, height)
                ):
                    raise ValueError("图片数据无效")
                decoded.load()

        actual_mime = Image.MIME.get(image_format, "").lower()
        if not actual_mime or actual_mime != declared_mime:
            raise ValueError("图片 MIME 类型与内容不一致")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("图片数据无效") from exc

    return ValidatedImage(
        data=image_bytes,
        mime_type=actual_mime,
        image_format=image_format,
        width=width,
        height=height,
    )
