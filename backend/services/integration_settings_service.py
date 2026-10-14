"""One explicit SQLite configuration store. No environment, file vault or probes."""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote

FIELDS = {
    "apify": frozenset({"api_key", "daily_limit"}),
    "serpapi": frozenset({"api_key", "daily_limit"}),
    "firecrawl": frozenset({"api_key", "daily_limit"}),
    "aliyun": frozenset({"access_key_id", "access_key_secret"}),
    "feishu": frozenset({"app_id", "app_secret", "base_app_token"}),
}
SECRETS = frozenset(
    {"api_key", "access_key_id", "access_key_secret", "app_secret", "base_app_token"}
)


class IntegrationSettingsService:
    def __init__(self, database: Path) -> None:
        self.database = Path(database)
        if not self.database.is_absolute() or ".." in self.database.parts:
            raise ValueError("integration database must be absolute")

    @contextmanager
    def connection(self):
        if not self.database.is_file() or any(
            p.is_symlink() for p in (self.database, *self.database.parents)
        ):
            raise ValueError("integration schema unprepared")
        db = sqlite3.connect(
            "file:" + quote(str(self.database), safe="/") + "?mode=rw",
            uri=True,
            timeout=30,
        )
        try:
            db.execute("PRAGMA foreign_keys=ON")
            revision = db.execute(
                "SELECT id,revision FROM full_merge_schema"
            ).fetchall()
            if (
                len(revision) != 1
                or revision[0][0] != 1
                or revision[0][1] not in (2, 3, 4)
            ):
                raise ValueError("integration schema unprepared")
            from models.full_merge import validate_prepared_schema
            from models.integration_settings import metadata
            from sqlalchemy import MetaData, create_engine

            # Inspect the actual schema with the shared minimum-structure validator.
            engine = create_engine("sqlite://", creator=lambda: db)
            try:
                with engine.connect() as connection:
                    from sqlalchemy.exc import SQLAlchemyError

                    try:
                        validate_prepared_schema(
                            connection, MetaData(), additional_metadata=metadata
                        )
                    except (ValueError, SQLAlchemyError):
                        raise ValueError("integration schema unprepared") from None
                    yield db
            finally:
                engine.dispose()
        except sqlite3.DatabaseError:
            raise ValueError("integration schema unprepared") from None
        finally:
            db.close()

    @staticmethod
    def validate(provider: str, purpose: str) -> None:
        if (
            provider not in FIELDS
            or not isinstance(purpose, str)
            or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", purpose)
        ):
            raise ValueError("invalid integration provider or purpose")

    def resolve(self, provider: str, purpose: str) -> dict[str, Any]:
        self.validate(provider, purpose)
        with self.connection() as db:
            row = db.execute(
                "SELECT value FROM integration_settings WHERE provider=? AND purpose=?",
                (provider, purpose),
            ).fetchone()
            return json.loads(row[0]) if row else {}

    @staticmethod
    def _public(provider: str, purpose: str, value: dict, version: int) -> dict:
        fields = {
            k: ("••••••••" if k in SECRETS and v else v) for k, v in value.items()
        }
        return {
            "provider": provider,
            "purpose": purpose,
            "version": version,
            "configured": all(
                bool(value.get(k)) for k in FIELDS[provider] - {"daily_limit"}
            ),
            "fields": fields,
        }

    def public(self, provider: str, purpose: str) -> dict:
        self.validate(provider, purpose)
        with self.connection() as db:
            row = db.execute(
                "SELECT value,version FROM integration_settings WHERE provider=? AND purpose=?",
                (provider, purpose),
            ).fetchone()
            return self._public(
                provider,
                purpose,
                json.loads(row[0]) if row else {},
                row[1] if row else 0,
            )

    def update(self, provider: str, purpose: str, changes: dict) -> dict:
        self.validate(provider, purpose)
        if (
            not isinstance(changes, dict)
            or not changes
            or set(changes) - FIELDS[provider]
        ):
            raise ValueError("invalid integration fields")
        for name, value in changes.items():
            if name == "daily_limit":
                if type(value) is not int or not 1 <= value <= 1000000:
                    raise ValueError("invalid integration daily limit")
                continue
            if value is not None and (
                not isinstance(value, str)
                or len(value) > 512
                or any(c.isspace() for c in value)
            ):
                raise ValueError("invalid integration field value")
            if value == "••••••••":
                raise ValueError("masked values cannot be saved")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute(
                    "SELECT value,version FROM integration_settings WHERE provider=? AND purpose=?",
                    (provider, purpose),
                ).fetchone()
                data = json.loads(row[0]) if row else {}
                for name, value in changes.items():
                    if value is None:
                        data.pop(name, None)
                    elif value:
                        data[name] = value
                version = row[1] + 1 if row else 1
                db.execute(
                    "INSERT INTO integration_settings(provider,purpose,value,version) VALUES(?,?,?,?) ON CONFLICT(provider,purpose) DO UPDATE SET value=excluded.value,version=excluded.version",
                    (provider, purpose, json.dumps(data), version),
                )
                db.commit()
            except BaseException:
                db.rollback()
                raise
            return self._public(provider, purpose, data, version)


class ResearchProviderSettings:
    """Original masked/status DTO backed by unified research-purpose settings."""

    def __init__(
        self, store: IntegrationSettingsService, purpose: str = "research"
    ) -> None:
        self.store, self.purpose = store, purpose

    def get(self, provider: str) -> str:
        if provider not in {"apify", "serpapi", "firecrawl"}:
            raise ValueError("invalid research provider")
        return self.store.resolve(provider, self.purpose).get("api_key", "")

    def status(self) -> dict[str, bool]:
        return {key: bool(self.get(key)) for key in ("apify", "serpapi", "firecrawl")}

    def update(self, changes: dict) -> dict[str, bool]:
        if (
            not isinstance(changes, dict)
            or not changes
            or set(changes) - {"apify", "serpapi", "firecrawl"}
        ):
            raise ValueError("invalid research provider")
        # Validate the entire request before changing any provider.
        for value in changes.values():
            if value is not None and (
                not isinstance(value, str)
                or len(value) > 512
                or any(c.isspace() for c in value)
            ):
                raise ValueError("invalid integration field value")
            if value == "••••••••":
                raise ValueError("masked values cannot be saved")
        for provider, value in changes.items():
            self.store.update(provider, self.purpose, {"api_key": value})
        return self.status()


def import_legacy_provider_fixture(
    store: IntegrationSettingsService, path: Path, *, purpose: str
) -> dict:
    """Explicit read-only fixture adapter, never a deployed fallback/migration trigger."""
    path = Path(path)
    if (
        not path.is_absolute()
        or not path.is_file()
        or path.is_symlink()
        or path.stat().st_size > 16384
    ):
        raise ValueError("invalid legacy fixture")
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or set(data) - {"apify", "serpapi", "firecrawl"}:
        raise ValueError("invalid legacy fixture")
    report = {}
    for provider, value in data.items():
        if store.resolve(provider, purpose).get("api_key"):
            report[provider] = "preserved"
        else:
            store.update(provider, purpose, {"api_key": value})
            report[provider] = "imported"
    return report
