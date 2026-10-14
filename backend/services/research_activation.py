"""Signed operator handoff, independent of evidence signatures and host worker locks."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import time


def canonical(report):
    return json.dumps({k: v for k, v in report.items() if k != 'signature'}, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode()


def read_key(paths):
    from services.research_runtime import _validate_path
    key = paths.keys_root / 'activation.key'
    _validate_path(key, private=True)
    with os.fdopen(os.open(key, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        value = stream.read(33)
    if len(value) != 32:
        raise ValueError('invalid activation material')
    evidence = paths.keys_root / 'evidence-signing.key'
    if evidence.exists() and value == evidence.read_bytes():
        raise ValueError('activation material must be independent')
    return value


def load_activation(paths):
    from services.research_runtime import _validate_path
    path = paths.keys_root / 'activation.json'
    _validate_path(path, private=True)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'r') as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('invalid activation report')
    return json.loads(raw)


def _logical_hash(connection):
    # Rows, schema, and SQLite sequence values from this transaction's snapshot;
    # includes committed WAL without filesystem races or nested backup deadlock.
    digest = hashlib.sha256()
    schema = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
    digest.update(json.dumps(schema, separators=(',', ':')).encode())
    for kind, name, _, _sql in schema:
        if kind != 'table':
            continue
        quoted = '"' + name.replace('"', '""') + '"'
        rows = connection.execute('SELECT * FROM ' + quoted).fetchall()
        def encode(row):
            return json.dumps([{'blob': v.hex()} if isinstance(v, bytes) else v for v in row],
                              separators=(',', ':'), allow_nan=False)
        digest.update(json.dumps(sorted(encode(row) for row in rows), separators=(',', ':')).encode())
    return digest.hexdigest()


def candidate_hash(database):
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
        connection.execute('BEGIN')
        return _logical_hash(connection)


def _valid(paths, report, connection):
    now = time.time()
    if not isinstance(report, dict) or report.get('mode') != 'active':
        return False
    if any(report.get(k) is not True for k in ('source_owner_stopped', 'source_writers_frozen', 'source_frozen')):
        return False
    if type(report.get('unresolved_nonidempotent')) is not int or report['unresolved_nonidempotent'] < 0:
        return False
    if type(report.get('owner_generation')) is not int or report['owner_generation'] < 1:
        return False
    signature = hmac.new(read_key(paths), canonical(report), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, report.get('signature', '')):
        return False
    row = connection.execute('SELECT dataset_id,owner_generation,activation_digest,cutover_state FROM full_merge_ledger WHERE source_snapshot_id=?',
                             (report['snapshot_id'],)).fetchone()
    if row is None or row[:2] != (report['dataset_id'], report['owner_generation']):
        return False
    if row[2] is not None:
        return row[2] == signature and row[3] == 'activated' and _check_quarantine(connection, report, first_use=False)
    if not _check_quarantine(connection, report, first_use=True):
        return False
    if not (0 < report['source_frozen_at'] <= report['snapshot_created_at'] <= report['issued_at'] <= now
            < report['expires_at'] <= report['issued_at'] + 86400):
        return False
    return row[3] == 'imported' and _logical_hash(connection) == report['target_db_hash']


def validate_activation(paths, report=None) -> bool:
    """Read only. Missing, expired, changed or wrong-generation credentials fail closed."""
    try:
        from services.research_runtime import resolve_runtime_paths
        if paths != resolve_runtime_paths(paths.database, paths.evidence_root.parent):
            return False
        report = load_activation(paths) if report is None else report
        with sqlite3.connect(f'file:{paths.database}?mode=ro', uri=True) as connection:
            connection.execute('BEGIN')
            return _valid(paths, report, connection)
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        return False


def claim_activation(paths, report=None):
    """First authorized write: atomically replace candidate hash check with ledger identity."""
    report = load_activation(paths) if report is None else report
    with sqlite3.connect(f'file:{paths.database}?mode=rw', uri=True) as connection:
        connection.execute('BEGIN IMMEDIATE')
        if not _valid(paths, report, connection):
            raise PermissionError('research_activation_denied')
        connection.execute("UPDATE full_merge_ledger SET activation_digest=?,cutover_state='activated' WHERE source_snapshot_id=? AND dataset_id=? AND owner_generation=?",
                           (report['signature'], report['snapshot_id'], report['dataset_id'], report['owner_generation']))


def validate_runtime_activation(runtime):
    return validate_activation(runtime.paths)


def external_services(paths, integrations, business_settings):
    """Lazy transports; media inputs are selected from the owned project by the route."""
    async def media_reader(item):
        if not validate_activation(paths):
            raise PermissionError('research_activation_denied')
        from rabbit_hole.integrations.media_download import MediaUrlClient, read_media_download
        from rabbit_hole.security import google_public_dns
        resolver = google_public_dns if getattr(business_settings, 'public_dns', 'system') == 'google' else None
        return await read_media_download(item, MediaUrlClient(resolver=resolver))

    async def stop_action(store, project_id, action_id, attempt, *, version=None):
        if not validate_activation(paths):
            raise PermissionError('research_activation_denied')
        from rabbit_hole.application.actions import stop_action as stop
        async def abort(engine, project_id, action_id, attempt, run_id):
            import httpx
            from rabbit_hole.integrations.provider_jobs import append_log
            key = integrations.providers.get('apify')
            message = '本地已停止；云端停止结果未知，请人工核对'
            if key:
                try:
                    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                        response = await client.post(f'https://api.apify.com/v2/actor-runs/{run_id}/abort', headers={'Authorization': 'Bearer ' + key})
                        response.raise_for_status()
                    message = '停止请求已提交；云端最终状态仍须核对'
                except httpx.HTTPError:
                    pass
            await append_log(engine, project_id, action_id, attempt, 'cloud_abort', message)
        return await stop(store, project_id, action_id, attempt, version=version, cloud_abort=abort)
    return {'media_reader': media_reader, 'stop_action': stop_action}


RESOURCE_TABLES = {'actions': 'workbench_actions', 'jobs': 'runtime_jobs',
                   'outbox': 'feishu_outbox', 'sync_runs': 'workbench_sync_runs'}


def resource_id(value):
    from uuid import UUID
    try:
        return str(UUID(str(value)))
    except ValueError:
        return str(value)


def _resource_rows(connection):
    for kind, table in RESOURCE_TABLES.items():
        columns = [r[1] for r in connection.execute('PRAGMA table_info(' + table + ')').fetchall()]
        if not columns:
            continue
        for raw in connection.execute('SELECT * FROM ' + table).fetchall():
            yield kind, dict(zip(columns, raw))


def _resource_entry(kind, row):
    value = row.get('payload') if kind != 'sync_runs' else {'snapshot': row.get('snapshot'), 'checkpoint': row.get('checkpoint')}
    if isinstance(value, str):
        value = json.loads(value)
    return {'kind': kind, 'id': resource_id(row['id']),
            'attempt': row.get('attempt', row.get('attempt_count', 0)),
            'payload_sha256': hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()}


def _unknown(kind, row):
    status = row.get('status')
    if status in {'complete', 'completed', 'succeeded', 'sent'}:
        return False
    if kind in {'outbox', 'sync_runs'}:
        return True  # Durable write intent exists, without a final acknowledgement.
    return status not in {'ready'} or row.get('attempt', 0) > 0


def _inventory(connection):
    return sorted((_resource_entry(kind, row) for kind, row in _resource_rows(connection) if _unknown(kind, row)),
                  key=lambda item: (item['kind'], item['id']))


def quarantine_inventory(database):
    """Private immutable identity list; performs no status conversions."""
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
        connection.execute('BEGIN')
        return _inventory(connection)


def _check_quarantine(connection, report, *, first_use):
    listed = report.get('quarantine', [])
    if not isinstance(listed, list) or len(listed) != report['unresolved_nonidempotent']:
        return False
    identities = set()
    actual = {(kind, resource_id(row['id'])): row for kind, row in _resource_rows(connection)}
    for item in listed:
        if not isinstance(item, dict) or set(item) != {'kind', 'id', 'attempt', 'payload_sha256'}:
            return False
        identity = item['kind'], item['id']
        if identity in identities or identity not in actual:
            return False
        identities.add(identity)
        row = actual[identity]
        if row['status'] not in {'blocked', 'needs_human', 'manual_check'} or _resource_entry(item['kind'], row) != item:
            return False
    if first_use:
        return sorted(listed, key=lambda item: (item['kind'], item['id'])) == _inventory(connection)
    return True


async def guard_connection(connection, *, kind=None, identifier=None, payload=None):
    """Validate the signed owner using the caller's transaction, before queue effects."""
    from pathlib import Path
    options = connection.sync_connection.get_execution_options()
    paths = options.get('research_ownership_paths')
    if paths is None:
        raise PermissionError('research_ownership_context_required')
    name = connection.engine.url.database
    if not name or Path(name).resolve() != paths.database.resolve():
        raise PermissionError('research_ownership_database_mismatch')
    if options.get('research_offline_commands') is True:
        import tempfile
        root = Path(tempfile.gettempdir()).resolve()
        if all(path.is_relative_to(root) for path in (paths.database, paths.evidence_root.parent)):
            return
        raise PermissionError('research_offline_context_denied')
    try:
        report = load_activation(paths)
        class TransactionView:
            def __init__(self, sync): self.sync = sync
            def execute(self, sql, args=()): return self.sync.exec_driver_sql(sql, args)
        allowed = await connection.run_sync(lambda sync: _valid(paths, report, TransactionView(sync)))
        if not allowed:
            raise PermissionError('research_activation_denied')
        for item in report.get('quarantine', []):
            if item['kind'] != kind:
                continue
            if identifier is not None and item['id'] == resource_id(identifier):
                raise PermissionError('research_resource_quarantined')
            if payload is not None:
                hashed = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
                if item['payload_sha256'] == hashed:
                    raise PermissionError('research_resource_quarantined')
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error) as exc:
        raise PermissionError('research_activation_denied') from exc
