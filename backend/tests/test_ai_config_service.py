from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from db import Base
from services.ai_config_service import (
    create_provider,
    delete_provider,
    get_snapshot,
    import_env_defaults_if_empty,
    mask_secret,
    set_binding,
    set_provider_enabled,
    update_provider,
    validate_base_url,
)


def make_db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def provider_data(**overrides):
    data = dict(
        name="Relay A", protocol="openai_compatible",
        base_url="https://relay.example.com", api_key="sk-secret-1234",
        text_model="text-model", image_model="image-model",
        supports_text=True, supports_image=True,
        timeout_seconds=60, max_retries=2, enabled=True,
    )
    data.update(overrides)
    return data


def test_snapshot_is_immutable_and_secret_is_masked():
    db = make_db()
    row = create_provider(db, provider_data())
    set_binding(db, "text", row.id)

    snapshot = get_snapshot(db, "text")

    assert snapshot.api_key == "sk-secret-1234"
    assert snapshot.capability == "text"
    assert mask_secret(snapshot.api_key) == "sk-****1234"


def test_bound_provider_cannot_be_disabled_or_deleted():
    db = make_db()
    row = create_provider(db, provider_data())
    set_binding(db, "image", row.id)

    for action in (
        lambda: set_provider_enabled(db, row.id, False),
        lambda: delete_provider(db, row.id),
    ):
        try:
            action()
            assert False, "expected ProviderInUseError"
        except ValueError as exc:
            assert "正在使用" in str(exc)


def test_import_env_only_when_provider_table_is_empty(monkeypatch):
    db = make_db()
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "key")
    monkeypatch.setenv("FRONTEND_TEXT_MODEL", "text-1")
    monkeypatch.setenv("FRONTEND_IMAGE_MODEL", "image-1")

    assert import_env_defaults_if_empty(db) is True
    assert import_env_defaults_if_empty(db) is False
    assert get_snapshot(db, "text").model == "text-1"
    assert get_snapshot(db, "image").model == "image-1"


def test_base_url_validation_requires_clean_http_url():
    assert validate_base_url("https://relay.example.com/") == "https://relay.example.com"
    for value in ("relay.example.com", "https://user:pass@relay.example.com"):
        try:
            validate_base_url(value)
            assert False, "expected invalid Base URL"
        except ValueError as exc:
            assert "Base URL" in str(exc)


def test_update_increments_version_and_cannot_disable_bound_provider():
    db = make_db()
    row = create_provider(db, provider_data())
    updated = update_provider(db, row.id, {"name": "Relay B"})

    assert updated.name == "Relay B"
    assert updated.config_version == 2

    set_binding(db, "text", row.id)
    try:
        update_provider(db, row.id, {"enabled": False})
        assert False, "expected ProviderInUseError"
    except ValueError as exc:
        assert "正在使用" in str(exc)
