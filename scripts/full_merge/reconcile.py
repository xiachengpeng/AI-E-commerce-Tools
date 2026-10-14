"""Read-only in-flight classification. No queue, cancel, or submission capability."""
from __future__ import annotations

import re


def reconcile_actions(snapshot: dict, probe) -> dict:
    result = {'resolved': [], 'pending': [], 'blocked': []}
    for collection in ('actions', 'sync_runs', 'outbox', 'jobs'):
        for row in snapshot.get(collection, []):
            item = {k: row[k] for k in ('id', 'attempt', 'input_version', 'status') if k in row}
            item['collection'] = collection
            state = (row.get('payload') or {}).get('apify_run') or {}
            category, reason = 'blocked', 'manual_check'
            if row.get('status') in {'complete', 'completed', 'succeeded', 'sent'}:
                category, reason = 'resolved', 'durable_terminal'
            elif collection == 'actions' and state:
                owner = {'action_id': str(row['id']), 'input_version': row.get('input_version'),
                         'fingerprint': (row.get('payload') or {}).get('fingerprint')}
                bound = state.get('owner') == owner and not state.get('restart_required') and state.get('submission') != 'uncertain'
                bound = bound and all(isinstance(state.get(k), str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', state[k]) for k in ('id', 'dataset'))
                if bound:
                    item.update(run_id=state['id'], dataset_id=state['dataset'])
                    try:
                        observed = probe(dict(item))
                    except Exception:
                        observed = None
                    if isinstance(observed, dict) and observed.get('run_id') == state['id'] and observed.get('dataset_id') == state['dataset']:
                        if observed.get('status') in {'READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'}:
                            category, reason = 'pending', 'cloud_active'
                        elif observed.get('status') in {'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'}:
                            category, reason = 'resolved', 'cloud_terminal_no_replay'
            result[category].append({**item, 'reason': reason})
    result['unresolved_nonidempotent'] = len(result['blocked']) + len(result['pending'])
    return result


def read_snapshot(database):
    """Private operator inventory from a consistent read transaction; no mutations.

    Project text, prompts, URLs, credentials and raw external payloads are excluded.
    IDs/receipts are private report data, not suitable for public logs.
    """
    import hashlib
    import json
    import sqlite3
    from pathlib import Path
    from urllib.parse import quote

    database = Path(database)
    if not database.is_absolute() or any(p.is_symlink() for p in (database, *database.parents)):
        raise ValueError('absolute nonsymlink snapshot required')
    result = {}
    with sqlite3.connect('file:' + quote(str(database), safe='/') + '?mode=ro', uri=True) as c:
        c.row_factory = sqlite3.Row
        c.execute('BEGIN')
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for target, table in [('actions', 'workbench_actions'), ('sync_runs', 'workbench_sync_runs'), ('outbox', 'feishu_outbox'), ('jobs', 'runtime_jobs')]:
            result[target] = []
            if table not in tables:
                continue
            for raw in c.execute('SELECT * FROM ' + table):
                row = dict(raw)
                item = {k: row[k] for k in ('id', 'project_id', 'status', 'attempt', 'input_version', 'lease_until', 'error_code', 'failure_code', 'record_id', 'record_version', 'attempt_count') if k in row}
                if target == 'actions':
                    payload = json.loads(row.get('payload') or '{}')
                    item['payload'] = {k: payload[k] for k in ('apify_run', 'fingerprint', 'execution_mode', 'provider_reservations', 'execution_uncertain', 'abort_pending', 'trend_submissions') if k in payload}
                result[target].append(item)
        result['daily_usage'] = [dict(row) for row in c.execute('SELECT * FROM daily_usage')] if 'daily_usage' in tables else []
        result['checkpoint_count'] = c.execute('SELECT count(*) FROM job_checkpoints').fetchone()[0] if 'job_checkpoints' in tables else 0
    result['source_database_sha256'] = hashlib.sha256(database.read_bytes()).hexdigest()
    return result
