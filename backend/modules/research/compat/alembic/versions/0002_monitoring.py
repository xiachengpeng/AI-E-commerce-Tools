"""Durable operational events, alert delivery, and worker heartbeat."""

import sqlalchemy as sa

from alembic import op

revision = "0002_monitoring"
down_revision = "0001_runtime"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "runtime_events",
        sa.Column("seq", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("event_key", sa.Text(), nullable=False, unique=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("recoveries", sa.Integer(), nullable=False),
        sa.Column("captcha", sa.Boolean(), nullable=False),
        sa.Column("schema_failure", sa.Boolean(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_runtime_events_created_at", "runtime_events", ["created_at"])
    op.create_table(
        "runtime_alerts",
        sa.Column("alert_key", sa.Text(), primary_key=True),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("occurrence_count", sa.Integer(), nullable=False),
        sa.Column("sent_count", sa.Integer(), nullable=False),
        sa.Column("event_fingerprint", sa.Text(), nullable=False),
    )
    op.create_table(
        "runtime_health",
        sa.Column("component", sa.Text(), primary_key=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("runtime_health")
    op.drop_table("runtime_alerts")
    op.drop_index("ix_runtime_events_created_at", table_name="runtime_events")
    op.drop_table("runtime_events")
