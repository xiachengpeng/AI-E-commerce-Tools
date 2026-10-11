from __future__ import annotations

import os
import shutil

import pytest
from alembic.config import Config
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from testcontainers.postgres import PostgresContainer

from alembic import command


def postgres_connection_url() -> str | None:
    return os.getenv("RABBIT_HOLE_TEST_POSTGRES_URL") or None


@pytest.fixture(scope="session")
def postgres_url(tmp_path_factory) -> str:
    if os.getenv("RABBIT_HOLE_TEST_SQLITE") == "1":
        yield "sqlite+aiosqlite:///" + str(tmp_path_factory.mktemp("sqlite-db") / "isolated.db")
        return
    """Provide an isolated PostgreSQL database for integration tests."""
    explicit_url = postgres_connection_url()
    if explicit_url is not None:
        yield explicit_url
        return
    if shutil.which("docker") is None:
        if os.getenv("RABBIT_HOLE_SKIP_POSTGRES_TESTS") == "1":
            pytest.skip("PostgreSQL tests explicitly skipped by environment")
        pytest.fail(
            "Docker is required for PostgreSQL queue integration tests; set "
            "RABBIT_HOLE_SKIP_POSTGRES_TESTS=1 only for local static-only runs"
        )
    with PostgresContainer("postgres:16-alpine") as postgres:
        yield postgres.get_connection_url().replace(
            "postgresql+psycopg2", "postgresql+psycopg"
        )


@pytest.fixture(scope="session")
def migrated_database(postgres_url: str) -> str:
    if postgres_url.startswith("sqlite"):
        import asyncio
        from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
        async def initialize():
            engine = create_engine(postgres_url)
            await initialize_sqlite(engine)
            await engine.dispose()
        asyncio.run(initialize())
        return postgres_url
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", postgres_url)
    command.upgrade(config, "head")
    return postgres_url


@pytest.fixture
async def db_engine(migrated_database: str, tmp_path):
    from rabbit_hole.persistence.sql import create_engine
    if migrated_database.startswith('sqlite'):
        migrated_database = 'sqlite+aiosqlite:///' + str(tmp_path / 'database.db')
    engine = create_engine(migrated_database)
    if engine.dialect.name == 'sqlite':
        from rabbit_hole.persistence.sql import initialize_sqlite
        await initialize_sqlite(engine)
    from rabbit_hole.persistence.database import daily_usage

    # Multi-connection concurrency tests commit; isolate the new daily ledger
    # between tests while preserving durability within each test.
    async with engine.begin() as connection:
        await connection.execute(delete(daily_usage))
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def db_transaction(db_engine: AsyncEngine):
    """A rollback-only transaction for tests that use a single connection."""
    async with db_engine.connect() as connection:
        if db_engine.dialect.name == "sqlite":
            await connection.execution_options(local_write=True)
        transaction = await connection.begin()
        try:
            yield connection
        finally:
            await transaction.rollback()


@pytest.fixture
def clock():
    from datetime import UTC, datetime

    class FrozenClock:
        def __init__(self, current):
            self.current = current

        def now(self):
            return self.current

        def advance(self, duration):
            self.current += duration

    return FrozenClock(datetime(2026, 9, 4, 4, 0, tzinfo=UTC))


@pytest.fixture
def job_repo(db_transaction, clock):
    from rabbit_hole.persistence.legacy_jobs import JobRepository

    return JobRepository(db_transaction, clock)
