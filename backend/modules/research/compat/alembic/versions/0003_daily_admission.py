"""Atomic manual admission and estimated cost accounting, by market and UTC day."""

import sqlalchemy as sa

from alembic import op

revision = "0003_daily_admission"
down_revision = "0002_monitoring"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "daily_usage",
        sa.Column("market", sa.Text(), primary_key=True),
        sa.Column("day", sa.Date(), primary_key=True),
        *[
            sa.Column(name, sa.Integer(), nullable=False, server_default="0")
            for name in (
                "scans",
                "keywords",
                "candidates",
                "discovered_candidates",
                "estimated_ai_calls",
            )
        ],
        sa.Column(
            "estimated_cost_usd", sa.Numeric(14, 6), nullable=False, server_default="0"
        ),
    )


def downgrade():
    op.drop_table("daily_usage")
