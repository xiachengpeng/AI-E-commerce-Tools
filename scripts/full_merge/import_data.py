"""Explicit, backup-gated raw SQLite import into an owned disposable candidate.

No ORM codecs, application lifecycle, source writes, or live replacement. Operator
manifests are trusted private inputs; external backup verification belongs rehearse.
"""
import hashlib
import json
from collections import Counter
from contextlib import closing
import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from scripts.full_merge.backup import database_stats


def _safe(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('absolute nonsymlink path required')
    return path


def candidate_directory(path):
    path = _safe(path)
    roots = (Path(tempfile.gettempdir()).resolve(), Path.home() / '.local/share/ai-ecommerce-merge')
    if not any(path.is_relative_to(root) and path != root for root in roots):
        raise ValueError('disposable candidate directory required')
    marker = _safe(path / '.full-merge-candidate')
    if not path.is_dir() or not marker.is_file() or marker.read_text() != '1':
        raise ValueError('owned candidate marker required')
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ValueError('private candidate directory required')
    return path


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def _copy_table(source, target, name, target_name=None):
    columns = [row[1] for row in source.execute('PRAGMA table_info(' + quote(name) + ')')]
    sql = 'INSERT INTO ' + quote(target_name or name) + '(' + ','.join(map(quote, columns)) + ') VALUES(' + ','.join('?' for _ in columns) + ')'
    target.executemany(sql, source.execute('SELECT ' + ','.join(map(quote, columns)) + ' FROM ' + quote(name)))


def _digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def _rows(connection, table):
    return Counter(hashlib.sha256(repr(tuple(row)).encode()).hexdigest() for row in connection.execute('SELECT * FROM ' + quote(table)))



def _candidate_content(connection):
    excluded = {'full_merge_import_receipt','full_merge_ledger'}
    tables = {}
    for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        if name not in excluded:
            tables[name] = dict(_rows(connection,name))
    schema = list(connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"))
    schema = [row for row in schema if row[2] not in excluded]
    return hashlib.sha256(json.dumps({'tables':tables,'schema':schema},sort_keys=True).encode()).hexdigest()


def _insert_rows(target, table, rows):
    columns = [r[1] for r in target.execute('PRAGMA table_info(' + quote(table) + ')')]
    for row in rows:
        if set(row) != set(columns):
            raise ValueError('complete raw configuration row required')
        target.execute('INSERT INTO ' + quote(table) + '(' + ','.join(map(quote,columns)) + ') VALUES(' + ','.join('?' for _ in columns) + ')', [row[name] for name in columns])


def _verify_research_archives(target, configuration):
    for row in configuration.get('research_ai_providers', []):
        if not isinstance(row, dict) or type(row.get('enabled')) is not int or row['enabled'] != 0:
            raise ValueError('explicit disabled archive provider required')
        current = target.execute('SELECT enabled FROM ai_provider_configs WHERE id=?',(row['id'],)).fetchone()
        if current != (0,):
            raise ValueError('disabled archive provider required')
        if target.execute('SELECT 1 FROM ai_capability_bindings WHERE provider_config_id=?',(row['id'],)).fetchone():
            raise ValueError('unbound archive provider required')


def _import_configuration(target, configuration):
    from services.ai_config_service import PROVIDER_FIELDS, validate_provider_data
    from services.integration_settings_service import FIELDS, IntegrationSettingsService
    if not isinstance(configuration, dict) or set(configuration) - {'main_effective_defaults','research_ai_providers','integrations','provenance'}:
        raise ValueError('explicit configuration mapping required')
    research = configuration.get('research_ai_providers', [])
    additions = set()
    empty = target.execute('SELECT COUNT(*) FROM ai_provider_configs').fetchone()[0] == 0
    if research and empty:
        defaults = configuration.get('main_effective_defaults')
        if not isinstance(defaults,dict) or set(defaults) != {'providers','bindings'} or not defaults['providers'] or {r['capability'] for r in defaults['bindings']} != {'text','image'}:
            raise ValueError('exact effective main defaults required before research providers')
        _insert_rows(target,'ai_provider_configs',defaults['providers'])
        _insert_rows(target,'ai_capability_bindings',defaults['bindings'])
        additions.update({'ai_provider_configs','ai_capability_bindings'})
    elif configuration.get('main_effective_defaults'):
        # Existing rows always take priority. A stale default snapshot cannot overwrite them.
        raise ValueError('effective main defaults conflict with existing settings')
    for row in research:
        if not isinstance(row, dict) or type(row.get('enabled')) is not int or row['enabled'] != 0:
            raise ValueError('explicit disabled archive provider required')
        try:
            validate_provider_data({k:row[k] for k in PROVIDER_FIELDS})
        except (KeyError, ValueError, TypeError):
            raise ValueError('explicit legacy AI mapping required') from None
    _insert_rows(target,'ai_provider_configs',research)
    _verify_research_archives(target,configuration)
    if research:
        additions.add('ai_provider_configs')
    for row in configuration.get('integrations', []):
        if not isinstance(row,dict) or set(row) != {'provider','purpose','value','version'}:
            raise ValueError('explicit integration mapping required')
        IntegrationSettingsService.validate(row['provider'], row['purpose'])
        value = json.loads(row['value'])
        if row['purpose'] != 'research' or not isinstance(value,dict) or set(value) - FIELDS[row['provider']] or type(row['version']) is not int or row['version'] < 1:
            raise ValueError('explicit research purpose mapping required')
        if row['provider'] in {'apify','serpapi','firecrawl'} and (type(value.get('daily_limit')) is not int or value['daily_limit'] < 1):
            raise ValueError('actual source daily budget required')
        existing = target.execute('SELECT value,version FROM integration_settings WHERE provider=? AND purpose=?',(row['provider'],row['purpose'])).fetchone()
        if existing is not None and existing != (row['value'],row['version']):
            raise ValueError('integration purpose conflict')
        if existing is None:
            _insert_rows(target,'integration_settings',[row])
            additions.add('integration_settings')
    provenance = configuration.get('provenance', [])
    if provenance:
        target.execute('CREATE TABLE full_merge_config_provenance(kind TEXT NOT NULL,name TEXT NOT NULL,sha256 TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(kind,name))')
        for row in provenance:
            if set(row) != {'kind','name','value'} or not all(isinstance(row[k],str) for k in row):
                raise ValueError('explicit configuration provenance required')
            raw = row['value'].encode()
            target.execute('INSERT INTO full_merge_config_provenance VALUES(?,?,?,?)',(row['kind'],row['name'],hashlib.sha256(raw).hexdigest(),raw))
    return additions


def _auxiliary_sources(manifest):
    tables = {}
    sources = []
    for entry in manifest.get('auxiliary_databases', []):
        if set(entry) != {'path','sha256','stats','active_table_mapping'}:
            raise ValueError('explicit auxiliary database mapping required')
        path = _safe(entry['path'])
        stats = database_stats(path)
        if _digest(path) != entry['sha256'] or stats != entry['stats'] or not stats['integrity_ok'] or stats['foreign_key_errors']:
            raise ValueError('auxiliary snapshot mismatch')
        if entry['active_table_mapping'] != {'translations':'research_translation_cache'} or set(stats['tables']) != {'translations'}:
            raise ValueError('unsupported auxiliary database mapping')
        for name,value in stats['tables'].items():
            if name in tables:
                raise ValueError('auxiliary table collision')
            tables[name] = value
            tables[entry['active_table_mapping'][name]] = value
        sources.append(entry)
    return sources,tables


def _import_auxiliary(target, sources):
    additions = set()
    for entry in sources:
        with closing(sqlite3.connect(Path(entry['path']).as_uri()+'?mode=ro',uri=True)) as source:
            for name,sql in source.execute("SELECT name,sql FROM sqlite_master WHERE type='table'"):
                if target.execute('SELECT name FROM sqlite_master WHERE name=?',(name,)).fetchone():
                    raise ValueError('auxiliary table collision')
                target.execute(sql)
                _copy_table(source,target,name)
                active = entry['active_table_mapping'][name]
                columns = [r[1] for r in source.execute('PRAGMA table_info('+quote(name)+')')]
                if columns != [r[1] for r in target.execute('PRAGMA table_info('+quote(active)+')')] or target.execute('SELECT COUNT(*) FROM '+quote(active)).fetchone()[0]:
                    raise ValueError('active cache collision')
                _copy_table(source,target,name,active)
                additions.add(active)
    return additions


def import_research(source_snapshot: Path, candidate_db: Path, manifest: dict) -> dict:
    source_snapshot, candidate_db = _safe(source_snapshot), _safe(candidate_db)
    candidate_directory(candidate_db.parent)
    if not source_snapshot.is_file() or not candidate_db.is_file() or source_snapshot == candidate_db:
        raise ValueError('distinct existing source and candidate required')
    if manifest.get('backup_verified') is not True:
        raise ValueError('verified backup required')
    source_hash = _digest(source_snapshot)
    source_stats = database_stats(source_snapshot)
    if source_hash != manifest.get('source_database_sha256') or source_stats != manifest.get('source_stats') or not source_stats['integrity_ok'] or source_stats['foreign_key_errors']:
        raise ValueError('source snapshot mismatch')
    snapshot_id, anchor = manifest.get('source_snapshot_id'), manifest.get('source_snapshot_sha256')
    if not isinstance(snapshot_id, str) or not snapshot_id or not isinstance(anchor, str) or len(anchor) != 64 or any(c not in '0123456789abcdef' for c in anchor):
        raise ValueError('snapshot identity required')
    auxiliary,auxiliary_tables = _auxiliary_sources(manifest)
    if set(auxiliary_tables).intersection(source_stats['tables']):
        raise ValueError('auxiliary source table collision')
    expected_tables = {**source_stats['tables'],**auxiliary_tables}
    before = database_stats(candidate_db)
    migration_hash = hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
    with closing(sqlite3.connect(source_snapshot.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(candidate_db)) as target:
        target.execute('PRAGMA foreign_keys=ON')
        if target.execute('SELECT id,revision FROM full_merge_schema').fetchall() not in ([(1, 3)], [(1, 4)]):
            raise ValueError('explicit revision3/4 candidate required')
        ledger = target.execute('SELECT source_snapshot_id,source_snapshot_sha256,source_database_sha256,cutover_state FROM full_merge_ledger').fetchall()
        if ledger:
            if len(ledger) != 1 or ledger[0][:3] != (snapshot_id, anchor, source_hash):
                raise ValueError('source snapshot ledger mismatch')
            if ledger[0][3] != 'imported':
                raise ValueError('unsupported snapshot ledger state')
            receipt = target.execute('SELECT manifest_sha256,candidate_sha256 FROM full_merge_import_receipt WHERE source_snapshot_id=?',(snapshot_id,)).fetchone()
            if receipt is None or receipt[0] != migration_hash:
                raise ValueError('migration manifest mismatch')
            _verify_research_archives(target,manifest.get('configuration', {}))
            if receipt[1] != _candidate_content(target):
                raise ValueError('imported candidate content mismatch')
            checked = database_stats(candidate_db)
            if any(checked['tables'].get(name) != value for name, value in expected_tables.items()):
                raise ValueError('imported snapshot content mismatch')
            return {'verified': True, 'mismatches': [], 'tables': len(source_stats['tables']), 'rows': sum(x['rows'] for x in source_stats['tables'].values()), 'hash': source_hash}
        from backend.migrations.full_merge_v1 import research_metadata
        research_names = set(research_metadata().tables)
        definitions = source.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        try:
            target.execute('BEGIN IMMEDIATE')
            target.execute('PRAGMA defer_foreign_keys=ON')
            original = {n:_rows(target,n) for n in before['tables'] if n not in research_names and n != 'full_merge_ledger'}
            additions = _import_configuration(target,manifest.get('configuration', {}))
            additions.update(_import_auxiliary(target,auxiliary))
            for name, sql in definitions:
                if name.startswith('sqlite_'):
                    raise ValueError('internal source table requires explicit mapping')
                found = target.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
                if found:
                    actual_columns = target.execute('PRAGMA table_info(' + quote(name) + ')').fetchall()
                    expected_columns = source.execute('PRAGMA table_info(' + quote(name) + ')').fetchall()
                    if name not in research_names or actual_columns != expected_columns or target.execute('SELECT COUNT(*) FROM ' + quote(name)).fetchone()[0]:
                        raise ValueError('source table collision')
                else:
                    target.execute(sql)
            for name, _ in definitions:
                _copy_table(source, target, name)
            # Preserve auxiliary source schema, while prepared research indexes are already present.
            for kind, name, sql in source.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL"):
                current = target.execute('SELECT sql FROM sqlite_master WHERE type=? AND name=?', (kind, name)).fetchone()
                if current is None:
                    target.execute(sql)
                elif current[0] != sql:
                    raise ValueError('source schema collision')
            if target.execute('PRAGMA foreign_key_check').fetchall():
                raise ValueError('candidate foreign key mismatch')
            # Read uncommitted rows using this connection, not a second connection.
            for name, expected in expected_tables.items():
                hashes = sorted(hashlib.sha256(repr(tuple(row)).encode()).hexdigest() for row in target.execute('SELECT * FROM ' + quote(name)))
                if {'rows':len(hashes), 'sha256':hashlib.sha256(''.join(hashes).encode()).hexdigest()} != expected:
                    raise ValueError('source row hash mismatch')
            for name, old in original.items():
                current = _rows(target,name)
                if any(current[k] < count for k,count in old.items()) or (name not in additions and current != old):
                    raise ValueError('main historical row mismatch')
            _verify_research_archives(target,manifest.get('configuration', {}))
            target.execute('CREATE TABLE full_merge_import_receipt(source_snapshot_id TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,candidate_sha256 TEXT NOT NULL)')
            target.execute('INSERT INTO full_merge_import_receipt VALUES(?,?,?)',(snapshot_id,migration_hash,_candidate_content(target)))
            target.execute('INSERT INTO full_merge_ledger(source_snapshot_id,source_snapshot_sha256,source_database_sha256,source_alembic_revision,cutover_state,captured_at) VALUES(?,?,?,?,?,?)', (snapshot_id, anchor, source_hash, manifest.get('source_alembic_revision'), 'imported', datetime.now(timezone.utc).isoformat()))
            target.commit()
            _verify_research_archives(target,manifest.get('configuration', {}))
        except BaseException:
            target.rollback()
            raise
    after = database_stats(candidate_db)
    for name, expected in before['tables'].items():
        if name not in research_names and name not in additions and name != 'full_merge_ledger' and after['tables'][name] != expected:
            raise ValueError('main historical row mismatch')
    return {'verified': True, 'mismatches': [], 'tables':len(source_stats['tables']), 'rows':sum(x['rows'] for x in source_stats['tables'].values()), 'hash':source_hash}
