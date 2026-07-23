import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


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
