"""Prepare private, verified recovery/candidate data. Never install or activate it."""
from __future__ import annotations
from contextlib import closing
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import sys

# Script invocation and module invocation share the same source-only helpers.
if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.full_merge.backup import create_snapshot, database_stats
from scripts.full_merge.collector import database_holders, file_holders
from scripts.full_merge.verify import verify_snapshot


def safe_path(value: Path) -> Path:
    value = Path(value)
    if not value.is_absolute() or any(p.is_symlink() for p in (value, *value.parents)):
        raise ValueError('Absolute, non-symlink paths required')
    return value.resolve(strict=False)


def files(root: Path) -> list[Path]:
    values = [root] if root.is_file() else sorted(root.rglob('*'))
    if any(p.is_symlink() for p in values):
        raise ValueError('Source symlinks require explicit resolution')
    return [p for p in values if p.is_file()]


def require_offline(database: Path, roots: list[Path]) -> None:
    for port in (9502, 9503):
        with socket.socket() as connection:
            connection.settimeout(.3)
            if connection.connect_ex(('127.0.0.1', port)) == 0:
                raise ValueError('Stop browser and desktop services before preparation')
    if database_holders([database]) or file_holders([p for root in roots for p in files(root)]):
        raise ValueError('Source files still have owners')


def inventory(root: Path) -> dict:
    return {p.relative_to(root).as_posix(): {'bytes': p.stat().st_size,
             'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files(root)}


def source_fingerprint(database: Path, roots: list[Path], configs: dict) -> str:
    result = {'database': database_stats(database), 'roots': [inventory(root) for root in roots],
              'configs': {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in configs.items()}}
    return hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()


def write_new(path: Path, value) -> None:
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    path.chmod(0o600)


def prepare_candidate(source_database: Path, source_static: Path, target: Path, *,
                      config_files=None, research_root: Path | None = None,
                      offline_check=require_offline) -> dict:
    source_database, source_static, target = map(safe_path, (source_database, source_static, target))
    if target.exists():
        raise FileExistsError('Candidate destination already exists')
    if not source_database.is_file() or not source_static.is_dir():
        raise ValueError('Source database/assets unavailable')
    config_files = config_files or {}
    if not set(config_files) <= {'.env', 'research.json'}:
        raise ValueError('Unsupported configuration role')
    configs = {name: safe_path(Path(path)) for name, path in config_files.items()}
    roots = [source_static]
    if research_root is not None:
        research_root = safe_path(research_root)
        if not research_root.is_dir():
            raise ValueError('Research evidence root unavailable')
        roots.append(research_root)
    # Integrated research rows cannot be backed up as a DB-only migration.
    with closing(sqlite3.connect(source_database.as_uri() + '?mode=ro', uri=True)) as connection:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='full_merge_ledger'").fetchone():
            if connection.execute('SELECT 1 FROM full_merge_ledger LIMIT 1').fetchone() and research_root is None:
                raise ValueError('Research private root is required for this dataset')
    for source in [source_database, *roots, *configs.values()]:
        if target == source or source in target.parents or target in source.parents:
            raise ValueError('Candidate and source paths must be disjoint')
        files(source)
    offline_check(source_database, [*roots, *configs.values()])
    original_fingerprint = source_fingerprint(source_database, roots, configs)
    old_mask = os.umask(0o077)
    try:
        target.mkdir(mode=0o700, parents=True, exist_ok=False)
        snapshot = target / 'backup'
        create_snapshot(snapshot, databases=[source_database], object_roots=roots,
                        key_files=list(configs.values()))
        digest = hashlib.sha256((snapshot / 'manifest.json').read_bytes()).hexdigest()
        backup_result = verify_snapshot(snapshot, expected_digest=digest)
        if not backup_result['verified'] or not backup_result['completeness_verified']:
            raise ValueError('Recovery verification failed')
        candidate = target / 'candidate'
        candidate.mkdir(mode=0o700)
        shutil.copyfile(snapshot / 'databases/0.db', candidate / 'history.db')
        if (snapshot / 'objects/0').is_dir():
            shutil.copytree(snapshot / 'objects/0', candidate / 'static')
        else:
            (candidate / 'static').mkdir(mode=0o700)
        for index, name in enumerate(configs):
            if name == '.env':
                shutil.copyfile(snapshot / f'keys/{index}/key', candidate / name)
        # A verified candidate is never authority to resume writes or paid jobs.
        write_new(candidate / 'research.json', {'enabled': False, 'worker_mode': 'paused'})
        for p in candidate.rglob('*'):
            p.chmod(0o700 if p.is_dir() else 0o600)
        stats = database_stats(candidate / 'history.db')
        if stats != database_stats(snapshot / 'databases/0.db'):
            raise ValueError('Candidate database mismatch')
        offline_check(source_database, [*roots, *configs.values()])
        if source_fingerprint(source_database, roots, configs) != original_fingerprint:
            raise ValueError('Sources changed after backup')
        report = {'version': 1, 'status': 'candidate_verified', 'execution_allowed': False,
                  'backup_manifest_sha256': digest, 'files': inventory(candidate),
                  'database_stats': stats, 'research_private_backed_up': research_root is not None,
                  'requires_explicit_cutover': True, 'source_fingerprint_sha256': original_fingerprint}
        write_new(target / 'candidate-report.json', report)
        verify_candidate(target)
        return report
    finally:
        os.umask(old_mask)


def verify_candidate(target: Path) -> dict:
    target = safe_path(target)
    report = json.loads((target / 'candidate-report.json').read_text())
    if report.get('version') != 1 or report.get('execution_allowed') is not False:
        raise ValueError('Invalid candidate report')
    backup = verify_snapshot(target / 'backup', expected_digest=report['backup_manifest_sha256'])
    if not backup['verified'] or not backup['completeness_verified']:
        raise ValueError('Recovery copy changed')
    candidate = target / 'candidate'
    if inventory(candidate) != report['files'] or database_stats(candidate / 'history.db') != report['database_stats']:
        raise ValueError('Candidate data changed')
    config = json.loads((candidate / 'research.json').read_text())
    if config != {'enabled': False, 'worker_mode': 'paused'}:
        raise ValueError('Candidate execution is not disabled')
    return {'verified': True, 'execution_allowed': False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-database', type=Path, required=True)
    parser.add_argument('--source-static', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--research-root', type=Path)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--research-config', type=Path)
    args = parser.parse_args()
    configs = {name: path for name, path in [('.env', args.env_file), ('research.json', args.research_config)] if path is not None}
    try:
        report = prepare_candidate(args.source_database, args.source_static, args.output,
                                   research_root=args.research_root, config_files=configs)
        print(json.dumps({key: report[key] for key in ['status', 'execution_allowed', 'requires_explicit_cutover']}))
        return 0
    except Exception:
        print('候选数据未就绪。请先正常停止客户端和网页版服务，并核对源文件、备份与目标目录；没有执行数据接管。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
