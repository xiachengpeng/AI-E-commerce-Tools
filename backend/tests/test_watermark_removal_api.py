from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from db import Base, get_db
from main import app


def valid_payload():
    return {
        "filename": "shoe.png",
        "image_data": "data:image/png;base64,YQ==",
        "mask_data": "data:image/png;base64,YQ==",
        "regions": [{"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}],
    }


def valid_history_result():
    return {
        "processing_id": "abc",
        "result_url": "/static/outputs/watermark-removal/abc/shoe-result.png",
    }


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine)

    def override_get_db():
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_watermark_removal_endpoint_returns_service_result(client):
    expected = {"processing_id": "abc", "result_url": "/static/result.png"}

    with patch("main.remove_watermark", new=AsyncMock(return_value=expected)):
        response = client.post("/api/watermark-removal", json=valid_payload())

    assert response.status_code == 200
    assert response.json() == {"status": "success", "data": expected}


def test_watermark_removal_endpoint_returns_error_envelope(client):
    with patch("main.remove_watermark", new=AsyncMock(side_effect=ValueError("图片无效"))):
        response = client.post("/api/watermark-removal", json=valid_payload())

    assert response.status_code == 200
    assert response.json() == {"status": "error", "message": "图片无效"}


def test_watermark_removal_history_round_trip(client):
    result = valid_history_result()

    saved = client.post(
        "/api/history/watermark-removal",
        json={"filename": "shoe.png", "result": result},
    )
    assert saved.status_code == 200
    assert saved.json()["status"] == "success"

    items = client.get("/api/history/watermark-removal").json()
    assert items[0]["filename"] == "shoe.png"
    assert items[0]["result"]["result_url"] == result["result_url"]

    deleted = client.delete(f"/api/history/watermark-removal/{items[0]['id']}")
    assert deleted.json()["status"] == "success"
