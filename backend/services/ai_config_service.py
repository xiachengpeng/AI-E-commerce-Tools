import os
from dataclasses import dataclass
from urllib.parse import urlparse

from db import AICapabilityBinding, AIProviderConfig


CAPABILITIES = {"text", "image"}
PROTOCOLS = {"gemini", "vertex", "openai_compatible"}
DEFAULT_TEXT_MODEL = "gemini-3.1-pro-preview"
DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image-preview"
PROVIDER_FIELDS = (
    "name",
    "protocol",
    "base_url",
    "api_key",
    "vertex_project_id",
    "vertex_location",
    "vertex_key_path",
    "text_model",
    "image_model",
    "supports_text",
    "supports_image",
    "timeout_seconds",
    "max_retries",
    "enabled",
)
STRING_FIELDS = {
    "name",
    "protocol",
    "base_url",
    "api_key",
    "vertex_project_id",
    "vertex_location",
    "vertex_key_path",
    "text_model",
    "image_model",
}
BLANK_INHERITS_ON_UPDATE = {
    "api_key",
    "vertex_project_id",
    "vertex_location",
    "vertex_key_path",
}
PROVIDER_DEFAULTS = {
    "base_url": None,
    "api_key": None,
    "vertex_project_id": None,
    "vertex_location": None,
    "vertex_key_path": None,
    "text_model": None,
    "image_model": None,
    "supports_text": True,
    "supports_image": False,
    "timeout_seconds": 60,
    "max_retries": 2,
    "enabled": True,
}
CONNECTION_TEST_RELEVANT_FIELDS = (
    "protocol",
    "base_url",
    "api_key",
    "vertex_project_id",
    "vertex_location",
    "vertex_key_path",
    "text_model",
    "image_model",
    "supports_text",
    "supports_image",
    "timeout_seconds",
    "max_retries",
)


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
    if len(value) <= 8:
        return "********"
    prefix = value[:3]
    return f"{prefix}****{value[-4:]}"


def validate_base_url(value: str | None) -> str | None:
    value = _clean_optional(value)
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


def _clean_optional(value):
    if isinstance(value, str):
        return value.strip() or None
    return value


def _provider_values(data, existing=None):
    values = {}
    for key in PROVIDER_FIELDS:
        if existing is not None and not _has_field(data, key):
            value = getattr(existing, key)
        else:
            default = (
                getattr(existing, key)
                if existing is not None
                else PROVIDER_DEFAULTS.get(key)
            )
            value = _data_value(data, key, default)
            if (
                existing is not None
                and key in BLANK_INHERITS_ON_UPDATE
                and _clean_optional(value) is None
            ):
                value = getattr(existing, key)
        if key in STRING_FIELDS:
            value = _clean_optional(value)
        values[key] = value
    values["protocol"] = (
        values["protocol"].lower()
        if isinstance(values["protocol"], str)
        else values["protocol"]
    )
    values["base_url"] = validate_base_url(values["base_url"])
    return values


def _validate_provider_values(values):
    protocol = values.get("protocol")
    if protocol not in PROTOCOLS:
        raise ValueError("不支持的 AI 协议")
    if not values.get("name"):
        raise ValueError("提供商名称不能为空")
    supports_text = bool(values.get("supports_text"))
    supports_image = bool(values.get("supports_image"))
    if not supports_text and not supports_image:
        raise ValueError("请至少启用一种 AI 能力")
    if supports_text and not values.get("text_model"):
        raise ValueError("启用文本能力时必须配置文本模型")
    if supports_image and not values.get("image_model"):
        raise ValueError("启用图片能力时必须配置图片模型")

    if protocol == "gemini":
        if not values.get("api_key"):
            raise ValueError("Gemini API Key 不能为空")
    elif protocol == "vertex":
        if not values.get("vertex_project_id"):
            raise ValueError("Vertex Project ID 不能为空")
        if not values.get("vertex_location"):
            raise ValueError("Vertex Location 不能为空")
        credential_path = values.get("vertex_key_path")
        if credential_path and not (
            os.path.isfile(credential_path)
            and os.access(credential_path, os.R_OK)
        ):
            raise ValueError("Vertex 凭据文件路径无效或不可读")
    elif not values.get("base_url"):
        raise ValueError("OpenAI Compatible Base URL 不能为空")
    return values


def validate_provider_data(data, existing=None):
    values = _provider_values(data, existing)
    return _validate_provider_values(values)


def _commit(db):
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise


def list_providers(db):
    return db.query(AIProviderConfig).order_by(AIProviderConfig.id).all()


def create_provider(db, data):
    values = validate_provider_data(data)
    row = AIProviderConfig(**values)
    db.add(row)
    _commit(db)
    db.refresh(row)
    return row


def update_provider(db, id, data):
    row = db.get(AIProviderConfig, id)
    if not row:
        raise ValueError("AI 提供商不存在")
    proposed = _provider_values(data, row)
    bindings = {
        binding.capability
        for binding in _bindings_for_provider(db, id)
    }
    if (
        _has_field(data, "enabled")
        and not _data_value(data, "enabled")
        and bindings
    ):
        raise ValueError("该提供商正在使用，无法禁用")
    if "text" in bindings:
        if not proposed["supports_text"]:
            raise ValueError("文本能力正在使用，无法禁用")
        if not proposed["text_model"]:
            raise ValueError("文本模型正在使用，不能为空")
    if "image" in bindings:
        if not proposed["supports_image"]:
            raise ValueError("图片能力正在使用，无法禁用")
        if not proposed["image_model"]:
            raise ValueError("图片模型正在使用，不能为空")
    _validate_provider_values(proposed)
    invalidates_test_status = any(
        getattr(row, key) != proposed[key]
        for key in CONNECTION_TEST_RELEVANT_FIELDS
    )
    for key, value in proposed.items():
        setattr(row, key, value)
    if invalidates_test_status:
        row.last_test_status = None
        row.last_test_message = None
        row.last_tested_at = None
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
    model = (
        provider.text_model
        if capability == "text"
        else provider.image_model
    )
    if not _clean_optional(model):
        raise ValueError("该提供商未配置所选能力模型")
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
    provider = (
        (os.getenv("AI_PROVIDER") or "gemini").strip().lower()
    )
    is_vertex = provider == "vertex"
    text_model = (
        (os.getenv("FRONTEND_TEXT_MODEL") or "").strip()
        or (os.getenv("GEMINI_MODEL_ID") or "").strip()
        or DEFAULT_TEXT_MODEL
    )
    image_model = (
        (os.getenv("FRONTEND_IMAGE_MODEL") or "").strip()
        or DEFAULT_IMAGE_MODEL
    )
    values = {
        "name": "Vertex AI" if is_vertex else "Gemini API",
        "protocol": "vertex" if is_vertex else "gemini",
        "api_key": None if is_vertex else os.getenv("GEMINI_API_KEY"),
        "vertex_project_id": os.getenv("VERTEX_PROJECT_ID") if is_vertex else None,
        "vertex_location": os.getenv("VERTEX_LOCATION") if is_vertex else None,
        "vertex_key_path": os.getenv("VERTEX_KEY_PATH") if is_vertex else None,
        "text_model": text_model,
        "image_model": image_model,
        "supports_text": True, "supports_image": True, "enabled": True,
    }
    if provider not in {"gemini", "vertex"}:
        return False
    try:
        values = validate_provider_data(values)
    except ValueError:
        db.rollback()
        return False

    try:
        row = AIProviderConfig(**values)
        db.add(row)
        db.flush()
        db.add_all(
            [
                AICapabilityBinding(
                    capability=capability,
                    provider_config_id=row.id,
                )
                for capability in ("text", "image")
            ]
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True
