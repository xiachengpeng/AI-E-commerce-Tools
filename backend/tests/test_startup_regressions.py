import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


BACKEND_DIR = Path(__file__).resolve().parents[1]


def _isolated_backend(tmp_path: Path) -> Path:
    target = tmp_path / "backend"
    shutil.copytree(
        BACKEND_DIR,
        target,
        ignore=shutil.ignore_patterns(
            ".env",
            "history.db",
            "__pycache__",
            "static",
            "tests",
        ),
    )
    return target


def _startup_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.update(
        {
            "AI_PROVIDER": "gemini",
            "GEMINI_API_KEY": "",
            "GEMINI_MODEL_ID": "",
            "FRONTEND_TEXT_MODEL": "",
            "FRONTEND_IMAGE_MODEL": "",
            "VERTEX_PROJECT_ID": "",
            "VERTEX_LOCATION": "",
            "VERTEX_KEY_PATH": "",
        }
    )
    return env


def test_config_import_does_not_require_legacy_gemini_key(tmp_path):
    backend = _isolated_backend(tmp_path)

    result = subprocess.run(
        [sys.executable, "-c", "import config; print('CONFIG_OK')"],
        cwd=backend,
        env=_startup_env(),
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "CONFIG_OK"


def test_backend_avoids_python_311_datetime_utc_alias():
    forbidden = "datetime" + "." + "UTC"
    offenders = []
    for path in BACKEND_DIR.rglob("*.py"):
        if forbidden in path.read_text(encoding="utf-8"):
            offenders.append(str(path.relative_to(BACKEND_DIR)))

    assert offenders == []


def test_ai_settings_migration_adds_last_test_capability_to_legacy_table(
    monkeypatch,
    tmp_path,
):
    import db as db_module
    from sqlalchemy import create_engine, inspect, text

    legacy_engine = create_engine(
        f"sqlite:///{tmp_path / 'legacy-settings.db'}"
    )
    with legacy_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE ai_provider_configs ("
                "id INTEGER PRIMARY KEY, "
                "name VARCHAR(120) NOT NULL UNIQUE"
                ")"
            )
        )
    monkeypatch.setattr(db_module, "engine", legacy_engine)

    db_module.migrate_ai_settings_tables()

    columns = {
        column["name"]
        for column in inspect(legacy_engine).get_columns(
            "ai_provider_configs"
        )
    }
    assert "last_test_capability" in columns


def test_ai_settings_migration_adds_image_generation_mode_idempotently(
    monkeypatch,
    tmp_path,
):
    import db as db_module
    from sqlalchemy import create_engine, inspect, text

    legacy_engine = create_engine(
        f"sqlite:///{tmp_path / 'legacy-image-mode.db'}"
    )
    with legacy_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE ai_provider_configs ("
                "id INTEGER PRIMARY KEY, "
                "name VARCHAR(120) NOT NULL UNIQUE"
                ")"
            )
        )
        connection.execute(
            text(
                "INSERT INTO ai_provider_configs (id, name) "
                "VALUES (1, 'legacy relay')"
            )
        )
    monkeypatch.setattr(db_module, "engine", legacy_engine)

    db_module.migrate_ai_settings_tables()
    db_module.migrate_ai_settings_tables()

    columns = {
        column["name"]
        for column in inspect(legacy_engine).get_columns(
            "ai_provider_configs"
        )
    }
    assert "image_generation_mode" in columns
    with legacy_engine.connect() as connection:
        mode = connection.execute(
            text(
                "SELECT image_generation_mode "
                "FROM ai_provider_configs WHERE id = 1"
            )
        ).scalar_one()
    assert mode == "image_to_image"


def test_ai_settings_migration_backfills_unique_provider_incarnations(
    monkeypatch,
    tmp_path,
):
    import uuid

    import db as db_module
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.exc import IntegrityError

    legacy_engine = create_engine(
        f"sqlite:///{tmp_path / 'legacy-incarnations.db'}"
    )
    with legacy_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE ai_provider_configs ("
                "id INTEGER PRIMARY KEY, "
                "name VARCHAR(120) NOT NULL UNIQUE"
                ")"
            )
        )
        connection.execute(
            text(
                "INSERT INTO ai_provider_configs (id, name) "
                "VALUES (1, 'first'), (2, 'second')"
            )
        )
    monkeypatch.setattr(db_module, "engine", legacy_engine)

    db_module.migrate_ai_settings_tables()
    columns = {
        column["name"]
        for column in inspect(legacy_engine).get_columns(
            "ai_provider_configs"
        )
    }
    assert "incarnation_id" in columns

    with legacy_engine.connect() as connection:
        first_values = connection.execute(
            text(
                "SELECT incarnation_id FROM ai_provider_configs "
                "ORDER BY id"
            )
        ).scalars().all()

    assert len(set(first_values)) == 2
    assert all(uuid.UUID(value).version == 4 for value in first_values)

    db_module.migrate_ai_settings_tables()
    with legacy_engine.connect() as connection:
        second_values = connection.execute(
            text(
                "SELECT incarnation_id FROM ai_provider_configs "
                "ORDER BY id"
            )
        ).scalars().all()
    assert second_values == first_values

    with pytest.raises(IntegrityError):
        with legacy_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE ai_provider_configs "
                    "SET incarnation_id = :duplicate WHERE id = 2"
                ),
                {"duplicate": first_values[0]},
            )


def test_existing_sqlite_vertex_configuration_starts_without_gemini_key(
    tmp_path,
):
    backend = _isolated_backend(tmp_path)
    script = """
import json
import db

db.init_db()
session = db.SessionLocal()
provider = db.AIProviderConfig(
    name="Existing Vertex",
    protocol="vertex",
    vertex_project_id="project-id",
    vertex_location="us-central1",
    text_model="text-model",
    image_model="image-model",
    supports_text=True,
    supports_image=True,
    enabled=True,
)
session.add(provider)
session.flush()
session.add_all([
    db.AICapabilityBinding(capability="text", provider_config_id=provider.id),
    db.AICapabilityBinding(capability="image", provider_config_id=provider.id),
])
session.commit()
session.close()

import main
session = db.SessionLocal()
print(json.dumps({
    "providers": session.query(db.AIProviderConfig).count(),
    "text": main.get_public_route(session, "text"),
    "image": main.get_public_route(session, "image"),
}))
session.close()
"""

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=backend,
        env=_startup_env(),
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout.strip().splitlines()[-1])
    assert data["providers"] == 1
    assert data["text"]["name"] == "Existing Vertex"
    assert data["image"]["name"] == "Existing Vertex"


def test_completely_unconfigured_app_starts_with_repairable_routes(tmp_path):
    backend = _isolated_backend(tmp_path)
    script = """
import json
import main
import db

session = db.SessionLocal()
print(json.dumps({
    "providers": session.query(db.AIProviderConfig).count(),
    "text": main.get_public_route(session, "text"),
    "image": main.get_public_route(session, "image"),
}))
session.close()
"""

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=backend,
        env=_startup_env(),
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout.strip().splitlines()[-1])
    assert data == {
        "providers": 0,
        "text": {
            "capability": "text",
            "name": None,
            "protocol": None,
            "model": None,
        },
        "image": {
            "capability": "image",
            "name": None,
            "protocol": None,
            "model": None,
        },
    }
