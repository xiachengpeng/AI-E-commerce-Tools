"""Add durable synchronization retry metadata without rewriting old snapshots."""

import sqlalchemy as sa

from alembic import op

revision = "0006_workbench_recovery"
down_revision = "0005_workbench_sync"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "workbench_sync_runs",
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "workbench_sync_runs", sa.Column("next_attempt_at", sa.DateTime(timezone=True))
    )
    op.add_column("workbench_sync_runs", sa.Column("error_code", sa.Text()))


def downgrade():
    op.drop_column("workbench_sync_runs", "error_code")
    op.drop_column("workbench_sync_runs", "next_attempt_at")
    op.drop_column("workbench_sync_runs", "attempt_count")
