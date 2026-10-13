"""Candidate-only migration: raw SQLite values and every immutable object version."""
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from scripts.full_merge.backup import database_stats


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def migration(tmp_path):
    from db import Base
    from sqlalchemy import create_engine
    from backend.migrations.full_merge_v1 import prepare_schema
    root = tmp_path / 'candidate'
    root.mkdir(mode=0o700)
    (root / '.full-merge-candidate').write_text('1')
    candidate = root / 'history.db'
    engine = create_engine(f'sqlite:///{candidate}')
    Base.metadata.create_all(engine)
    engine.dispose()
    with sqlite3.connect(candidate) as c:
        c.execute("INSERT INTO analysis_history(id,timestamp,query_url,data) VALUES(71,'2020-01-02 03:04:05','fixture','{ \"kept\" : null }')")
    prepare_schema(candidate, backup_verified=True, target_revision=3)
    source = tmp_path / 'source.db'
    with sqlite3.connect(source) as c:
        c.executescript('CREATE TABLE legacy_projects(id TEXT PRIMARY KEY, utc TEXT, raw TEXT, optional BLOB); CREATE TABLE legacy_events(id TEXT PRIMARY KEY, project_id TEXT REFERENCES legacy_projects(id), raw TEXT); CREATE TABLE legacy_usage(id INTEGER PRIMARY KEY, budget INTEGER, cache BLOB, outbox TEXT);')
        c.execute('INSERT INTO legacy_projects VALUES(?,?,?,?)', ('a83ba4c9-3ec7-4041-8aba-dcb9ca274497','2020-01-01T12:04:05.123456+00:00','{ "order": [2,1], "null":null }', None))
        c.execute('INSERT INTO legacy_events VALUES(?,?,?)', ('event','a83ba4c9-3ec7-4041-8aba-dcb9ca274497','{"signature":"original","path":"/original/private/root"}'))
        c.execute('INSERT INTO legacy_usage VALUES(?,?,?,?)', (1,11,b'\x00\xff','[ 1, null ]'))
    manifest = {'backup_verified': True, 'source_snapshot_id':'fixture', 'source_snapshot_sha256':'a'*64, 'source_database_sha256':digest(source), 'source_stats':database_stats(source)}
    return source, candidate, manifest


def test_raw_rows_preserved_and_idempotent(migration):
    from scripts.full_merge.import_data import import_research
    source, candidate, manifest = migration
    before = database_stats(candidate)['tables']['analysis_history']
    first = import_research(source, candidate, manifest)
    assert first['verified'] and first['mismatches'] == []
    after = database_stats(candidate)
    assert after['tables']['analysis_history'] == before
    for name, expected in manifest['source_stats']['tables'].items():
        assert after['tables'][name] == expected
    assert import_research(source, candidate, manifest) == first
    assert database_stats(candidate) == after


def test_interruption_rolls_back_and_resumes(migration, monkeypatch):
    import scripts.full_merge.import_data as module
    source, candidate, manifest = migration
    real = module._copy_table
    def interrupt(*args):
        real(*args)
        raise KeyboardInterrupt
    monkeypatch.setattr(module, '_copy_table', interrupt)
    with pytest.raises(KeyboardInterrupt):
        module.import_research(source, candidate, manifest)
    assert 'legacy_projects' not in database_stats(candidate)['tables']
    monkeypatch.setattr(module, '_copy_table', real)
    assert module.import_research(source, candidate, manifest)['verified']


def test_source_mismatch_refuses_without_overwrite(migration):
    from scripts.full_merge.import_data import import_research
    source, candidate, manifest = migration
    import_research(source, candidate, manifest)
    before = digest(candidate)
    altered = dict(manifest, source_snapshot_sha256='b'*64)
    with pytest.raises(ValueError, match='snapshot'):
        import_research(source, candidate, altered)
    assert digest(candidate) == before


def test_live_destination_refused(migration, tmp_path):
    from scripts.full_merge.import_data import import_research
    source, candidate, manifest = migration
    live = tmp_path / 'live.db'
    live.write_bytes(candidate.read_bytes())
    before = digest(live)
    with pytest.raises(ValueError, match='candidate'):
        import_research(source, live, manifest)
    assert digest(live) == before


def test_schema_collision_is_atomic(migration):
    from scripts.full_merge.import_data import import_research
    source, candidate, manifest = migration
    with sqlite3.connect(source) as c:
        c.execute('CREATE TABLE analysis_history(id INTEGER PRIMARY KEY)')
        c.execute('INSERT INTO analysis_history VALUES(999)')
    manifest.update(source_database_sha256=digest(source), source_stats=database_stats(source))
    before = database_stats(candidate)
    with pytest.raises(ValueError, match='collision'):
        import_research(source, candidate, manifest)
    assert database_stats(candidate) == before


@pytest.fixture
def objects(tmp_path):
    from scripts.full_merge.copy_objects import inventory_objects
    root = tmp_path / 'objects'
    root.mkdir(mode=0o700)
    (root / '.signing-key').write_bytes(bytes(range(32)))
    key = 'nested/evidence'
    directory = root / 'fixture-bucket' / hashlib.sha256(key.encode()).hexdigest()
    versions = []
    for version, body in [('old-version', b'original'),('new-version',b'latest')]:
        path = directory / hashlib.sha256(version.encode()).hexdigest() / 'body'
        path.parent.mkdir(mode=0o700, parents=True)
        path.write_bytes(body)
        versions.append({'VersionId':version,'DeleteMarker':False,'sha256':hashlib.sha256(body).hexdigest(),'Size':len(body),'Metadata':{'signature':'immutable'}})
    (directory / 'index.json').write_text(json.dumps({'Key':key,'versions':versions}))
    manifest = inventory_objects(root)
    return root, tmp_path / 'staging', manifest


def test_all_versions_and_original_key_bytes(objects):
    from scripts.full_merge.copy_objects import copy_objects
    source, staging, manifest = objects
    result = copy_objects(source, staging, manifest)
    assert result['verified'] and result['versions'] == 2
    for entry in manifest['files']:
        assert (staging / entry['path']).read_bytes() == (source / entry['path']).read_bytes()
    assert copy_objects(source, staging, manifest) == result


@pytest.mark.parametrize('fault', ['missing','hash','symlink','escape','space'])
def test_objects_fail_closed(objects, fault, monkeypatch):
    import scripts.full_merge.copy_objects as module
    source, staging, manifest = objects
    entry = next(e for e in manifest['files'] if e['path'].endswith('/body'))
    path = source / entry['path']
    if fault == 'missing':
        path.unlink()
    elif fault == 'hash':
        path.write_bytes(b'corrupt')
    elif fault == 'symlink':
        path.unlink()
        path.symlink_to(source / '.signing-key')
    elif fault == 'escape':
        entry['path'] = '../outside'
    else:
        from collections import namedtuple
        usage = namedtuple('usage', 'total used free')
        monkeypatch.setattr(module.shutil, 'disk_usage', lambda _: usage(1,1,0))
    with pytest.raises((ValueError, OSError)):
        module.copy_objects(source, staging, manifest)
    assert not staging.exists()


def raw_rows(path, table):
    with sqlite3.connect(path) as c:
        c.row_factory = sqlite3.Row
        return [dict(row) for row in c.execute('SELECT * FROM "' + table + '"')]


def provider_rows(tmp_path, monkeypatch):
    from db import Base
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from services.ai_config_service import import_env_defaults_if_empty
    path = tmp_path / 'defaults.db'
    engine = create_engine(f'sqlite:///{path}')
    Base.metadata.create_all(engine)
    monkeypatch.setenv('AI_PROVIDER','gemini')
    monkeypatch.setenv('GEMINI_API_KEY','fixture-environment-key')
    with Session(engine) as session:
        assert import_env_defaults_if_empty(session)
    engine.dispose()
    return {'providers':raw_rows(path,'ai_provider_configs'), 'bindings':raw_rows(path,'ai_capability_bindings')}


def test_empty_main_materializes_exact_effective_defaults_before_research(migration, tmp_path, monkeypatch):
    from scripts.full_merge.import_data import import_research
    source, candidate, manifest = migration
    defaults = provider_rows(tmp_path,monkeypatch)
    legacy = dict(defaults['providers'][0], id=29, incarnation_id='legacy-fixture',name='Legacy research',enabled=0,protocol='openai_compatible',base_url='https://fixture.test/v1',text_model='legacy-model',supports_image=0,image_model=None)
    manifest['configuration'] = {'main_effective_defaults':defaults,'research_ai_providers':[legacy], 'integrations':[{'provider':'apify','purpose':'research','value':'{ "api_key":"fixture", "daily_limit":19 }','version':1}], 'provenance':[{'kind':'legacy-alias','name':'fixture','value':'{ "legacy_name" : "kept" }'}]}
    assert import_research(source,candidate,manifest)['verified']
    assert raw_rows(candidate,'ai_capability_bindings') == defaults['bindings']
    assert raw_rows(candidate,'ai_provider_configs') == [defaults['providers'][0], legacy]
    assert raw_rows(candidate,'integration_settings')[0]['value'] == manifest['configuration']['integrations'][0]['value']
    assert import_research(source,candidate,manifest)['verified']
    altered = json.loads(json.dumps(manifest))
    altered['configuration']['integrations'][0]['value'] = '{}'
    with pytest.raises(ValueError,match='manifest'):
        import_research(source,candidate,altered)


def test_empty_main_missing_defaults_and_purpose_conflicts_refuse_atomically(migration, tmp_path, monkeypatch):
    from scripts.full_merge.import_data import import_research
    source,candidate,manifest = migration
    defaults = provider_rows(tmp_path,monkeypatch)
    legacy = dict(defaults['providers'][0],id=29,incarnation_id='legacy-fixture',name='Legacy research',enabled=0)
    manifest['configuration'] = {'research_ai_providers':[legacy]}
    before = database_stats(candidate)
    with pytest.raises(ValueError,match='effective main'):
        import_research(source,candidate,manifest)
    assert database_stats(candidate) == before
    with sqlite3.connect(candidate) as c:
        c.execute('INSERT INTO integration_settings VALUES(?,?,?,?)',('apify','research','{"api_key":"kept"}',3))
    before = database_stats(candidate)
    manifest['configuration'] = {'integrations':[{'provider':'apify','purpose':'research','value':'{"api_key":"different","daily_limit":20}','version':1}]}
    with pytest.raises(ValueError,match='purpose conflict'):
        import_research(source,candidate,manifest)
    assert database_stats(candidate) == before


def test_existing_main_providers_and_bindings_not_overwritten(migration, tmp_path, monkeypatch):
    from scripts.full_merge.import_data import import_research
    source,candidate,manifest = migration
    defaults = provider_rows(tmp_path,monkeypatch)
    with sqlite3.connect(candidate) as c:
        for table, rows in [('ai_provider_configs',defaults['providers']),('ai_capability_bindings',defaults['bindings'])]:
            for row in rows:
                columns = list(row)
                c.execute('INSERT INTO '+table+'('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',list(row.values()))
    legacy = dict(defaults['providers'][0],id=29,incarnation_id='legacy-fixture',name='Legacy research',enabled=0)
    manifest['configuration'] = {'research_ai_providers':[legacy]}
    assert import_research(source,candidate,manifest)['verified']
    assert raw_rows(candidate,'ai_provider_configs') == [defaults['providers'][0],legacy]
    assert raw_rows(candidate,'ai_capability_bindings') == defaults['bindings']


@pytest.mark.parametrize("fault", ["none", "auxiliary", "schema-interrupt"])
def test_rehearse_anchored_snapshots_and_runtime_material(migration, objects, tmp_path, monkeypatch, fault):
    from scripts.full_merge.backup import create_snapshot
    from scripts.full_merge.rehearse import rehearse
    source,candidate,_ = migration
    source_root,_,_ = objects
    namespace = tmp_path / 'namespace.json'
    namespace.write_text('{"version":1,"evidence_bucket":"fixture-bucket","collector_version":"fixture-v1"}')
    business = tmp_path / 'business.json'
    # Explicit source-effective configuration, not defaults invented by migrator.
    business.write_text(json.dumps({'market':{'code':'US','currency':'USD','min_aov':10,'max_aov':100,'payment_percent':3,'payment_fixed':0.3,'loss_reserve_percent':5},'admission':{'daily_candidates':50,'daily_keywords':20,'daily_scans':50,'daily_ai_calls':500,'daily_cost_usd':'10','estimated_call_cost_usd':'0.01','estimated_research_scan_cost_usd':'0.01'},'trend_thresholds':{'coverage':0.8,'rising':0.2,'declining':0.2,'stable_median_ratio':0.1,'peak_ratio':0.7,'seasonal_ratio':1.2,'seasonal_years':3,'seasonal_tolerance_weeks':3},'browser_concurrency':2,'poll_seconds':60,'public_dns':'system'}))
    source_snapshot = tmp_path / 'research-snapshot'
    databases = [source]
    if fault == "auxiliary":
        cache = tmp_path/"translation.sqlite3"
        with sqlite3.connect(cache) as connection:
            connection.execute("CREATE TABLE translations(key TEXT PRIMARY KEY,value TEXT NOT NULL,created REAL NOT NULL)")
            connection.execute("INSERT INTO translations VALUES(?,?,?)",("fixture-key",'{ "text" : null }',1234.25))
        databases.append(cache)
    create_snapshot(source_snapshot,databases=databases,object_roots=[source_root],key_files=[namespace,business])
    main_snapshot = tmp_path / 'main-snapshot'
    from db import Base
    from sqlalchemy import create_engine
    unprepared = tmp_path/'unprepared-main.db'
    engine = create_engine(f'sqlite:///{unprepared}')
    Base.metadata.create_all(engine)
    engine.dispose()
    create_snapshot(main_snapshot,databases=[unprepared])
    for snap in (source_snapshot,main_snapshot):
        snap.with_suffix('.anchor').write_text(digest(snap/'manifest.json'))
        snap.with_suffix('.anchor').chmod(0o600)
    plan = {'version':1,'source_database':'databases/0.db','main_database':'databases/0.db','evidence_root':'objects/0','namespace_file':'keys/0/key','business_settings_file':'keys/1/key','original_evidence_root':'/original/private/root','configuration':{}}
    if fault == 'auxiliary':
        plan['auxiliary_databases'] = [{'database':'databases/1.db','active_table_mapping':{'translations':'research_translation_cache'}}]
    plan_file = source_snapshot.with_suffix('.plan.json')
    plan_file.write_text(json.dumps(plan))
    plan_file.chmod(0o600)
    destination = tmp_path / 'rehearsal'
    if fault == 'schema-interrupt':
        import scripts.full_merge.rehearse as module
        real_write = module._write_private
        def interrupt(path, raw):
            if path.name == 'schema-prepared.json':
                raise KeyboardInterrupt
            return real_write(path,raw)
        monkeypatch.setattr(module,'_write_private',interrupt)
        with pytest.raises(KeyboardInterrupt):
            rehearse(source_snapshot,main_snapshot,destination)
        monkeypatch.setattr(module,'_write_private',real_write)
    result = rehearse(source_snapshot,main_snapshot,destination)
    if fault == 'auxiliary':
        assert raw_rows(destination/'history.db','research_translation_cache') == [{'key':'fixture-key','value':'{ "text" : null }','created':1234.25}]
    assert result['verified'] and result['mismatches'] == []
    assert (destination/'research/keys/evidence-signing.key').read_bytes() == bytes(range(32))
    assert (destination/'research/keys/evidence-namespace.json').read_bytes() == namespace.read_bytes()
    assert (destination/'research/keys/business-settings.json').read_bytes() == business.read_bytes()
    assert (destination/'research/keys/path-map.json').is_file()
    assert rehearse(source_snapshot,main_snapshot,destination) == result
    with sqlite3.connect(destination/'history.db') as c:
        assert c.execute('SELECT raw FROM legacy_events').fetchone()[0] == '{"signature":"original","path":"/original/private/root"}'
    before = digest(destination/'history.db')
    namespace.write_bytes(b'different') # Original live inputs are not used by rehearsal.
    assert rehearse(source_snapshot,main_snapshot,destination) == result
    assert digest(destination/'history.db') == before
    (source_snapshot/'keys/0/key').write_bytes(b'corrupt')
    with pytest.raises(ValueError,match='backup'):
        rehearse(source_snapshot,main_snapshot,destination)


def test_all_registered_source_tables_and_indexes_are_preserved(migration, tmp_path):
    from backend.migrations.full_merge_v1 import research_metadata
    from scripts.full_merge.import_data import import_research
    from sqlalchemy import create_engine
    source,candidate,manifest = migration
    engine = create_engine(f'sqlite:///{source}')
    metadata = research_metadata()
    metadata.create_all(engine)
    engine.dispose()
    # Populate every source table with raw values; this detects omitted Job10/usage/cache/outbox.
    with sqlite3.connect(source) as c:
        for table in metadata.sorted_tables:
            columns = c.execute('PRAGMA table_info("'+table.name+'")').fetchall()
            values = []
            for _,name,kind,required,default,primary in columns:
                if 'INT' in kind or 'NUMERIC' in kind:
                    value = 1
                elif name == 'project_id':
                    value = 'a83ba4c9-3ec7-4041-8aba-dcb9ca274497'
                elif name == 'id' and table.name == 'workbench_projects':
                    value = 'a83ba4c9-3ec7-4041-8aba-dcb9ca274497'
                elif name in {'id','lease_token','job_id'} or name.endswith('_id'):
                    value = 'a83ba4c93ec740418abadcb9ca274497'
                elif name in {'created_at','updated_at','available_at','expires_at','lease_until','finished_at','started_at','observed_at'}:
                    value = '2020-01-01T12:04:05.123456+00:00'
                elif 'INT' in kind or 'NUMERIC' in kind:
                    value = 1
                elif kind == 'JSON':
                    value = '{ "fixture" : [null, 1], "ai_usage": {"2020-01-01":11} }'
                elif required or primary:
                    value = 'fixture'
                else:
                    value = None
                values.append(value)
            c.execute('INSERT INTO "'+table.name+'" VALUES('+','.join('?' for _ in columns)+')',values)
    manifest.update(source_database_sha256=digest(source),source_stats=database_stats(source))
    result = import_research(source,candidate,manifest)
    assert result['verified'] and set(metadata.tables).issubset(database_stats(candidate)['tables'])
    assert all(database_stats(candidate)['tables'][n] == manifest['source_stats']['tables'][n] for n in metadata.tables)


def test_copy_interruption_resumes_and_refuses_unexpected_symlink(objects, monkeypatch, tmp_path):
    import scripts.full_merge.copy_objects as module
    source,staging,manifest = objects
    original = module.shutil.copyfileobj
    calls = 0
    def interrupt(src,dst):
        nonlocal calls
        calls += 1
        if calls == 2:
            dst.write(b'partial')
            raise KeyboardInterrupt
        original(src,dst)
    monkeypatch.setattr(module.shutil,'copyfileobj',interrupt)
    with pytest.raises(KeyboardInterrupt):
        module.copy_objects(source,staging,manifest)
    monkeypatch.setattr(module.shutil,'copyfileobj',original)
    assert module.copy_objects(source,staging,manifest)['verified']
    (staging/'unexpected').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError,match='symlink'):
        module.copy_objects(source,staging,manifest)


def test_original_path_read_mapping_cannot_escape(objects, tmp_path):
    from scripts.full_merge.rehearse import resolve_original_evidence_path
    source,_,manifest = objects
    root = tmp_path/'mapped'
    (root/'keys').mkdir(parents=True)
    (root/'evidence').mkdir(mode=0o700)
    path = root/'keys/path-map.json'
    path.write_text('{"version":1,"original_evidence_root":"/original/private/root"}')
    path.chmod(0o600)
    from scripts.full_merge.copy_objects import copy_objects
    copy_objects(source,root/'evidence',manifest)
    entry = next(e for e in manifest['files'] if e['path'].endswith('/body'))
    actual = resolve_original_evidence_path(Path('/original/private/root')/entry['path'],root)
    assert actual.read_bytes() == (source/entry['path']).read_bytes()
    for path in (Path('/etc/passwd'),Path('/original/private/root/../keys/private')):
        with pytest.raises(ValueError):
            resolve_original_evidence_path(path,root)


def test_auxiliary_translation_cache_preserves_raw_rows(migration, tmp_path):
    from scripts.full_merge.import_data import import_research
    source,candidate,manifest = migration
    cache = tmp_path/'cache.sqlite3'
    with sqlite3.connect(cache) as c:
        c.execute('CREATE TABLE translations(key TEXT PRIMARY KEY,value TEXT NOT NULL,created REAL NOT NULL)')
        c.execute('INSERT INTO translations VALUES(?,?,?)',('raw-hash','{ "reading": "fixture", "null":null }',1234.25))
    manifest['auxiliary_databases'] = [{'path':str(cache),'sha256':digest(cache),'stats':database_stats(cache),'active_table_mapping':{'translations':'research_translation_cache'}}]
    assert import_research(source,candidate,manifest)['verified']
    assert database_stats(candidate)['tables']['translations'] == database_stats(cache)['tables']['translations']
    assert database_stats(candidate)['tables']['research_translation_cache'] == database_stats(cache)['tables']['translations']
    assert import_research(source,candidate,manifest)['verified']


def test_readonly_native_authenticated_read_and_original_main_endpoint(migration, tmp_path):
    import asyncio
    from scripts.full_merge.rehearse import authenticated_candidate_read, benchmark_main_reads
    source,candidate,manifest = migration
    root = tmp_path/'runtime'
    root.mkdir(mode=0o700)
    (root/'keys').mkdir(mode=0o700)
    namespace = root/'keys/evidence-namespace.json'
    namespace.write_text('{"version":1,"evidence_bucket":"fixture-bucket","collector_version":"fixture-v1"}')
    namespace.chmod(0o600)
    before = digest(candidate)
    result = asyncio.run(authenticated_candidate_read(candidate,root))
    assert result == {'authenticated':True,'unauthenticated_refused':True,'readonly':True,'projects':0}
    main = tmp_path/'main.db'
    main.write_bytes(candidate.read_bytes())
    stats = benchmark_main_reads(main,candidate,samples=40)
    assert stats['samples'] == 40 and stats['response_hash_equal'] and stats['readonly']
    assert stats['main_p95_ms'] > 0 and stats['candidate_p95_ms'] > 0
    assert digest(candidate) == before


def test_reentry_refuses_changed_main_rows(migration):
    from scripts.full_merge.import_data import import_research
    source,candidate,manifest = migration
    import_research(source,candidate,manifest)
    with sqlite3.connect(candidate) as connection:
        connection.execute("UPDATE analysis_history SET data='changed' WHERE id=71")
    with pytest.raises(ValueError,match='candidate content'):
        import_research(source,candidate,manifest)


@pytest.mark.parametrize('enabled', [1, -1, 2, None, '0', False, 'missing'])
def test_archive_provider_requires_explicit_disabled_integer_atomically(migration, tmp_path, monkeypatch, enabled):
    from scripts.full_merge.import_data import import_research
    source,candidate,manifest = migration
    defaults = provider_rows(tmp_path,monkeypatch)
    legacy = dict(defaults['providers'][0],id=29,incarnation_id='archive-fixture',name='Archive',enabled=enabled)
    if enabled == 'missing':
        legacy.pop('enabled')
    manifest['configuration'] = {'main_effective_defaults':defaults,'research_ai_providers':[legacy]}
    before = database_stats(candidate)
    with pytest.raises(ValueError,match='disabled archive'):
        import_research(source,candidate,manifest)
    assert database_stats(candidate) == before


def test_archive_provider_cannot_receive_effective_default_binding(migration, tmp_path, monkeypatch):
    from scripts.full_merge.import_data import import_research
    source,candidate,manifest = migration
    defaults = provider_rows(tmp_path,monkeypatch)
    legacy = dict(defaults['providers'][0],id=29,incarnation_id='archive-fixture',name='Archive',enabled=0)
    defaults['bindings'][0]['provider_config_id'] = 29
    manifest['configuration'] = {'main_effective_defaults':defaults,'research_ai_providers':[legacy]}
    before = database_stats(candidate)
    with pytest.raises(ValueError,match='unbound archive'):
        import_research(source,candidate,manifest)
    assert database_stats(candidate) == before


@pytest.mark.parametrize('change', ['enabled','bound'])
def test_reentry_explicitly_refuses_activated_archive(migration, tmp_path, monkeypatch, change):
    from scripts.full_merge.import_data import import_research
    source,candidate,manifest = migration
    defaults = provider_rows(tmp_path,monkeypatch)
    legacy = dict(defaults['providers'][0],id=29,incarnation_id='archive-fixture',name='Archive',enabled=0)
    manifest['configuration'] = {'main_effective_defaults':defaults,'research_ai_providers':[legacy]}
    import_research(source,candidate,manifest)
    with sqlite3.connect(candidate) as connection:
        if change == 'enabled':
            connection.execute('UPDATE ai_provider_configs SET enabled=1 WHERE id=29')
        else:
            connection.execute("UPDATE ai_capability_bindings SET provider_config_id=29 WHERE capability='text'")
    before = digest(candidate)
    with pytest.raises(ValueError,match='archive'):
        import_research(source,candidate,manifest)
    assert digest(candidate) == before
