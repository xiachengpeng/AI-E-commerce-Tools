# Square Redraw Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new "方图重绘" module that batch redraws 1 to 100 ecommerce images into 1:1 square images, skips existing square images, and exports one zip package.

**Architecture:** Add a focused backend service for batch creation, item processing, dimension checks, AI redraw calls, retry, and zip generation. Add SQLite models for batches/items and a standalone vanilla JS frontend module that uploads images, shows progress, polls backend state, retries failures, and downloads the final zip.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite, google-genai through existing `AIService`, Pillow for dimension checks, vanilla JavaScript, existing Phosphor icons and app CSS.

---

## File Structure

- Create `backend/services/square_redraw_service.py`: owns prompt, data URL parsing, image saving, dimension detection, batch/item processing, AI calls, retry, summary serialization, and zip generation.
- Modify `backend/db.py`: add `SquareRedrawBatch` and `SquareRedrawItem` SQLAlchemy models.
- Modify `backend/models/request.py`: add typed request models for batch creation.
- Modify `backend/requirements.txt`: add Pillow for backend image dimension parsing.
- Modify `backend/main.py`: import models/service functions and expose `/api/square-redraw/*` routes.
- Create `backend/tests/test_square_redraw_service.py`: service-level tests for validation, skip behavior, AI payload, retry, and zip structure.
- Modify `backend/tests/test_main.py`: route-level tests for create/get/retry/download behavior.
- Create `frontend/js/square_redraw.js`: standalone frontend state, upload/dimension detection, rendering, polling, retry, and zip download.
- Modify `frontend/index.html`: add sidebar tab, page markup, and script tag.
- Reuse existing utility classes and do not modify `frontend/css/style.css` in the first implementation.

---

### Task 1: Add Backend Persistence Models

**Files:**
- Modify: `backend/db.py`
- Test: `backend/tests/test_square_redraw_service.py`

- [ ] **Step 1: Write the failing model smoke test**

Create `backend/tests/test_square_redraw_service.py` with this initial content:

```python
import datetime

from db import Base, SquareRedrawBatch, SquareRedrawItem


def test_square_redraw_models_are_registered():
    assert "square_redraw_batches" in Base.metadata.tables
    assert "square_redraw_items" in Base.metadata.tables


def test_square_redraw_model_defaults():
    batch = SquareRedrawBatch(status="queued", output_dir="/tmp/out")
    item = SquareRedrawItem(
        batch_id=1,
        source_filename="dress.jpg",
        source_mime_type="image/jpeg",
        status="queued",
    )

    assert batch.status == "queued"
    assert batch.output_dir == "/tmp/out"
    assert item.retry_count == 0
    assert item.source_filename == "dress.jpg"
    assert isinstance(batch.created_at, datetime.datetime) or batch.created_at is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py::test_square_redraw_models_are_registered -v
```

Expected: FAIL with an import error for `SquareRedrawBatch` or `SquareRedrawItem`.

- [ ] **Step 3: Add SQLAlchemy models**

In `backend/db.py`, update the import line:

```python
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, JSON, ForeignKey
```

Then add these models after `RenderHistory`:

```python
class SquareRedrawBatch(Base):
    __tablename__ = "square_redraw_batches"
    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)
    status = Column(String(30), default="queued", index=True)
    output_dir = Column(Text)
    zip_path = Column(Text, nullable=True)


class SquareRedrawItem(Base):
    __tablename__ = "square_redraw_items"
    id = Column(Integer, primary_key=True, index=True)
    batch_id = Column(Integer, ForeignKey("square_redraw_batches.id"), index=True)
    created_at = Column(DateTime, default=datetime.datetime.now)
    updated_at = Column(DateTime, default=datetime.datetime.now, onupdate=datetime.datetime.now)
    source_filename = Column(String(255))
    source_mime_type = Column(String(100))
    source_width = Column(Integer, nullable=True)
    source_height = Column(Integer, nullable=True)
    status = Column(String(30), default="queued", index=True)
    retry_count = Column(Integer, default=0)
    source_url = Column(Text, nullable=True)
    output_url = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
```

- [ ] **Step 4: Run the model tests**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py -v
```

Expected: PASS for the two model tests.

- [ ] **Step 5: Commit**

```bash
git add backend/db.py backend/tests/test_square_redraw_service.py
git commit -m "Add square redraw persistence models"
```

---

### Task 2: Add Request Models and Core Service Helpers

**Files:**
- Modify: `backend/requirements.txt`
- Modify: `backend/models/request.py`
- Create/Modify: `backend/services/square_redraw_service.py`
- Test: `backend/tests/test_square_redraw_service.py`

- [ ] **Step 1: Add Pillow dependency**

Add this line to `backend/requirements.txt` if it is not already present:

```text
Pillow>=10.0.0
```

Then install dependencies in the current environment if needed:

```bash
pip install -r backend/requirements.txt
```

Expected: Pillow is importable as `PIL`.

- [ ] **Step 2: Add failing tests for request validation and data URL parsing**

Append to `backend/tests/test_square_redraw_service.py`:

```python
import base64
import io

import pytest
from PIL import Image

from models.request import SquareRedrawBatchRequest
from services.square_redraw_service import (
    MAX_SQUARE_REDRAW_BATCH_SIZE,
    decode_image_data_url,
    image_size_from_bytes,
    safe_output_basename,
)


def make_data_url(width=10, height=20, fmt="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format=fmt)
    mime = "image/png" if fmt == "PNG" else "image/jpeg"
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:{mime};base64,{encoded}"


def test_square_redraw_request_accepts_one_image():
    request = SquareRedrawBatchRequest(images=[{
        "filename": "dress.jpg",
        "image_data": make_data_url(),
        "width": 10,
        "height": 20,
    }])
    assert len(request.images) == 1


def test_square_redraw_request_rejects_more_than_100_images():
    images = [{
        "filename": f"image-{idx}.jpg",
        "image_data": make_data_url(),
        "width": 10,
        "height": 20,
    } for idx in range(MAX_SQUARE_REDRAW_BATCH_SIZE + 1)]
    with pytest.raises(ValueError, match="最多 100 张"):
        SquareRedrawBatchRequest(images=images)


def test_decode_image_data_url_returns_mime_and_bytes():
    mime_type, data = decode_image_data_url(make_data_url(8, 9))
    assert mime_type == "image/png"
    assert image_size_from_bytes(data) == (8, 9)


def test_decode_image_data_url_rejects_non_image_data():
    with pytest.raises(ValueError, match="图片 data URL"):
        decode_image_data_url("not-an-image")


def test_safe_output_basename_removes_path_and_extension():
    assert safe_output_basename("../dress photo.JPG") == "dress-photo"
    assert safe_output_basename("图 1.png") == "image"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py -v
```

Expected: FAIL because `SquareRedrawBatchRequest` and helper functions do not exist.

- [ ] **Step 4: Add request models**

In `backend/models/request.py`, add these classes after `AdCopyGenerateRequest`:

```python
class SquareRedrawImageInput(BaseModel):
    filename: str
    image_data: str
    width: int | None = None
    height: int | None = None

    @field_validator("filename", "image_data")
    @classmethod
    def strip_required_text(cls, v: str) -> str:
        return v.strip()


class SquareRedrawBatchRequest(BaseModel):
    images: List[SquareRedrawImageInput]

    @field_validator("images")
    @classmethod
    def validate_images(cls, v: List[SquareRedrawImageInput]) -> List[SquareRedrawImageInput]:
        if not v:
            raise ValueError("请至少上传 1 张图片")
        if len(v) > 100:
            raise ValueError("每批最多 100 张图片")
        return v
```

- [ ] **Step 5: Add service helper implementation**

Create `backend/services/square_redraw_service.py`:

```python
import base64
import io
import os
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
    return stem or "image"


def mime_extension(mime_type: str) -> str:
    mapping = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
    }
    return mapping.get((mime_type or "").lower(), "png")
```

- [ ] **Step 6: Run helper tests**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py -v
```

Expected: PASS for model and helper tests.

- [ ] **Step 7: Commit**

```bash
git add backend/requirements.txt backend/models/request.py backend/services/square_redraw_service.py backend/tests/test_square_redraw_service.py
git commit -m "Add square redraw request validation"
```

---

### Task 3: Implement Batch Creation and Item Processing

**Files:**
- Modify: `backend/services/square_redraw_service.py`
- Test: `backend/tests/test_square_redraw_service.py`

- [ ] **Step 1: Add failing service tests for create/process behavior**

Append to `backend/tests/test_square_redraw_service.py`:

```python
from unittest.mock import AsyncMock, patch

from db import SessionLocal, SquareRedrawBatch, SquareRedrawItem
from models.request import SquareRedrawBatchRequest
from services.square_redraw_service import (
    create_square_redraw_batch,
    process_square_redraw_batch,
    serialize_square_redraw_batch,
)


def clear_square_redraw_tables():
    db = SessionLocal()
    try:
        db.query(SquareRedrawItem).delete()
        db.query(SquareRedrawBatch).delete()
        db.commit()
    finally:
        db.close()


def test_create_batch_marks_square_images_skipped():
    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[{
        "filename": "square.png",
        "image_data": make_data_url(40, 40),
        "width": 40,
        "height": 40,
    }])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        data = serialize_square_redraw_batch(db, batch.id)
        assert data["summary"]["total"] == 1
        assert data["summary"]["skipped"] == 1
        assert data["items"][0]["status"] == "skipped_square"
        assert data["items"][0]["source_url"].startswith("/static/outputs/square-redraw/")
    finally:
        db.close()


@pytest.mark.asyncio
async def test_process_non_square_uses_square_image_config():
    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[{
        "filename": "portrait.png",
        "image_data": make_data_url(40, 80),
        "width": 40,
        "height": 80,
    }])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
    finally:
        db.close()

    ai_response = {
        "candidates": [{
            "content": {
                "parts": [{
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": base64.b64encode(b"fake-image").decode("utf-8"),
                    }
                }]
            }
        }]
    }
    with patch("services.square_redraw_service.AIService.generate_content", new=AsyncMock(return_value=ai_response)) as mock_ai:
        await process_square_redraw_batch(batch.id)

    payload = mock_ai.await_args.kwargs["payload"]
    assert payload["generationConfig"]["responseModalities"] == ["IMAGE"]
    assert payload["generationConfig"]["imageConfig"]["aspectRatio"] == "1:1"

    db = SessionLocal()
    try:
        item = db.query(SquareRedrawItem).filter(SquareRedrawItem.batch_id == batch.id).one()
        assert item.status == "done"
        assert item.output_url.startswith("/static/outputs/square-redraw/")
    finally:
        db.close()
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py::test_create_batch_marks_square_images_skipped backend/tests/test_square_redraw_service.py::test_process_non_square_uses_square_image_config -v
```

Expected: FAIL because batch functions do not exist.

- [ ] **Step 3: Add batch serialization and file-save helpers**

Append to `backend/services/square_redraw_service.py`:

```python
import asyncio
import uuid

from db import SessionLocal, SquareRedrawBatch, SquareRedrawItem
from services.ai_service import AIService
from config import FRONTEND_STAGGER_DELAY, GEMINI_MODEL_ID


STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
SQUARE_OUTPUT_ROOT = os.path.join(STATIC_DIR, "outputs", "square-redraw")


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


def serialize_square_redraw_batch(db, batch_id: int) -> dict:
    batch = db.query(SquareRedrawBatch).filter(SquareRedrawBatch.id == batch_id).first()
    if not batch:
        raise ValueError("批次不存在")
    items = db.query(SquareRedrawItem).filter(SquareRedrawItem.batch_id == batch_id).order_by(SquareRedrawItem.id.asc()).all()
    return {
        "id": batch.id,
        "status": batch.status,
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
```

- [ ] **Step 4: Add create and process functions**

Append to `backend/services/square_redraw_service.py`:

```python
def create_square_redraw_batch(db, request) -> SquareRedrawBatch:
    batch = SquareRedrawBatch(status="queued", output_dir=SQUARE_OUTPUT_ROOT)
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
            if width == height:
                item.status = "skipped_square"
        except Exception as exc:
            item.status = "failed"
            item.error_message = str(exc)
        db.add(item)

    db.commit()
    _update_batch_status(db, batch.id)
    db.refresh(batch)
    return batch


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


def _read_static_url_bytes(static_url: str) -> bytes:
    if not static_url or not static_url.startswith("/static/"):
        raise ValueError("源图片路径无效")
    rel_path = static_url.replace("/static/", "", 1)
    abs_path = os.path.join(STATIC_DIR, rel_path)
    with open(abs_path, "rb") as file:
        return file.read()


def _image_model_id() -> str:
    return os.getenv("FRONTEND_IMAGE_MODEL") or GEMINI_MODEL_ID


async def process_square_redraw_batch(batch_id: int) -> None:
    db = SessionLocal()
    try:
        items = db.query(SquareRedrawItem).filter(
            SquareRedrawItem.batch_id == batch_id,
            SquareRedrawItem.status == "queued",
        ).order_by(SquareRedrawItem.id.asc()).all()
    finally:
        db.close()

    for index, item in enumerate(items):
        await process_square_redraw_item(item.id)
        if index < len(items) - 1 and FRONTEND_STAGGER_DELAY > 0:
            await asyncio.sleep(FRONTEND_STAGGER_DELAY / 1000)


async def process_square_redraw_item(item_id: int) -> None:
    db = SessionLocal()
    try:
        item = None
        item = db.query(SquareRedrawItem).filter(SquareRedrawItem.id == item_id).first()
        if not item or item.status != "queued":
            return
        item.status = "running"
        item.error_message = None
        db.commit()
        _update_batch_status(db, item.batch_id)

        source_bytes = _read_static_url_bytes(item.source_url)
        source_b64 = base64.b64encode(source_bytes).decode("utf-8")
        payload = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": SQUARE_REDRAW_PROMPT},
                    {"inlineData": {"mimeType": item.source_mime_type, "data": source_b64}},
                ],
            }],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "imageConfig": {"aspectRatio": "1:1"},
            },
        }
        response = await AIService.generate_content(model_id=_image_model_id(), payload=payload)
        image_part = next(
            (part.get("inlineData") for part in response.get("candidates", [{}])[0].get("content", {}).get("parts", []) if part.get("inlineData")),
            None,
        )
        if not image_part:
            raise ValueError("模型未返回图像数据")
        output_bytes = base64.b64decode(image_part["data"])
        item.output_url = save_bytes_for_item(
            item.batch_id,
            f"{safe_output_basename(item.source_filename)}-square.png",
            output_bytes,
            image_part.get("mimeType") or "image/png",
            "redrawn",
        )
        item.status = "done"
        item.error_message = None
    except Exception as exc:
        item = db.query(SquareRedrawItem).filter(SquareRedrawItem.id == item_id).first()
        if item:
            item.status = "failed"
            item.error_message = str(exc)[:500]
    finally:
        if item:
            db.commit()
            _update_batch_status(db, item.batch_id)
        db.close()
```

- [ ] **Step 5: Run service tests**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/services/square_redraw_service.py backend/tests/test_square_redraw_service.py
git commit -m "Implement square redraw batch processing"
```

---

### Task 4: Add Retry and Zip Export

**Files:**
- Modify: `backend/services/square_redraw_service.py`
- Test: `backend/tests/test_square_redraw_service.py`

- [ ] **Step 1: Add failing retry and zip tests**

Append to `backend/tests/test_square_redraw_service.py`:

```python
import json
import zipfile

from services.square_redraw_service import build_square_redraw_zip, retry_failed_square_redraw_items, save_bytes_for_item


def test_retry_failed_only_resets_failed_items():
    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[
        {"filename": "bad.png", "image_data": "bad", "width": 10, "height": 20},
        {"filename": "square.png", "image_data": make_data_url(20, 20), "width": 20, "height": 20},
    ])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        reset_count = retry_failed_square_redraw_items(db, batch.id)
        items = db.query(SquareRedrawItem).filter(SquareRedrawItem.batch_id == batch.id).order_by(SquareRedrawItem.id.asc()).all()
        assert reset_count == 1
        assert items[0].status == "queued"
        assert items[0].retry_count == 1
        assert items[1].status == "skipped_square"
    finally:
        db.close()


def test_build_square_redraw_zip_contains_redrawn_skipped_and_manifest(tmp_path):
    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[{
        "filename": "square.png",
        "image_data": make_data_url(20, 20),
        "width": 20,
        "height": 20,
    }])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        redrawn_path = save_bytes_for_item(batch.id, "portrait-square.png", b"redrawn", "image/png", "redrawn")
        done = SquareRedrawItem(
            batch_id=batch.id,
            source_filename="portrait.png",
            source_mime_type="image/png",
            source_width=10,
            source_height=20,
            status="done",
            output_url=redrawn_path,
        )
        db.add(done)
        db.commit()
        zip_path = build_square_redraw_zip(db, batch.id)
        assert zip_path.endswith(".zip")
        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            assert "manifest.json" in names
            assert any(name.startswith("redrawn/") for name in names)
            assert any(name.startswith("skipped-originals/") for name in names)
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            assert len(manifest["items"]) == 2
    finally:
        db.close()
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py::test_retry_failed_only_resets_failed_items backend/tests/test_square_redraw_service.py::test_build_square_redraw_zip_contains_redrawn_skipped_and_manifest -v
```

Expected: FAIL because retry and zip functions do not exist.

- [ ] **Step 3: Add retry and zip functions**

Append to `backend/services/square_redraw_service.py`:

```python
import json
import zipfile


def retry_failed_square_redraw_items(db, batch_id: int) -> int:
    failed_items = db.query(SquareRedrawItem).filter(
        SquareRedrawItem.batch_id == batch_id,
        SquareRedrawItem.status == "failed",
    ).all()
    for item in failed_items:
        item.status = "queued"
        item.error_message = None
        item.output_url = None
        item.retry_count = (item.retry_count or 0) + 1
    db.commit()
    _update_batch_status(db, batch_id)
    return len(failed_items)


def _static_url_to_abs_path(static_url: str) -> str:
    if not static_url or not static_url.startswith("/static/"):
        raise ValueError("静态文件路径无效")
    return os.path.join(STATIC_DIR, static_url.replace("/static/", "", 1))


def _zip_arcname(folder: str, item: SquareRedrawItem, url: str) -> str:
    ext = Path(_static_url_to_abs_path(url)).suffix or ".png"
    base = safe_output_basename(item.source_filename)
    return f"{folder}/{base}{ext}"


def build_square_redraw_zip(db, batch_id: int) -> str:
    batch = db.query(SquareRedrawBatch).filter(SquareRedrawBatch.id == batch_id).first()
    if not batch:
        raise ValueError("批次不存在")
    items = db.query(SquareRedrawItem).filter(SquareRedrawItem.batch_id == batch_id).order_by(SquareRedrawItem.id.asc()).all()
    usable_items = [item for item in items if item.status in {"done", "skipped_square"}]
    if not usable_items:
        raise ValueError("没有可导出的图片")

    out_dir = os.path.join(SQUARE_OUTPUT_ROOT, str(batch_id))
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"square-redraw-{batch_id}.zip")
    manifest = {
        "batch_id": batch_id,
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
        for item in usable_items:
            if item.status == "done" and item.output_url:
                archive.write(_static_url_to_abs_path(item.output_url), _zip_arcname("redrawn", item, item.output_url))
            if item.status == "skipped_square" and item.source_url:
                archive.write(_static_url_to_abs_path(item.source_url), _zip_arcname("skipped-originals", item, item.source_url))
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    batch.zip_path = zip_path
    db.commit()
    return zip_path
```

- [ ] **Step 4: Run service tests**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/square_redraw_service.py backend/tests/test_square_redraw_service.py
git commit -m "Add square redraw retry and zip export"
```

---

### Task 5: Add FastAPI Routes

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/models/request.py`
- Test: `backend/tests/test_main.py`

- [ ] **Step 1: Add failing route tests**

Append to `backend/tests/test_main.py`:

```python
def make_route_image(width=10, height=20):
    import base64
    import io
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("utf-8")


def test_square_redraw_create_rejects_empty_batch():
    resp = client.post("/api/square-redraw/batches", json={"images": []})
    assert resp.status_code in {200, 422}
    data = resp.json()
    assert data.get("status") == "error" or "detail" in data


def test_square_redraw_create_accepts_square_image():
    resp = client.post("/api/square-redraw/batches", json={
        "images": [{
            "filename": "square.png",
            "image_data": make_route_image(12, 12),
            "width": 12,
            "height": 12,
        }]
    })
    data = resp.json()
    assert data["status"] == "success"
    assert data["data"]["summary"]["skipped"] == 1


def test_square_redraw_get_missing_batch_returns_error():
    resp = client.get("/api/square-redraw/batches/999999")
    data = resp.json()
    assert data["status"] == "error"
```

- [ ] **Step 2: Run the route tests to verify they fail**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_square_redraw_create_accepts_square_image backend/tests/test_main.py::test_square_redraw_get_missing_batch_returns_error -v
```

Expected: FAIL with 404 route responses.

- [ ] **Step 3: Import request model and service functions**

In `backend/main.py`, extend the `models.request` import:

```python
    AdCopyGenerateRequest,
    SquareRedrawBatchRequest,
)
```

Add service imports near the other service imports:

```python
from services.square_redraw_service import (
    build_square_redraw_zip,
    create_square_redraw_batch,
    process_square_redraw_batch,
    retry_failed_square_redraw_items,
    serialize_square_redraw_batch,
)
```

Extend the `db` import:

```python
from db import init_db, get_db, SessionLocal, AnalysisHistory, ListingHistory, TranslationHistory, TextTranslationHistory, AdsHistory, RenderHistory, SquareRedrawBatch
```

- [ ] **Step 4: Add API routes**

Add these routes before `/api/history/{module}` in `backend/main.py`:

```python
@app.post("/api/square-redraw/batches")
async def api_square_redraw_create(request: SquareRedrawBatchRequest, db: Session = Depends(get_db)):
    try:
        batch = create_square_redraw_batch(db, request)
        data = serialize_square_redraw_batch(db, batch.id)
        if data["summary"]["queued"] > 0:
            asyncio.create_task(process_square_redraw_batch(batch.id))
        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"❌ [方图重绘] 创建批次失败: {e}")
        return {"status": "error", "message": str(e)}


@app.get("/api/square-redraw/batches/{batch_id}")
async def api_square_redraw_get(batch_id: int, db: Session = Depends(get_db)):
    try:
        return {"status": "success", "data": serialize_square_redraw_batch(db, batch_id)}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/square-redraw/batches/{batch_id}/retry-failed")
async def api_square_redraw_retry_failed(batch_id: int, db: Session = Depends(get_db)):
    try:
        reset_count = retry_failed_square_redraw_items(db, batch_id)
        if reset_count:
            asyncio.create_task(process_square_redraw_batch(batch_id))
        return {"status": "success", "data": serialize_square_redraw_batch(db, batch_id)}
    except Exception as e:
        logger.error(f"❌ [方图重绘] 重跑失败项失败: {e}")
        return {"status": "error", "message": str(e)}


@app.get("/api/square-redraw/batches/{batch_id}/download")
async def api_square_redraw_download(batch_id: int, db: Session = Depends(get_db)):
    from fastapi.responses import FileResponse

    try:
        zip_path = build_square_redraw_zip(db, batch_id)
        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename=f"square-redraw-{batch_id}.zip",
        )
    except Exception as e:
        logger.error(f"❌ [方图重绘] 打包下载失败: {e}")
        return {"status": "error", "message": str(e)}
```

- [ ] **Step 5: Run route tests**

Run:

```bash
python -m pytest backend/tests/test_main.py::test_square_redraw_create_rejects_empty_batch backend/tests/test_main.py::test_square_redraw_create_accepts_square_image backend/tests/test_main.py::test_square_redraw_get_missing_batch_returns_error -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/models/request.py backend/tests/test_main.py
git commit -m "Add square redraw API routes"
```

---

### Task 6: Add Frontend Module and Markup

**Files:**
- Create: `frontend/js/square_redraw.js`
- Modify: `frontend/index.html`
- Test: `frontend/js/square_redraw.js`

- [ ] **Step 1: Add the frontend script**

Create `frontend/js/square_redraw.js`:

```javascript
let squareRedrawImages = [];
let squareRedrawBatchId = null;
let squareRedrawPollingTimer = null;
let squareRedrawFilter = 'all';

function initSquareRedrawControls() {
    renderSquareRedrawList();
    updateSquareRedrawActions();
}

function handleSquareRedrawUpload(event) {
    loadSquareRedrawFiles([...event.target.files]);
    event.target.value = '';
}

function handleSquareRedrawDrop(event) {
    event.preventDefault();
    loadSquareRedrawFiles([...event.dataTransfer.files].filter(file => file.type.startsWith('image/')));
}

function readImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('图片尺寸读取失败'));
        img.src = dataUrl;
    });
}

async function loadSquareRedrawFiles(files) {
    if (!files.length) return;
    if (files.length > 100) {
        showToast('每批最多上传 100 张图片，请拆批处理', 'error');
        return;
    }

    squareRedrawImages = [];
    for (const file of files) {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = () => reject(new Error('图片读取失败'));
            reader.readAsDataURL(file);
        });
        const size = await readImageDimensions(dataUrl);
        squareRedrawImages.push({
            id: `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            filename: file.name,
            image_data: dataUrl,
            width: size.width,
            height: size.height,
            status: size.width === size.height ? 'skipped_square' : 'ready',
            source_url: dataUrl,
            output_url: '',
            error_message: '',
        });
    }

    squareRedrawBatchId = null;
    renderSquareRedrawList();
    updateSquareRedrawActions();
    showToast(`已添加 ${squareRedrawImages.length} 张图片`, 'success');
}

function squareRedrawSummary() {
    return {
        total: squareRedrawImages.length,
        ready: squareRedrawImages.filter(item => item.status === 'ready' || item.status === 'queued').length,
        running: squareRedrawImages.filter(item => item.status === 'running').length,
        done: squareRedrawImages.filter(item => item.status === 'done').length,
        failed: squareRedrawImages.filter(item => item.status === 'failed').length,
        skipped: squareRedrawImages.filter(item => item.status === 'skipped_square').length,
    };
}

function renderSquareRedrawSummary() {
    const summary = squareRedrawSummary();
    const el = document.getElementById('squareRedrawSummary');
    if (!el) return;
    el.innerHTML = `
        <span>总数 ${summary.total}</span>
        <span>待重绘 ${summary.ready}</span>
        <span>处理中 ${summary.running}</span>
        <span>成功 ${summary.done}</span>
        <span>失败 ${summary.failed}</span>
        <span>跳过 ${summary.skipped}</span>
    `;
}

function setSquareRedrawFilter(filter) {
    squareRedrawFilter = filter;
    renderSquareRedrawList();
}

function squareRedrawVisibleItems() {
    if (squareRedrawFilter === 'all') return squareRedrawImages;
    if (squareRedrawFilter === 'pending') return squareRedrawImages.filter(item => ['ready', 'queued', 'running'].includes(item.status));
    if (squareRedrawFilter === 'success') return squareRedrawImages.filter(item => item.status === 'done');
    if (squareRedrawFilter === 'failed') return squareRedrawImages.filter(item => item.status === 'failed');
    if (squareRedrawFilter === 'skipped') return squareRedrawImages.filter(item => item.status === 'skipped_square');
    return squareRedrawImages;
}

function squareRedrawStatusLabel(status) {
    const labels = {
        ready: '待重绘',
        queued: '排队中',
        running: '处理中',
        done: '完成',
        failed: '失败',
        skipped_square: '已是 1:1，跳过',
    };
    return labels[status] || status;
}

function renderSquareRedrawList() {
    const empty = document.getElementById('squareRedrawEmptyState');
    const list = document.getElementById('squareRedrawList');
    if (!empty || !list) return;
    renderSquareRedrawSummary();

    if (!squareRedrawImages.length) {
        empty.classList.remove('hidden');
        list.classList.add('hidden');
        list.innerHTML = '';
        return;
    }

    empty.classList.add('hidden');
    list.classList.remove('hidden');
    list.innerHTML = squareRedrawVisibleItems().map(item => {
        const preview = item.output_url ? formatSquareRedrawUrl(item.output_url) : item.source_url;
        const error = item.error_message ? `<div class="text-[11px] text-red-500 mt-1">${escapeSquareRedrawHtml(item.error_message)}</div>` : '';
        return `
            <div class="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3">
                <div class="w-20 h-20 rounded-lg bg-slate-100 overflow-hidden flex-shrink-0">
                    <img src="${preview}" class="w-full h-full object-contain">
                </div>
                <div class="min-w-0 flex-1">
                    <div class="font-bold text-sm text-slate-800 truncate">${escapeSquareRedrawHtml(item.filename)}</div>
                    <div class="text-xs text-slate-400 mt-1">${item.width || '-'} x ${item.height || '-'}</div>
                    ${error}
                </div>
                <span class="text-[11px] font-black px-2 py-1 rounded-lg bg-slate-100 text-slate-600">${squareRedrawStatusLabel(item.status)}</span>
            </div>
        `;
    }).join('');
}

function escapeSquareRedrawHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[char]));
}

function formatSquareRedrawUrl(url) {
    if (!url) return '';
    if (url.startsWith('data:image') || url.startsWith('http')) return url;
    if (url.startsWith('/static')) return API_BASE + url;
    return url;
}

function updateSquareRedrawActions() {
    const startBtn = document.getElementById('squareRedrawStartBtn');
    const retryBtn = document.getElementById('squareRedrawRetryBtn');
    const downloadBtn = document.getElementById('squareRedrawDownloadBtn');
    const summary = squareRedrawSummary();
    if (startBtn) startBtn.disabled = !squareRedrawImages.length;
    if (retryBtn) retryBtn.disabled = !squareRedrawBatchId || summary.failed === 0;
    if (downloadBtn) downloadBtn.disabled = !squareRedrawBatchId || (summary.done + summary.skipped === 0);
}

async function startSquareRedrawBatch() {
    if (!squareRedrawImages.length) {
        showToast('请先上传图片', 'error');
        return;
    }

    const payload = {
        images: squareRedrawImages.map(item => ({
            filename: item.filename,
            image_data: item.image_data,
            width: item.width,
            height: item.height,
        })),
    };

    const response = await fetch(`${API_BASE}/api/square-redraw/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (data.status !== 'success') {
        showToast(data.message || '创建重绘任务失败', 'error');
        return;
    }
    applySquareRedrawBatch(data.data);
    startSquareRedrawPolling();
}

function applySquareRedrawBatch(batch) {
    squareRedrawBatchId = batch.id;
    squareRedrawImages = (batch.items || []).map(item => ({
        id: `server_${item.id}`,
        filename: item.filename,
        image_data: '',
        width: item.width,
        height: item.height,
        status: item.status,
        source_url: formatSquareRedrawUrl(item.source_url),
        output_url: formatSquareRedrawUrl(item.output_url),
        error_message: item.error_message || '',
    }));
    renderSquareRedrawList();
    updateSquareRedrawActions();
}

function startSquareRedrawPolling() {
    stopSquareRedrawPolling();
    squareRedrawPollingTimer = setInterval(refreshSquareRedrawBatch, 2000);
    refreshSquareRedrawBatch();
}

function stopSquareRedrawPolling() {
    if (squareRedrawPollingTimer) clearInterval(squareRedrawPollingTimer);
    squareRedrawPollingTimer = null;
}

async function refreshSquareRedrawBatch() {
    if (!squareRedrawBatchId) return;
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}`);
    const data = await response.json();
    if (data.status !== 'success') return;
    applySquareRedrawBatch(data.data);
    const active = squareRedrawImages.some(item => ['queued', 'running'].includes(item.status));
    if (!active) stopSquareRedrawPolling();
}

async function retrySquareRedrawFailed() {
    if (!squareRedrawBatchId) return;
    const response = await fetch(`${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/retry-failed`, { method: 'POST' });
    const data = await response.json();
    if (data.status !== 'success') {
        showToast(data.message || '重跑失败项失败', 'error');
        return;
    }
    applySquareRedrawBatch(data.data);
    startSquareRedrawPolling();
}

function downloadSquareRedrawZip() {
    if (!squareRedrawBatchId) return;
    window.location.href = `${API_BASE}/api/square-redraw/batches/${squareRedrawBatchId}/download`;
}
```

- [ ] **Step 2: Add sidebar tab, page markup, and script tag**

In `frontend/index.html`, add this sidebar button near the image translation tab:

```html
<button id="tab-square-redraw" onclick="switchMainTab('square-redraw')" class="side-tab" title="方图重绘">
    <i class="ph ph-crop"></i><span>方图重绘</span>
</button>
```

Add this page near the existing `view-translate` section:

```html
<div id="view-square-redraw" class="hidden flex-1 overflow-hidden flex flex-col bg-slate-50">
    <div class="flex-shrink-0 bg-white/80 backdrop-blur border-b border-slate-200 px-8 py-3.5 flex items-center gap-3 sticky top-0 z-30">
        <div class="flex items-center gap-2.5 mr-4">
            <div class="bg-slate-900 p-1.5 rounded-xl shadow-md">
                <i class="ph ph-crop text-white text-base"></i>
            </div>
            <div>
                <div class="text-sm font-black tracking-tight text-slate-800 leading-none">AI 1:1 方图重绘</div>
                <div id="squareRedrawSummary" class="flex gap-3 text-[10px] font-bold text-slate-400 mt-1"></div>
            </div>
        </div>
        <label for="squareRedrawUpload" class="flex items-center gap-2 cursor-pointer bg-slate-900 hover:bg-slate-700 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors shadow-md select-none">
            <i class="ph ph-upload-simple text-sm"></i> 上传图片
            <input type="file" id="squareRedrawUpload" class="hidden" accept="image/*" multiple onchange="handleSquareRedrawUpload(event)">
        </label>
        <button id="squareRedrawStartBtn" onclick="startSquareRedrawBatch()" disabled class="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-black px-5 py-2 rounded-xl transition-colors">
            <i class="ph ph-play-circle text-sm"></i> 开始重绘
        </button>
        <button id="squareRedrawRetryBtn" onclick="retrySquareRedrawFailed()" disabled class="flex items-center gap-2 bg-amber-50 hover:bg-amber-100 disabled:opacity-40 text-amber-700 text-xs font-black px-4 py-2 rounded-xl transition-colors border border-amber-100">
            <i class="ph ph-arrows-clockwise text-sm"></i> 重跑失败
        </button>
        <button id="squareRedrawDownloadBtn" onclick="downloadSquareRedrawZip()" disabled class="ml-auto flex items-center gap-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-600 text-xs font-black px-4 py-2 rounded-xl transition-colors">
            <i class="ph ph-file-zip text-sm"></i> 下载 ZIP
        </button>
    </div>
    <div class="px-8 pt-4 flex items-center gap-2 text-xs font-bold">
        <button onclick="setSquareRedrawFilter('all')" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600">全部</button>
        <button onclick="setSquareRedrawFilter('pending')" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600">待处理</button>
        <button onclick="setSquareRedrawFilter('success')" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600">成功</button>
        <button onclick="setSquareRedrawFilter('failed')" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600">失败</button>
        <button onclick="setSquareRedrawFilter('skipped')" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600">已跳过</button>
    </div>
    <div class="flex-1 overflow-y-auto custom-scrollbar px-8 py-6">
        <div id="squareRedrawEmptyState" class="border-2 border-dashed border-slate-300 rounded-2xl p-16 bg-white text-center cursor-pointer" onclick="document.getElementById('squareRedrawUpload').click()" ondragover="event.preventDefault()" ondrop="handleSquareRedrawDrop(event)">
            <i class="ph ph-images text-5xl text-slate-300"></i>
            <div class="mt-4 text-lg font-black text-slate-700">上传 1-100 张图片</div>
            <div class="mt-2 text-sm text-slate-400">已是 1:1 的图片会自动跳过并进入最终 ZIP</div>
        </div>
        <div id="squareRedrawList" class="hidden max-w-5xl mx-auto flex flex-col gap-3"></div>
    </div>
</div>
```

Add the script tag near the other module scripts:

```html
<script src="js/square_redraw.js"></script>
```

- [ ] **Step 3: Initialize the module on load**

In `frontend/js/app.js`, add this line near other init calls:

```javascript
if (typeof initSquareRedrawControls === 'function') initSquareRedrawControls();
```

- [ ] **Step 4: Run frontend syntax check**

Run:

```bash
node --check frontend/js/square_redraw.js
```

Expected: no output and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/js/app.js frontend/js/square_redraw.js
git commit -m "Add square redraw frontend module"
```

---

### Task 7: Final Verification and Cleanup

**Files:**
- Verify: backend and frontend files changed in previous tasks

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
python -m pytest backend/tests/test_square_redraw_service.py backend/tests/test_main.py::test_square_redraw_create_rejects_empty_batch backend/tests/test_main.py::test_square_redraw_create_accepts_square_image backend/tests/test_main.py::test_square_redraw_get_missing_batch_returns_error -v
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run full backend tests**

Run:

```bash
python -m pytest backend/tests
```

Expected: all backend tests PASS. If unrelated dirty worktree changes cause failures, capture the failing test names and error messages before making any changes.

- [ ] **Step 3: Run frontend syntax checks**

Run:

```bash
node --check frontend/js/square_redraw.js
node --check frontend/js/app.js
node --check frontend/js/translate.js
```

Expected: no output and exit code 0 for each command.

- [ ] **Step 4: Manual browser verification**

Run the local app:

```bash
python run.py
```

Open `http://localhost:8080/index.html`, switch to "方图重绘", and verify:

- Uploading 1 image shows one card.
- Uploading more than 100 images is blocked.
- A 1:1 image is shown as skipped.
- A non-square image starts as pending/running.
- When backend AI is mocked or live AI succeeds, the item becomes done.
- The ZIP download contains `redrawn/`, `skipped-originals/`, and `manifest.json`.

- [ ] **Step 5: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only square-redraw related files are changed beyond pre-existing unrelated dirty files.

- [ ] **Step 6: Commit verification fixes if any were needed**

If Step 1 through Step 5 required small fixes, commit only those square-redraw files:

```bash
git add backend/db.py backend/requirements.txt backend/models/request.py backend/services/square_redraw_service.py backend/tests/test_square_redraw_service.py backend/tests/test_main.py frontend/index.html frontend/js/app.js frontend/js/square_redraw.js
git commit -m "Verify square redraw batch workflow"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage: The tasks cover the standalone sidebar module, 1-100 upload limit, frontend and backend 1:1 skip behavior, detail-page AI generation path, SQLite batch/item persistence, retry failed, polling, and zip-only export with `redrawn/`, `skipped-originals/`, and `manifest.json`.
- Completeness scan: no forbidden incomplete markers or unspecified testing steps remain.
- Type consistency: Request models use `SquareRedrawBatchRequest` and `SquareRedrawImageInput`; service functions use the same names across tests, routes, and implementation steps; item statuses match the approved spec.
