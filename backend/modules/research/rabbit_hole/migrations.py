"""Configuration shared by the Alembic migration environment and runtime."""

from __future__ import annotations

import os


def migration_database_url(configured_url: str) -> str:
    """Prefer the deployment database URL over Alembic's safe placeholder."""

    return os.getenv("RABBIT_HOLE_DATABASE_URL", configured_url)
