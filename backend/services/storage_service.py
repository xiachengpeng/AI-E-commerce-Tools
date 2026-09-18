import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import ipaddress
import logging
import os
import re
from pathlib import Path
from typing import Optional, Tuple
import urllib.parse
import httpx
from sqlalchemy.orm import Session

logger = logging.getLogger("storage_service")

from db import StorageConfig
from models.storage import (
    ImageUploadRequest,
    ImageUploadResponse,
    StorageConfigRead,
    StorageConfigWrite,
    StorageTestResponse,
)


from services.security_utils import validate_outbound_url


def _check_url_ssrf_safety(url_or_host: str) -> Tuple[bool, str]:
    return validate_outbound_url(url_or_host, require_http=False)


def mask_secret(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    val = value.strip()
    if len(val) <= 8:
        return "••••••••"
    return f"{val[:3]}••••{val[-3:]}"


def is_masked_or_empty(value: Optional[str]) -> bool:
    if not value or not value.strip():
        return True
    return "••••" in value


def clean_shopify_domain(domain: Optional[str]) -> str:
    if not domain:
        return ""
    val = domain.strip().lower()
    val = re.sub(r"^https?://", "", val).rstrip("/")
    if "." not in val:
        val = f"{val}.myshopify.com"
    return val


def extract_image_bytes(image_data: str, default_mime: str = "image/jpeg") -> Tuple[bytes, str]:
    """Extract raw image bytes and detected mime type from base64 string, data URL, or static file path."""
    cleaned = image_data.strip()
    mime_type = default_mime

    # Check for local static file reference
    static_match = re.search(r"/?static/(.+)$", cleaned)
    if static_match:
        rel_subpath = static_match.group(1)
        static_dir = Path(__file__).resolve().parent.parent / "static"
        target_path = (static_dir / rel_subpath).resolve()
        if target_path.is_file() and str(target_path).startswith(str(static_dir.resolve())):
            content = target_path.read_bytes()
            ext = target_path.suffix.lower()
            mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
            return content, mime_map.get(ext, default_mime)

    match = re.match(r"^data:([^;]+);base64,(.*)$", cleaned, re.DOTALL)
    if match:
        mime_type = match.group(1).strip().lower()
        raw_b64 = match.group(2).strip()
    else:
        raw_b64 = cleaned

    try:
        image_bytes = base64.b64decode(raw_b64)
        return image_bytes, mime_type
    except Exception as e:
        raise ValueError(f"无法解析图片 Base64 数据: {str(e)}")


def to_config_read(item: StorageConfig) -> StorageConfigRead:
    has_wp_pass = bool(item.wp_app_password and item.wp_app_password.strip())
    has_shop_tok = bool(item.shopify_access_token and item.shopify_access_token.strip())
    has_r2_sec = bool(item.r2_secret_access_key and item.r2_secret_access_key.strip())

    return StorageConfigRead(
        id=item.id,
        storage_type=item.storage_type,  # type: ignore
        name=item.name,
        is_default=bool(item.is_default),
        enabled=bool(item.enabled),
        wp_url=item.wp_url,
        wp_username=item.wp_username,
        has_wp_app_password=has_wp_pass,
        wp_app_password_masked=mask_secret(item.wp_app_password) if has_wp_pass else None,
        shopify_shop_domain=item.shopify_shop_domain,
        has_shopify_token=has_shop_tok,
        shopify_token_masked=mask_secret(item.shopify_access_token) if has_shop_tok else None,
        r2_account_id=item.r2_account_id,
        r2_access_key_id=item.r2_access_key_id,
        has_r2_secret=has_r2_sec,
        r2_secret_masked=mask_secret(item.r2_secret_access_key) if has_r2_sec else None,
        r2_bucket_name=item.r2_bucket_name,
        r2_public_url=item.r2_public_url,
        r2_path_prefix=item.r2_path_prefix or "pdp/",
        last_test_status=item.last_test_status,
        last_test_message=item.last_test_message,
        last_tested_at=item.last_tested_at,
    )


def get_all_storage_configs(db: Session) -> list[StorageConfigRead]:
    rows = (
        db.query(StorageConfig)
        .order_by(StorageConfig.storage_type, StorageConfig.is_default.desc(), StorageConfig.id.asc())
        .all()
    )
    found_types = {r.storage_type for r in rows}
    results = [to_config_read(r) for r in rows]

    for st in ["wordpress", "shopify", "r2"]:
        if st not in found_types:
            results.append(
                StorageConfigRead(
                    id=0,
                    storage_type=st,  # type: ignore
                    name=f"默认 {st.title()}",
                    is_default=True,
                    enabled=True,
                    has_wp_app_password=False,
                    has_shopify_token=False,
                    has_r2_secret=False,
                    r2_path_prefix="pdp/",
                )
            )
    return results


def get_storage_config_model(
    storage_type: str,
    db: Session,
    config_id: Optional[int] = None,
) -> Optional[StorageConfig]:
    if config_id and config_id > 0:
        found = db.query(StorageConfig).filter(StorageConfig.id == config_id).first()
        if found:
            return found
    # Try default first, then fallback to first matching type
    default_row = (
        db.query(StorageConfig)
        .filter(StorageConfig.storage_type == storage_type, StorageConfig.is_default == 1)
        .first()
    )
    if default_row:
        return default_row
    return db.query(StorageConfig).filter(StorageConfig.storage_type == storage_type).first()


def save_storage_config(write: StorageConfigWrite, db: Session) -> StorageConfigRead:
    row = None
    if write.id and write.id > 0:
        row = db.query(StorageConfig).filter(StorageConfig.id == write.id).first()

    if not row:
        if write.storage_type == "r2":
            row = db.query(StorageConfig).filter(StorageConfig.storage_type == "r2").first()

    if not row:
        row = StorageConfig(storage_type=write.storage_type)
        db.add(row)

    row.storage_type = write.storage_type
    row.enabled = 1 if write.enabled else 0

    if write.storage_type == "wordpress":
        row.wp_url = (write.wp_url or "").strip().rstrip("/")
        row.wp_username = (write.wp_username or "").strip()
        if write.wp_app_password and not is_masked_or_empty(write.wp_app_password):
            row.wp_app_password = write.wp_app_password.strip().replace(" ", "")
        name_val = (write.name or "").strip()
        if row.wp_url and name_val.endswith(f"({row.wp_url})"):
            name_val = name_val[: -len(f"({row.wp_url})")].strip()
        default_name = row.wp_username or (urllib.parse.urlparse(row.wp_url).netloc if row.wp_url else "") or "WordPress 站点"
        row.name = name_val or default_name
    elif write.storage_type == "shopify":
        row.shopify_shop_domain = clean_shopify_domain(write.shopify_shop_domain)
        if write.shopify_access_token and not is_masked_or_empty(write.shopify_access_token):
            row.shopify_access_token = write.shopify_access_token.strip()
        name_val = (write.name or "").strip()
        if row.shopify_shop_domain and name_val.endswith(f"({row.shopify_shop_domain})"):
            name_val = name_val[: -len(f"({row.shopify_shop_domain})")].strip()
        default_name = row.shopify_shop_domain or "Shopify 店铺"
        row.name = name_val or default_name
    elif write.storage_type == "r2":
        row.r2_account_id = (write.r2_account_id or "").strip()
        row.r2_access_key_id = (write.r2_access_key_id or "").strip()
        if write.r2_secret_access_key and not is_masked_or_empty(write.r2_secret_access_key):
            row.r2_secret_access_key = write.r2_secret_access_key.strip()
        row.r2_bucket_name = (write.r2_bucket_name or "").strip()
        row.r2_public_url = (write.r2_public_url or "").strip().rstrip("/")
        prefix = (write.r2_path_prefix or "pdp/").strip().strip("/")
        row.r2_path_prefix = f"{prefix}/" if prefix else ""
        row.name = (write.name or "").strip() or "默认 Cloudflare R2"

    # Manage is_default flag
    db.flush()
    existing_count = db.query(StorageConfig).filter(StorageConfig.storage_type == write.storage_type).count()
    if write.is_default or existing_count <= 1:
        db.query(StorageConfig).filter(
            StorageConfig.storage_type == write.storage_type,
            StorageConfig.id != row.id,
        ).update({"is_default": 0})
        row.is_default = 1
    else:
        row.is_default = 0

    db.commit()
    db.refresh(row)
    return to_config_read(row)


def delete_storage_config(config_id: int, db: Session) -> bool:
    row = db.query(StorageConfig).filter(StorageConfig.id == config_id).first()
    if not row:
        return False
    st = row.storage_type
    was_default = bool(row.is_default)
    db.delete(row)
    db.commit()

    if was_default:
        another = db.query(StorageConfig).filter(StorageConfig.storage_type == st).first()
        if another:
            another.is_default = 1
            db.commit()
    return True


def set_default_storage_config(config_id: int, db: Session) -> Optional[StorageConfigRead]:
    row = db.query(StorageConfig).filter(StorageConfig.id == config_id).first()
    if not row:
        return None
    db.query(StorageConfig).filter(
        StorageConfig.storage_type == row.storage_type,
        StorageConfig.id != row.id,
    ).update({"is_default": 0})
    row.is_default = 1
    db.commit()
    db.refresh(row)
    return to_config_read(row)


# ─────────────────────────────────────────────────────────────────────────────
# AWS S3 SigV4 纯 Python 异步签名引擎 (用于 Cloudflare R2 / AWS S3)
# ─────────────────────────────────────────────────────────────────────────────

def _sign_s3_request(
    method: str,
    url: str,
    headers: dict,
    payload: bytes,
    access_key: str,
    secret_key: str,
    region: str = "auto",
    service: str = "s3",
) -> dict:
    """Computes AWS Signature Version 4 for S3-compatible endpoints."""
    parsed = urllib.parse.urlsplit(url)
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    payload_hash = hashlib.sha256(payload).hexdigest()

    req_headers = {k.lower(): str(v).strip() for k, v in headers.items()}
    req_headers["host"] = parsed.netloc
    req_headers["x-amz-date"] = amz_date
    req_headers["x-amz-content-sha256"] = payload_hash

    # Header canonicalization
    sorted_header_names = sorted(req_headers.keys())
    canonical_headers = "".join(f"{k}:{req_headers[k]}\n" for k in sorted_header_names)
    signed_headers = ";".join(sorted_header_names)

    # URI canonicalization: ensure path starts with '/' and handles slashes safely
    canonical_uri = parsed.path if parsed.path else "/"
    # Query canonicalization
    canonical_querystring = parsed.query or ""

    canonical_request = (
        f"{method}\n"
        f"{canonical_uri}\n"
        f"{canonical_querystring}\n"
        f"{canonical_headers}\n"
        f"{signed_headers}\n"
        f"{payload_hash}"
    )

    algorithm = "AWS4-HMAC-SHA256"
    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = (
        f"{algorithm}\n"
        f"{amz_date}\n"
        f"{credential_scope}\n"
        f"{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
    )

    # Calculate HMAC-SHA256 signature key
    k_date = hmac.new(("AWS4" + secret_key).encode("utf-8"), date_stamp.encode("utf-8"), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode("utf-8"), hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()

    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization_header = (
        f"{algorithm} "
        f"Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )

    req_headers["authorization"] = authorization_header
    return req_headers


# ─────────────────────────────────────────────────────────────────────────────
# 连通性测试 (Test Connection)
# ─────────────────────────────────────────────────────────────────────────────

async def check_wordpress_connection(
    wp_url: str,
    wp_username: str,
    wp_app_password: str,
) -> Tuple[bool, str, Optional[dict]]:
    if not wp_url:
        return False, "WordPress 站点地址不能为空", None
    if not wp_username or not wp_app_password:
        return False, "WordPress 用户名与应用程序密码不能为空", None

    clean_url = wp_url.strip().rstrip("/")
    if not clean_url.startswith("http://") and not clean_url.startswith("https://"):
        clean_url = "https://" + clean_url

    safe, ssrf_err = _check_url_ssrf_safety(clean_url)
    if not safe:
        return False, f"WordPress 站点地址不合规: {ssrf_err}", None

    test_endpoint = f"{clean_url}/wp-json/wp/v2/users/me"
    clean_pass = wp_app_password.replace(" ", "")
    auth_str = base64.b64encode(f"{wp_username}:{clean_pass}".encode("utf-8")).decode("ascii")

    headers = {
        "Authorization": f"Basic {auth_str}",
        "Accept": "application/json",
        "User-Agent": "AIEcommerceTools/1.0",
    }

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(test_endpoint, headers=headers)

            if resp.status_code == 200:
                data = resp.json()
                name = data.get("name") or data.get("slug") or wp_username
                return True, f"WordPress REST API 连接成功！已成功识别用户: {name}", {"user": name, "id": data.get("id")}
            elif resp.status_code == 401:
                return False, "WordPress 认证失败 (401)：用户名或应用程序密码错误，请确认在 WordPress 后台【用户 -> 个人资料 -> 应用程序密码】生成无误", None
            elif resp.status_code == 403:
                return False, "WordPress 权限不足 (403)：当前账号没有 REST API 访问权限", None
            elif resp.status_code == 404:
                return False, f"WordPress REST API 接口未找到 (404)：请检查站点地址 [{clean_url}] 是否正确，或是否禁用了 REST API", None
            else:
                return False, f"WordPress 返回异常状态码 {resp.status_code}: {resp.text[:200]}", None
    except httpx.ConnectError:
        return False, f"无法连接到 WordPress 站点: {clean_url} (网络超时或域名无法解析)", None
    except Exception as e:
        return False, f"WordPress 连接测试发生异常: {str(e)}", None


async def check_r2_connection(
    account_id: str,
    access_key_id: str,
    secret_access_key: str,
    bucket_name: str,
    public_url: Optional[str] = None,
) -> Tuple[bool, str, Optional[dict]]:
    clean_acc_id = (account_id or "").strip()
    clean_acc_id = re.sub(r"^https?://", "", clean_acc_id)
    clean_acc_id = re.sub(r"\.r2\.cloudflarestorage\.com.*$", "", clean_acc_id).strip("/")
    clean_key_id = (access_key_id or "").strip()
    clean_secret = (secret_access_key or "").strip()
    clean_bucket = (bucket_name or "").strip().strip("/")

    if not clean_acc_id:
        return False, "Cloudflare Account ID 不能为空", None
    if not clean_key_id or not clean_secret:
        return False, "R2 Access Key ID 与 Secret Access Key 不能为空", None
    if not clean_bucket:
        return False, "R2 Bucket Name (存储桶名称) 不能为空", None

    endpoint = f"https://{clean_acc_id}.r2.cloudflarestorage.com/{clean_bucket}?max-keys=1"
    headers = {"Accept": "application/xml"}

    try:
        signed_headers = _sign_s3_request(
            method="GET",
            url=endpoint,
            headers=headers,
            payload=b"",
            access_key=access_key_id,
            secret_key=secret_access_key,
            region="auto",
            service="s3",
        )

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(endpoint, headers=signed_headers)

            if resp.status_code == 200:
                pub_msg = f" (已绑定公开域名: {public_url})" if public_url else " (注意: 未配置公开域名，生成的图片将使用私有存储路径)"
                return True, f"Cloudflare R2 存储桶 [{bucket_name}] 连接成功，读写权限正常！{pub_msg}", {"bucket": bucket_name}
            elif resp.status_code == 403:
                return False, "Cloudflare R2 鉴权失败 (403)：Access Key ID 或 Secret Access Key 错误，或该 Token 无权访问此存储桶", None
            elif resp.status_code == 404:
                return False, f"Cloudflare R2 存储桶不存在 (404)：未找到名为 [{bucket_name}] 的 Bucket，请检查拼写", None
            else:
                return False, f"Cloudflare R2 返回状态码 {resp.status_code}: {resp.text[:200]}", None
    except httpx.ConnectError:
        return False, f"无法连接到 Cloudflare R2 终端节点: https://{account_id}.r2.cloudflarestorage.com", None
    except Exception as e:
        return False, f"Cloudflare R2 连接测试发生异常: {str(e)}", None


async def check_shopify_connection(
    shop_domain: str,
    access_token: str,
) -> Tuple[bool, str, Optional[dict]]:
    domain = clean_shopify_domain(shop_domain)
    token = (access_token or "").strip()
    if not domain:
        return False, "Shopify 店铺域名不能为空 (例如 your-store.myshopify.com)", None
    safe, ssrf_err = _check_url_ssrf_safety(domain)
    if not safe:
        return False, f"Shopify 店铺域名不合规: {ssrf_err}", None
    if not token:
        return False, "Shopify Admin API Access Token 不能为空 (shpat_...)", None

    graphql_url = f"https://{domain}/admin/api/2024-10/graphql.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        "User-Agent": "AIEcommerceTools/1.0",
    }
    query = """
    query {
      shop {
        name
        email
        myshopifyDomain
        plan {
          displayName
        }
      }
    }
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(graphql_url, json={"query": query}, headers=headers)
            if resp.status_code in (401, 403):
                return (
                    False,
                    f"Shopify 鉴权失败 ({resp.status_code})：Access Token 无效或权限不足。请确保自定义应用拥有 read_files / write_files 权限",
                    None,
                )
            if resp.status_code != 200:
                return False, f"Shopify 返回异常状态码 {resp.status_code}: {resp.text[:200]}", None
            data = resp.json()
            if "errors" in data and not data.get("data"):
                err_msg = data["errors"][0].get("message", "未知 GraphQL 错误")
                return False, f"Shopify 接口报错: {err_msg}", None
            shop_info = data.get("data", {}).get("shop", {})
            shop_name = shop_info.get("name") or domain
            myshop_domain = shop_info.get("myshopifyDomain") or domain
            plan_name = shop_info.get("plan", {}).get("displayName") or "Standard"
            return (
                True,
                f"Shopify Admin API 连接成功！已成功识别店铺: {shop_name} ({myshop_domain})",
                {"shop_name": shop_name, "domain": myshop_domain, "plan": plan_name},
            )
    except httpx.ConnectError:
        return False, f"无法连接到 Shopify 店铺: https://{domain} (网络超时或域名不存在)", None
    except Exception as e:
        return False, f"Shopify 连接测试发生异常: {str(e)}", None


async def test_storage_connection(
    storage_type: str,
    db: Session,
    config_override: Optional[StorageConfigWrite] = None,
) -> StorageTestResponse:
    # Resolve parameters from override or db
    target_id = config_override.id if config_override else None
    row = get_storage_config_model(storage_type, db, config_id=target_id)

    if storage_type == "wordpress":
        wp_url = (config_override.wp_url.strip() if (config_override and config_override.wp_url and config_override.wp_url.strip()) else (row.wp_url if row else "")) or ""
        wp_user = (config_override.wp_username.strip() if (config_override and config_override.wp_username and config_override.wp_username.strip()) else (row.wp_username if row else "")) or ""
        raw_pass = config_override.wp_app_password if config_override else None
        wp_pass = raw_pass if (raw_pass and not is_masked_or_empty(raw_pass)) else (row.wp_app_password if row else "")

        success, msg, details = await check_wordpress_connection(wp_url or "", wp_user or "", wp_pass or "")
    elif storage_type == "shopify":
        domain = (config_override.shopify_shop_domain.strip() if (config_override and config_override.shopify_shop_domain and config_override.shopify_shop_domain.strip()) else (row.shopify_shop_domain if row else "")) or ""
        raw_tok = config_override.shopify_access_token if config_override else None
        token = raw_tok if (raw_tok and not is_masked_or_empty(raw_tok)) else (row.shopify_access_token if row else "")

        success, msg, details = await check_shopify_connection(domain or "", token or "")
    elif storage_type == "r2":
        acc_id = (config_override.r2_account_id.strip() if (config_override and config_override.r2_account_id and config_override.r2_account_id.strip()) else (row.r2_account_id if row else "")) or ""
        key_id = (config_override.r2_access_key_id.strip() if (config_override and config_override.r2_access_key_id and config_override.r2_access_key_id.strip()) else (row.r2_access_key_id if row else "")) or ""
        raw_sec = config_override.r2_secret_access_key if config_override else None
        secret = raw_sec if (raw_sec and not is_masked_or_empty(raw_sec)) else (row.r2_secret_access_key if row else "")
        bucket = (config_override.r2_bucket_name.strip() if (config_override and config_override.r2_bucket_name and config_override.r2_bucket_name.strip()) else (row.r2_bucket_name if row else "")) or ""
        pub_url = (config_override.r2_public_url.strip() if (config_override and config_override.r2_public_url and config_override.r2_public_url.strip()) else (row.r2_public_url if row else "")) or ""

        success, msg, details = await check_r2_connection(acc_id or "", key_id or "", secret or "", bucket or "", pub_url or "")
    else:
        return StorageTestResponse(success=False, message=f"未知的存储类型: {storage_type}")

    # Persist status in DB if record exists
    if row:
        row.last_test_status = "success" if success else "failed"
        row.last_test_message = msg
        row.last_tested_at = datetime.now()
        db.commit()

    return StorageTestResponse(success=success, message=msg, details=details)


# ─────────────────────────────────────────────────────────────────────────────
# 图片上传实现 (Upload Image)
# ─────────────────────────────────────────────────────────────────────────────

async def upload_image_to_wordpress(
    config: StorageConfig,
    image_bytes: bytes,
    filename: str,
    mime_type: str,
    title: Optional[str] = None,
    alt_text: Optional[str] = None,
) -> ImageUploadResponse:
    if not config.wp_url or not config.wp_username or not config.wp_app_password:
        return ImageUploadResponse(
            success=False,
            storage_type="wordpress",
            filename=filename,
            error="WordPress 配置不完整：请先在设置中填写站点 URL、用户名与应用程序密码",
        )

    clean_url = config.wp_url.strip().rstrip("/")
    if not clean_url.startswith("http://") and not clean_url.startswith("https://"):
        clean_url = "https://" + clean_url

    safe, ssrf_err = _check_url_ssrf_safety(clean_url)
    if not safe:
        return ImageUploadResponse(
            success=False,
            storage_type="wordpress",
            filename=filename,
            error=f"WordPress 站点地址不合规: {ssrf_err}",
        )

    upload_endpoint = f"{clean_url}/wp-json/wp/v2/media"
    clean_pass = config.wp_app_password.replace(" ", "")
    auth_str = base64.b64encode(f"{config.wp_username}:{clean_pass}".encode("utf-8")).decode("ascii")

    # Sanitize filename
    safe_filename = re.sub(r"[^a-zA-Z0-9._-]", "-", filename) or "image.jpg"

    headers = {
        "Authorization": f"Basic {auth_str}",
        "Content-Disposition": f'attachment; filename="{safe_filename}"',
        "Content-Type": mime_type,
        "Accept": "application/json",
        "User-Agent": "AIEcommerceTools/1.0",
    }

    try:
        async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
            resp = await client.post(upload_endpoint, headers=headers, content=image_bytes)

            if resp.status_code in (200, 201):
                data = resp.json()
                media_id = str(data.get("id"))
                source_url = data.get("source_url")

                # Update metadata if needed
                if media_id and (title or alt_text):
                    patch_payload = {}
                    if title:
                        patch_payload["title"] = title
                    if alt_text:
                        patch_payload["alt_text"] = alt_text
                    if patch_payload:
                        try:
                            await client.post(
                                f"{upload_endpoint}/{media_id}",
                                headers={"Authorization": f"Basic {auth_str}", "Content-Type": "application/json"},
                                json=patch_payload,
                                timeout=10.0,
                            )
                        except Exception:
                            pass

                return ImageUploadResponse(
                    success=True,
                    remote_url=source_url,
                    storage_type="wordpress",
                    media_id=media_id,
                    filename=safe_filename,
                )
            elif resp.status_code == 401:
                return ImageUploadResponse(
                    success=False,
                    storage_type="wordpress",
                    filename=safe_filename,
                    error="WordPress 401 认证失败：用户名或应用程序密码错误",
                )
            elif resp.status_code == 403:
                return ImageUploadResponse(
                    success=False,
                    storage_type="wordpress",
                    filename=safe_filename,
                    error="WordPress 403 权限不足：无权在媒体库中上传文件",
                )
            else:
                return ImageUploadResponse(
                    success=False,
                    storage_type="wordpress",
                    filename=safe_filename,
                    error=f"WordPress 返回错误 {resp.status_code}: {resp.text[:200]}",
                )
    except httpx.ConnectError:
        return ImageUploadResponse(
            success=False,
            storage_type="wordpress",
            filename=safe_filename,
            error=f"无法连接至 WordPress 站点: {clean_url}",
        )
    except Exception as e:
        return ImageUploadResponse(
            success=False,
            storage_type="wordpress",
            filename=safe_filename,
            error=f"上传至 WordPress 发生异常: {str(e)}",
        )


async def upload_image_to_shopify(
    config: StorageConfig,
    image_bytes: bytes,
    filename: str,
    mime_type: str = "image/png",
    alt_text: Optional[str] = None,
) -> ImageUploadResponse:
    domain = clean_shopify_domain(config.shopify_shop_domain)
    token = (config.shopify_access_token or "").strip()

    if not domain or not token:
        return ImageUploadResponse(
            success=False,
            storage_type="shopify",
            filename=filename,
            error="Shopify 配置不完整：请先在设置中填写店铺域名与 Access Token",
        )

    safe, ssrf_err = _check_url_ssrf_safety(domain)
    if not safe:
        return ImageUploadResponse(
            success=False,
            storage_type="shopify",
            filename=filename,
            error=f"Shopify 店铺域名不合规: {ssrf_err}",
        )

    graphql_url = f"https://{domain}/admin/api/2024-10/graphql.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        "User-Agent": "AIEcommerceTools/1.0",
    }
    safe_filename = re.sub(r"[^a-zA-Z0-9._-]", "-", filename) or "pdp-asset.png"

    # Step 1: stagedUploadsCreate
    staged_mutation = """
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          resourceUrl
          url
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
    """
    staged_vars = {
        "input": [
            {
                "filename": safe_filename,
                "mimeType": mime_type,
                "resource": "IMAGE",
                "httpMethod": "POST",
            }
        ]
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(graphql_url, json={"query": staged_mutation, "variables": staged_vars}, headers=headers)
            if resp.status_code != 200:
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error=f"Shopify stagedUploadsCreate 失败 (HTTP {resp.status_code}): {resp.text[:200]}",
                )
            staged_res = resp.json()
            staged_payload = staged_res.get("data", {}).get("stagedUploadsCreate", {})
            user_errors = staged_payload.get("userErrors", [])
            if user_errors:
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error=f"Shopify 创建暂存上传失败: {user_errors[0].get('message')}",
                )
            targets = staged_payload.get("stagedTargets", [])
            if not targets:
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error="Shopify 未返回暂存上传目标信息",
                )
            target = targets[0]
            upload_url = target["url"]
            parameters = target["parameters"]
            resource_url = target["resourceUrl"]

            # Step 2: Upload file data to upload_url (Form data, file must be the last field)
            form_fields = []
            for p in parameters:
                form_fields.append((p["name"], (None, p["value"])))
            form_fields.append(("file", (safe_filename, image_bytes, mime_type)))

            upload_resp = await client.post(upload_url, files=form_fields)
            if upload_resp.status_code not in (200, 201, 204):
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error=f"上传图片文件到 Shopify 暂存桶失败 (HTTP {upload_resp.status_code}): {upload_resp.text[:200]}",
                )

            # Step 3: fileCreate mutation
            file_create_mutation = """
            mutation fileCreate($files: [FileCreateInput!]!) {
              fileCreate(files: $files) {
                files {
                  id
                  fileStatus
                  alt
                  ... on MediaImage {
                    image {
                      url
                    }
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
            """
            file_create_vars = {
                "files": [
                    {
                        "alt": alt_text or safe_filename,
                        "contentType": "IMAGE",
                        "originalSource": resource_url,
                    }
                ]
            }

            fc_resp = await client.post(graphql_url, json={"query": file_create_mutation, "variables": file_create_vars}, headers=headers)
            if fc_resp.status_code != 200:
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error=f"Shopify fileCreate 注册失败 (HTTP {fc_resp.status_code}): {fc_resp.text[:200]}",
                )
            fc_data = fc_resp.json()
            fc_payload = fc_data.get("data", {}).get("fileCreate", {})
            fc_errors = fc_payload.get("userErrors", [])
            if fc_errors:
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error=f"Shopify 文件注册错误: {fc_errors[0].get('message')}",
                )
            files = fc_payload.get("files", [])
            if not files:
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error="Shopify 未能创建文件对象",
                )
            file_node = files[0]
            file_id = file_node.get("id")
            cdn_url = file_node.get("image", {}).get("url") if file_node.get("image") else None

            # Step 4: If cdn_url not yet available, poll node(id: $id)
            if not cdn_url and file_id:
                poll_query = """
                query getFile($id: ID!) {
                  node(id: $id) {
                    ... on MediaImage {
                      fileStatus
                      image {
                        url
                      }
                    }
                  }
                }
                """
                for _ in range(8):
                    await asyncio.sleep(1.2)
                    poll_resp = await client.post(graphql_url, json={"query": poll_query, "variables": {"id": file_id}}, headers=headers)
                    if poll_resp.status_code == 200:
                        p_data = poll_resp.json()
                        node = p_data.get("data", {}).get("node", {})
                        if node:
                            img = node.get("image") or {}
                            if img.get("url"):
                                cdn_url = img.get("url")
                                break
                            if node.get("fileStatus") == "FAILED":
                                return ImageUploadResponse(
                                    success=False,
                                    storage_type="shopify",
                                    filename=safe_filename,
                                    error="Shopify 图片处理失败 (fileStatus: FAILED)",
                                )

            if cdn_url:
                return ImageUploadResponse(
                    success=True,
                    remote_url=cdn_url,
                    storage_type="shopify",
                    media_id=file_id,
                    filename=safe_filename,
                )
            else:
                return ImageUploadResponse(
                    success=False,
                    storage_type="shopify",
                    filename=safe_filename,
                    error="Shopify 文件已提交但在等待时间内未就绪，请稍后重试",
                )
    except Exception as e:
        return ImageUploadResponse(
            success=False,
            storage_type="shopify",
            filename=safe_filename,
            error=f"上传至 Shopify 发生异常: {str(e)}",
        )


async def upload_image_to_r2(
    config: StorageConfig,
    image_bytes: bytes,
    filename: str,
    mime_type: str,
) -> ImageUploadResponse:
    clean_acc_id = (config.r2_account_id or "").strip()
    clean_acc_id = re.sub(r"^https?://", "", clean_acc_id)
    clean_acc_id = re.sub(r"\.r2\.cloudflarestorage\.com.*$", "", clean_acc_id).strip("/")
    clean_bucket = (config.r2_bucket_name or "").strip().strip("/")

    if not clean_acc_id or not config.r2_access_key_id or not config.r2_secret_access_key or not clean_bucket:
        return ImageUploadResponse(
            success=False,
            storage_type="r2",
            filename=filename,
            error="Cloudflare R2 配置不完整：请先在设置中填写 Account ID、密钥对与存储桶名称",
        )

    safe_filename = re.sub(r"[^a-zA-Z0-9._-]", "-", filename) or "image.jpg"
    prefix = (config.r2_path_prefix or "").strip().strip("/")
    object_key = f"{prefix}/{safe_filename}" if prefix else safe_filename

    endpoint = f"https://{clean_acc_id}.r2.cloudflarestorage.com/{clean_bucket}/{object_key}"

    headers = {
        "Content-Type": mime_type,
        "Content-Length": str(len(image_bytes)),
    }

    try:
        signed_headers = _sign_s3_request(
            method="PUT",
            url=endpoint,
            headers=headers,
            payload=image_bytes,
            access_key=config.r2_access_key_id,
            secret_key=config.r2_secret_access_key,
            region="auto",
            service="s3",
        )

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.put(endpoint, headers=signed_headers, content=image_bytes)

            if resp.status_code in (200, 201):
                # Public URL resolution
                if config.r2_public_url:
                    public_base = config.r2_public_url.strip().rstrip("/")
                    if not public_base.startswith("http://") and not public_base.startswith("https://"):
                        public_base = "https://" + public_base
                    remote_url = f"{public_base}/{object_key}"
                else:
                    # Fallback to direct R2 path (note: R2 bucket might be private)
                    remote_url = f"https://{config.r2_bucket_name}.{config.r2_account_id}.r2.dev/{object_key}"

                return ImageUploadResponse(
                    success=True,
                    remote_url=remote_url,
                    storage_type="r2",
                    filename=safe_filename,
                )
            elif resp.status_code == 403:
                return ImageUploadResponse(
                    success=False,
                    storage_type="r2",
                    filename=safe_filename,
                    error="Cloudflare R2 403 权限拒绝：密钥错误或无写入此存储桶权限",
                )
            elif resp.status_code == 404:
                return ImageUploadResponse(
                    success=False,
                    storage_type="r2",
                    filename=safe_filename,
                    error=f"Cloudflare R2 404 存储桶未找到: {config.r2_bucket_name}",
                )
            else:
                return ImageUploadResponse(
                    success=False,
                    storage_type="r2",
                    filename=safe_filename,
                    error=f"Cloudflare R2 返回错误 {resp.status_code}: {resp.text[:200]}",
                )
    except httpx.ConnectError:
        return ImageUploadResponse(
            success=False,
            storage_type="r2",
            filename=safe_filename,
            error=f"无法连接到 Cloudflare R2 终端节点: https://{config.r2_account_id}.r2.cloudflarestorage.com",
        )
    except Exception as e:
        return ImageUploadResponse(
            success=False,
            storage_type="r2",
            filename=safe_filename,
            error=f"上传至 Cloudflare R2 发生异常: {str(e)}",
        )


async def upload_image_dispatcher(
    request: ImageUploadRequest,
    db: Session,
) -> ImageUploadResponse:
    row = get_storage_config_model(request.storage_type, db, config_id=request.config_id)
    if not row or not row.enabled:
        return ImageUploadResponse(
            success=False,
            storage_type=request.storage_type,
            filename=request.filename,
            error=f"存储类型 [{request.storage_type}] 尚未启用或尚未配置，请先保存配置并测试连接",
        )

    try:
        image_bytes, mime_type = extract_image_bytes(request.image_data, request.mime_type)
    except ValueError as err:
        return ImageUploadResponse(
            success=False,
            storage_type=request.storage_type,
            filename=request.filename,
            error=str(err),
        )

    target_filename = request.filename
    if request.convert_to_webp:
        from services.image_compression_service import compress_to_webp
        try:
            image_bytes, _ = compress_to_webp(image_bytes, quality=request.quality)
            mime_type = "image/webp"
            base_stem = re.sub(r"\.(png|jpe?g|bmp|tiff)$", "", target_filename, flags=re.IGNORECASE)
            if not base_stem.lower().endswith(".webp"):
                target_filename = f"{base_stem}.webp"
        except Exception as exc:
            logger.warning(f"WebP 转换失败，使用原始格式上传: {exc}")

    if request.storage_type == "wordpress":
        return await upload_image_to_wordpress(
            config=row,
            image_bytes=image_bytes,
            filename=target_filename,
            mime_type=mime_type,
            title=request.title,
            alt_text=request.alt_text,
        )
    elif request.storage_type == "shopify":
        return await upload_image_to_shopify(
            config=row,
            image_bytes=image_bytes,
            filename=target_filename,
            mime_type=mime_type,
            alt_text=request.alt_text,
        )
    elif request.storage_type == "r2":
        return await upload_image_to_r2(
            config=row,
            image_bytes=image_bytes,
            filename=target_filename,
            mime_type=mime_type,
        )
    else:
        return ImageUploadResponse(
            success=False,
            storage_type=request.storage_type,
            filename=target_filename,
            error=f"不支持的存储类型: {request.storage_type}",
        )
