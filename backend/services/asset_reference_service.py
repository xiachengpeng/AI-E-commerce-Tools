"""Read-only asset inventory and a cross-process reference/cleanup boundary.

No provider client, schema creation, or application startup is imported here.
Unknown business-history schemas and malformed payloads make GC fail closed.
"""
from contextlib import closing, contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import unquote, urlsplit

FIELDS = {
    'analysis_history': {'data':'json'},
    'listing_history': {'result':'json'},
    'translation_history': {'image_url':'text','result':'json'},
    'text_translation_history': {'result':'text'},
    'ads_history': {'image_url':'text','result':'json'},
    'render_history': {'image_base64':'text','metadata_info':'json'},
    'square_redraw_history': {'result':'json'},
    'watermark_removal_history': {'result':'json'},
    'square_redraw_batches': {'output_dir':'directory','zip_path':'text'},
    'square_redraw_items': {'source_url':'text','output_url':'text'},
    'workbench_projects': {'state':'json'},
    'workbench_events': {'payload':'json'},
    'workbench_actions': {'payload':'json','result':'json'},
    'workbench_sync_runs': {'snapshot':'json','checkpoint':'json'},
    'runtime_jobs': {'payload':'json'},
    'feishu_outbox': {'payload':'json'},
}
MAX_JSON_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class AssetReferenceIndex:
    complete: bool
    protected_paths: frozenset[Path]
    unresolved: tuple[str, ...]
    protected_directories: frozenset[Path] = frozenset()

    def protects(self, path: Path) -> bool:
        return path in self.protected_paths or any(root == path or root in path.parents for root in self.protected_directories)


def current_database() -> Path:
    path = Path(os.environ.get('SQLITE_DB_PATH') or Path(__file__).resolve().parents[1] / 'history.db').absolute()
    return path if path.is_symlink() else path.resolve()


def _no_symlinks(path: Path) -> bool:
    return not any(part.is_symlink() for part in (path, *path.parents))


@contextmanager
def asset_reference_lock(database: Path, *, exclusive=False, blocking=True):
    """Lock outside the public static root, on an inode that is never replaced."""
    database = Path(database).absolute()
    if database.is_symlink():
        raise ValueError('asset_reference_path_invalid')
    database = database.resolve()
    if not _no_symlinks(database) or not database.parent.is_dir():
        raise ValueError('asset_reference_path_invalid')
    lock = database.parent / '.asset-reference.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        operation=fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        fcntl.flock(fd,operation if blocking else operation|fcntl.LOCK_NB)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def install_reference_transaction_lock(engine, database: Path):
    """References published through app DB engines coordinate with static GC."""
    from sqlalchemy import event
    if engine.dialect.name != 'sqlite' or getattr(engine, '_asset_reference_lock_installed', False):
        return
    engine._asset_reference_lock_installed = True
    @event.listens_for(engine, 'begin')
    def begin(connection):
        if '_asset_reference_lock' not in connection.info:
            import asyncio
            if engine.dialect.is_async:
                from sqlalchemy.util.concurrency import await_only
                lock = asset_reference_lock(database)
                async def acquire():
                    future=asyncio.get_running_loop().run_in_executor(None,lock.__enter__)
                    try:await asyncio.shield(future)
                    except BaseException:
                        # Cancellation must release a lock acquired by the still-running thread.
                        def release_late(done):
                            if not done.cancelled() and done.exception() is None:lock.__exit__(None,None,None)
                        future.add_done_callback(release_late)
                        raise
                await_only(acquire())
            else:
                try:asyncio.get_running_loop()
                except RuntimeError:blocking=True
                else:blocking=False
                # A sync Session used directly inside an async route must fail
                # before BEGIN rather than freeze an event loop behind cleanup.
                lock = asset_reference_lock(database,blocking=blocking)
                lock.__enter__()
            connection.info['_asset_reference_lock'] = lock
    # Engine commit/rollback events happen before the DBAPI operation; release
    # only when the pooled connection is checked back in, after commit/rollback.
    @event.listens_for(engine.pool, 'checkin')
    def checkin(_dbapi, record):
        lock = record.info.pop('_asset_reference_lock', None)
        if lock is not None:
            lock.__exit__(None, None, None)


def local_asset_path(value: str, asset_root: Path) -> Path | None:
    if value.startswith(('data:', 'blob:')):
        return None
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            return None
        if parsed.username or parsed.password:
            raise ValueError('unsafe_local_asset_url')
        value = parsed.path
    else:
        value = value.split('?', 1)[0].split('#', 1)[0]
    value = unquote(value)
    if value.startswith('/static/'):
        relative = value[len('/static/'):]
    elif value.startswith('static/'):
        relative = value[len('static/'):]
    elif value.startswith(str(asset_root) + os.sep):
        relative = value[len(str(asset_root)) + 1:]
    else:
        return None
    if '\x00' in relative or '\\' in relative or '..' in Path(relative).parts:
        raise ValueError('asset_reference_traversal')
    path = asset_root / relative
    if not _no_symlinks(path) or not path.absolute().is_relative_to(asset_root):
        raise ValueError('asset_reference_symlink_or_escape')
    return path.absolute()


def collect_asset_references(database: Path, private_root: Path | None = None, *, asset_root: Path | None = None) -> AssetReferenceIndex:
    if asset_root is None:
        from services.runtime_paths import static_root
        asset_root = static_root()
    asset_root, database = Path(asset_root).absolute(), Path(database).absolute()
    protected, directories, errors = set(), set(), []
    def walk(value, *, directory=False, depth=0):
        if depth > 48:
            raise ValueError('asset_reference_depth')
        if isinstance(value, str):
            if value.startswith(('data:', 'blob:')): return
            # Standalone URLs retain their origin. Only scan embedded local
            # references when text is a rendered HTML/CSS fragment.
            candidates = [value]
            if '<' in value or 'url(' in value:
                candidates += re.findall(r'''(?:src|href)=["']([^"']+)["']|url\(["']?([^\s)"']+)''', value)
                candidates = [value] + [part for match in candidates[1:] for part in match if part]
            for candidate in candidates:
                path = local_asset_path(candidate, asset_root)
                if path is not None:
                    (directories if directory else protected).add(path)
        elif isinstance(value, dict):
            for child in value.values(): walk(child, depth=depth+1)
        elif isinstance(value, list):
            for child in value: walk(child, depth=depth+1)
    if not database.is_file() or not _no_symlinks(database) or not _no_symlinks(asset_root):
        return AssetReferenceIndex(False, frozenset(), ('asset_reference_unavailable',))
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5)) as connection:
            connection.execute('BEGIN')
            tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            unknown = {name for name in tables if name.endswith('_history') and name not in FIELDS}
            errors.extend('unknown_history_schema' for _ in unknown)
            for table, fields in FIELDS.items():
                if table not in tables: continue
                columns = {r[1] for r in connection.execute('PRAGMA table_info("' + table + '")')}
                if not set(fields) <= columns:
                    errors.append('asset_reference_schema_incomplete'); continue
                query = 'SELECT ' + ','.join('"'+name+'"' for name in fields) + ' FROM "'+table+'"'
                for row in connection.execute(query):
                    for (column, kind), raw in zip(fields.items(), row):
                        if raw is None: continue
                        try:
                            if not isinstance(raw, str): raise ValueError('asset_reference_type')
                            if len(raw.encode('utf-8')) > MAX_JSON_BYTES: raise ValueError('asset_reference_size')
                            value = json.loads(raw) if kind == 'json' else raw
                            walk(value, directory=kind == 'directory')
                        except (ValueError, TypeError, RecursionError):
                            errors.append('asset_reference_payload_invalid')
    except sqlite3.Error:
        errors.append('asset_reference_database_unavailable')
    return AssetReferenceIndex(not errors, frozenset(protected), tuple(sorted(set(errors))), frozenset(directories))
