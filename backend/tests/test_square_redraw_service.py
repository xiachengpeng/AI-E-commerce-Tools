import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from db import Base, SquareRedrawBatch, SquareRedrawItem


def test_square_redraw_models_are_registered():
    assert "square_redraw_batches" in Base.metadata.tables
    assert "square_redraw_items" in Base.metadata.tables
    assert not Base.metadata.tables["square_redraw_items"].c.batch_id.nullable


def test_square_redraw_model_defaults_are_persisted(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'square_redraw.db'}")
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = Session()
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
