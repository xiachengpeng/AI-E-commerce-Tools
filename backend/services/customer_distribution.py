"""Explicit customer-only installation lifecycle; never imports the live main DB.

The app creates a new workspace atomically. Existing workspaces are validated,
not repaired or re-keyed. Version changes require a cold complete backup first.
"""
from contextlib import ExitStack, closing
from datetime import UTC, datetime
import fcntl
import hashlib
import hmac
from importlib import import_module
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time
from uuid import uuid4


def _version(value):
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]*', value.split('.')[0]):
        raise ValueError('invalid_customer_version')
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value):
        raise ValueError('invalid_customer_version')
    return tuple(map(int, value.split('.')))


def _private(path):
    from services.research_runtime import _validate_path
    _validate_path(path, private=True)


def write_json(path, value):
    """Atomic private-file replacement; callers hold the lifecycle/setup lock."""
    _private(path.parent)
    _private(path)
    fd, temporary = tempfile.mkstemp(prefix='.customer-write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def _schema(database):
    from services.research_runtime import _research_imports
    from sqlalchemy import create_engine
    from models.full_merge import metadata, validate_prepared_schema
    from models.integration_settings import metadata as integrations
    from models.research_ai_usage import metadata as usage
    _research_imports()
    for name in ('application.actions', 'application.sync', 'monitoring',
                 'integrations.provider_jobs', 'persistence.projects'):
        import_module('rabbit_hole.' + name)
    source = import_module('rabbit_hole.persistence.database').metadata
    engine = create_engine('sqlite:///' + str(database))
    try:
        with engine.begin() as c:
            c.exec_driver_sql('PRAGMA foreign_keys=ON')
            source.create_all(c)
            # Create baseline ledger plus the same additive revision-4 columns.
            metadata.tables['full_merge_ledger'].create(c)
            for field, kind in [('dataset_id', 'TEXT'), ('owner_generation', 'INTEGER'), ('activation_digest', 'TEXT')]:
                c.exec_driver_sql(f'ALTER TABLE full_merge_ledger ADD COLUMN {field} {kind}')
            c.exec_driver_sql('CREATE TABLE full_merge_schema (id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision IN (1,2,3,4)))')
            c.exec_driver_sql('INSERT INTO full_merge_schema VALUES (1,4)')
            integrations.create_all(c); usage.create_all(c)
            validate_prepared_schema(c, source, additional_metadata=integrations)
            validate_prepared_schema(c, source, additional_metadata=usage)
    finally: engine.dispose()


def _initialize(stage, destination, version):
    from services.research_runtime import resolve_runtime_paths
    from services.research_activation import canonical, candidate_hash, claim_activation
    database = stage / 'history.db'
    database.touch(mode=0o600)
    _schema(database)
    research = stage / 'research'; research.mkdir(mode=0o700)
    paths = resolve_runtime_paths(database, research)
    for directory in (paths.evidence_root, paths.keys_root, paths.browser_root, paths.lock_root):
        directory.mkdir(mode=0o700)
    for name in ('activation.key', 'evidence-signing.key'):
        with os.fdopen(os.open(paths.keys_root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
            stream.write(os.urandom(32)); stream.flush(); os.fsync(stream.fileno())
    dataset = str(uuid4()); snapshot = 'fresh-' + str(uuid4())
    write_json(paths.keys_root / 'evidence-namespace.json', {
        'version': 1, 'evidence_bucket': 'customer-' + dataset, 'collector_version': 'integrated-v1'})
    empty_hash = hashlib.sha256(b'fresh-empty-customer-dataset-v1').hexdigest()
    with closing(sqlite3.connect(database)) as c, c:
        c.execute('INSERT INTO full_merge_ledger (source_snapshot_id,source_snapshot_sha256,source_database_sha256,cutover_state,captured_at,dataset_id,owner_generation) VALUES (?,?,?,?,?,?,?)',
                  (snapshot, empty_hash, empty_hash, 'verified', datetime.now(UTC).isoformat(), dataset, 1))
    now = time.time()
    report = {'kind': 'fresh_install', 'mode': 'active', 'dataset_id': dataset,
              'snapshot_id': snapshot, 'owner_generation': 1,
              'issued_at': now, 'expires_at': now + 3600, 'target_db_hash': candidate_hash(database),
              'unresolved_nonidempotent': 0, 'quarantine': []}
    report['signature'] = hmac.new((paths.keys_root / 'activation.key').read_bytes(), canonical(report), hashlib.sha256).hexdigest()
    write_json(paths.keys_root / 'activation.json', report)
    claim_activation(paths, report)
    write_json(stage / 'research.json', {
        'enabled': True, 'mode': 'local', 'data_root': str(destination / 'research'),
        'worker_mode': 'paused', 'feishu_polling_enabled': False})
    marker = {'schema': 1, 'version': version, 'dataset_id': dataset,
              'setup_complete': False, 'created_at': datetime.now(UTC).isoformat()}
    write_json(stage / 'customer-install.json', marker)


def customer_install(data):
    """Validate identity without exposing or rewriting credentials."""
    from services.research_runtime import resolve_runtime_paths
    from services.research_activation import load_activation, validate_activation
    _private(data)
    path = data / 'customer-install.json'; _private(path)
    if not path.is_file(): raise ValueError('unknown_customer_workspace')
    if path.stat().st_size > 8192: raise ValueError('invalid_customer_install')
    marker = json.loads(path.read_text())
    if marker.get('schema') != 1 or type(marker.get('setup_complete')) is not bool:
        raise ValueError('invalid_customer_install')
    _version(marker.get('version'))
    paths = resolve_runtime_paths(data / 'history.db', data / 'research')
    if not validate_activation(paths) or load_activation(paths).get('dataset_id') != marker.get('dataset_id'):
        raise ValueError('invalid_customer_owner')
    return marker


def _backup(data, previous):
    # Cold snapshot: locks are held by prepare_customer_data, no copied WAL races.
    parent = data.parent / 'backups'; parent.mkdir(mode=0o700, exist_ok=True); _private(parent)
    output = parent / (previous + '-' + datetime.now(UTC).strftime('%Y%m%dT%H%M%S') + '-' + uuid4().hex[:8])
    stage = Path(tempfile.mkdtemp(prefix='.backup-', dir=parent))
    try:
        for item in data.iterdir():
            if item.name in {'history.db', 'history.db-wal', 'history.db-shm'} or item.name.endswith('.lock'):
                continue
            if item.is_symlink(): raise ValueError('customer_backup_symlink')
            if item.is_dir():
                if any(p.is_symlink() for p in item.rglob('*')): raise ValueError('customer_backup_symlink')
                shutil.copytree(item, stage / item.name)
            else: shutil.copy2(item, stage / item.name)
        with closing(sqlite3.connect(data.joinpath('history.db').as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(stage / 'history.db')) as target:
            source.backup(target)
            if target.execute('PRAGMA integrity_check').fetchone() != ('ok',): raise ValueError('customer_backup_invalid')
        profile = data.parent / 'profile'
        if profile.exists():
            # Browser is not yet open; Electron can still hold its own profile locks.
            # Keep business browser storage, not cache or singleton socket files.
            saved = stage / 'browser-profile'; saved.mkdir(mode=0o700)
            for name in ('Local Storage', 'IndexedDB', 'Session Storage', 'Preferences'):
                source = profile / name
                if not source.exists(): continue
                if source.is_symlink() or (source.is_dir() and any(p.is_symlink() for p in source.rglob('*'))):
                    raise ValueError('customer_backup_symlink')
                if source.is_dir(): shutil.copytree(source, saved / name)
                else: shutil.copy2(source, saved / name)
        for p in stage.rglob('*'):
            p.chmod(0o700 if p.is_dir() else 0o600)
        write_json(stage / 'backup-info.json', {'schema': 1, 'version': previous, 'created_at': datetime.now(UTC).isoformat()})
        os.rename(stage, output)
        return str(output)
    except BaseException:
        shutil.rmtree(stage)
        raise


def prepare_customer_data(data: Path, version: str) -> dict:
    """Explicit customer channel only; never accept an unrecognized existing DB."""
    data = Path(data); _private(data); _version(version)
    data.parent.mkdir(mode=0o700, parents=True, exist_ok=True); _private(data.parent)
    lock = data.parent / '.customer-lifecycle.lock'; _private(lock)
    with os.fdopen(os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not data.exists():
            stage = Path(tempfile.mkdtemp(prefix='.customer-init-', dir=data.parent))
            try:
                _initialize(stage, data, version)
                os.rename(stage, data)
            except BaseException:
                shutil.rmtree(stage)
                raise
            return customer_install(data)
        with ExitStack() as stack:
            for mode in ('api', 'frontend', 'worker'):
                path = data / (mode + '.lock'); _private(path)
                # Existing same-version restarts must not create files.
                if path.exists():
                    owned = stack.enter_context(path.open('a'))
                    fcntl.flock(owned, fcntl.LOCK_EX | fcntl.LOCK_NB)
            marker = customer_install(data)
            old = _version(marker['version'])
            if _version(version) < old: raise ValueError('customer_downgrade_requires_restore')
            if _version(version) == old: return marker
            backup = _backup(data, marker['version'])
            marker['version'] = version
            write_json(data / 'customer-install.json', marker)
            return {**marker, 'backup': backup}
