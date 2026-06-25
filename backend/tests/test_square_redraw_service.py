import datetime
import asyncio
import base64
import io

import pytest
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from db import Base, SquareRedrawBatch, SquareRedrawItem, enable_sqlite_foreign_keys
from models.request import SquareRedrawBatchRequest
from services.square_redraw_service import (
    MAX_SQUARE_REDRAW_BATCH_SIZE,
    create_square_redraw_batch,
    decode_image_data_url,
    image_size_from_bytes,
    mime_extension,
    process_square_redraw_batch,
    safe_output_basename,
    serialize_square_redraw_batch,
)
from unittest.mock import AsyncMock, patch


def make_data_url(width=10, height=20, fmt="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format=fmt)
    mime = "image/png" if fmt == "PNG" else "image/jpeg"
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:{mime};base64,{encoded}"


def make_test_session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'square_redraw.db'}")
    enable_sqlite_foreign_keys(engine)
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    return Session()


def test_square_redraw_models_are_registered():
    assert "square_redraw_batches" in Base.metadata.tables
    assert "square_redraw_items" in Base.metadata.tables
    assert not Base.metadata.tables["square_redraw_items"].c.batch_id.nullable


def test_square_redraw_model_defaults_are_persisted(tmp_path):
    session = make_test_session(tmp_path)
    try:
        batch = SquareRedrawBatch(output_dir="/tmp/out")
        session.add(batch)
        session.flush()
        session.refresh(batch)

        item = SquareRedrawItem(
            batch_id=batch.id,
            source_filename="dress.jpg",
            source_mime_type="image/jpeg",
        )
        session.add(item)
        session.flush()
        session.refresh(item)

        assert batch.id is not None
        assert item.id is not None
        assert batch.status == "queued"
        assert item.status == "queued"
        assert item.retry_count == 0
        assert isinstance(batch.created_at, datetime.datetime)
        assert item.batch_id == batch.id
    finally:
        session.close()


def test_square_redraw_item_requires_existing_batch(tmp_path):
    session = make_test_session(tmp_path)
    try:
        item = SquareRedrawItem(
            batch_id=999,
            source_filename="dress.jpg",
            source_mime_type="image/jpeg",
        )
        session.add(item)

        with pytest.raises(IntegrityError):
            session.flush()
    finally:
        session.close()


def test_square_redraw_request_accepts_one_image():
    request = SquareRedrawBatchRequest(images=[{
        "filename": "dress.jpg",
        "image_data": make_data_url(),
        "width": 10,
        "height": 20,
    }])
    assert len(request.images) == 1


def test_square_redraw_request_strips_required_text():
    image_data = f"  {make_data_url()}  "
    request = SquareRedrawBatchRequest(images=[{
        "filename": "  dress.jpg  ",
        "image_data": image_data,
    }])
    assert request.images[0].filename == "dress.jpg"
    assert request.images[0].image_data == image_data.strip()


def test_square_redraw_request_rejects_empty_images():
    with pytest.raises(ValueError, match="至少上传 1 张"):
        SquareRedrawBatchRequest(images=[])


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


def test_decode_image_data_url_rejects_disguised_non_image_bytes():
    encoded = base64.b64encode(b"hello").decode("utf-8")
    with pytest.raises(ValueError, match="图片数据无效"):
        decode_image_data_url(f"data:image/png;base64,{encoded}")


def test_decode_image_data_url_rejects_unsupported_mime_type():
    encoded = base64.b64encode(b"<svg></svg>").decode("utf-8")
    with pytest.raises(ValueError, match="不支持的图片格式"):
        decode_image_data_url(f"data:image/svg+xml;base64,{encoded}")


def test_square_redraw_request_rejects_empty_required_text():
    with pytest.raises(ValueError, match="文件名不能为空"):
        SquareRedrawBatchRequest(images=[{
            "filename": "  ",
            "image_data": make_data_url(),
        }])
    with pytest.raises(ValueError, match="图片数据不能为空"):
        SquareRedrawBatchRequest(images=[{
            "filename": "dress.jpg",
            "image_data": "  ",
        }])


def test_square_redraw_request_rejects_non_positive_dimensions():
    with pytest.raises(ValueError, match="宽度必须大于 0"):
        SquareRedrawBatchRequest(images=[{
            "filename": "dress.jpg",
            "image_data": make_data_url(),
            "width": 0,
        }])
    with pytest.raises(ValueError, match="高度必须大于 0"):
        SquareRedrawBatchRequest(images=[{
            "filename": "dress.jpg",
            "image_data": make_data_url(),
            "height": -1,
        }])


def test_mime_extension_returns_supported_extensions():
    assert mime_extension("image/jpeg") == "jpg"
    assert mime_extension("image/png") == "png"
    assert mime_extension("image/webp") == "webp"


def test_safe_output_basename_removes_path_and_extension():
    assert safe_output_basename("../dress photo.JPG") == "dress-photo"
    assert safe_output_basename("图 1.png") == "image"


def clear_square_redraw_tables():
    from db import SessionLocal

    db = SessionLocal()
    try:
        Base.metadata.create_all(bind=db.get_bind())
        db.query(SquareRedrawItem).delete()
        db.query(SquareRedrawBatch).delete()
        db.commit()
    finally:
        db.close()


def test_create_batch_marks_square_images_skipped():
    from db import SessionLocal

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


def test_process_non_square_uses_square_image_config():
    from db import SessionLocal

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
        asyncio.run(process_square_redraw_batch(batch.id))

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
