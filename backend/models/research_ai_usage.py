"""Revision3 explicit-only usage metadata; never main Base/startup create_all."""

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
)

metadata = MetaData()
reservations = Table(
    "research_ai_reservations",
    metadata,
    Column("id", Text, primary_key=True),
    Column("project_id", Uuid, nullable=False),
    Column("action_id", Uuid, nullable=False),
    Column("attempt", Integer, nullable=False),
    Column("operation", Text, nullable=False),
    Column("day", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("created_at", DateTime, nullable=False),
    UniqueConstraint(
        "action_id", "attempt", "operation", name="uq_research_ai_logical"
    ),
    CheckConstraint("attempt >= 1", name="research_ai_attempt_positive"),
    CheckConstraint(
        "status IN ('reserved','submitted','retrying','received','succeeded','failed','uncertain','cancelled')",
        name="research_ai_status",
    ),
    Index("ix_research_ai_project_day", "project_id", "day"),
)
network_attempts = Table(
    "research_ai_network_attempts",
    metadata,
    Column(
        "reservation_id",
        Text,
        ForeignKey("research_ai_reservations.id"),
        primary_key=True,
    ),
    Column("network_attempt", Integer, primary_key=True),
    Column("status", Text, nullable=False),
    Column("category", Text, nullable=False),
    Column("delay_ms", Integer, nullable=False),
    Column("duration_ms", Integer, nullable=False),
    Column("updated_at", DateTime, nullable=False),
    CheckConstraint("network_attempt >= 1", name="research_ai_network_positive"),
)
