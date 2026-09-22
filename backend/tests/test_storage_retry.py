import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import httpx
import pytest

from db import StorageConfig
from models.storage import ImageUploadResponse
from services.storage_service import (
    upload_image_to_wordpress,
    upload_image_to_shopify,
    upload_image_to_r2,
)


@pytest.fixture
def wp_config():
    return StorageConfig(
        id=1,
        storage_type="wordpress",
        name="WP Test",
        wp_url="https://example.com",
        wp_username="editor",
        wp_app_password="app_password_123",
        enabled=1,
    )


@pytest.fixture
def shopify_config():
    return StorageConfig(
        id=2,
        storage_type="shopify",
        name="Shopify Test",
        shopify_shop_domain="mystore.myshopify.com",
        shopify_access_token="shpat_test_token_12345",
        enabled=1,
    )


@pytest.fixture
def r2_config():
    return StorageConfig(
        id=3,
        storage_type="r2",
        name="R2 Test",
        r2_account_id="acc123",
        r2_access_key_id="key123",
        r2_secret_access_key="secret123",
        r2_bucket_name="my-bucket",
        r2_public_url="https://cdn.example.com",
        r2_path_prefix="pdp/",
        enabled=1,
    )


@pytest.mark.asyncio
async def test_wordpress_upload_read_timeout_blocks_retry_and_reports_ambiguous(wp_config):
    """
    WordPress media upload is NON-IDEMPOTENT.
    If ReadTimeout occurs, the request may have reached upstream and saved the media.
    Retrying would create duplicate files (e.g. image-1.jpg).
    Must NOT retry and must return an informative ambiguous outcome message.
    """
    with patch("httpx.AsyncClient.post") as mock_post:
        mock_post.side_effect = httpx.ReadTimeout("The read operation timed out")

        res: ImageUploadResponse = await upload_image_to_wordpress(
            config=wp_config,
            image_bytes=b"fake-image-bytes",
            filename="hero.jpg",
            mime_type="image/jpeg",
        )

        assert res.success is False
        assert res.storage_type == "wordpress"
        # Must be called EXACTLY ONCE: no automatic retry on read timeout
        assert mock_post.call_count == 1
        # Error must warn about ambiguous outcome / avoiding duplicates
        assert "超时" in res.error or "副本" in res.error or "已发送" in res.error


@pytest.mark.asyncio
async def test_wordpress_upload_connect_error_retries_and_succeeds(wp_config):
    """
    ConnectTimeout / ConnectError means the request did NOT reach upstream.
    Safe to retry within budget.
    """
    success_resp = MagicMock()
    success_resp.status_code = 201
    success_resp.json.return_value = {
        "id": 101,
        "source_url": "https://example.com/wp-content/uploads/hero.jpg",
    }

    sleeps = []

    async def fake_sleep(seconds: float):
        sleeps.append(seconds)

    with patch("httpx.AsyncClient.post") as mock_post, \
         patch("asyncio.sleep", side_effect=fake_sleep):
        mock_post.side_effect = [
            httpx.ConnectError("Connection refused"),
            success_resp,
        ]

        res: ImageUploadResponse = await upload_image_to_wordpress(
            config=wp_config,
            image_bytes=b"fake-image-bytes",
            filename="hero.jpg",
            mime_type="image/jpeg",
        )

        assert res.success is True
        assert res.media_id == "101"
        assert res.remote_url == "https://example.com/wp-content/uploads/hero.jpg"
        assert mock_post.call_count == 2
        assert len(sleeps) == 1


@pytest.mark.asyncio
async def test_wordpress_upload_auth_error_fails_immediately(wp_config):
    """HTTP 401 / 403 must fail immediately without retrying."""
    fail_resp = MagicMock()
    fail_resp.status_code = 401
    fail_resp.text = "Unauthorized"

    with patch("httpx.AsyncClient.post") as mock_post:
        mock_post.return_value = fail_resp

        res = await upload_image_to_wordpress(
            config=wp_config,
            image_bytes=b"fake-image-bytes",
            filename="hero.jpg",
            mime_type="image/jpeg",
        )

        assert res.success is False
        assert mock_post.call_count == 1
        assert "401" in res.error or "认证失败" in res.error


@pytest.mark.asyncio
async def test_shopify_upload_rate_limit_respects_retry_after(shopify_config):
    """Shopify 429 Rate Limit must respect Retry-After header and retry successfully."""
    rate_limit_resp = httpx.Response(
        status_code=429,
        headers={"Retry-After": "2"},
        text="Too Many Requests",
        request=httpx.Request("POST", "https://mystore.myshopify.com/admin/api/2024-10/graphql.json"),
    )

    # stagedUploadsCreate success response
    staged_resp = MagicMock()
    staged_resp.status_code = 200
    staged_resp.json.return_value = {
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

    gcs_resp = MagicMock()
    gcs_resp.status_code = 201

    fc_resp = MagicMock()
    fc_resp.status_code = 200
    fc_resp.json.return_value = {
        "data": {
            "fileCreate": {
                "files": [
                    {
                        "id": "gid://shopify/MediaImage/9999",
                        "fileStatus": "READY",
                        "image": {"url": "https://cdn.shopify.com/s/files/1/test.png"},
                    }
                ],
                "userErrors": [],
            }
        }
    }

    sleeps = []

    async def fake_sleep(seconds: float):
        sleeps.append(seconds)

    with patch("httpx.AsyncClient.post") as mock_post, \
         patch("asyncio.sleep", side_effect=fake_sleep):
        # 1st call: 429, 2nd call: staged 200, 3rd call: gcs 201, 4th call: fc 200
        mock_post.side_effect = [
            rate_limit_resp,
            staged_resp,
            gcs_resp,
            fc_resp,
        ]

        res = await upload_image_to_shopify(
            config=shopify_config,
            image_bytes=b"fake-bytes",
            filename="product.png",
            mime_type="image/png",
        )

        assert res.success is True
        assert res.media_id == "gid://shopify/MediaImage/9999"
        assert res.remote_url == "https://cdn.shopify.com/s/files/1/test.png"
        assert any(s >= 2.0 for s in sleeps)


@pytest.mark.asyncio
async def test_r2_upload_transient_error_retries_and_succeeds(r2_config):
    """R2 PUT Object is idempotent, network errors or 503 should retry and succeed."""
    r2_503 = MagicMock()
    r2_503.status_code = 503
    r2_503.text = "Service Unavailable"

    r2_success = MagicMock()
    r2_success.status_code = 200

    sleeps = []

    async def fake_sleep(seconds: float):
        sleeps.append(seconds)

    with patch("httpx.AsyncClient.put") as mock_put, \
         patch("asyncio.sleep", side_effect=fake_sleep):
        mock_put.side_effect = [
            httpx.ConnectTimeout("Connect timeout"),
            r2_success,
        ]

        res = await upload_image_to_r2(
            config=r2_config,
            image_bytes=b"fake-bytes",
            filename="banner.jpg",
            mime_type="image/jpeg",
        )

        assert res.success is True
        assert res.remote_url == "https://cdn.example.com/pdp/banner.jpg"
        assert mock_put.call_count == 2
        assert len(sleeps) == 1
