"""Explicit preparation metadata; never registered on startup's main Base."""
from sqlalchemy import CheckConstraint, Column, DateTime, Integer, MetaData, Table, Text

metadata = MetaData()
full_merge_schema = Table(
    'full_merge_schema', metadata,
    Column('id', Integer, primary_key=True),
    Column('revision', Integer, nullable=False),
    CheckConstraint('id = 1', name='full_merge_schema_singleton'),
    CheckConstraint('revision IN (1, 2, 3)', name='full_merge_schema_known_revision'),
)
full_merge_ledger = Table(
    'full_merge_ledger', metadata,
    Column('source_snapshot_id', Text, primary_key=True),
    Column('source_snapshot_sha256', Text, nullable=False),
    Column('source_database_sha256', Text, nullable=False),
    Column('source_alembic_revision', Text, nullable=True),
    Column('cutover_state', Text, nullable=False),
    Column('captured_at', DateTime, nullable=False),
    CheckConstraint("cutover_state IN ('captured', 'verified', 'imported', 'activated', 'rolled_back')", name='full_merge_ledger_state'),
)
