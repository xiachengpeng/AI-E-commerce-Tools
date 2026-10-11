"""Durable append-only Feishu snapshot requests."""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0005_workbench_sync"
down_revision = "0004_business_workbench"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "workbench_sync_runs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("target", sa.Text(), nullable=False),
        sa.Column("digest", sa.Text(), nullable=False),
        sa.Column("snapshot", JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("checkpoint", JSONB(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "project_id", "version", "target", name="uq_workbench_sync_version"
        ),
    )


def downgrade():
    op.drop_table("workbench_sync_runs")
