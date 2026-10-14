"""Synthetic ownership barriers; never source credentials or external transports."""
import json
import sqlite3
import time

import pytest


def test_missing_freeze_never_issues_active(tmp_path):
    from scripts.full_merge.ownership import issue_activation
    with pytest.raises(ValueError, match='freeze'):
        issue_activation({'mode': 'active'}, source_frozen=False)


def test_reconciliation_unknown_never_resubmits():
    from scripts.full_merge.reconcile import reconcile_actions
    calls = []
    snapshot = {'actions': [
        {'id': 'a', 'attempt': 2, 'status': 'running', 'payload': {'apify_run': {'submission': 'uncertain'}}},
    ], 'sync_runs': [{'id': 's', 'status': 'running'}], 'outbox': [{'id': 'o', 'status': 'pending'}]}
    result = reconcile_actions(snapshot, lambda item: calls.append(item))
    assert len(result['blocked']) == 3
    assert result['pending'] == result['resolved'] == []
    assert calls == []
    assert result['blocked'][0]['attempt'] == 2


def test_bound_cloud_only_readonly_probe_and_active_stays_pending():
    from scripts.full_merge.reconcile import reconcile_actions
    state = {'id': 'run', 'dataset': 'data', 'owner': {'action_id': 'a', 'input_version': 3, 'fingerprint': 'f'}}
    action = {'id': 'a', 'attempt': 2, 'input_version': 3, 'status': 'running', 'payload': {'fingerprint': 'f', 'apify_run': state}}
    result = reconcile_actions({'actions': [action]}, lambda item: {'run_id': 'run', 'dataset_id': 'data', 'status': 'RUNNING'})
    assert len(result['pending']) == 1
    assert result['unresolved_nonidempotent'] == 1
    wrong = reconcile_actions({'actions': [action]}, lambda item: {'run_id': 'other', 'dataset_id': 'data', 'status': 'SUCCEEDED'})
    assert len(wrong['blocked']) == 1


def fixture_activation(tmp_path):
    from scripts.full_merge.ownership import prepare_ownership, issue_activation
    from services.research_runtime import resolve_runtime_paths
    from backend.migrations.full_merge_v1 import prepare_schema
    db = tmp_path / 'history.db'
    sqlite3.connect(db).close()
    prepare_schema(db, backup_verified=True, target_revision=4)
    with sqlite3.connect(db) as c:
        c.execute("INSERT INTO full_merge_ledger (source_snapshot_id,source_snapshot_sha256,source_database_sha256,source_alembic_revision,cutover_state,captured_at) VALUES ('snap','snapshot-hash','source-hash',NULL,'imported','2026-01-01')")
    root = tmp_path / 'private'
    root.mkdir(mode=0o700)
    paths = resolve_runtime_paths(db, root)
    for folder in (paths.keys_root, paths.evidence_root, paths.lock_root, paths.browser_root):
        folder.mkdir(mode=0o700)
    (paths.keys_root / 'evidence-signing.key').write_bytes(b'e' * 32)
    (paths.keys_root / 'evidence-signing.key').chmod(0o600)
    prepare_ownership(paths, snapshot_id='snap', dataset_id='dataset', owner_generation=1, backup_verified=True)
    report = dict(snapshot_id='snap', dataset_id='dataset', owner_generation=1,
                  target_db_hash=__import__('services.research_activation', fromlist=['candidate_hash']).candidate_hash(db), source_owner_stopped=True,
                  source_writers_frozen=True, unresolved_nonidempotent=0, snapshot_created_at=time.time(),
                  source_frozen_at=time.time()-1, expires_at=time.time()+600, mode='active', keys_root=str(paths.keys_root))
    return paths, issue_activation(report, source_frozen=True)


def test_signed_claim_survives_legitimate_writes_but_not_replay(tmp_path):
    from services.research_activation import validate_activation, claim_activation
    paths, report = fixture_activation(tmp_path)
    assert validate_activation(paths, report)
    claim_activation(paths, report)
    with sqlite3.connect(paths.database) as c:
        c.execute('CREATE TABLE legitimate_write(value INTEGER)')
    assert validate_activation(paths, report)
    tampered = {**report, 'owner_generation': 2}
    assert not validate_activation(paths, tampered)
    with sqlite3.connect(paths.database) as c:
        c.execute("UPDATE full_merge_ledger SET owner_generation=2")
    assert not validate_activation(paths, report)


def test_changed_candidate_and_expired_report_refuse(tmp_path):
    from services.research_activation import validate_activation
    paths, report = fixture_activation(tmp_path)
    assert not validate_activation(paths, {**report, 'expires_at': 0})
    with sqlite3.connect(paths.database) as c:
        c.execute('CREATE TABLE changed(value INTEGER)')
    assert not validate_activation(paths, report)


def test_revision4_explicit_preserves_legacy_and_is_repeatable(tmp_path):
    from backend.migrations.full_merge_v1 import prepare_schema
    db = tmp_path / 'db'
    with sqlite3.connect(db) as c:
        c.execute('CREATE TABLE legacy(value TEXT)')
        c.execute("INSERT INTO legacy VALUES ('kept')")
    prepare_schema(db, backup_verified=True, target_revision=3)
    before = db.read_bytes()
    with pytest.raises(ValueError, match='backup'):
        prepare_schema(db, backup_verified=False, target_revision=4)
    assert db.read_bytes() == before
    assert prepare_schema(db, backup_verified=True, target_revision=4)['revision'] == 4
    assert prepare_schema(db, backup_verified=True, target_revision=4)['revision'] == 4
    with sqlite3.connect(db) as c:
        assert c.execute('SELECT value FROM legacy').fetchall() == [('kept',)]
        assert {'dataset_id', 'owner_generation', 'activation_digest'} <= {r[1] for r in c.execute('PRAGMA table_info(full_merge_ledger)')}


@pytest.mark.asyncio
async def test_external_runtime_uses_real_factories_only_after_activation(tmp_path):
    from services.research_runtime import open_research_runtime
    paths, report = fixture_activation(tmp_path)
    namespace = paths.keys_root / 'evidence-namespace.json'
    namespace.write_text(json.dumps({'version': 1, 'evidence_bucket': 'fixture-bucket', 'collector_version': 'fixture'}))
    namespace.chmod(0o600)
    activation = paths.keys_root / 'activation.json'
    activation.write_text(json.dumps(report))
    activation.chmod(0o600)
    async with open_research_runtime(paths, allow_commands=True, allow_external=True) as runtime:
        assert runtime.non_ai_integrations.allow_external is True
        assert callable(runtime.workbench_services['media_reader'])
        assert callable(runtime.workbench_services['stop_action'])
    from services.research_activation import validate_activation
    assert validate_activation(paths)


def test_consumed_activation_outlives_first_use_window(tmp_path, monkeypatch):
    from services import research_activation
    paths, report = fixture_activation(tmp_path)
    research_activation.claim_activation(paths, report)
    monkeypatch.setattr(research_activation.time, 'time', lambda: report['expires_at'] + 10)
    assert research_activation.validate_activation(paths, report)


def test_uncheckpointed_wal_cannot_bypass_initial_hash(tmp_path):
    from services.research_activation import validate_activation
    paths, report = fixture_activation(tmp_path)
    with sqlite3.connect(paths.database) as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA wal_autocheckpoint=0')
        c.execute('CREATE TABLE wal_change(value TEXT)')
        c.commit()
        assert not validate_activation(paths, report)


def test_logical_candidate_hash_includes_committed_wal_and_claims_same_snapshot(tmp_path):
    from services.research_activation import candidate_hash, claim_activation, validate_activation
    from scripts.full_merge.ownership import issue_activation
    paths, report = fixture_activation(tmp_path)
    with sqlite3.connect(paths.database) as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA wal_autocheckpoint=0')
        c.execute('CREATE TABLE wal_only(value TEXT)')
        c.execute("INSERT INTO wal_only VALUES ('new')")
        c.commit()
        current = candidate_hash(paths.database)
        assert current != report['target_db_hash']
        report = issue_activation({**report, 'target_db_hash': current, 'keys_root': str(paths.keys_root)}, source_frozen=True)
        assert validate_activation(paths, report)
        claim_activation(paths, report)
        assert validate_activation(paths, report)


@pytest.mark.asyncio
async def test_atomic_stop_version_binding_and_pending_abort_prevent_new_attempt(tmp_path):
    import asyncio
    from uuid import UUID
    from sqlalchemy import update
    from services.research_runtime import open_research_runtime
    paths, _report = fixture_activation(tmp_path)
    namespace = paths.keys_root / 'evidence-namespace.json'
    namespace.write_text(json.dumps({'version': 1, 'evidence_bucket': 'fixture-bucket', 'collector_version': 'fixture'}))
    namespace.chmod(0o600)
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        from backend.tests.test_research_worker_local import queued_scan
        from rabbit_hole.application.actions import actions, stop_action, enqueue_action, get_action
        from rabbit_hole.domain.project import WorkbenchError
        project, word, queued = await queued_scan(runtime)
        async with runtime.engine.begin() as c:
            from sqlalchemy import select
            row = (await c.execute(select(actions).where(actions.c.id == UUID(queued['id'])))).mappings().one()
            payload = dict(row['payload'])
            payload['execution_mode'] = 'api'
            payload['apify_run'] = {'id': 'bound-run', 'dataset': 'bound-data', 'owner': {'action_id': queued['id'], 'input_version': row['input_version'], 'fingerprint': payload.get('fingerprint')}}
            await c.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(payload=payload, attempt=1, status='running'))
        started, finish = asyncio.Event(), asyncio.Event()
        async def abort(*args):
            started.set()
            await finish.wait()
        latest = await runtime.store.get(project['id'])
        with pytest.raises(WorkbenchError) as failure:
            await stop_action(runtime.store, project['id'], queued['id'], 1, version=latest['version']-1, cloud_abort=abort)
        assert failure.value.status == 409
        assert not started.is_set()
        stopping = asyncio.create_task(stop_action(runtime.store, project['id'], queued['id'], 1, version=latest['version'], cloud_abort=abort))
        await asyncio.wait_for(started.wait(), 2)
        saved = await get_action(runtime.engine, project['id'], queued['id'])
        assert saved['status'] == 'blocked'
        assert saved['attempt'] == 1
        latest = await runtime.store.get(project['id'])
        with pytest.raises(WorkbenchError) as blocked:
            await enqueue_action(runtime.store, project['id'], {'kind': 'scan', 'version': latest['version'], 'keyword_id': word})
        assert blocked.value.code == 'submission_uncertain'
        finish.set()
        await stopping
        assert (await get_action(runtime.engine, project['id'], queued['id']))['attempt'] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('observed', [
    {'id': 'other', 'defaultDatasetId': 'data', 'status': 'SUCCEEDED'},
    {'id': 'run', 'defaultDatasetId': 'other', 'status': 'SUCCEEDED'},
    {'id': 'run', 'defaultDatasetId': 'data', 'status': 'RUNNING'},
])
async def test_resumed_cloud_validates_response_and_never_auto_aborts(monkeypatch, observed):
    from types import SimpleNamespace
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.integrations import provider_budget
    from rabbit_hole.integrations.collectors.provider_api import ProviderError
    calls = []
    async def transport(client, method, url, **kwargs):
        calls.append(method)
        return {'data': observed}
    async def noop(*args, **kwargs):
        pass
    monkeypatch.setattr(provider_budget, 'request_json', transport)
    monkeypatch.setattr(provider_budget, 'checkpoint', noop)
    action = {'id': 'a', 'input_version': 1, 'keyword_id': 'k', 'payload': {'fingerprint': 'f', 'apify_run': {'id': 'run', 'dataset': 'data', 'owner': {'action_id': 'a', 'input_version': 1, 'fingerprint': 'f'}, 'started_at': '2020-01-01T00:00:00+00:00'}}}
    with pytest.raises(ProviderError):
        await provider_budget.meta(SimpleNamespace(log=noop), action, {'market': 'US', 'keywords': [{'id': 'k', 'text': 'rare phrase'}]}, None, 'synthetic')
    assert calls == ['GET']


@pytest.mark.asyncio
async def test_actual_lifespan_without_handoff_reads_but_refuses_commands(tmp_path):
    from fastapi import FastAPI
    from routes.research_workbench import research_lifespan
    from backend.tests.test_research_workbench_routes import make_client, PREFIX
    paths, _report = fixture_activation(tmp_path)
    namespace = paths.keys_root / 'evidence-namespace.json'
    namespace.write_text(json.dumps({'version': 1, 'evidence_bucket': 'fixture-bucket', 'collector_version': 'fixture'}))
    namespace.chmod(0o600)
    app = FastAPI()
    before = paths.database.read_bytes()
    async with research_lifespan(app, config={'enabled': True, 'mode': 'local'}, database=paths.database, data_root=paths.evidence_root.parent):
        runtime = app.state.research_runtime
        client = make_client(runtime)
        assert client.get(PREFIX + '/projects').status_code == 200
        response = client.post(PREFIX + '/projects', json={'title': 'forbidden', 'direction': 'fixture', 'market': 'US', 'command_id': '00000000-0000-4000-8000-000000000001'})
        assert response.status_code == 503
    assert paths.database.read_bytes() == before


@pytest.mark.asyncio
async def test_commands_cannot_bypass_handoff_with_external_false(tmp_path):
    from services.research_runtime import open_research_runtime
    paths, _report = fixture_activation(tmp_path)
    namespace = paths.keys_root / 'evidence-namespace.json'
    namespace.write_text(json.dumps({'version': 1, 'evidence_bucket': 'fixture-bucket', 'collector_version': 'fixture'}))
    namespace.chmod(0o600)
    with pytest.raises(PermissionError, match='activation'):
        async with open_research_runtime(paths, allow_commands=True):
            pytest.fail('unowned writable runtime')


@pytest.mark.asyncio
async def test_offline_fixture_cannot_enable_external_or_escape_temp(tmp_path, monkeypatch):
    from services.research_runtime import open_research_runtime
    paths, _report = fixture_activation(tmp_path)
    with pytest.raises(PermissionError, match='offline'):
        async with open_research_runtime(paths, allow_commands=True, allow_external=True, offline_commands=True):
            pass
    monkeypatch.setattr('tempfile.gettempdir', lambda: str(tmp_path / 'different-root'))
    with pytest.raises(PermissionError, match='temporary'):
        async with open_research_runtime(paths, allow_commands=True, offline_commands=True):
            pass


def test_snapshot_reader_retains_unknown_jobs_and_budget_without_payload(tmp_path):
    from scripts.full_merge.reconcile import read_snapshot, reconcile_actions
    db = tmp_path / 'source.db'
    with sqlite3.connect(db) as c:
        c.execute('CREATE TABLE runtime_jobs(id TEXT,status TEXT,attempt INTEGER,payload TEXT)')
        c.execute('INSERT INTO runtime_jobs VALUES (?,?,?,?)', ('j','needs_human',3,json.dumps({'secret':'never-export'})))
        c.execute('CREATE TABLE daily_usage(day TEXT, scans INTEGER)')
        c.execute("INSERT INTO daily_usage VALUES ('2026-01-01',2)")
    before = db.read_bytes()
    snapshot = read_snapshot(db)
    result = reconcile_actions(snapshot, lambda _: pytest.fail('unknown job must not probe'))
    assert result['blocked'][0]['id'] == 'j'
    assert result['blocked'][0]['attempt'] == 3
    assert snapshot['daily_usage'][0]['scans'] == 2
    assert 'never-export' not in json.dumps(snapshot)
    assert db.read_bytes() == before


@pytest.mark.parametrize('field,value', [('dataset_id','other'),('owner_generation',2),('snapshot_id','other')])
def test_valid_signature_cannot_cross_dataset_generation_snapshot(tmp_path, field, value):
    from scripts.full_merge.ownership import issue_activation
    from services.research_activation import validate_activation
    paths, report = fixture_activation(tmp_path)
    other = issue_activation({**report, field:value, 'keys_root':str(paths.keys_root)}, source_frozen=True)
    assert not validate_activation(paths, other)


def test_first_use_expires_and_original_evidence_key_remains_distinct(tmp_path, monkeypatch):
    from services import research_activation
    paths, report = fixture_activation(tmp_path)
    assert (paths.keys_root / 'evidence-signing.key').read_bytes() == b'e'*32
    assert (paths.keys_root / 'activation.key').read_bytes() != b'e'*32
    monkeypatch.setattr(research_activation.time, 'time', lambda: report['expires_at']+1)
    assert not research_activation.validate_activation(paths, report)
    with pytest.raises(PermissionError):
        research_activation.claim_activation(paths, report)


@pytest.mark.asyncio
async def test_real_media_factory_reuses_safe_reader_with_fake_transport(tmp_path, monkeypatch):
    import httpx
    from services.research_activation import claim_activation, external_services
    paths, report = fixture_activation(tmp_path)
    saved = paths.keys_root / 'activation.json'
    saved.write_text(json.dumps(report))
    saved.chmod(0o600)
    claim_activation(paths)
    from rabbit_hole.integrations import media_download
    real_client = media_download.MediaUrlClient
    responses = [httpx.Response(200, headers={'content-type':'image/png'}, content=b'fixture'),
                 httpx.Response(302, headers={'location':'http://127.0.0.1/private'})]
    monkeypatch.setattr(media_download, 'MediaUrlClient', lambda **kwargs: real_client(resolver=lambda h,p:['8.8.8.8'], transport=httpx.MockTransport(lambda r:responses.pop(0))))
    reader = external_services(paths, None, None)['media_reader']
    item = {'kind':'image', 'url':'https://fixture.example/image.png'}
    assert await reader(item) == (b'fixture','image/png','png')
    with pytest.raises(media_download.MediaDownloadError):
        await reader(item)


def quarantine_fixture(tmp_path):
    from services.research_activation import candidate_hash, quarantine_inventory
    from scripts.full_merge.ownership import issue_activation
    paths, report = fixture_activation(tmp_path)
    with sqlite3.connect(paths.database) as c:
        for table in ('runtime_jobs', 'feishu_outbox'):
            # Temporary minimal rows still honor all actual table constraints.
            if table == 'runtime_jobs':
                c.execute("INSERT INTO runtime_jobs(id,idempotency_key,kind,status,payload,attempt,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                          ('00000000000040008000000000000001','fixture-job','keyword_scan','needs_human','{}',1,'2026-01-01','2026-01-01','2026-01-01'))
            else:
                c.execute("INSERT INTO feishu_outbox(id,record_id,record_version,payload,status,attempt,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                          ('00000000000040008000000000000002','fixture-record','v1','{}','needs_human',1,'2026-01-01','2026-01-01','2026-01-01'))
    report.update(quarantine=quarantine_inventory(paths.database), unresolved_nonidempotent=2,
                  target_db_hash=candidate_hash(paths.database), keys_root=str(paths.keys_root))
    return paths, issue_activation(report, source_frozen=True)


def test_signed_complete_quarantine_allows_owner_but_keeps_resources_blocked(tmp_path):
    from services.research_activation import claim_activation, validate_activation
    paths, report = quarantine_fixture(tmp_path)
    assert validate_activation(paths, report)
    claim_activation(paths, report)
    with sqlite3.connect(paths.database) as c:
        assert c.execute('SELECT status,attempt FROM runtime_jobs').fetchone() == ('needs_human',1)
    assert validate_activation(paths, report)


@pytest.mark.parametrize('damage', ['missing','ready','payload','attempt','count'])
def test_quarantine_coverage_and_eligibility_cannot_be_forged(tmp_path, damage):
    from services.research_activation import validate_activation, candidate_hash
    from scripts.full_merge.ownership import issue_activation
    paths, report = quarantine_fixture(tmp_path)
    if damage == 'missing': report['quarantine'] = report['quarantine'][:1]
    elif damage == 'count': report['unresolved_nonidempotent'] = 0
    else:
        with sqlite3.connect(paths.database) as c:
            if damage == 'ready': c.execute("UPDATE runtime_jobs SET status='ready'")
            elif damage == 'payload': c.execute("UPDATE runtime_jobs SET payload=' {\"changed\":1}'")
            elif damage == 'attempt': c.execute('UPDATE runtime_jobs SET attempt=2')
        report['target_db_hash'] = candidate_hash(paths.database)
    report['keys_root'] = str(paths.keys_root)
    try:
        signed = issue_activation(report, source_frozen=True)
    except ValueError:
        return
    assert not validate_activation(paths, signed)


@pytest.mark.asyncio
async def test_merged_legacy_requires_context_and_quarantine_blocks_retry(tmp_path):
    from datetime import timedelta
    from uuid import UUID
    from services.research_activation import claim_activation
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine
    from rabbit_hole.persistence.legacy_jobs import JobRepository, OutboxRepository
    paths, report = quarantine_fixture(tmp_path)
    saved = paths.keys_root / 'activation.json'; saved.write_text(json.dumps(report)); saved.chmod(0o600)
    claim_activation(paths)
    engine = create_engine('sqlite+aiosqlite:///' + str(paths.database), initialize_file=False, lock_root=paths.lock_root)
    try:
        with pytest.raises(PermissionError):
            await JobRepository(engine).lease_next('test', lease_for=timedelta(seconds=10))
        engine.update_execution_options(research_ownership_paths=paths)
        assert await JobRepository(engine).lease_next('test', lease_for=timedelta(seconds=10)) is None
        with pytest.raises(PermissionError):
            await JobRepository(engine).requeue(UUID('00000000-0000-4000-8000-000000000001'))
        # A new, unrelated queue entry remains available with verified ownership.
        fresh = await OutboxRepository(engine).enqueue('unrelated','v2',{'fixture':'safe'})
        assert fresh
        from rabbit_hole.domain.legacy import JobPayload, JobKind
        new_job = await JobRepository(engine).enqueue(JobPayload(kind=JobKind.META_SCAN,record_id='unrelated',input_version='v2'))
        claimed = await JobRepository(engine).lease_next('test',lease_for=timedelta(seconds=10))
        assert claimed.id == new_job.id
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_quarantined_outbox_adapter_cannot_reconcile_or_send(tmp_path):
    from types import SimpleNamespace
    from uuid import UUID
    from services.research_activation import claim_activation
    paths, report = quarantine_fixture(tmp_path)
    saved = paths.keys_root/'activation.json'; saved.write_text(json.dumps(report)); saved.chmod(0o600)
    claim_activation(paths)
    from rabbit_hole.persistence.sql import create_engine
    from rabbit_hole.runtime.legacy import FeishuWorkflowAdapter
    engine = create_engine('sqlite+aiosqlite:///'+str(paths.database), initialize_file=False, lock_root=paths.lock_root)
    engine.update_execution_options(research_ownership_paths=paths)
    class NoNetwork:
        base_token = 'fixture'
        def __getattr__(self, name):
            pytest.fail('quarantined resource reached external client')
    try:
        adapter = FeishuWorkflowAdapter(NoNetwork(), engine)
        with pytest.raises(PermissionError):
            await adapter._reconcile(UUID('00000000-0000-4000-8000-000000000002'), SimpleNamespace(action='update',table='fixture',record_id='fixture'), {})
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_quarantine_workbench_retry_denied_unrelated_worker_claims(tmp_path, monkeypatch):
    from uuid import UUID
    from sqlalchemy import update
    from services.research_runtime import open_research_runtime
    from services.research_activation import quarantine_inventory, candidate_hash, claim_activation
    from scripts.full_merge.ownership import issue_activation
    from backend.tests.test_research_worker_local import queued_scan
    paths, report = quarantine_fixture(tmp_path)
    namespace=paths.keys_root/'evidence-namespace.json'
    namespace.write_text(json.dumps({'version':1,'evidence_bucket':'fixture','collector_version':'fixture'})); namespace.chmod(0o600)
    async with open_research_runtime(paths,allow_commands=True,offline_commands=True) as runtime:
        from rabbit_hole.application.actions import actions
        project, word, old = await queued_scan(runtime)
        fresh_project, fresh_word, fresh = await queued_scan(runtime)
        async with runtime.engine.begin() as c:
            await c.execute(update(actions).where(actions.c.id==UUID(old['id'])).values(status='blocked',attempt=1,error_code='submission_uncertain'))
    report.update(quarantine=quarantine_inventory(paths.database),unresolved_nonidempotent=3,
                  target_db_hash=candidate_hash(paths.database),keys_root=str(paths.keys_root))
    report=issue_activation(report,source_frozen=True)
    saved=paths.keys_root/'activation.json';saved.write_text(json.dumps(report));saved.chmod(0o600)
    claim_activation(paths)
    async with open_research_runtime(paths,allow_commands=True) as runtime:
        from rabbit_hole.application.actions import enqueue_action, get_action
        from rabbit_hole.application.runner import WorkbenchRunner
        latest=await runtime.store.get(project['id'])
        with pytest.raises(PermissionError):
            await enqueue_action(runtime.store,project['id'],{'kind':'scan','version':latest['version'],'keyword_id':word})
        runner=WorkbenchRunner(runtime.store,runtime.settings,runtime.evidence_store)
        executed=[]
        async def execute(action, project):
            executed.append(str(action['id']))
            return {'fixture':True}
        monkeypatch.setattr(runner,'execute',execute)
        assert await runner.run_once()
        assert executed==[fresh['id']]
        assert (await get_action(runtime.engine,project['id'],old['id']))['attempt']==1


def test_new_generation_cannot_drop_quarantine_without_private_resolution(tmp_path):
    from scripts.full_merge.ownership import issue_activation
    from services.research_activation import claim_activation
    paths, report=quarantine_fixture(tmp_path)
    saved=paths.keys_root/'activation.json';saved.write_text(json.dumps(report));saved.chmod(0o600)
    claim_activation(paths)
    for generation in (1,2):
        with pytest.raises(ValueError,match='resolution'):
            issue_activation({**report,'owner_generation':generation,'quarantine':[],
                              'unresolved_nonidempotent':0,'keys_root':str(paths.keys_root)},source_frozen=True)


def test_new_generation_release_requires_exact_private_proofs_and_terminal_rows(tmp_path):
    import hashlib
    from scripts.full_merge.ownership import issue_activation
    from services.research_activation import claim_activation, candidate_hash, validate_activation
    paths, old = quarantine_fixture(tmp_path)
    saved=paths.keys_root/'activation.json';saved.write_text(json.dumps(old));saved.chmod(0o600)
    claim_activation(paths)
    proofs=[]
    for index,item in enumerate(old['quarantine']):
        evidence=tmp_path/f'evidence-{index}.json';evidence.write_text('{"fixture_receipt":"confirmed"}');evidence.chmod(0o600)
        proof=tmp_path/f'proof-{index}.json'
        proof.write_text(json.dumps({**item,'verified':True,'outcome':'succeeded','evidence_file':str(evidence),'evidence_sha256':hashlib.sha256(evidence.read_bytes()).hexdigest()}));proof.chmod(0o600)
        proofs.append(str(proof))
    with sqlite3.connect(paths.database) as c:
        c.execute("UPDATE full_merge_ledger SET owner_generation=2,activation_digest=NULL,cutover_state='imported'")
    proposal={**old,'owner_generation':2,'quarantine':[],'unresolved_nonidempotent':0,'resolution_files':proofs,'keys_root':str(paths.keys_root),'target_db_hash':candidate_hash(paths.database)}
    signed=issue_activation(proposal,source_frozen=True)
    assert not validate_activation(paths,signed) # Proof alone never rewrites or clears pending rows.
    with sqlite3.connect(paths.database) as c:
        c.execute("UPDATE runtime_jobs SET status='succeeded'")
        c.execute("UPDATE feishu_outbox SET status='succeeded'")
    signed=issue_activation({**proposal,'target_db_hash':candidate_hash(paths.database)},source_frozen=True)
    assert len(signed['resolutions'])==2
    claim_activation(paths,signed)
    assert validate_activation(paths,signed)
    assert not validate_activation(paths,old)


@pytest.mark.asyncio
async def test_context_with_unconsumed_credential_cannot_write(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine
    from rabbit_hole.persistence.legacy_jobs import OutboxRepository
    paths,report=quarantine_fixture(tmp_path)
    saved=paths.keys_root/'activation.json';saved.write_text(json.dumps(report));saved.chmod(0o600)
    engine=create_engine('sqlite+aiosqlite:///'+str(paths.database),initialize_file=False,lock_root=paths.lock_root)
    engine.update_execution_options(research_ownership_paths=paths)
    try:
        with pytest.raises(PermissionError):
            await OutboxRepository(engine).enqueue('new','v1',{'fixture':1})
    finally:
        await engine.dispose()
