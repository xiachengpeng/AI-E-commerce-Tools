"""Explicit additive preparation of a backed-up candidate, never live startup.

Programmatic callers assert backup_verified with an exact bool. The CLI additionally
checks a private operator report's independent manifest anchor and restored DB.
That local report is an operator trust boundary, not cryptographic authentication.
"""
import argparse
import json
import os
import stat
import sys
from importlib import import_module
from pathlib import Path

from sqlalchemy import create_engine, inspect

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))
from db import enable_sqlite_foreign_keys
from models.full_merge import full_merge_schema, metadata, validate_prepared_schema


def research_metadata():
    source = str(_BACKEND / 'modules' / 'research')
    if source not in sys.path:
        sys.path.insert(0, source)
    for name in ('application.actions', 'application.sync', 'monitoring',
                 'integrations.provider_jobs', 'persistence.projects'):
        import_module('rabbit_hole.' + name)
    return import_module('rabbit_hole.persistence.database').metadata


def _regular_absolute(path: Path, *, private: bool = False) -> Path:
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('absolute regular non-symlink path required')
    info = path.stat() if path.exists() else None
    if info is None or not stat.S_ISREG(info.st_mode):
        raise ValueError('existing regular file required')
    if private and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        raise ValueError('private operator report required')
    return path


def prepare_schema(database: Path, *, backup_verified: bool) -> dict:
    if backup_verified is not True:
        raise ValueError('verified backup is required')
    database = _regular_absolute(database)
    source = research_metadata()
    engine = create_engine(f'sqlite:///{database}', connect_args={'timeout': 30})
    enable_sqlite_foreign_keys(engine)
    try:
        with engine.connect() as c:
            # Explicit BEGIN makes SQLite DDL part of the same rollbackable transaction.
            c.exec_driver_sql('BEGIN IMMEDIATE')
            try:
                tables = set(inspect(c).get_table_names())
                if 'full_merge_schema' in tables:
                    # Reject malformed markers before checking the baseline structures.
                    rows = c.exec_driver_sql('SELECT id,revision FROM full_merge_schema').fetchall()
                    if len(rows) != 1 or rows[0][0] != 1 or type(rows[0][1]) is not int or rows[0][1] not in {1, 2, 3}:
                        raise ValueError('unknown full merge revision')
                    revision = validate_prepared_schema(c, source)
                else:
                    if set(source.tables).intersection(tables) or 'full_merge_ledger' in tables:
                        raise ValueError('unversioned partial research schema')
                    source.create_all(c)
                    metadata.create_all(c)
                    c.execute(full_merge_schema.insert().values(id=1, revision=1))
                    revision = 1
                c.commit()
            except BaseException:
                c.rollback()
                raise
        return {'revision': revision, 'research_tables': sorted(source.tables), 'prepared': True}
    finally:
        engine.dispose()


def verify_backup_report(database: Path, report_path: Path) -> None:
    from scripts.full_merge.backup import database_stats
    from scripts.full_merge.verify import verify_snapshot
    report_path = _regular_absolute(report_path, private=True)
    try:
        report = json.loads(report_path.read_text())
        if type(report.get('version')) is not int or report['version'] != 1:
            raise ValueError('invalid report version')
        for gate in ('verified', 'integrity_verified', 'completeness_verified', 'restore_verified'):
            if report.get(gate) is not True:
                raise ValueError('backup verification gates missing')
        directory = Path(report['snapshot_directory'])
        if not directory.is_absolute() or '..' in directory.parts or any(p.is_symlink() for p in (directory, *directory.parents)):
            raise ValueError('invalid snapshot directory')
        digest = report['manifest_sha256']
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('invalid manifest anchor')
        checked = verify_snapshot(directory, expected_digest=digest)
        if any(checked.get(gate) is not True for gate in ('verified', 'integrity_verified', 'completeness_verified')):
            raise ValueError('snapshot reverification failed')
        manifest = json.loads((directory / 'manifest.json').read_text())
        candidate = database_stats(_regular_absolute(database))
        matches = [entry for entry in manifest['databases'] if entry.get('verified') is True and entry.get('stats') == candidate]
        if len(matches) != 1:
            raise ValueError('candidate must match exactly one restored snapshot database')
    except (OSError, KeyError, TypeError, AttributeError) as exc:
        raise ValueError('invalid backup report') from exc


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--prepare-schema', required=True, action='store_true')
    parser.add_argument('--backup-report', required=True, type=Path)
    args = parser.parse_args()
    try:
        verify_backup_report(args.database, args.backup_report)
        print(json.dumps(prepare_schema(args.database, backup_verified=True), sort_keys=True))
    except (ValueError, OSError):
        parser.error('candidate preparation refused: invalid candidate or verified backup report')


if __name__ == '__main__':
    main()
