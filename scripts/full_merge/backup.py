"""Logical row hashes use O(row count) memory per table; freeze sources before backup.

Opt-in private recovery snapshots; SQLite backup includes committed WAL rows."""
import hashlib
import json
import os
import shutil
import sqlite3
from pathlib import Path


def _connect_readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)


def database_stats(path):
    with _connect_readonly(path) as connection:
        integrity = [r[0] for r in connection.execute('PRAGMA integrity_check')]
        foreign_key_errors = len(connection.execute('PRAGMA foreign_key_check').fetchall())
        tables = {}
        for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            # Order-independent row multiset hashes compare logical content without exporting values.
            hashes = []
            for row in connection.execute('SELECT * FROM ' + quoted):
                encoded = repr(tuple(row)).encode('utf-8')
                hashes.append(hashlib.sha256(encoded).hexdigest())
            tables[name] = {'rows': len(hashes), 'sha256': hashlib.sha256(''.join(sorted(hashes)).encode()).hexdigest()}
        schema = list(connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name'))
        return {'integrity_ok': integrity == ['ok'], 'foreign_key_errors': foreign_key_errors, 'tables': tables, 'schema_sha256': hashlib.sha256(repr(schema).encode()).hexdigest()}


def backup_sqlite(source: Path, destination: Path) -> dict:
    source, destination = Path(source), Path(destination)
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    reference = destination.with_name(destination.name + '.verification-copy')
    reference_created = False
    try:
        descriptor = os.open(reference, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        reference_created = True
        with _connect_readonly(source) as live, sqlite3.connect(destination) as restored:
            live.backup(restored)
        # Compare restored copies of the stable snapshot, never a moving live database.
        with _connect_readonly(destination) as snapshot, sqlite3.connect(reference) as copy:
            snapshot.backup(copy)
        expected, actual = database_stats(destination), database_stats(reference)
        return {'verified': expected == actual and actual['integrity_ok'] and actual['foreign_key_errors'] == 0, 'stats': actual}
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        if reference_created:
            reference.unlink(missing_ok=True)


def create_snapshot(directory: Path, *, databases=(), object_roots=(), key_files=()) -> dict:
    directory = Path(directory)
    if not (databases or object_roots or key_files):
        raise ValueError('Snapshot requires explicit nonempty sources')
    # Validate every requested source before creating a partial recovery set.
    for source in [*databases, *object_roots, *key_files]:
        if Path(source).is_symlink():
            raise ValueError('Symlink source roots are unsupported')
        if not Path(source).exists():
            raise FileNotFoundError(source)
    def source_state():
        state = {}
        for index, source in enumerate([*object_roots, *key_files]):
            source = Path(source)
            files = sorted(source.rglob('*')) if source.is_dir() else [source]
            for file in files:
                if file.is_symlink():
                    raise ValueError('Symlinks require explicit source resolution')
                if file.is_file():
                    stat = file.stat()
                    state[(index, str(file))] = (stat.st_ino, stat.st_size, stat.st_mtime_ns, hashlib.sha256(file.read_bytes()).hexdigest())
        return state
    initial_state = source_state()
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    manifest = {'version': 1, 'databases': [], 'objects': [], 'keys': [], 'requested_sources': []}
    for category, sources in [('databases', databases), ('objects', object_roots), ('keys', key_files)]:
        for index, source in enumerate(sources):
            source = Path(source)
            count = 1 if source.is_file() else sum(f.is_file() for f in source.rglob('*'))
            manifest['requested_sources'].append({'category': category, 'index': index, 'source_id': hashlib.sha256(str(source.resolve()).encode()).hexdigest(), 'files': count})
    for index, source in enumerate(databases):
        relative = f'databases/{index}.db'
        result = backup_sqlite(source, directory / relative)
        manifest['databases'].append({'path': relative, **result})
    for category, sources in [('objects', object_roots), ('keys', key_files)]:
        for index, source in enumerate(sources):
            source = Path(source)
            files = sorted(source.rglob('*')) if source.is_dir() else [source]
            for file in files:
                if file.is_symlink():
                    raise ValueError('Symlinks require explicit source resolution')
                if not file.is_file():
                    continue
                suffix = file.relative_to(source).as_posix() if source.is_dir() else 'key'
                relative = f'{category}/{index}/{suffix}'
                target = directory / relative
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(file, target)
                os.chmod(target, 0o600)
                manifest[category].append({'path': relative, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size})
    if source_state() != initial_state:
        raise ValueError('Sources changed during snapshot; freeze writes before retry')
    manifest['expected_counts'] = {category: len(manifest[category]) for category in ('databases', 'objects', 'keys')}
    target = directory / 'manifest.json'
    target.write_text(json.dumps(manifest, indent=2))
    os.chmod(target, 0o600)
    return manifest
