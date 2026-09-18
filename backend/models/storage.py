from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field


class StorageConfigRead(BaseModel):
    id: int = 0
    storage_type: Literal["wordpress", "shopify", "r2"]
    name: Optional[str] = None
    is_default: bool = False
    enabled: bool = True

    # WordPress fields
    wp_url: Optional[str] = None
    wp_username: Optional[str] = None
    has_wp_app_password: bool = False
    wp_app_password_masked: Optional[str] = None

    # Shopify fields
    shopify_shop_domain: Optional[str] = None
    has_shopify_token: bool = False
    shopify_token_masked: Optional[str] = None

    # Cloudflare R2 fields
    r2_account_id: Optional[str] = None
    r2_access_key_id: Optional[str] = None
    has_r2_secret: bool = False
    r2_secret_masked: Optional[str] = None
    r2_bucket_name: Optional[str] = None
    r2_public_url: Optional[str] = None
    r2_path_prefix: Optional[str] = "pdp/"

    last_test_status: Optional[str] = None
    last_test_message: Optional[str] = None
    last_tested_at: Optional[datetime] = None


class StorageConfigWrite(BaseModel):
    id: Optional[int] = None
    storage_type: Literal["wordpress", "shopify", "r2"]
    name: Optional[str] = None
    is_default: bool = False
    enabled: bool = True

    # WordPress fields
    wp_url: Optional[str] = None
    wp_username: Optional[str] = None
    wp_app_password: Optional[str] = None

    # Shopify fields
    shopify_shop_domain: Optional[str] = None
    shopify_access_token: Optional[str] = None

    # Cloudflare R2 fields
    r2_account_id: Optional[str] = None
    r2_access_key_id: Optional[str] = None
    r2_secret_access_key: Optional[str] = None
    r2_bucket_name: Optional[str] = None
    r2_public_url: Optional[str] = None
    r2_path_prefix: Optional[str] = "pdp/"


class StorageTestRequest(BaseModel):
    storage_type: Literal["wordpress", "shopify", "r2"]
    config_id: Optional[int] = None
    config_override: Optional[StorageConfigWrite] = None

    # Direct flat fields support from frontend forms
    name: Optional[str] = None
    wp_url: Optional[str] = None
    wp_username: Optional[str] = None
    wp_app_password: Optional[str] = None

    shopify_shop_domain: Optional[str] = None
    shopify_access_token: Optional[str] = None

    r2_account_id: Optional[str] = None
    r2_access_key_id: Optional[str] = None
    r2_secret_access_key: Optional[str] = None
    r2_bucket_name: Optional[str] = None
    r2_public_url: Optional[str] = None
    r2_path_prefix: Optional[str] = "pdp/"

    def resolve_override(self) -> StorageConfigWrite:
        if self.config_override is not None:
            return self.config_override
        return StorageConfigWrite(
            id=self.config_id,
            storage_type=self.storage_type,
            name=self.name,
            enabled=True,
            wp_url=self.wp_url,
            wp_username=self.wp_username,
            wp_app_password=self.wp_app_password,
            shopify_shop_domain=self.shopify_shop_domain,
            shopify_access_token=self.shopify_access_token,
            r2_account_id=self.r2_account_id,
            r2_access_key_id=self.r2_access_key_id,
            r2_secret_access_key=self.r2_secret_access_key,
            r2_bucket_name=self.r2_bucket_name,
            r2_public_url=self.r2_public_url,
            r2_path_prefix=self.r2_path_prefix or "pdp/",
        )


class StorageTestResponse(BaseModel):
    success: bool
    message: str
    details: Optional[dict] = None


class ImageUploadRequest(BaseModel):
    storage_type: Literal["wordpress", "shopify", "r2"]
    config_id: Optional[int] = None
    image_data: str = Field(description="Base64 encoded image data or data URL")
    filename: str = Field(default="image.jpg", description="Target filename")
    mime_type: str = Field(default="image/jpeg", description="MIME type of the image")
    title: Optional[str] = None
    alt_text: Optional[str] = None
    convert_to_webp: bool = Field(default=False, description="Whether to compress and convert to WebP before uploading")
    quality: int = Field(default=90, description="WebP compression quality (1-100)")



class ImageUploadResponse(BaseModel):
    success: bool
    remote_url: Optional[str] = None
    storage_type: str
    media_id: Optional[str] = None
    filename: str
    error: Optional[str] = None
