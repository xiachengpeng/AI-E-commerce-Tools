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
