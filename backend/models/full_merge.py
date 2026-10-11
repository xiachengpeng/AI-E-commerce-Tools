"""Explicit preparation metadata; never registered on startup's main Base."""
from typing import Any

from sqlalchemy import CheckConstraint, Column, DateTime, Integer, MetaData, Table, Text
from sqlalchemy.engine import Connection
from sqlalchemy.types import TypeEngine

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


def validate_prepared_schema(connection: Connection, source_metadata: MetaData) -> int:
    """Read-only baseline contract for revisions 1/2/3; additive changes are allowed.

    Later revisions retain revision1's minimum structures. Inspect columns and
    integrity properties, rather than table names or complete CREATE SQL strings.
    """
    import re

    from sqlalchemy import (
        DefaultClause,
        ForeignKeyConstraint,
        UniqueConstraint,
        inspect,
    )

    def tokens(sql: Any) -> tuple[str, ...]:
        # Preserve string values; ignore SQL whitespace, identifier quoting/case.
        sql = re.sub(r'["`\[]([A-Za-z_][A-Za-z_0-9]*)["`\]]', r'\1', str(sql))
        return tuple(t if t.startswith("'") else t.lower() for t in
                     re.findall(r"'(?:''|[^'])*'|[A-Za-z_][A-Za-z_0-9]*|\d+|[^\s]", sql))

    def affinity(column_type: TypeEngine[Any]) -> str:
        name = str(column_type.compile(dialect=connection.dialect)).upper()
        if 'INT' in name:
            return 'integer'
        if any(t in name for t in ('CHAR', 'CLOB', 'TEXT')):
            return 'text'
        if any(t in name for t in ('REAL', 'FLOA', 'DOUB')):
            return 'real'
        return 'blob' if not name or 'BLOB' in name else 'numeric'

    inspector = inspect(connection)
    required = {**source_metadata.tables, **metadata.tables}
    if not set(required).issubset(inspector.get_table_names()):
        raise ValueError('partial prepared schema: missing table')
    for name, table in required.items():
        actual = {c['name']: c for c in inspector.get_columns(name)}
        for column in table.columns:
            found = actual.get(column.name)
            if found is None or affinity(found['type']) != affinity(column.type) or (not column.nullable and found['nullable']):
                raise ValueError(f'partial prepared schema: column {name}.{column.name}')
            if isinstance(column.server_default, DefaultClause) and tokens(str(found.get('default')).strip("'")) != tokens(str(column.server_default.arg).strip("'")):
                raise ValueError(f'partial prepared schema: default {name}.{column.name}')
        primary = tuple(inspector.get_pk_constraint(name)['constrained_columns'])
        if primary != tuple(c.name for c in table.primary_key.columns):
            raise ValueError(f'partial prepared schema: primary key {name}')
        indexes = inspector.get_indexes(name)
        unique = {tuple(c['column_names']) for c in inspector.get_unique_constraints(name)}
        unique.update(tuple(str(c) for c in i['column_names']) for i in indexes if i['unique'] and None not in i['column_names'] and i.get('dialect_options', {}).get('sqlite_where') is None)
        fks = inspector.get_foreign_keys(name)
        checks = {tokens(c['sqltext']) for c in inspector.get_check_constraints(name)}
        for constraint in table.constraints:
            if isinstance(constraint, UniqueConstraint) and tuple(c.name for c in constraint.columns) not in unique:
                raise ValueError(f'partial prepared schema: unique key {name}')
            if isinstance(constraint, ForeignKeyConstraint):
                elements = list(constraint.elements)
                valid = any(tuple(f['constrained_columns']) == tuple(c.name for c in constraint.columns)
                            and f['referred_table'] == elements[0].column.table.name
                            and tuple(f['referred_columns']) == tuple(e.column.name for e in elements)
                            and (f.get('options', {}).get('ondelete') or '').upper() == (constraint.ondelete or '').upper()
                            for f in fks)
                if not valid:
                    raise ValueError(f'partial prepared schema: foreign key {name}')
            if isinstance(constraint, CheckConstraint) and tokens(constraint.sqltext) not in checks:
                raise ValueError(f'partial prepared schema: check constraint {name}')
        for index in table.indexes:
            columns = tuple(c.name for c in index.columns)
            if not any(tuple(i['column_names']) == columns and bool(i['unique']) == bool(index.unique)
                       and i.get('dialect_options', {}).get('sqlite_where') is None for i in indexes):
                raise ValueError(f'partial prepared schema: index {name}')
    rows = connection.exec_driver_sql('SELECT id,revision FROM full_merge_schema').fetchall()
    if len(rows) != 1 or rows[0][0] != 1 or type(rows[0][1]) is not int or rows[0][1] not in {1, 2, 3}:
        raise ValueError('unknown full merge revision')
    return rows[0][1]
