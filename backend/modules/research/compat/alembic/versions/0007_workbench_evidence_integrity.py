"""Add the stable evidence action pagination index."""

from alembic import op

revision = "0007_workbench_evidence_integrity"
down_revision = "0006_workbench_recovery"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)")
    op.execute(
        "CREATE INDEX ix_workbench_actions_project_created_id "
        "ON workbench_actions (project_id, created_at DESC, id DESC)"
    )


def downgrade():
    op.execute("DROP INDEX ix_workbench_actions_project_created_id")
