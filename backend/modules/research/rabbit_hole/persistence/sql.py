"""Portable transactions and same-host ownership for the local workbench."""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import DateTime, event, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator[datetime]):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("timestamps must be timezone-aware")
        utc = value.astimezone(UTC)
        return utc.replace(tzinfo=None) if dialect.name == "sqlite" else utc

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def create_engine(url: str, **options: Any) -> AsyncEngine:
    engine = create_async_engine(url, connect_args={"timeout": 30} if url.startswith("sqlite") else {}, **options)
    if engine.dialect.name == "sqlite":
        name = engine.url.database
        if name and name != ":memory:":
            database = Path(name).absolute()
            if any(part.is_symlink() for part in (database, *database.parents)):
                raise ValueError("invalid database path")
            fd = os.open(database, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            os.fchmod(fd, 0o600)
            os.close(fd)
        @event.listens_for(engine.sync_engine, "connect")
        def configure(dbapi: Any, _: Any) -> None:
            dbapi.isolation_level = None
            cursor = dbapi.cursor()
            for pragma in ("busy_timeout=30000", "foreign_keys=ON", "journal_mode=WAL", "synchronous=FULL"):
                cursor.execute("PRAGMA " + pragma)
            cursor.close()

        @event.listens_for(engine.sync_engine, "begin")
        def begin(connection: Any) -> None:
            connection.exec_driver_sql("BEGIN IMMEDIATE" if connection.get_execution_options().get("local_write") else "BEGIN")
    return engine


def dialect_insert(bind: AsyncEngine | AsyncConnection, table: Any) -> Any:
    return (sqlite_insert if bind.dialect.name == "sqlite" else pg_insert)(table)


@asynccontextmanager
async def write_transaction(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    async with engine.connect() as c:
        if engine.dialect.name == "sqlite":
            await c.execution_options(local_write=True)
        async with c.begin():
            yield c


async def transaction_lock(connection: AsyncConnection, key: str | int) -> None:
    # BEGIN IMMEDIATE already serializes SQLite read/modify/write transactions.
    if connection.dialect.name == "postgresql":
        if isinstance(key, int):
            await connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key":key})
        else:
            await connection.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key":key})


@asynccontextmanager
async def session_lock(database: AsyncEngine | AsyncConnection, key: str | int, *, wait: bool = False) -> AsyncIterator[bool]:
    """Do not hold a SQLite transaction while running HTTP or nested DB writes."""
    engine = database.engine if isinstance(database, AsyncConnection) else database
    digest = hashlib.sha256(str(key).encode()).hexdigest()
    if engine.dialect.name == "sqlite":
        name = engine.url.database
        if not name or name == ":memory:":
            raise ValueError("process ownership requires a file-backed SQLite database")
        directory = Path(name).absolute().parent / ".locks"
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink():
            raise ValueError("invalid lock directory")
        fd = os.open(directory / (digest + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        acquired = False
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                    break
                except BlockingIOError:
                    if not wait:
                        break
                    await asyncio.sleep(.05)
            yield acquired
        finally:
            if acquired:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        return
    number = key if isinstance(key, int) else int.from_bytes(hashlib.sha256(str(key).encode()).digest()[:8], "big", signed=True)
    async with engine.connect() as c:
        acquired = False
        try:
            if wait:
                await c.execute(text("SELECT pg_advisory_lock(:k)"), {"k":number})
                acquired = True
            else:
                acquired = bool(await c.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k":number}))
            await c.commit()
            yield acquired
        finally:
            if acquired and not c.invalidated:
                await c.execute(text("SELECT pg_advisory_unlock(:k)"), {"k":number})
                await c.commit()


async def initialize_sqlite(engine: AsyncEngine, *, migration: bool = False) -> None:
    if engine.dialect.name != "sqlite":
        return
    # Explicitly register every table, including the formerly raw-SQL log table.
    from importlib import import_module
    for module in ("rabbit_hole.application.actions", "rabbit_hole.application.sync", "rabbit_hole.monitoring", "rabbit_hole.integrations.provider_jobs", "rabbit_hole.persistence.projects"):
        import_module(module)
    from rabbit_hole.persistence.database import metadata
    root = Path(engine.url.database or "").absolute().parent
    if not migration and (root / ".migration-required").exists():
        import json
        try:
            report = json.loads((root / "migration-report.json").read_text())
            verified = report.get("verified") is True and set(metadata.tables).issubset(report["database"]) and all(item.get("matched") is True for item in report["database"].values()) and report["evidence"].get("matched") is True
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            verified = False
        if not verified:
            raise ValueError("storage migration is not verified")
    async with write_transaction(engine) as c:
        await c.run_sync(metadata.create_all)

@asynccontextmanager
async def command_transaction(engine: AsyncEngine, connection: AsyncConnection | None) -> AsyncIterator[AsyncConnection]:
    if connection is not None:
        if not connection.in_transaction():
            raise ValueError("command connection requires an active transaction")
        yield connection
    else:
        async with write_transaction(engine) as c:
            yield c
