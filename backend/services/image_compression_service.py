"""High-quality WebP image compression service using Pillow and libwebp."""

from __future__ import annotations

import base64
import io
import re
from typing import Any, Tuple

from PIL import Image


def compress_to_webp(
    image_bytes: bytes,
    quality: int = 90,
    method: int = 6,
) -> Tuple[bytes, dict[str, Any]]:
    """Compress raw image bytes to WebP format.

    Args:
        image_bytes: Raw binary bytes of the input image (PNG, JPEG, WEBP, etc.).
        quality: Integer between 1 and 100 (default 90 for high-fidelity visually lossless).
        method: Quality/speed trade-off between 0 (fastest) and 6 (slowest/best compression).

    Returns:
        A tuple of (compressed_webp_bytes, stats_dict).
    """
    if not image_bytes:
        raise ValueError("输入图片数据为空")

    quality = max(1, min(100, int(quality)))
    method = max(0, min(6, int(method)))
    original_size = len(image_bytes)

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            orig_format = img.format or "UNKNOWN"
            orig_width, orig_height = img.size

            # Preserve or adapt transparency
            if img.mode in ("RGBA", "LA"):
                proc_img = img.copy()
            elif img.mode == "P":
                if "transparency" in img.info:
                    proc_img = img.convert("RGBA")
                else:
                    proc_img = img.convert("RGB")
            elif img.mode == "CMYK":
                proc_img = img.convert("RGB")
            elif img.mode in ("RGB", "L"):
                proc_img = img.copy()
            else:
                proc_img = img.convert("RGBA" if "A" in img.mode else "RGB")

            save_kwargs: dict[str, Any] = {
                "format": "WEBP",
                "quality": quality,
                "method": method,
            }

            # Preserve ICC profile if present
            icc = img.info.get("icc_profile")
            if icc:
                save_kwargs["icc_profile"] = icc

            # Preserve EXIF if present
            exif = img.info.get("exif")
            if exif:
                save_kwargs["exif"] = exif

            out_buffer = io.BytesIO()
            proc_img.save(out_buffer, **save_kwargs)
            webp_bytes = out_buffer.getvalue()

    except Exception as exc:
        raise ValueError(f"图片解码或压缩失败: {exc}") from exc

    compressed_size = len(webp_bytes)
    savings = max(0, original_size - compressed_size)
    savings_percent = round((savings / original_size) * 100, 1) if original_size > 0 else 0.0

    stats = {
        "original_size": original_size,
        "compressed_size": compressed_size,
        "savings_bytes": savings,
        "savings_percent": savings_percent,
        "width": orig_width,
        "height": orig_height,
        "original_format": orig_format,
        "output_format": "WEBP",
        "mime_type": "image/webp",
        "quality": quality,
    }

    return webp_bytes, stats


def compress_data_url_to_webp(
    data_url: str,
    quality: int = 90,
    method: int = 6,
) -> Tuple[str, dict[str, Any]]:
    """Compress a base64 Data URL to a WebP base64 Data URL."""
    if not isinstance(data_url, str) or not data_url.strip():
        raise ValueError("无效的图片 Data URL")

    clean_url = data_url.strip()
    match = re.match(r"^data:(image\/[a-zA-Z0-9\+\-\.]+);base64,(.+)$", clean_url, re.DOTALL)
    if not match:
        raise ValueError("图片不是合法的 base64 Data URL 格式")

    raw_bytes = base64.b64decode(match.group(2))
    webp_bytes, stats = compress_to_webp(raw_bytes, quality=quality, method=method)

    # If already webp and compressed size is not smaller, return original
    if stats["compressed_size"] >= stats["original_size"] and match.group(1) == "image/webp":
        return clean_url, stats

    encoded_webp = base64.b64encode(webp_bytes).decode("ascii")
    out_data_url = f"data:image/webp;base64,{encoded_webp}"
    return out_data_url, stats
