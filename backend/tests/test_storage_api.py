import base64
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from main import app
from db import get_db, Base, StorageConfig
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Create isolated test database for API tests
engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
Base.metadata.create_all(bind=engine)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_storage_api_db():
    Base.metadata.create_all(bind=engine)
    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.pop(get_db, None)


client = TestClient(app)


def test_get_and_save_storage_configs():
    # 1. GET initial configs
    resp = client.get("/api/storage/configs")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    types = [item["storage_type"] for item in data]
    assert "wordpress" in types
    assert "r2" in types

    # 2. POST save WordPress config
    wp_payload = {
        "storage_type": "wordpress",
        "enabled": True,
        "wp_url": "https://test-wp-site.com",
        "wp_username": "site_admin",
        "wp_app_password": "super_secret_wp_app_pass",
    }
    resp = client.post("/api/storage/config", json=wp_payload)
    assert resp.status_code == 200
    saved = resp.json()
    assert saved["storage_type"] == "wordpress"
    assert saved["wp_url"] == "https://test-wp-site.com"
    assert saved["has_wp_app_password"] is True
    assert saved["wp_app_password_masked"] is not None
    assert "super_secret" not in saved["wp_app_password_masked"]

    # 3. POST save R2 config
    r2_payload = {
        "storage_type": "r2",
        "enabled": True,
        "r2_account_id": "r2_account_999",
        "r2_access_key_id": "r2_access_888",
        "r2_secret_access_key": "r2_secret_77777777777",
        "r2_bucket_name": "pdp-assets",
        "r2_public_url": "https://assets.test-site.com",
        "r2_path_prefix": "pdp-2026",
    }
    resp = client.post("/api/storage/config", json=r2_payload)
    assert resp.status_code == 200
    saved_r2 = resp.json()
    assert saved_r2["storage_type"] == "r2"
    assert saved_r2["r2_bucket_name"] == "pdp-assets"
    assert saved_r2["has_r2_secret"] is True
    assert saved_r2["r2_secret_masked"] is not None


def test_storage_test_endpoint():
    with patch("services.storage_service.check_wordpress_connection") as mock_test_wp:
        mock_test_wp.return_value = (True, "连接成功", {"user": "admin"})

        # 1. Nested config_override
        resp = client.post("/api/storage/test", json={"storage_type": "wordpress"})
        assert resp.status_code == 200
        res_data = resp.json()
        assert res_data["success"] is True
        assert res_data["message"] == "连接成功"

        # 2. Direct flat fields from form
        resp_flat = client.post(
            "/api/storage/test",
            json={
                "storage_type": "wordpress",
                "wp_url": "https://direct-wp.com",
                "wp_username": "editor_direct",
                "wp_app_password": "pass1234password",
            },
        )
        assert resp_flat.status_code == 200
        data_flat = resp_flat.json()
        assert data_flat["success"] is True


def test_upload_image_endpoint_mock():
    # Construct small test base64 image
    img_b64 = "data:image/jpeg;base64," + base64.b64encode(b"fake-jpeg-data").decode("ascii")

    with patch("services.storage_service.upload_image_to_wordpress") as mock_upload:
        from models.storage import ImageUploadResponse
        mock_upload.return_value = ImageUploadResponse(
            success=True,
            remote_url="https://test-wp-site.com/wp-content/uploads/hero.jpg",
            storage_type="wordpress",
            media_id="101",
            filename="hero.jpg",
        )

        upload_payload = {
            "storage_type": "wordpress",
            "image_data": img_b64,
            "filename": "hero.jpg",
            "mime_type": "image/jpeg",
            "title": "Hero Image",
            "alt_text": "Ergonomic chair hero",
        }
        resp = client.post("/api/storage/upload-image", json=upload_payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["remote_url"] == "https://test-wp-site.com/wp-content/uploads/hero.jpg"
        assert data["media_id"] == "101"


def test_shopify_api_endpoints():
    # 1. Save Shopify config
    shop_payload = {
        "storage_type": "shopify",
        "enabled": True,
        "name": "Shopify UK",
        "shopify_shop_domain": "https://my-uk-shop.myshopify.com",
        "shopify_access_token": "shpat_9876543210abcdef",
    }
    resp = client.post("/api/storage/config", json=shop_payload)
    assert resp.status_code == 200
    saved = resp.json()
    assert saved["storage_type"] == "shopify"
    assert saved["name"] == "Shopify UK"
    assert saved["shopify_shop_domain"] == "my-uk-shop.myshopify.com"
    assert saved["has_shopify_token"] is True
    assert saved["shopify_token_masked"] is not None
    assert "9876543210" not in saved["shopify_token_masked"]

    # 2. Test Shopify connection endpoint
    with patch("services.storage_service.check_shopify_connection") as mock_chk:
        mock_chk.return_value = (True, "Shopify 连接成功", {"shop": "Shopify UK"})
        test_resp = client.post(
            "/api/storage/test",
            json={
                "storage_type": "shopify",
                "shopify_shop_domain": "my-uk-shop.myshopify.com",
                "shopify_access_token": "shpat_9876543210abcdef",
            },
        )
        assert test_resp.status_code == 200
        assert test_resp.json()["success"] is True


def test_multi_site_delete_and_default_api():
    # Create Site 1
    resp1 = client.post(
        "/api/storage/config",
        json={
            "storage_type": "wordpress",
            "name": "站点 1",
            "wp_url": "https://s1.com",
            "wp_username": "u1",
            "wp_app_password": "p1",
            "is_default": True,
        },
    )
    s1_id = resp1.json()["id"]

    # Create Site 2
    resp2 = client.post(
        "/api/storage/config",
        json={
            "storage_type": "wordpress",
            "name": "站点 2",
            "wp_url": "https://s2.com",
            "wp_username": "u2",
            "wp_app_password": "p2",
            "is_default": False,
        },
    )
    s2_id = resp2.json()["id"]

    # Set Site 2 as default
    def_resp = client.post(f"/api/storage/config/{s2_id}/default")
    assert def_resp.status_code == 200
    assert def_resp.json()["is_default"] is True

    # Delete Site 1
    del_resp = client.delete(f"/api/storage/config/{s1_id}")
    assert del_resp.status_code == 200
    assert del_resp.json()["success"] is True

    # Verify Site 1 deleted
    list_resp = client.get("/api/storage/configs")
    wp_list = [x for x in list_resp.json() if x["storage_type"] == "wordpress"]
    ids = [x["id"] for x in wp_list]
    assert s1_id not in ids
    assert s2_id in ids
