"""One explicit SQLite configuration store. No environment, file vault or probes."""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
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
            or purpose.endswith('__profiles')
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
            "secret_previews": {k: (str(v)[:3] + "••••••" + str(v)[-3:] if len(str(v)) > 10 else "••••••••") for k, v in value.items() if k in SECRETS and v},
        }

    @staticmethod
    def _row(db, provider, purpose):
        row = db.execute("SELECT value,version FROM integration_settings WHERE provider=? AND purpose=?", (provider, purpose)).fetchone()
        return (json.loads(row[0]), row[1]) if row else ({}, 0)

    @staticmethod
    def _write(db, provider, purpose, value, version):
        db.execute("INSERT INTO integration_settings(provider,purpose,value,version) VALUES(?,?,?,?) ON CONFLICT(provider,purpose) DO UPDATE SET value=excluded.value,version=excluded.version", (provider, purpose, json.dumps(value), version))

    def _catalog(self, db, provider, purpose):
        value, version = self._row(db, provider, purpose)
        catalog, _ = self._row(db, provider, purpose + "__profiles")
        if not catalog:
            catalog = {"active": "default", "profiles": {"default": {"name": "原有配置", "fields": value, "version": version}}}
        else:
            # Older binaries know only the flat active row. Keep that row the
            # authority after rollback/upgrade; reading never writes a migration.
            active = catalog['profiles'][catalog['active']]
            if active['fields'] != value:
                active.update(fields=value, version=max(active['version'] + 1, version))
        return catalog, version

    def _view(self, db, provider, purpose, profile_id=None):
        catalog, active_version = self._catalog(db, provider, purpose)
        selected = profile_id or catalog["active"]
        if selected not in catalog["profiles"]:
            raise ValueError("unknown integration profile")
        profile = catalog["profiles"][selected]
        result = self._public(provider, purpose, profile["fields"], profile["version"])
        result.update(profile_id=selected, profile_version=profile['version'], active_profile_id=catalog["active"], active_version=active_version, name=profile["name"], profiles=[{"id": key, "name": item["name"], "configured": all(bool(item["fields"].get(k)) for k in FIELDS[provider] - {"daily_limit"})} for key, item in catalog["profiles"].items()])
        # Keep the old endpoint's version as the active credential revision.
        if profile_id is None:
            result["version"] = active_version
            result["profile_version"] = profile["version"]
        return result

    def public(self, provider: str, purpose: str) -> dict:
        self.validate(provider, purpose)
        with self.connection() as db:
            db.execute("BEGIN")
            return self._view(db, provider, purpose)

    def profile(self, provider: str, purpose: str, profile_id: str) -> dict:
        self._validate_profile_request(provider, purpose, profile_id)
        with self.connection() as db:
            db.execute("BEGIN")
            return self._view(db, provider, purpose, profile_id)

    def _validate_profile_request(self, provider, purpose, profile_id="default"):
        self.validate(provider, purpose)
        if purpose != "research" or not isinstance(profile_id, str) or not re.fullmatch(r"default|[a-f0-9]{32}", profile_id):
            raise ValueError("invalid integration profile")

    @staticmethod
    def _name(name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or any(ord(c) < 32 for c in name):
            raise ValueError("invalid profile name")
        return name.strip()

    def _validated_changes(self, provider, changes, *, allow_empty=False):
        if not isinstance(changes, dict) or (not changes and not allow_empty) or set(changes) - FIELDS[provider]:
            raise ValueError("invalid integration fields")
        for name, value in changes.items():
            if name == "daily_limit":
                if type(value) is not int or not 1 <= value <= 1000000:
                    raise ValueError("invalid integration daily limit")
            elif value is not None and (not isinstance(value, str) or len(value) > 512 or any(c.isspace() for c in value)):
                raise ValueError("invalid integration field value")
            elif isinstance(value, str) and "•" in value:
                raise ValueError("masked values cannot be saved")

    @staticmethod
    def _merge(data, changes):
        result = dict(data)
        for name, value in changes.items():
            if value is None:
                result.pop(name, None)
            elif value:
                result[name] = value
        return result

    def create_profile(self, provider, purpose, name, changes):
        self._validate_profile_request(provider, purpose)
        name = self._name(name)
        self._validated_changes(provider, changes, allow_empty=True)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            catalog, version = self._catalog(db, provider, purpose)
            if len(catalog["profiles"]) >= 20:
                raise ValueError("profile limit reached")
            if any(p["name"] == name for p in catalog["profiles"].values()):
                raise ValueError("duplicate profile name")
            identity = uuid.uuid4().hex
            catalog["profiles"][identity] = {"name": name, "fields": self._merge({}, changes), "version": 1}
            self._write(db, provider, purpose + "__profiles", catalog, 1)
            result = self._view(db, provider, purpose, identity)
            db.commit()
            return result

    def update_profile(self, provider, purpose, profile_id, name, changes, *, expected_version):
        self._validate_profile_request(provider, purpose, profile_id)
        name = self._name(name)
        self._validated_changes(provider, changes, allow_empty=True)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            catalog, version = self._catalog(db, provider, purpose)
            item = catalog["profiles"].get(profile_id)
            if not item or type(expected_version) is not int or item["version"] != expected_version:
                raise ValueError("stale integration profile")
            if any(k != profile_id and p["name"] == name for k, p in catalog["profiles"].items()):
                raise ValueError("duplicate profile name")
            item.update(name=name, fields=self._merge(item["fields"], changes), version=item["version"] + 1)
            if profile_id == catalog["active"]:
                self._write(db, provider, purpose, item["fields"], version + 1)
            self._write(db, provider, purpose + "__profiles", catalog, 1)
            result = self._view(db, provider, purpose, profile_id)
            db.commit()
            return result

    def activate_profile(self, provider, purpose, profile_id, *, expected_version, profile_version=None):
        self._validate_profile_request(provider, purpose, profile_id)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            catalog, version = self._catalog(db, provider, purpose)
            item = catalog["profiles"].get(profile_id)
            if not item or type(expected_version) is not int or version != expected_version or (profile_version is not None and item["version"] != profile_version):
                raise ValueError("stale integration profile")
            if not all(item["fields"].get(k) for k in FIELDS[provider] - {"daily_limit"}):
                raise ValueError("incomplete profile")
            if "daily_limit" in FIELDS[provider] and type(item["fields"].get("daily_limit")) is not int:
                raise ValueError("invalid integration daily limit")
            if profile_id != catalog["active"]:
                catalog["active"] = profile_id
                self._write(db, provider, purpose, item["fields"], version + 1)
                self._write(db, provider, purpose + "__profiles", catalog, 1)
            result = self._view(db, provider, purpose)
            db.commit()
            return result

    def reveal(self, provider, purpose, profile_id, field, *, expected_version):
        self._validate_profile_request(provider, purpose, profile_id)
        if field not in FIELDS[provider] or field not in SECRETS:
            raise ValueError("invalid secret field")
        with self.connection() as db:
            catalog, _ = self._catalog(db, provider, purpose)
            item = catalog["profiles"].get(profile_id)
            if not item or type(expected_version) is not int or item["version"] != expected_version:
                raise ValueError("stale integration profile")
            return {"value": item["fields"].get(field, "")}

    def profile_credentials(self, provider, purpose, profile_id, *, expected_version):
        """Private server-only snapshot used by explicit account probes."""
        self._validate_profile_request(provider, purpose, profile_id)
        with self.connection() as db:
            catalog, _ = self._catalog(db, provider, purpose)
            item = catalog["profiles"].get(profile_id)
            if not item or type(expected_version) is not int or item["version"] != expected_version:
                raise ValueError('stale integration profile')
            return dict(item['fields'])

    def update(self, provider: str, purpose: str, changes: dict) -> dict:
        self.validate(provider, purpose)
        self._validated_changes(provider, changes)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute(
                    "SELECT value,version FROM integration_settings WHERE provider=? AND purpose=?",
                    (provider, purpose),
                ).fetchone()
                data = self._merge(json.loads(row[0]) if row else {}, changes)
                version = row[1] + 1 if row else 1
                catalog, _ = self._row(db, provider, purpose + "__profiles")
                if catalog:
                    item = catalog["profiles"][catalog["active"]]
                    item.update(fields=data, version=item["version"] + 1)
                    self._write(db, provider, purpose + "__profiles", catalog, 1)
                self._write(db, provider, purpose, data, version)
                db.commit()
            except BaseException:
                db.rollback()
                raise
            return self._view(db, provider, purpose)


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
