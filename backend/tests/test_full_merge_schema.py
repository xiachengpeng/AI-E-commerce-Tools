"""Temporary-only schema preparation and shared SQLite regression fixtures."""
import asyncio
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from db import Base, enable_sqlite_foreign_keys
from services.research_repository import migrate
from sqlalchemy import create_engine, text

from backend.migrations.full_merge_v1 import prepare_schema, research_metadata


@pytest.fixture
def candidate(tmp_path):
    path = tmp_path / 'candidate.db'
    engine = create_engine(f'sqlite:///{path}')
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for name, table in Base.metadata.tables.items():
            values = {}
            if name == 'ai_provider_configs':
                values = {'id':91, 'name':'synthetic-provider', 'protocol':'gemini', 'api_key':'synthetic-key', 'text_model':'synthetic-model'}
            elif name == 'ai_capability_bindings':
                values = {'capability':'text', 'provider_config_id':91}
            elif name == 'storage_configs':
                values = {'id':92, 'storage_type':'r2'}
            elif name == 'square_redraw_items':
                values = {'batch_id':1}
            elif name == 'app_settings':
                values = {'key':'preserved', 'value':{'synthetic':True}}
            conn.execute(table.insert().values(**values))
    engine.dispose()
    migrate(path)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO analysis_history(id,timestamp,query_url,data) VALUES(71,'2020-01-02 03:04:05','synthetic','{}')")
        conn.execute("INSERT INTO research_links VALUES('synthetic-link','fixture','{}','US',1,'[]')")
        conn.execute("INSERT INTO research_import_events VALUES('synthetic-event','digest','synthetic-link','{}','2020-01-02')")
        conn.execute("INSERT INTO app_settings(key,value,updated_at) VALUES('synthetic','{}','2020-01-02')")
    return path


def snapshot(path):
    with sqlite3.connect(path) as conn:
        names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        return {n: conn.execute('SELECT * FROM "' + n + '"').fetchall() for n in names}


def test_preserves_old_tables_and_idempotence(candidate):
    before = snapshot(candidate)
    assert len(before) == 18
    result = prepare_schema(candidate, backup_verified=True)
    after = snapshot(candidate)
    assert all(after[n] == rows for n, rows in before.items())
    assert set(research_metadata().tables).issubset(after)
    assert result['revision'] == 1
    assert after['full_merge_schema'] == [(1, 1)]
    assert prepare_schema(candidate, backup_verified=True) == result
    assert snapshot(candidate) == after


@pytest.mark.parametrize('verified', [False, None, 1, 'true'])
def test_backup_gate(candidate, verified):
    before = snapshot(candidate)
    with pytest.raises(ValueError, match='backup'):
        prepare_schema(candidate, backup_verified=verified)
    assert snapshot(candidate) == before


def test_unknown_revision_and_partial_schema_refused(candidate):
    with sqlite3.connect(candidate) as conn:
        conn.execute('CREATE TABLE full_merge_schema(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)')
        conn.execute('INSERT INTO full_merge_schema VALUES(1,99)')
    before = snapshot(candidate)
    with pytest.raises(ValueError, match='revision'):
        prepare_schema(candidate, backup_verified=True)
    assert snapshot(candidate) == before


def test_no_implicit_file_or_relative_path(tmp_path):
    with pytest.raises(ValueError):
        prepare_schema(tmp_path / 'absent.db', backup_verified=True)
    with pytest.raises(ValueError):
        prepare_schema(__import__('pathlib').Path('candidate.db'), backup_verified=True)
    assert not (tmp_path / 'absent.db').exists()


@pytest.mark.asyncio
async def test_engine_pragmas_and_concurrent_writes(candidate, record_property):
    prepare_schema(candidate, backup_verified=True)
    from rabbit_hole.persistence.sql import create_engine as async_engine
    from rabbit_hole.persistence.sql import write_transaction
    sync = create_engine(f'sqlite:///{candidate}', connect_args={'timeout': 30})
    enable_sqlite_foreign_keys(sync)
    research = async_engine(f'sqlite+aiosqlite:///{candidate}', initialize_file=False)
    expected = [2, 1, 'wal', 30000]
    pragmas = ['synchronous', 'foreign_keys', 'journal_mode', 'busy_timeout']
    with sync.connect() as c:
        assert [c.exec_driver_sql('PRAGMA ' + p).scalar() for p in pragmas] == expected
        assert c.exec_driver_sql('PRAGMA database_list').fetchone()[2] == str(candidate)
    async with research.connect() as c:
        assert [(await c.exec_driver_sql('PRAGMA ' + p)).scalar() for p in pragmas] == expected
        assert (await c.exec_driver_sql('PRAGMA database_list')).fetchone()[2] == str(candidate)
    def history(i):
        with sync.begin() as c:
            c.execute(text('INSERT INTO analysis_history(id,query_url) VALUES(:id,:url)'), {'id':1000+i,'url':'synthetic'})
    async def usage(i):
        async with write_transaction(research) as c:
            await c.execute(text("INSERT INTO daily_usage(market,day,scans) VALUES(:market,'2026-01-01',1)"), {'market':f'T{i}'})
    start = time.perf_counter()
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            loop = asyncio.get_running_loop()
            await asyncio.gather(*(loop.run_in_executor(pool, history, i) for i in range(40)), *(usage(i) for i in range(40)))
        with sync.connect() as c:
            assert c.scalar(text('SELECT count(*) FROM analysis_history WHERE id>=1000')) == 40
            assert c.scalar(text('SELECT count(*) FROM daily_usage')) == 40
            assert c.scalar(text('SELECT count(*) FROM runtime_jobs WHERE failure_code IS NOT NULL')) == 0
        record_property('synthetic_80_writes_ms', round((time.perf_counter()-start)*1000, 2))
    finally:
        await research.dispose()
        sync.dispose()


def test_transaction_rolls_back_all_new_tables(candidate, monkeypatch):
    from backend.migrations import full_merge_v1
    before = snapshot(candidate)
    def fail(*args, **kwargs):
        raise RuntimeError('synthetic DDL failure')
    monkeypatch.setattr(full_merge_v1.metadata, 'create_all', fail)
    with pytest.raises(RuntimeError):
        prepare_schema(candidate, backup_verified=True)
    assert snapshot(candidate) == before


@pytest.mark.parametrize('revision', [2, 3])
def test_later_known_revisions_preserved(candidate, revision):
    prepare_schema(candidate, backup_verified=True)
    with sqlite3.connect(candidate) as conn:
        conn.execute('UPDATE full_merge_schema SET revision=?', (revision,))
    assert prepare_schema(candidate, backup_verified=True)['revision'] == revision


@pytest.fixture
def backup_report(candidate, tmp_path):
    import hashlib
    import json

    from scripts.full_merge.backup import create_snapshot
    directory = tmp_path / 'snapshot'
    create_snapshot(directory, databases=[candidate])
    report = tmp_path / 'operator-report.json'
    report.write_text(json.dumps({'version':1, 'snapshot_directory':str(directory),
        'manifest_sha256':hashlib.sha256((directory / 'manifest.json').read_bytes()).hexdigest(),
        'verified':True, 'integrity_verified':True, 'completeness_verified':True, 'restore_verified':True}))
    report.chmod(0o600)
    return report


def test_cli_verified_restored_candidate(candidate, backup_report):
    import subprocess
    import sys
    result = subprocess.run([sys.executable, '-m', 'backend.migrations.full_merge_v1',
        '--database', str(candidate), '--prepare-schema', '--backup-report', str(backup_report)], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert snapshot(candidate)['full_merge_schema'] == [(1,1)]


@pytest.mark.parametrize('failure', ['gate', 'anchor', 'mismatch', 'public', 'symlink', 'malformed'])
def test_cli_backup_report_fail_closed(candidate, backup_report, failure):
    import json

    from backend.migrations.full_merge_v1 import verify_backup_report
    report = json.loads(backup_report.read_text())
    if failure == 'gate':
        report['completeness_verified'] = False
    elif failure == 'anchor':
        report['manifest_sha256'] = '0'*64
    elif failure == 'mismatch':
        with sqlite3.connect(candidate) as conn:
            conn.execute("UPDATE analysis_history SET query_url='changed'")
    elif failure == 'public':
        backup_report.chmod(0o644)
    elif failure == 'symlink':
        linked = backup_report.with_name('linked.json')
        linked.symlink_to(backup_report)
        backup_report = linked
    if failure in ('gate', 'anchor'):
        backup_report.write_text(json.dumps(report))
    if failure == 'malformed':
        backup_report.write_text('[]')
    before = snapshot(candidate)
    with pytest.raises(ValueError):
        verify_backup_report(candidate, backup_report)
    assert snapshot(candidate) == before


def test_pragma_failures_propagate_and_cursor_closes():
    from unittest.mock import Mock
    engine = create_engine('sqlite:///:memory:')
    enable_sqlite_foreign_keys(engine)
    dbapi = Mock()
    dbapi.cursor.return_value.execute.side_effect = RuntimeError('synthetic pragma failure')
    listener = list(engine.pool.dispatch.connect)[-1]
    with pytest.raises(RuntimeError, match='synthetic pragma failure'):
        listener(dbapi, None)
    dbapi.cursor.return_value.close.assert_called_once()
    engine.dispose()


def test_old_schema_sql_and_performance_fixture(candidate, record_property):
    def schema():
        with sqlite3.connect(candidate) as c:
            return dict(c.execute("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index')"))
    before = schema()
    def latency():
        start = time.perf_counter()
        with sqlite3.connect(candidate) as c:
            for _ in range(100):
                c.execute('SELECT name,protocol,enabled FROM ai_provider_configs').fetchall()
        return round((time.perf_counter()-start)*1000/100, 4)
    record_property('synthetic_config_select_before_ms', latency())
    prepare_schema(candidate, backup_verified=True)
    record_property('synthetic_config_select_after_ms', latency())
    after = schema()
    assert all(after[name] == sql for name, sql in before.items())


def test_synthetic_config_api_performance(candidate, record_property):
    from db import get_db
    from fastapi.testclient import TestClient
    from main import app
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(f'sqlite:///{candidate}', connect_args={'check_same_thread':False})
    enable_sqlite_foreign_keys(engine)
    sessions = sessionmaker(bind=engine)
    def dependency():
        with sessions() as session:
            yield session
    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = dependency
    client = TestClient(app)
    def latency():
        start = time.perf_counter()
        for _ in range(20):
            response = client.get('/config')
            assert response.status_code == 200
            assert response.json()['TEXT_ROUTE']['name'] == 'synthetic-provider'
        return round((time.perf_counter()-start)*1000/20, 2)
    try:
        record_property('synthetic_config_api_before_ms', latency())
        prepare_schema(candidate, backup_verified=True)
        record_property('synthetic_config_api_after_ms', latency())
    finally:
        client.close()
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous
        engine.dispose()


@pytest.mark.parametrize('damage', ['column', 'unique', 'foreign_key', 'index', 'check'])
def test_existing_revision_rejects_structural_damage(candidate, damage):
    from models.full_merge import metadata as merge_metadata
    from sqlalchemy import ForeignKeyConstraint, MetaData, UniqueConstraint

    prepare_schema(candidate, backup_verified=True)
    engine = create_engine(f'sqlite:///{candidate}')
    if damage == 'column':
        with engine.begin() as c:
            c.exec_driver_sql('ALTER TABLE daily_usage DROP COLUMN scans')
    elif damage == 'index':
        with engine.begin() as c:
            c.exec_driver_sql('DROP INDEX ix_workbench_events_project_created')
    else:
        original = merge_metadata.tables['full_merge_ledger'] if damage == 'check' else research_metadata().tables['runtime_jobs' if damage == 'unique' else 'workbench_events']
        clone = original.to_metadata(MetaData())
        for constraint in list(clone.constraints):
            if (damage == 'unique' and isinstance(constraint, UniqueConstraint)) or (damage == 'foreign_key' and isinstance(constraint, ForeignKeyConstraint)) or (damage == 'check' and constraint.__class__.__name__ == 'CheckConstraint'):
                clone.constraints.remove(constraint)
        if damage == 'foreign_key':
            research_metadata().tables['workbench_projects'].to_metadata(clone.metadata)
        with engine.begin() as c:
            original.drop(c)
            clone.create(c)
            if damage == 'unique':
                c.exec_driver_sql('CREATE UNIQUE INDEX synthetic_unique ON runtime_jobs(idempotency_key)')
                c.exec_driver_sql('DROP INDEX synthetic_unique')
    engine.dispose()
    before = snapshot(candidate)
    with pytest.raises(ValueError, match='schema'):
        prepare_schema(candidate, backup_verified=True)
    assert snapshot(candidate) == before


@pytest.mark.parametrize('revision', [2, 3])
def test_additive_future_schema_is_allowed(candidate, revision):
    prepare_schema(candidate, backup_verified=True)
    with sqlite3.connect(candidate) as c:
        c.execute('UPDATE full_merge_schema SET revision=?', (revision,))
        c.execute('ALTER TABLE daily_usage ADD COLUMN synthetic_future TEXT')
        c.execute('CREATE TABLE synthetic_future (id INTEGER PRIMARY KEY)')
        c.execute('CREATE INDEX synthetic_extra ON daily_usage(synthetic_future)')
    before = snapshot(candidate)
    assert prepare_schema(candidate, backup_verified=True)['revision'] == revision
    assert snapshot(candidate) == before


def test_equivalent_unique_index_preserves_integrity(candidate):
    from sqlalchemy import MetaData, UniqueConstraint

    prepare_schema(candidate, backup_verified=True)
    table = research_metadata().tables['runtime_jobs']
    clone = table.to_metadata(MetaData())
    for constraint in list(clone.constraints):
        if isinstance(constraint, UniqueConstraint):
            clone.constraints.remove(constraint)
    engine = create_engine(f'sqlite:///{candidate}')
    with engine.begin() as c:
        table.drop(c)
        clone.create(c)
        c.exec_driver_sql('CREATE UNIQUE INDEX equivalent_key ON runtime_jobs(idempotency_key)')
    assert prepare_schema(candidate, backup_verified=True)['prepared'] is True
    with engine.begin() as c:
        c.exec_driver_sql('DROP INDEX equivalent_key')
        c.exec_driver_sql("CREATE UNIQUE INDEX partial_key ON runtime_jobs(idempotency_key) WHERE status='synthetic'")
    with pytest.raises(ValueError, match='unique key'):
        prepare_schema(candidate, backup_verified=True)
    engine.dispose()
