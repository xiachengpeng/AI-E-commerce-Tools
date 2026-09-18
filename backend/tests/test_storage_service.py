import base64
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from db import Base, StorageConfig
from models.storage import StorageConfigWrite, ImageUploadRequest, ImageUploadResponse
from services.storage_service import (
    mask_secret,
    is_masked_or_empty,
    extract_image_bytes,
    save_storage_config,
    get_all_storage_configs,
    _sign_s3_request,
    check_wordpress_connection,
    check_shopify_connection,
    check_r2_connection,
    upload_image_to_wordpress,
    upload_image_to_r2,
    upload_image_dispatcher,
)


@pytest.fixture
def test_db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    db = Session()
    yield db
    db.close()


def test_mask_secret():
    assert mask_secret(None) is None
    assert mask_secret("") is None
    assert mask_secret("short") == "••••••••"
    assert mask_secret("12345678") == "••••••••"
    # > 8 chars shows first 3 and last 3
    masked = mask_secret("secret_token_12345")
    assert masked == "sec••••345"


def test_is_masked_or_empty():
    assert is_masked_or_empty(None) is True
    assert is_masked_or_empty("") is True
    assert is_masked_or_empty("   ") is True
    assert is_masked_or_empty("••••••••") is True
    assert is_masked_or_empty("sec••••345") is True
    assert is_masked_or_empty("my_real_password") is False


def test_extract_image_bytes():
    raw_data = b"fake-image-bytes-123"
    b64_str = base64.b64encode(raw_data).decode("ascii")

    # Pure base64
    bytes_out, mime = extract_image_bytes(b64_str, "image/jpeg")
    assert bytes_out == raw_data
    assert mime == "image/jpeg"

    # Data URL
    data_url = f"data:image/png;base64,{b64_str}"
    bytes_out2, mime2 = extract_image_bytes(data_url)
    assert bytes_out2 == raw_data
    assert mime2 == "image/png"

    # Static file reference
    with patch("services.storage_service.Path.is_file", return_value=True), \
         patch("services.storage_service.Path.read_bytes", return_value=raw_data):
        bytes_out3, mime3 = extract_image_bytes("/static/test.png")
        assert bytes_out3 == raw_data
        assert mime3 == "image/png"


def test_save_and_read_storage_config(test_db):
    # 1. Save WordPress config
    wp_payload = StorageConfigWrite(
        storage_type="wordpress",
        enabled=True,
        wp_url="https://example.com/blog",
        wp_username="editor",
        wp_app_password="abcd efgh 1234 5678",
    )
    saved_wp = save_storage_config(wp_payload, test_db)
    assert saved_wp.storage_type == "wordpress"
    assert saved_wp.wp_url == "https://example.com/blog"
    assert saved_wp.wp_username == "editor"
    assert saved_wp.has_wp_app_password is True
    assert saved_wp.wp_app_password_masked is not None

    # Verify secret is masked in read
    configs = get_all_storage_configs(test_db)
    wp_read = next(c for c in configs if c.storage_type == "wordpress")
    assert wp_read.wp_username == "editor"
    assert "••••" in wp_read.wp_app_password_masked

    # 2. Update without changing password (send masked password or None)
    wp_update = StorageConfigWrite(
        storage_type="wordpress",
        enabled=True,
        wp_url="https://example.com/new-blog",
        wp_username="editor_updated",
        wp_app_password="••••••••",
    )
    saved_wp2 = save_storage_config(wp_update, test_db)
    assert saved_wp2.wp_url == "https://example.com/new-blog"
    assert saved_wp2.wp_username == "editor_updated"

    # In DB, original password must be preserved
    row = test_db.query(StorageConfig).filter(StorageConfig.storage_type == "wordpress").first()
    assert row.wp_app_password == "abcdefgh12345678"

    # 3. Save R2 config
    r2_payload = StorageConfigWrite(
        storage_type="r2",
        enabled=True,
        r2_account_id="acc123",
        r2_access_key_id="key456",
        r2_secret_access_key="my_super_secret_r2_key",
        r2_bucket_name="shop-images",
        r2_public_url="https://cdn.example.com",
        r2_path_prefix="pdp-v2",
    )
    saved_r2 = save_storage_config(r2_payload, test_db)
    assert saved_r2.storage_type == "r2"
    assert saved_r2.r2_bucket_name == "shop-images"
    assert saved_r2.r2_path_prefix == "pdp-v2/"
    assert saved_r2.has_r2_secret is True
    assert saved_r2.r2_secret_masked is not None


def test_sign_s3_request():
    headers = {"Content-Type": "image/jpeg"}
    payload = b"test payload"
    signed = _sign_s3_request(
        method="PUT",
        url="https://acc123.r2.cloudflarestorage.com/my-bucket/image.jpg",
        headers=headers,
        payload=payload,
        access_key="AKIAIOSFODNN7EXAMPLE",
        secret_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region="auto",
        service="s3",
    )

    assert "host" in signed
    assert signed["host"] == "acc123.r2.cloudflarestorage.com"
    assert "x-amz-date" in signed
    assert "x-amz-content-sha256" in signed
    assert "authorization" in signed
    assert signed["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/")
    assert "SignedHeaders=" in signed["authorization"]
    assert "Signature=" in signed["authorization"]


@pytest.mark.asyncio
async def test_wordpress_connection_mock():
    # Success case
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"name": "TestAdmin", "id": 1}
        mock_get.return_value = mock_resp

        ok, msg, details = await check_wordpress_connection(
            wp_url="https://mywp.com",
            wp_username="admin",
            wp_app_password="pass word 1234",
        )
        assert ok is True
        assert "TestAdmin" in msg
        assert details["user"] == "TestAdmin"

    # 401 unauthorized
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_get.return_value = mock_resp

        ok, msg, _ = await check_wordpress_connection(
            wp_url="https://mywp.com",
            wp_username="admin",
            wp_app_password="wrong",
        )
        assert ok is False
        assert "401" in msg


@pytest.mark.asyncio
async def test_r2_connection_mock():
    # Success case
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        ok, msg, details = await check_r2_connection(
            account_id="acc123",
            access_key_id="key123",
            secret_access_key="sec123",
            bucket_name="my-bucket",
            public_url="https://cdn.mywp.com",
        )
        assert ok is True
        assert "my-bucket" in msg
        assert "cdn.mywp.com" in msg

    # 403 forbidden
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_get.return_value = mock_resp

        ok, msg, _ = await check_r2_connection(
            account_id="acc123",
            access_key_id="key123",
            secret_access_key="sec123",
            bucket_name="my-bucket",
        )
        assert ok is False
        assert "403" in msg


@pytest.mark.asyncio
async def test_upload_image_to_wordpress_success():
    config = StorageConfig(
        storage_type="wordpress",
        enabled=1,
        wp_url="https://my-store.com",
        wp_username="admin",
        wp_app_password="app_pass_test",
    )

    with patch("httpx.AsyncClient.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            "id": 888,
            "source_url": "https://my-store.com/wp-content/uploads/2026/09/hero.jpg",
        }
        mock_post.return_value = mock_resp

        res = await upload_image_to_wordpress(
            config=config,
            image_bytes=b"sample-image",
            filename="hero.jpg",
            mime_type="image/jpeg",
            title="Product Hero",
            alt_text="Main Product Image",
        )
        assert res.success is True
        assert res.remote_url == "https://my-store.com/wp-content/uploads/2026/09/hero.jpg"
        assert res.media_id == "888"
        assert res.storage_type == "wordpress"


@pytest.mark.asyncio
async def test_upload_image_to_r2_success():
    config = StorageConfig(
        storage_type="r2",
        enabled=1,
        r2_account_id="cf_acc_123",
        r2_access_key_id="cf_key_456",
        r2_secret_access_key="cf_sec_789",
        r2_bucket_name="product-pdp",
        r2_public_url="https://cdn.my-store.com",
        r2_path_prefix="pdp/",
    )

    with patch("httpx.AsyncClient.put") as mock_put:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_put.return_value = mock_resp

        res = await upload_image_to_r2(
            config=config,
            image_bytes=b"sample-image-data",
            filename="feature-1.jpg",
            mime_type="image/jpeg",
        )
        assert res.success is True
        assert res.remote_url == "https://cdn.my-store.com/pdp/feature-1.jpg"
        assert res.storage_type == "r2"
        assert res.filename == "feature-1.jpg"


def test_multi_wordpress_sites_management(test_db):
    from services.storage_service import delete_storage_config, set_default_storage_config, get_storage_config_model

    # 1. Add Site A
    site_a = save_storage_config(
        StorageConfigWrite(
            storage_type="wordpress",
            name="站点 A (US Shop)",
            wp_url="https://site-a.com",
            wp_username="admin_a",
            wp_app_password="pass-a-1234",
            is_default=True,
        ),
        test_db,
    )
    assert site_a.id > 0
    assert site_a.is_default is True
    assert site_a.name == "站点 A (US Shop)"

    # 2. Add Site B
    site_b = save_storage_config(
        StorageConfigWrite(
            storage_type="wordpress",
            name="站点 B (UK Shop)",
            wp_url="https://site-b.co.uk",
            wp_username="admin_b",
            wp_app_password="pass-b-5678",
            is_default=False,
        ),
        test_db,
    )
    assert site_b.id > 0
    assert site_b.id != site_a.id
    assert site_b.is_default is False

    # 3. List all configs should have both sites
    configs = get_all_storage_configs(test_db)
    wp_configs = [c for c in configs if c.storage_type == "wordpress"]
    assert len(wp_configs) == 2

    # 4. Set Site B as default
    updated_b = set_default_storage_config(site_b.id, test_db)
    assert updated_b.is_default is True
    model_a = get_storage_config_model("wordpress", test_db, config_id=site_a.id)
    assert model_a.is_default == 0

    # 5. Delete Site A
    del_ok = delete_storage_config(site_a.id, test_db)
    assert del_ok is True
    wp_remaining = [c for c in get_all_storage_configs(test_db) if c.storage_type == "wordpress"]
    assert len(wp_remaining) == 1
    assert wp_remaining[0].id == site_b.id


@pytest.mark.asyncio
async def test_shopify_connection_and_upload_service(test_db):
    from services.storage_service import check_shopify_connection, upload_image_to_shopify

    # Test Shopify connection check
    with patch("httpx.AsyncClient.post") as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": {
                "shop": {
                    "name": "My Shopify Store",
                    "email": "owner@myshop.com",
                    "myshopifyDomain": "my-store.myshopify.com",
                    "plan": {"displayName": "Shopify Plus"},
                }
            }
        }
        mock_post.return_value = mock_resp

        ok, msg, details = await check_shopify_connection("https://my-store.myshopify.com", "shpat_123456789")
        assert ok is True
        assert "My Shopify Store" in msg
        assert details["domain"] == "my-store.myshopify.com"

    # Test Shopify upload
    shop_cfg = StorageConfig(
        id=99,
        storage_type="shopify",
        name="Shopify Test",
        shopify_shop_domain="my-store.myshopify.com",
        shopify_access_token="shpat_123456789",
        enabled=1,
    )

    with patch("httpx.AsyncClient.post") as mock_post:
        # Mock 1: stagedUploadsCreate
        mock_staged_resp = MagicMock()
        mock_staged_resp.status_code = 200
        mock_staged_resp.json.return_value = {
            "data": {
                "stagedUploadsCreate": {
                    "stagedTargets": [
                        {
                            "url": "https://shopify-staged-uploads.storage.googleapis.com",
                            "resourceUrl": "https://shopify-staged-uploads.storage.googleapis.com/tmp/pdp.png",
                            "parameters": [{"name": "key", "value": "tmp/pdp.png"}],
                        }
                    ],
                    "userErrors": [],
                }
            }
        }

        # Mock 2: upload binary to GCS target
        mock_gcs_resp = MagicMock()
        mock_gcs_resp.status_code = 201

        # Mock 3: fileCreate mutation
        mock_fc_resp = MagicMock()
        mock_fc_resp.status_code = 200
        mock_fc_resp.json.return_value = {
            "data": {
                "fileCreate": {
                    "files": [
                        {
                            "id": "gid://shopify/MediaImage/12345",
                            "fileStatus": "READY",
                            "alt": "Alt text",
                            "image": {
                                "url": "https://cdn.shopify.com/s/files/1/0001/files/pdp-asset.png?v=123"
                            },
                        }
                    ],
                    "userErrors": [],
                }
            }
        }

        mock_post.side_effect = [mock_staged_resp, mock_gcs_resp, mock_fc_resp]

        res = await upload_image_to_shopify(
            config=shop_cfg,
            image_bytes=b"png-data-bytes",
            filename="my-pdp-hero.png",
            mime_type="image/png",
            alt_text="Banner Image",
        )

        assert res.success is True
        assert res.storage_type == "shopify"
        assert res.remote_url == "https://cdn.shopify.com/s/files/1/0001/files/pdp-asset.png?v=123"
        assert res.media_id == "gid://shopify/MediaImage/12345"


@pytest.mark.asyncio
async def test_upload_image_dispatcher_with_webp_conversion(test_db):
    import io
    from PIL import Image
    from services.storage_service import upload_image_dispatcher

    im = Image.new("RGB", (50, 50), (255, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    png_bytes = buf.getvalue()
    b64_png = base64.b64encode(png_bytes).decode("ascii")

    cfg = StorageConfig(
        storage_type="wordpress",
        name="WP Test",
        enabled=1,
        is_default=1,
        wp_url="https://test.com",
        wp_username="admin",
        wp_app_password="pwd",
    )
    test_db.add(cfg)
    test_db.commit()

    with patch("services.storage_service.upload_image_to_wordpress") as mock_wp:
        mock_wp.return_value = ImageUploadResponse(
            success=True,
            storage_type="wordpress",
            remote_url="https://test.com/wp-content/uploads/hero.webp",
            filename="hero.webp",
        )

        req = ImageUploadRequest(
            storage_type="wordpress",
            image_data=f"data:image/png;base64,{b64_png}",
            filename="hero.png",
            mime_type="image/png",
            convert_to_webp=True,
            quality=85,
        )

        resp = await upload_image_dispatcher(req, test_db)
        assert resp.success is True
        mock_wp.assert_called_once()
        call_kwargs = mock_wp.call_args.kwargs
        assert call_kwargs["filename"] == "hero.webp"
        assert call_kwargs["mime_type"] == "image/webp"
        with Image.open(io.BytesIO(call_kwargs["image_bytes"])) as out_im:
            assert out_im.format == "WEBP"


@pytest.mark.asyncio
async def test_ssrf_protection_in_storage():
    # 1. Cloud metadata 169.254.169.254 blocked
    success, msg, _ = await check_wordpress_connection("http://169.254.169.254/latest", "admin", "pass")
    assert success is False
    assert "不合规" in msg

    # 2. Loopback 127.0.0.1 blocked by default
    success, msg, _ = await check_wordpress_connection("http://127.0.0.1:8080", "admin", "pass")
    assert success is False
    assert "不合规" in msg

    # 3. Shopify shop domain SSRF blocked
    success, msg, _ = await check_shopify_connection("169.254.169.254", "shpat_123")
    assert success is False
    assert "不合规" in msg
