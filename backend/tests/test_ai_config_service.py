import pytest
from sqlalchemy import event
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from db import AICapabilityBinding, AIProviderConfig, Base
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
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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


def test_empty_env_model_values_use_nonempty_fallbacks(monkeypatch):
    db = make_db()
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "key")
    monkeypatch.setenv("GEMINI_MODEL_ID", "")
    monkeypatch.setenv("FRONTEND_TEXT_MODEL", "")
    monkeypatch.setenv("FRONTEND_IMAGE_MODEL", "")

    assert import_env_defaults_if_empty(db) is True
    assert get_snapshot(db, "text").model == "gemini-3.1-pro-preview"
    assert (
        get_snapshot(db, "image").model
        == "gemini-3.1-flash-image-preview"
    )


def test_invalid_env_defaults_leave_database_unconfigured(monkeypatch):
    db = make_db()
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "   ")

    assert import_env_defaults_if_empty(db) is False
    assert db.query(AIProviderConfig).count() == 0
    assert db.query(AICapabilityBinding).count() == 0


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        (
            {
                "protocol": "gemini",
                "base_url": None,
                "api_key": " ",
            },
            "API Key",
        ),
        (
            {
                "protocol": "vertex",
                "base_url": None,
                "api_key": None,
                "vertex_project_id": "",
                "vertex_location": "us-central1",
            },
            "Project",
        ),
        (
            {
                "protocol": "vertex",
                "base_url": None,
                "api_key": None,
                "vertex_project_id": "project-id",
                "vertex_location": "",
            },
            "Location",
        ),
        (
            {
                "protocol": "vertex",
                "base_url": None,
                "api_key": None,
                "vertex_project_id": "project-id",
                "vertex_location": "us-central1",
                "vertex_key_path": "/definitely/missing/credentials.json",
            },
            "凭据",
        ),
        (
            {
                "protocol": "openai_compatible",
                "base_url": "ftp://relay.example.com",
            },
            "Base URL",
        ),
        (
            {
                "supports_text": False,
                "supports_image": False,
            },
            "至少",
        ),
        (
            {
                "supports_text": True,
                "text_model": " ",
            },
            "文本模型",
        ),
        (
            {
                "supports_image": True,
                "image_model": None,
            },
            "图片模型",
        ),
    ],
)
def test_provider_protocol_and_capability_combinations_are_validated(
    overrides,
    message,
):
    db = make_db()

    with pytest.raises(ValueError, match=message):
        create_provider(db, provider_data(**overrides))

    assert db.query(AIProviderConfig).count() == 0


def test_vertex_accepts_existing_optional_credential_file(tmp_path):
    db = make_db()
    credential_path = tmp_path / "vertex.json"
    credential_path.write_text("{}", encoding="utf-8")

    row = create_provider(
        db,
        provider_data(
            protocol="vertex",
            base_url=None,
            api_key=None,
            vertex_project_id="project-id",
            vertex_location="us-central1",
            vertex_key_path=str(credential_path),
        ),
    )

    assert row.vertex_key_path == str(credential_path)


@pytest.mark.parametrize(
    ("capability", "model_field"),
    [("text", "text_model"), ("image", "image_model")],
)
def test_set_binding_independently_rejects_missing_capability_model(
    capability,
    model_field,
):
    db = make_db()
    row = AIProviderConfig(
        name="Legacy invalid row",
        protocol="openai_compatible",
        base_url="https://relay.example.com",
        supports_text=True,
        supports_image=True,
        text_model="text-model",
        image_model="image-model",
        enabled=True,
    )
    setattr(row, model_field, None)
    db.add(row)
    db.commit()

    with pytest.raises(ValueError, match="模型"):
        set_binding(db, capability, row.id)

    assert db.query(AICapabilityBinding).count() == 0


def test_first_run_import_rolls_back_provider_and_bindings_atomically(
    monkeypatch,
):
    db = make_db()
    monkeypatch.setenv("AI_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "key")

    def reject_binding_flush(session, _flush_context, _instances):
        if any(
            isinstance(item, AICapabilityBinding)
            for item in session.new
        ):
            raise RuntimeError("binding insert failed")

    event.listen(db, "before_flush", reject_binding_flush)
    try:
        with pytest.raises(RuntimeError, match="binding insert failed"):
            import_env_defaults_if_empty(db)
    finally:
        event.remove(db, "before_flush", reject_binding_flush)

    assert not db.new
    assert db.query(AIProviderConfig).count() == 0
    assert db.query(AICapabilityBinding).count() == 0


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


def test_rejected_update_does_not_leak_mutations_into_later_commit():
    db = make_db()
    row = create_provider(db, provider_data())

    try:
        update_provider(db, row.id, {"name": "Should not persist", "base_url": "not-a-url"})
        assert False, "expected invalid Base URL"
    except ValueError as exc:
        assert "Base URL" in str(exc)

    set_provider_enabled(db, row.id, False)
    db.refresh(row)
    assert row.name == "Relay A"


@pytest.mark.parametrize(
    ("capability", "invalid_update", "message"),
    [
        ("text", {"supports_text": False}, "文本能力"),
        ("text", {"text_model": ""}, "文本模型"),
        ("image", {"supports_image": False}, "图片能力"),
        ("image", {"image_model": ""}, "图片模型"),
    ],
)
def test_bound_provider_update_rejects_invalid_capability_without_dirtying_session(
    capability,
    invalid_update,
    message,
):
    db = make_db()
    row = create_provider(db, provider_data())
    set_binding(db, capability, row.id)
    original = {
        "name": row.name,
        "supports_text": row.supports_text,
        "text_model": row.text_model,
        "supports_image": row.supports_image,
        "image_model": row.image_model,
        "config_version": row.config_version,
    }

    with pytest.raises(ValueError, match=message):
        update_provider(
            db,
            row.id,
            {"name": "Must not persist", **invalid_update},
        )

    assert not db.dirty
    db.commit()
    db.refresh(row)
    assert {
        "name": row.name,
        "supports_text": row.supports_text,
        "text_model": row.text_model,
        "supports_image": row.supports_image,
        "image_model": row.image_model,
        "config_version": row.config_version,
    } == original
