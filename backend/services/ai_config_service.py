import os
from dataclasses import dataclass
from urllib.parse import urlparse

from db import AICapabilityBinding, AIProviderConfig


CAPABILITIES = {"text", "image"}
PROTOCOLS = {"gemini", "vertex", "openai_compatible"}


@dataclass(frozen=True)
class ProviderSnapshot:
    id: int
    capability: str
    name: str
    protocol: str
    base_url: str | None
    api_key: str | None
    vertex_project_id: str | None
    vertex_location: str | None
    vertex_key_path: str | None
    model: str
    timeout_seconds: int
    max_retries: int
    config_version: int


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    prefix = value[:3] if len(value) > 7 else ""
    return f"{prefix}****{value[-4:]}"


def validate_base_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Base URL 必须是 http/https 地址")
    if parsed.username or parsed.password:
        raise ValueError("Base URL 不能包含用户名或密码")
    return value.rstrip("/")


def _data_value(data, key, default=None):
    if isinstance(data, dict):
        return data.get(key, default)
    return getattr(data, key, default)


def _has_field(data, key):
    if isinstance(data, dict):
        return key in data
    if hasattr(data, "model_fields_set"):
        return key in data.model_fields_set
    return hasattr(data, key)


def _validate_provider_data(data):
    protocol = _data_value(data, "protocol")
    if protocol not in PROTOCOLS:
        raise ValueError("不支持的 AI 协议")
    if not _data_value(data, "name"):
        raise ValueError("提供商名称不能为空")


def _commit(db):
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise


def list_providers(db):
    return db.query(AIProviderConfig).order_by(AIProviderConfig.id).all()


def create_provider(db, data):
    _validate_provider_data(data)
    values = {
        key: _data_value(data, key)
        for key in (
            "name", "protocol", "api_key", "vertex_project_id", "vertex_location",
            "vertex_key_path", "text_model", "image_model", "supports_text",
            "supports_image", "timeout_seconds", "max_retries", "enabled",
        )
        if _data_value(data, key) is not None
    }
    values["base_url"] = validate_base_url(_data_value(data, "base_url"))
    row = AIProviderConfig(**values)
    db.add(row)
    _commit(db)
    db.refresh(row)
    return row


def update_provider(db, id, data):
    row = db.get(AIProviderConfig, id)
    if not row:
        raise ValueError("AI 提供商不存在")
    merged = {
        key: _data_value(data, key) if _has_field(data, key) else getattr(row, key)
        for key in ("name", "protocol")
    }
    _validate_provider_data(merged)
    base_url = (
        validate_base_url(_data_value(data, "base_url"))
        if _has_field(data, "base_url")
        else None
    )
    if _has_field(data, "enabled") and not _data_value(data, "enabled") and _bindings_for_provider(db, id):
        raise ValueError("该提供商正在使用，无法禁用")
    fields = (
        "name", "protocol", "api_key", "vertex_project_id", "vertex_location",
        "vertex_key_path", "text_model", "image_model", "supports_text",
        "supports_image", "timeout_seconds", "max_retries", "enabled",
    )
    for key in fields:
        if _has_field(data, key):
            setattr(row, key, _data_value(data, key))
    if _has_field(data, "base_url"):
        row.base_url = base_url
    row.config_version += 1
    _commit(db)
    db.refresh(row)
    return row


def _bindings_for_provider(db, provider_id):
    return db.query(AICapabilityBinding).filter_by(provider_config_id=provider_id).all()


def delete_provider(db, id):
    row = db.get(AIProviderConfig, id)
    if not row:
        raise ValueError("AI 提供商不存在")
    if _bindings_for_provider(db, id):
        raise ValueError("该提供商正在使用，无法删除")
    db.delete(row)
    _commit(db)


def set_provider_enabled(db, id, enabled):
    row = db.get(AIProviderConfig, id)
    if not row:
        raise ValueError("AI 提供商不存在")
    if not enabled and _bindings_for_provider(db, id):
        raise ValueError("该提供商正在使用，无法禁用")
    row.enabled = bool(enabled)
    row.config_version += 1
    _commit(db)
    db.refresh(row)
    return row


def get_bindings(db):
    return db.query(AICapabilityBinding).order_by(AICapabilityBinding.capability).all()


def set_binding(db, capability, provider_id):
    if capability not in CAPABILITIES:
        raise ValueError("不支持的能力类型")
    provider = db.get(AIProviderConfig, provider_id)
    if not provider:
        raise ValueError("AI 提供商不存在")
    if not provider.enabled:
        raise ValueError("AI 提供商已禁用")
    if capability == "text" and not provider.supports_text:
        raise ValueError("该提供商不支持文本能力")
    if capability == "image" and not provider.supports_image:
        raise ValueError("该提供商不支持图片能力")
    binding = db.get(AICapabilityBinding, capability)
    if binding:
        binding.provider_config_id = provider_id
    else:
        binding = AICapabilityBinding(capability=capability, provider_config_id=provider_id)
        db.add(binding)
    _commit(db)
    db.refresh(binding)
    return binding


def get_snapshot(db, capability):
    if capability not in CAPABILITIES:
        raise ValueError("不支持的能力类型")
    binding = db.get(AICapabilityBinding, capability)
    if not binding:
        raise ValueError("该能力尚未绑定 AI 提供商")
    provider = db.get(AIProviderConfig, binding.provider_config_id)
    if not provider or not provider.enabled:
        raise ValueError("绑定的 AI 提供商不可用")
    supported = provider.supports_text if capability == "text" else provider.supports_image
    if not supported:
        raise ValueError("绑定的 AI 提供商不支持该能力")
    model = provider.text_model if capability == "text" else provider.image_model
    if not model:
        raise ValueError("绑定的 AI 提供商未配置模型")
    return ProviderSnapshot(
        id=provider.id, capability=capability, name=provider.name,
        protocol=provider.protocol, base_url=provider.base_url, api_key=provider.api_key,
        vertex_project_id=provider.vertex_project_id, vertex_location=provider.vertex_location,
        vertex_key_path=provider.vertex_key_path, model=model,
        timeout_seconds=provider.timeout_seconds, max_retries=provider.max_retries,
        config_version=provider.config_version,
    )


def import_env_defaults_if_empty(db):
    if db.query(AIProviderConfig.id).first() is not None:
        return False
    provider = os.getenv("AI_PROVIDER", "gemini").lower()
    is_vertex = provider == "vertex"
    row = create_provider(db, {
        "name": "Vertex AI" if is_vertex else "Gemini API",
        "protocol": "vertex" if is_vertex else "gemini",
        "api_key": None if is_vertex else os.getenv("GEMINI_API_KEY"),
        "vertex_project_id": os.getenv("VERTEX_PROJECT_ID") if is_vertex else None,
        "vertex_location": os.getenv("VERTEX_LOCATION") if is_vertex else None,
        "vertex_key_path": os.getenv("VERTEX_KEY_PATH") if is_vertex else None,
        "text_model": os.getenv("FRONTEND_TEXT_MODEL", os.getenv("GEMINI_MODEL_ID", "gemini-3.1-pro-preview")),
        "image_model": os.getenv("FRONTEND_IMAGE_MODEL", "gemini-3.1-flash-image-preview"),
        "supports_text": True, "supports_image": True, "enabled": True,
    })
    set_binding(db, "text", row.id)
    set_binding(db, "image", row.id)
    return True
