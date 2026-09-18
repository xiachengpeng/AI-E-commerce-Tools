"""Tests for brand profiles persistence endpoints in main.py."""

import pytest
from fastapi.testclient import TestClient

from main import app
from db import get_db


def test_brand_profiles_crud():
    client = TestClient(app)

    # 1. Initial GET returns empty list if no setting
    res = client.get("/api/brand-profiles")
    assert res.status_code == 200
    json_data = res.json()
    assert json_data["status"] == "success"
    assert isinstance(json_data["data"], list)

    # 2. Save brand profiles
    sample_profiles = [
        {
            "id": "brand_test_1",
            "name": "人体工学椅",
            "brandName": "ErgoTest",
            "brandColor": "#2563EB",
            "brandFont": "Inter",
        }
    ]
    res = client.post("/api/brand-profiles", json={"profiles": sample_profiles})
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    assert len(res.json()["data"]) == 1

    # 3. GET returns saved profiles
    res = client.get("/api/brand-profiles")
    assert res.status_code == 200
    data = res.json()["data"]
    assert len(data) == 1
    assert data[0]["id"] == "brand_test_1"
    assert data[0]["brandColor"] == "#2563EB"

    # 4. POST with invalid payload fails
    res = client.post("/api/brand-profiles", json={"profiles": "not_a_list"})
    assert res.status_code == 400
