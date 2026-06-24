import datetime
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
