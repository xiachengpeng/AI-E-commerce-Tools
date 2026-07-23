import datetime
import asyncio
import base64
import io
import json
import zipfile

import pytest
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from db import Base, SquareRedrawBatch, SquareRedrawItem, enable_sqlite_foreign_keys
from models.request import SquareRedrawBatchRequest
from services.square_redraw_service import (
    build_square_redraw_zip,
    MAX_SQUARE_REDRAW_BATCH_SIZE,
    create_square_redraw_batch,
    decode_image_data_url,
    delete_square_redraw_item,
    image_matches_aspect_ratio,
    image_size_from_bytes,
    mime_extension,
    process_square_redraw_batch,
    retry_failed_square_redraw_items,
    safe_output_basename,
    save_bytes_for_item,
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
    assert request.target_aspect_ratio == "1:1"


def test_square_redraw_request_accepts_supported_target_aspect_ratio():
    request = SquareRedrawBatchRequest(
        target_aspect_ratio="1200:1600",
        images=[{
            "filename": "dress.jpg",
            "image_data": make_data_url(),
            "width": 10,
            "height": 20,
        }],
    )
    assert request.target_aspect_ratio == "3:4"


def test_square_redraw_request_rejects_unsupported_target_aspect_ratio():
    with pytest.raises(ValueError, match="暂不支持该目标比例"):
        SquareRedrawBatchRequest(
            target_aspect_ratio="6:5",
            images=[{
                "filename": "dress.jpg",
                "image_data": make_data_url(),
                "width": 10,
                "height": 20,
            }],
        )


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


def test_image_matches_aspect_ratio():
    assert image_matches_aspect_ratio(1200, 1600, "3:4")
    assert image_matches_aspect_ratio(40, 40, "1:1")
    assert not image_matches_aspect_ratio(1200, 1500, "3:4")


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


def test_create_batch_marks_target_ratio_images_skipped():
    from db import SessionLocal

    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(
        target_aspect_ratio="3:4",
        images=[{
            "filename": "portrait.png",
            "image_data": make_data_url(30, 40),
            "width": 30,
            "height": 40,
        }],
    )
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        data = serialize_square_redraw_batch(db, batch.id)
        assert data["target_aspect_ratio"] == "3:4"
        assert data["summary"]["skipped"] == 1
        assert data["items"][0]["status"] == "skipped_square"
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
        batch_id = batch.id
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
        asyncio.run(process_square_redraw_batch(batch_id))

    payload = mock_ai.await_args.kwargs["payload"]
    assert payload["generationConfig"]["responseModalities"] == ["IMAGE"]
    assert payload["generationConfig"]["imageConfig"]["aspectRatio"] == "1:1"
    assert mock_ai.await_args.kwargs["capability"] == "image"

    db = SessionLocal()
    try:
        item = db.query(SquareRedrawItem).filter(SquareRedrawItem.batch_id == batch_id).one()
        assert item.status == "done"
        assert item.output_url.startswith("/static/outputs/square-redraw/")
    finally:
        db.close()


def test_process_uses_custom_target_aspect_ratio():
    from db import SessionLocal

    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(
        target_aspect_ratio="4:5",
        images=[{
            "filename": "portrait.png",
            "image_data": make_data_url(40, 80),
            "width": 40,
            "height": 80,
        }],
    )
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        batch_id = batch.id
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
        asyncio.run(process_square_redraw_batch(batch_id))

    payload = mock_ai.await_args.kwargs["payload"]
    assert payload["generationConfig"]["imageConfig"]["aspectRatio"] == "4:5"
    assert "4:5" in payload["contents"][0]["parts"][0]["text"]


def test_process_batch_runs_items_concurrently(monkeypatch):
    from db import SessionLocal

    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[
        {"filename": "portrait-1.png", "image_data": make_data_url(40, 80), "width": 40, "height": 80},
        {"filename": "portrait-2.png", "image_data": make_data_url(40, 80), "width": 40, "height": 80},
    ])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        batch_id = batch.id
    finally:
        db.close()

    active = 0
    max_active = 0

    async def fake_generate_content(**kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.02)
        active -= 1
        return {
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

    monkeypatch.setattr("services.square_redraw_service.FRONTEND_CONCURRENCY_LIMIT", 2)
    monkeypatch.setattr("services.square_redraw_service.AIService.generate_content", fake_generate_content)

    asyncio.run(process_square_redraw_batch(batch_id))

    assert max_active == 2


def test_retry_failed_only_resets_failed_items():
    from db import SessionLocal

    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[
        {"filename": "bad.png", "image_data": "bad", "width": 10, "height": 20},
        {"filename": "square.png", "image_data": make_data_url(20, 20), "width": 20, "height": 20},
    ])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        reset_count = retry_failed_square_redraw_items(db, batch.id)
        items = (
            db.query(SquareRedrawItem)
            .filter(SquareRedrawItem.batch_id == batch.id)
            .order_by(SquareRedrawItem.id.asc())
            .all()
        )
        assert reset_count == 1
        assert items[0].status == "queued"
        assert items[0].retry_count == 1
        assert items[1].status == "skipped_square"
    finally:
        db.close()


def test_delete_square_redraw_item_removes_non_running_item():
    from db import SessionLocal

    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[{
        "filename": "portrait.png",
        "image_data": make_data_url(10, 20),
        "width": 10,
        "height": 20,
    }])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        item = db.query(SquareRedrawItem).filter(SquareRedrawItem.batch_id == batch.id).one()
        delete_square_redraw_item(db, batch.id, item.id)
        data = serialize_square_redraw_batch(db, batch.id)
        assert data["summary"]["total"] == 0
        assert data["items"] == []
    finally:
        db.close()


def test_build_square_redraw_zip_contains_flat_images_and_manifest(tmp_path):
    from db import SessionLocal

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
        redrawn_url = save_bytes_for_item(batch.id, "portrait-square.png", b"redrawn", "image/png", "redrawn")
        done = SquareRedrawItem(
            batch_id=batch.id,
            source_filename="portrait.png",
            source_mime_type="image/png",
            source_width=10,
            source_height=20,
            status="done",
            output_url=redrawn_url,
        )
        db.add(done)
        db.commit()

        zip_path = build_square_redraw_zip(db, batch.id)

        assert zip_path.endswith(".zip")
        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            assert "manifest.json" in names
            image_names = [name for name in names if name != "manifest.json"]
            assert image_names
            assert all("/" not in name for name in image_names)
            assert "portrait.png" in image_names
            assert "square.png" in image_names
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            assert len(manifest["items"]) == 2
    finally:
        db.close()


def test_build_square_redraw_zip_deduplicates_flat_filenames(tmp_path):
    from db import SessionLocal

    clear_square_redraw_tables()
    request = SquareRedrawBatchRequest(images=[
        {"filename": "same.png", "image_data": make_data_url(20, 20), "width": 20, "height": 20},
        {"filename": "same.png", "image_data": make_data_url(30, 30), "width": 30, "height": 30},
    ])
    db = SessionLocal()
    try:
        batch = create_square_redraw_batch(db, request)
        zip_path = build_square_redraw_zip(db, batch.id)

        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            assert "same.png" in names
            assert "same-2.png" in names
    finally:
        db.close()
