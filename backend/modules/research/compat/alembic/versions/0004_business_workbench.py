"""Persistent business workbench aggregates, events, and runner actions."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0004_business_workbench"
down_revision = "0003_daily_admission"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "workbench_projects",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("market", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("state", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("create_command_id", sa.Text(), nullable=False, unique=True),
        sa.Column("create_digest", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "workbench_events",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("workbench_projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("command_id", sa.Text(), nullable=False),
        sa.Column("digest", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "project_id", "command_id", name="uq_workbench_event_project_command"
        ),
    )
    op.create_index(
        "ix_workbench_events_project_created",
        "workbench_events",
        ["project_id", "created_at"],
    )
    op.create_table(
        "workbench_actions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("keyword_id", sa.Text(), nullable=True),
        sa.Column("product_id", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="ready"),
        sa.Column("input_version", sa.Integer(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("dedupe_key", sa.Text(), nullable=False, unique=True),
    )
    op.create_index(
        "ix_workbench_actions_status_created",
        "workbench_actions",
        ["status", "created_at"],
    )
    op.create_index("ix_workbench_actions_project", "workbench_actions", ["project_id"])


def downgrade():
    op.drop_index("ix_workbench_actions_project", table_name="workbench_actions")
    op.drop_index("ix_workbench_actions_status_created", table_name="workbench_actions")
    op.drop_table("workbench_actions")
    op.drop_index("ix_workbench_events_project_created", table_name="workbench_events")
    op.drop_table("workbench_events")
    op.drop_table("workbench_projects")
