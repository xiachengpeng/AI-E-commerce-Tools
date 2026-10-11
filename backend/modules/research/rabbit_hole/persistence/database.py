from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import (
    JSON,
    Column,
    Date,
    Integer,
    MetaData,
    Numeric,
    SmallInteger,
    Table,
    Text,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
)

from rabbit_hole.config import Settings
from rabbit_hole.persistence.sql import UTCDateTime

metadata = MetaData()
json_type = JSON().with_variant(JSONB, "postgresql")

daily_usage = Table(
    "daily_usage",
    metadata,
    Column("market", Text, primary_key=True),
    Column("day", Date, primary_key=True),
    Column("scans", Integer, nullable=False, server_default="0"),
    Column("keywords", Integer, nullable=False, server_default="0"),
    Column("candidates", Integer, nullable=False, server_default="0"),
    Column("discovered_candidates", Integer, nullable=False, server_default="0"),
    Column("estimated_ai_calls", Integer, nullable=False, server_default="0"),
    Column("estimated_cost_usd", Numeric(14, 6), nullable=False, server_default="0"),
)

runtime_jobs = Table(
    "runtime_jobs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("idempotency_key", Text, nullable=False, unique=True),
    Column("kind", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("payload", json_type, nullable=False),
    Column("attempt", SmallInteger, nullable=False, default=0),
    Column("available_at", UTCDateTime(), nullable=False),
    Column("lease_until", UTCDateTime()),
    Column("leased_by", Text),
    Column("lease_token", Uuid),
    Column("failure_code", Text),
    Column("failure_detail", Text),
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
)

job_checkpoints = Table(
    "job_checkpoints",
    metadata,
    Column("job_id", Uuid, primary_key=True),
    Column("stage", Text, primary_key=True),
    Column("data", json_type, nullable=False),
    Column("created_at", UTCDateTime(), nullable=False),
)

collector_cache = Table(
    "collector_cache",
    metadata,
    Column("cache_key", Text, primary_key=True),
    Column("value", json_type, nullable=False),
    Column("content_hash", Text, nullable=False),
    Column("expires_at", UTCDateTime(), nullable=False),
    Column("created_at", UTCDateTime(), nullable=False),
)

feishu_outbox = Table(
    "feishu_outbox",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("record_id", Text, nullable=False),
    Column("record_version", Text, nullable=False),
    Column("payload", json_type, nullable=False),
    Column("status", Text, nullable=False),
    Column("attempt", SmallInteger, nullable=False, default=0),
    Column("available_at", UTCDateTime(), nullable=False),
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
)


def create_database_engine(settings: Settings) -> AsyncEngine:
    from rabbit_hole.persistence.sql import create_engine
    return create_engine(settings.database_url)


def create_session_factory(settings: Settings) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(create_database_engine(settings), expire_on_commit=False)


@asynccontextmanager
async def session_scope(
    sessions: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    async with sessions() as session, session.begin():
        yield session
