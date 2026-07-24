import base64
import asyncio
import io
import json
import os
import re
import time
import uuid
import zipfile
from pathlib import Path

from PIL import Image

from config import FRONTEND_CONCURRENCY_LIMIT
from db import SessionLocal, SquareRedrawBatch, SquareRedrawItem
from services.ai_service import AIService
from services.app_log_service import app_logs
from services.image_validation import validate_image_payload


MAX_SQUARE_REDRAW_BATCH_SIZE = 100
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
SQUARE_OUTPUT_ROOT = os.path.join(STATIC_DIR, "outputs", "square-redraw")
SQUARE_REDRAW_PROMPT_TEMPLATE = """Redraw the uploaded image into a perfect {aspect_ratio} format.

Keep the original subject, clothing, composition, lighting, colors, textures, and visual style unchanged.

Extend or intelligently reconstruct the missing areas if necessary to fit the target canvas.

Do not crop important elements.
Do not cut off the model, clothing, accessories, or product.

Maintain:
- original outfit details
- fabric texture
- colors and patterns
- lighting and shadows
- photography style
- commercial quality

The final image should look like the original image was naturally photographed in a {aspect_ratio} composition.

High-end ecommerce photography, ultra realistic, Pinterest advertising quality."""


def decode_image_data_url(image_data: str) -> tuple[str, bytes]:
    if not isinstance(image_data, str) or not image_data.startswith("data:image") or "," not in image_data:
        raise ValueError("请上传有效的图片 data URL")
    header, encoded = image_data.split(",", 1)
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64$", header)
    if not match:
        raise ValueError("请上传有效的图片 data URL")
    mime_type = match.group(1).lower()
    supported_mime_types = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
    if mime_type not in supported_mime_types:
        raise ValueError("不支持的图片格式")
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("图片 base64 数据无效") from exc
    try:
        image_size_from_bytes(data)
    except Exception as exc:
        raise ValueError("图片数据无效") from exc
    return mime_type, data


def image_size_from_bytes(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as image:
        image.load()
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


def static_url_for_path(path: str) -> str:
    rel_path = os.path.relpath(path, STATIC_DIR).replace(os.sep, "/")
    return f"/static/{rel_path}"


def save_bytes_for_item(batch_id: int, filename: str, data: bytes, mime_type: str, folder: str) -> str:
    ext = mime_extension(mime_type)
    basename = safe_output_basename(filename)
    out_dir = os.path.join(SQUARE_OUTPUT_ROOT, str(batch_id), folder)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{basename}-{uuid.uuid4().hex[:8]}.{ext}")
    with open(out_path, "wb") as file:
        file.write(data)
    return static_url_for_path(out_path)


def summarize_items(items: list[SquareRedrawItem]) -> dict:
    return {
        "total": len(items),
        "queued": sum(1 for item in items if item.status == "queued"),
        "running": sum(1 for item in items if item.status == "running"),
        "done": sum(1 for item in items if item.status == "done"),
        "failed": sum(1 for item in items if item.status == "failed"),
        "skipped": sum(1 for item in items if item.status == "skipped_square"),
    }


def image_matches_aspect_ratio(width: int | None, height: int | None, aspect_ratio: str) -> bool:
    if not width or not height or ":" not in aspect_ratio:
        return False
    target_width, target_height = [int(part) for part in aspect_ratio.split(":", 1)]
    return width * target_height == height * target_width


def serialize_square_redraw_batch(db, batch_id: int) -> dict:
    batch = db.query(SquareRedrawBatch).filter(SquareRedrawBatch.id == batch_id).first()
    if not batch:
        raise ValueError("批次不存在")

    items = (
        db.query(SquareRedrawItem)
        .filter(SquareRedrawItem.batch_id == batch_id)
        .order_by(SquareRedrawItem.id.asc())
        .all()
    )
    return {
        "id": batch.id,
        "status": batch.status,
        "target_aspect_ratio": batch.target_aspect_ratio or "1:1",
        "created_at": batch.created_at.isoformat() if batch.created_at else None,
        "updated_at": batch.updated_at.isoformat() if batch.updated_at else None,
        "summary": summarize_items(items),
        "items": [{
            "id": item.id,
            "filename": item.source_filename,
            "mime_type": item.source_mime_type,
            "width": item.source_width,
            "height": item.source_height,
            "status": item.status,
            "retry_count": item.retry_count,
            "source_url": item.source_url,
            "output_url": item.output_url,
            "error_message": item.error_message,
        } for item in items],
    }


def _update_batch_status(db, batch_id: int) -> None:
    batch = db.query(SquareRedrawBatch).filter(SquareRedrawBatch.id == batch_id).first()
    if not batch:
        return

    items = db.query(SquareRedrawItem).filter(SquareRedrawItem.batch_id == batch_id).all()
    if not items:
        batch.status = "failed"
    elif any(item.status == "running" for item in items):
        batch.status = "running"
    elif any(item.status == "queued" for item in items):
        batch.status = "queued"
    elif any(item.status == "failed" for item in items):
        batch.status = "failed"
    else:
        batch.status = "done"
    db.commit()


def create_square_redraw_batch(db, request) -> SquareRedrawBatch:
    target_aspect_ratio = request.target_aspect_ratio or "1:1"
    batch = SquareRedrawBatch(status="queued", target_aspect_ratio=target_aspect_ratio, output_dir=SQUARE_OUTPUT_ROOT)
    db.add(batch)
    db.commit()
    db.refresh(batch)

    for image in request.images:
        item = SquareRedrawItem(
            batch_id=batch.id,
            source_filename=image.filename,
            source_mime_type="",
            status="queued",
        )
        try:
            mime_type, data = decode_image_data_url(image.image_data)
            width, height = image_size_from_bytes(data)
            item.source_mime_type = mime_type
            item.source_width = width
            item.source_height = height
            item.source_url = save_bytes_for_item(batch.id, image.filename, data, mime_type, "sources")
            if image_matches_aspect_ratio(width, height, target_aspect_ratio):
                item.status = "skipped_square"
        except Exception as exc:
            item.status = "failed"
            item.error_message = str(exc)
        db.add(item)

    db.commit()
    _update_batch_status(db, batch.id)
    db.refresh(batch)
    return batch


def _read_static_url_bytes(static_url: str) -> bytes:
    if not static_url or not static_url.startswith("/static/"):
        raise ValueError("源图片路径无效")
    rel_path = static_url.replace("/static/", "", 1)
    abs_path = os.path.join(STATIC_DIR, rel_path)
    with open(abs_path, "rb") as file:
        return file.read()


async def process_square_redraw_batch(batch_id: int) -> None:
    db = SessionLocal()
    try:
        items = (
            db.query(SquareRedrawItem)
            .filter(
                SquareRedrawItem.batch_id == batch_id,
                SquareRedrawItem.status == "queued",
            )
            .order_by(SquareRedrawItem.id.asc())
            .all()
        )
    finally:
        db.close()

    concurrency = max(1, FRONTEND_CONCURRENCY_LIMIT)
    semaphore = asyncio.Semaphore(concurrency)

    async def run_item(item_id: int) -> None:
        async with semaphore:
            await process_square_redraw_item(item_id)

    await asyncio.gather(*(run_item(item.id) for item in items))


async def process_square_redraw_item(item_id: int) -> None:
    db = SessionLocal()
    item = None
    started = time.monotonic()
    event_started = False
    try:
        item = db.query(SquareRedrawItem).filter(SquareRedrawItem.id == item_id).first()
        if not item or item.status != "queued":
            return

        app_logs.emit(
            level="info",
            source="image",
            message="方图重绘开始",
            capability="image",
        )
        event_started = True
        item.status = "running"
        item.error_message = None
        db.commit()
        _update_batch_status(db, item.batch_id)

        batch = db.query(SquareRedrawBatch).filter(SquareRedrawBatch.id == item.batch_id).first()
        target_aspect_ratio = (batch.target_aspect_ratio if batch else None) or "1:1"
        source_bytes = _read_static_url_bytes(item.source_url)
        source_b64 = base64.b64encode(source_bytes).decode("utf-8")
        payload = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": SQUARE_REDRAW_PROMPT_TEMPLATE.format(aspect_ratio=target_aspect_ratio)},
                    {"inlineData": {"mimeType": item.source_mime_type, "data": source_b64}},
                ],
            }],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "imageConfig": {"aspectRatio": target_aspect_ratio},
            },
        }
        response = await AIService.generate_content(
            payload=payload,
            capability="image",
        )
        image_part = next(
            (
                part.get("inlineData")
                for part in response.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                if part.get("inlineData")
            ),
            None,
        )
        if not image_part:
            raise ValueError("模型未返回图像数据")

        output_image = validate_image_payload(
            image_part.get("data"),
            image_part.get("mimeType")
            or image_part.get("mime_type")
            or "",
        )
        item.output_url = save_bytes_for_item(
            item.batch_id,
            f"{safe_output_basename(item.source_filename)}-square.png",
            output_image.data,
            output_image.mime_type,
            "redrawn",
        )
        item.status = "done"
        item.error_message = None
        app_logs.emit(
            level="success",
            source="image",
            message="方图重绘完成",
            capability="image",
            duration_ms=round((time.monotonic() - started) * 1000),
        )
    except Exception as exc:
        if item is None:
            item = db.query(SquareRedrawItem).filter(SquareRedrawItem.id == item_id).first()
        if item:
            item.status = "failed"
            item.error_message = str(exc)[:500]
        if event_started:
            app_logs.emit(
                level="error",
                source="image",
                message="方图重绘失败",
                capability="image",
                duration_ms=round(
                    (time.monotonic() - started) * 1000
                ),
            )
    finally:
        if item:
            db.commit()
            _update_batch_status(db, item.batch_id)
        db.close()


def retry_failed_square_redraw_items(db, batch_id: int) -> int:
    failed_items = (
        db.query(SquareRedrawItem)
        .filter(
            SquareRedrawItem.batch_id == batch_id,
            SquareRedrawItem.status == "failed",
        )
        .all()
    )
    for item in failed_items:
        item.status = "queued"
        item.error_message = None
        item.output_url = None
        item.retry_count = (item.retry_count or 0) + 1
    db.commit()
    _update_batch_status(db, batch_id)
    return len(failed_items)


def delete_square_redraw_item(db, batch_id: int, item_id: int) -> None:
    item = (
        db.query(SquareRedrawItem)
        .filter(
            SquareRedrawItem.batch_id == batch_id,
            SquareRedrawItem.id == item_id,
        )
        .first()
    )
    if not item:
        raise ValueError("图片不存在")
    if item.status == "running":
        raise ValueError("图片正在处理中，暂不能删除")

    db.delete(item)
    db.commit()
    _update_batch_status(db, batch_id)


def _static_url_to_abs_path(static_url: str) -> str:
    if not static_url or not static_url.startswith("/static/"):
        raise ValueError("静态文件路径无效")
    return os.path.join(STATIC_DIR, static_url.replace("/static/", "", 1))


def _zip_arcname(item: SquareRedrawItem, url: str, used_names: set[str]) -> str:
    ext = Path(_static_url_to_abs_path(url)).suffix or ".png"
    base = safe_output_basename(item.source_filename)
    candidate = f"{base}{ext}"
    index = 2
    while candidate in used_names:
        candidate = f"{base}-{index}{ext}"
        index += 1
    used_names.add(candidate)
    return candidate


def build_square_redraw_zip(db, batch_id: int) -> str:
    batch = db.query(SquareRedrawBatch).filter(SquareRedrawBatch.id == batch_id).first()
    if not batch:
        raise ValueError("批次不存在")

    items = (
        db.query(SquareRedrawItem)
        .filter(SquareRedrawItem.batch_id == batch_id)
        .order_by(SquareRedrawItem.id.asc())
        .all()
    )
    usable_items = [item for item in items if item.status in {"done", "skipped_square"}]
    if not usable_items:
        raise ValueError("没有可导出的图片")

    out_dir = os.path.join(SQUARE_OUTPUT_ROOT, str(batch_id))
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"square-redraw-{batch_id}.zip")
    manifest = {
        "batch_id": batch_id,
        "target_aspect_ratio": batch.target_aspect_ratio or "1:1",
        "items": [{
            "filename": item.source_filename,
            "width": item.source_width,
            "height": item.source_height,
            "status": item.status,
            "retry_count": item.retry_count or 0,
            "source_url": item.source_url,
            "output_url": item.output_url,
            "error_message": item.error_message,
        } for item in items],
    }

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        used_names = {"manifest.json"}
        for item in usable_items:
            if item.status == "done" and item.output_url:
                archive.write(
                    _static_url_to_abs_path(item.output_url),
                    _zip_arcname(item, item.output_url, used_names),
                )
            if item.status == "skipped_square" and item.source_url:
                archive.write(
                    _static_url_to_abs_path(item.source_url),
                    _zip_arcname(item, item.source_url, used_names),
                )
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    batch.zip_path = zip_path
    db.commit()
    return zip_path
