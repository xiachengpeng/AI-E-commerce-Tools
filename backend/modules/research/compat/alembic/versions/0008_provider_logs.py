"""Persistent source progress and diagnostics; provider checkpoints use action payload."""
from alembic import op

revision = "0008_provider_logs"
down_revision = "0007_workbench_evidence_integrity"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE TABLE workbench_provider_logs (id BIGSERIAL PRIMARY KEY, project_id UUID NOT NULL, action_id UUID NOT NULL, attempt INTEGER NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, level TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())")
    op.execute("CREATE INDEX ix_provider_logs_project ON workbench_provider_logs(project_id,id)")


def downgrade():
    op.execute("DROP TABLE workbench_provider_logs")
