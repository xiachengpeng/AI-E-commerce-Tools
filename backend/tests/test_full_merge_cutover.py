"""Disposable cutover failure fixtures; no real process or external operations."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

import pytest


def private(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    return path


@pytest.fixture
def setup(tmp_path, monkeypatch):
    from scripts.full_merge import cutover as module
    from scripts.full_merge.backup import create_snapshot
    from backend.tests.test_full_merge_ownership import fixture_activation
    area = tmp_path / 'operator'
    area.mkdir(mode=0o700)
    old = tmp_path / 'primary' / 'backend'
    old.mkdir(parents=True)
    live = old / 'history.db'
    with closing(sqlite3.connect(live)) as c, c:
        c.execute('CREATE TABLE marketing(value TEXT)')
        c.execute("INSERT INTO marketing VALUES ('original')")
    candidate = area / 'candidate'
    candidate.mkdir(mode=0o700)
    (candidate / '.full-merge-candidate').write_text('1')
    paths, activation = fixture_activation(candidate)
    import gc
    gc.collect()  # Older shared fixture uses connection transaction contexts.
    private(paths.keys_root / 'evidence-namespace.json', {'version':1,'evidence_bucket':'fixture','collector_version':'fixture'})
    # Namespace is filesystem-only and does not change the signed candidate.
    snapshot = area / 'main-snapshot'
    create_snapshot(snapshot, databases=[live])
    snapshot.with_suffix('.anchor').write_text(hashlib.sha256((snapshot / 'manifest.json').read_bytes()).hexdigest())
    snapshot.with_suffix('.anchor').chmod(0o600)
    source = area / 'source-snapshot'
    create_snapshot(source, databases=[live])
    source.with_suffix('.anchor').write_text(hashlib.sha256((source / 'manifest.json').read_bytes()).hexdigest())
    source.with_suffix('.anchor').chmod(0o600)
    frozen = time.time()-2
    source_anchor=source.with_suffix('.anchor').read_text()
    main_anchor=snapshot.with_suffix('.anchor').read_text()
    private(candidate/'candidate-inputs.json',{'source_anchor':source_anchor,'main_anchor':main_anchor,'plan_sha256':'d'*64})
    with closing(sqlite3.connect(paths.database)) as c,c:
        c.execute('UPDATE full_merge_ledger SET source_snapshot_id=?',(source_anchor,))
    from scripts.full_merge.ownership import issue_activation
    from services.research_activation import candidate_hash
    activation=issue_activation(dict(activation,snapshot_id=source_anchor,keys_root=str(paths.keys_root),
                                    target_db_hash=candidate_hash(paths.database),source_frozen_at=frozen,
                                    snapshot_created_at=frozen+1),source_frozen=True)
    report = private(area / 'activation-report.json', activation)
    plan = {'version':1,'database':str(live),'candidate':str(candidate), 'candidate_database':'history.db',
            'candidate_data_root':'private','data_root':str(tmp_path/'research'),
            'ledger':str(area/'ledger.json'),'recovery_root':str(area/'recovery'),
            'main_snapshot':str(snapshot),'source_snapshot':str(source),'activation_report':str(report),
            'dataset_id':'dataset','owner_generation':1,'snapshot_id':source_anchor,
            'freeze':{'frozen_since':frozen,'snapshot_created_at':frozen+1,'source_state_sha256':'a'*64,
                      'max_age_seconds':600,'autostart_ids':['api','worker']},
            'barrier_probe':{'script':str(area/'probe.py'),'sha256':'b'*64,'python':os.sys.executable},
            'target_phase':'local_readonly'}
    receipt = {'reachable':True,'dataset_id':'dataset','owner_generation':1,'snapshot_id':source_anchor,
               'frozen_since':frozen,'source_state_sha256':'a'*64,'writers':[], 'inflight':[],
               'autostart':{'api':False,'worker':False}}
    monkeypatch.setattr(module, '_observe_barrier', lambda p: dict(receipt, observed_at=time.time()))
    p = private(area/'plan.json',plan)
    return module,p,plan,receipt,live,paths


def test_default_dry_run_does_not_create_ledger_or_replace(setup):
    m,p,plan,receipt,live,paths = setup
    before = live.read_bytes()
    result = m.cutover(p)
    assert result['dry_run'] and result['ready']
    assert not Path(plan['ledger']).exists()
    assert live.read_bytes() == before
    assert paths.database.exists()


def test_closed_database_and_original_path_readonly_then_activate(setup):
    m,p,plan,receipt,live,paths = setup
    assert m.cutover(p, execute=True)['phase'] == 'local_readonly'
    assert not live.is_symlink()
    assert not (Path(plan['data_root'])/'keys/activation.json').exists()
    plan['target_phase'] = 'local_active'
    private(p,plan)
    assert m.cutover(p, execute=True)['phase'] == 'local_active'
    with closing(sqlite3.connect(live)) as c, c:
        assert c.execute('SELECT cutover_state FROM full_merge_ledger').fetchone() == ('activated',)


@pytest.mark.parametrize('mutation', ['unreachable','restart','inflight','expired','generation','hash','autostart'])
def test_stale_or_restart_barrier_blocks_every_swap(setup, mutation):
    m,p,plan,receipt,live,paths = setup
    before = live.read_bytes()
    if mutation == 'unreachable': receipt['reachable'] = False
    if mutation == 'restart': receipt['writers'] = [{'pid':123,'start':'fixture'}]
    if mutation == 'inflight': receipt['inflight'] = [{'status':'unknown'}]
    if mutation == 'expired': plan['freeze']['frozen_since'] = time.time()-1000; private(p,plan)
    if mutation == 'generation': receipt['owner_generation'] = 2
    if mutation == 'hash': receipt['source_state_sha256'] = 'c'*64
    if mutation == 'autostart': receipt['autostart']['worker'] = True
    result = m.cutover(p)
    assert not result['ready']
    with pytest.raises(ValueError): m.cutover(p, execute=True)
    assert live.read_bytes() == before


def test_open_idle_connection_rejected_even_without_transaction(setup):
    m,p,plan,receipt,live,paths = setup
    with sqlite3.connect(live) as connection:
        connection.execute('SELECT * FROM marketing').fetchall()
        assert not m.cutover(p)['ready']
        with pytest.raises(ValueError, match='connection'): m.cutover(p, execute=True)


def test_backup_anchor_tampering_rejected(setup):
    m,p,plan,receipt,live,paths = setup
    Path(plan['main_snapshot']).with_suffix('.anchor').write_text('0'*64)
    assert not m.cutover(p)['ready']


@pytest.mark.parametrize('step', range(1, 7))
def test_power_loss_each_replace_recovers_original_group(setup, monkeypatch, step):
    m,p,plan,receipt,live,paths = setup
    from scripts.full_merge.rollback import rollback
    # Closed, stale sidecars are carried as a group, never reused with new DB.
    Path(str(live)+'-wal').write_bytes(b'old-wal')
    Path(str(live)+'-shm').write_bytes(b'old-shm')
    # No snapshot reads of stale sidecars: make them empty valid leftovers.
    Path(str(live)+'-wal').write_bytes(b'')
    Path(str(live)+'-shm').write_bytes(b'')
    Path(plan['data_root']).mkdir(mode=0o700)
    (Path(plan['data_root'])/'original.txt').write_text('preserve original root')
    original = live.read_bytes()
    original_replace = m._replace
    calls = []
    def crash(source, target):
        original_replace(source, target)
        calls.append((source,target))
        if len(calls) == step: raise KeyboardInterrupt('power loss')
    monkeypatch.setattr(m,'_replace',crash)
    try: m.cutover(p, execute=True)
    except KeyboardInterrupt: pass
    monkeypatch.setattr(m,'_replace',original_replace)
    assert len(calls) == step
    result = rollback(p)
    assert result['phase'] == 'rolled_back'
    assert live.read_bytes() == original
    assert not live.is_symlink()
    assert not (Path(plan['data_root'])/'keys/activation.json').exists()


def test_after_activation_rollback_preserves_new_data_and_never_revives_source(setup):
    m,p,plan,receipt,live,paths = setup
    from scripts.full_merge.rollback import rollback
    m.cutover(p,execute=True)
    plan['target_phase']='local_active'; private(p,plan)
    m.cutover(p,execute=True)
    with closing(sqlite3.connect(live)) as c, c:
        c.execute('CREATE TABLE new_event(value TEXT)')
        c.execute("INSERT INTO new_event VALUES ('preserve')")
    with pytest.raises(ValueError, match='new writes'): rollback(p,preserve_new_writes=False)
    result = rollback(p)
    assert result['phase']=='reconciliation_required'
    assert result['source_restart_allowed'] is False
    with closing(sqlite3.connect(live)) as c, c:
        assert c.execute('SELECT value FROM new_event').fetchall()==[('preserve',)]
    assert Path(result['incremental_snapshot']).is_dir()


def test_duplicate_cutover_owner_rejected(setup):
    import fcntl
    m,p,plan,receipt,live,paths = setup
    lock = Path(plan['ledger']).with_suffix('.lock')
    with lock.open('w') as stream:
        fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with pytest.raises(ValueError,match='owner'): m.cutover(p,execute=True)


def test_snapshot_identity_must_match_independent_source_anchor(setup):
    m,p,plan,receipt,live,paths=setup
    private(Path(plan['candidate'])/'candidate-inputs.json',{'source_anchor':'0'*64,'main_anchor':'0'*64,'plan_sha256':'0'*64})
    assert not m.cutover(p)['ready']


def test_rollback_does_not_need_live_source_or_fresh_activation(setup):
    m,p,plan,receipt,live,paths=setup
    from scripts.full_merge.rollback import rollback
    m.cutover(p,execute=True)
    receipt['reachable']=False
    assert rollback(p)['phase']=='rolled_back'


def test_barrier_restart_between_moves_is_detected_and_recoverable(setup, monkeypatch):
    m,p,plan,receipt,live,paths=setup
    from scripts.full_merge.rollback import rollback
    original=m._replace
    def restart(source,target):
        original(source,target)
        receipt['writers']=[{'pid':123,'start':'new'}]
    monkeypatch.setattr(m,'_replace',restart)
    with pytest.raises(ValueError,match='writers'): m.cutover(p,execute=True)
    monkeypatch.setattr(m,'_replace',original)
    assert rollback(p)['phase']=='rolled_back'


def test_primary_initialization_consumes_handoff_before_marketing_writes(tmp_path):
    from backend.tests.test_full_merge_ownership import fixture_activation
    from services.research_activation import validate_activation
    from services.research_runtime import claim_before_main_initialization
    paths,report=fixture_activation(tmp_path)
    private(paths.keys_root/'activation.json',report)
    assert claim_before_main_initialization(paths.database,config={'enabled':True,'mode':'local'},data_root=paths.evidence_root.parent)
    with closing(sqlite3.connect(paths.database)) as c,c:
        c.execute('CREATE TABLE marketing_after_init(value TEXT)')
    assert validate_activation(paths)


def test_missing_handoff_main_startup_has_no_research_writes(tmp_path):
    from backend.tests.test_full_merge_ownership import fixture_activation
    from services.research_runtime import claim_before_main_initialization
    paths,report=fixture_activation(tmp_path)
    before=paths.database.read_bytes()
    assert not claim_before_main_initialization(paths.database,config={'enabled':True,'mode':'local'},data_root=paths.evidence_root.parent)
    assert paths.database.read_bytes()==before


def test_launcher_local_worker_requires_consumed_handoff_and_stops_only_child(tmp_path, monkeypatch):
    import run
    from backend.tests.test_full_merge_ownership import fixture_activation
    from services.research_activation import claim_activation
    paths,report=fixture_activation(tmp_path)
    private(paths.keys_root/'activation.json',report)
    config={'enabled':True,'mode':'local','worker_mode':'active','data_root':str(paths.evidence_root.parent)}
    assert run.local_worker_command(config,paths.database) is None
    claim_activation(paths)
    command=run.local_worker_command(config,paths.database)
    assert command[1:3]==['-m','services.research_worker']
    assert str(paths.database) in command
    assert run.local_worker_command(dict(config,mode='remote'),paths.database) is None
    assert run.local_worker_command(dict(config,worker_mode='paused'),paths.database) is None
    class Child:
        def __init__(self): self.events=[]
        def poll(self): return None
        def terminate(self): self.events.append('terminate')
        def wait(self,timeout=None): self.events.append('wait')
    child=Child(); run.stop_owned_child(child)
    assert child.events==['terminate','wait']


def test_partial_cutover_blocks_even_direct_main_initialization(tmp_path):
    from services.research_runtime import claim_before_main_initialization
    from backend.tests.test_full_merge_ownership import fixture_activation
    paths,report=fixture_activation(tmp_path)
    ledger=private(tmp_path/'cutover.json',{'phase':'local_readonly','database':str(paths.database)})
    with pytest.raises(ValueError,match='maintenance'):
        claim_before_main_initialization(paths.database,config={'enabled':True,'mode':'local','cutover_ledger':str(ledger)},data_root=paths.evidence_root.parent)


def test_rollback_is_reentrant_after_each_reverse_replace(setup, monkeypatch):
    m,p,plan,receipt,live,paths=setup
    from scripts.full_merge.rollback import rollback
    original=live.read_bytes()
    m.cutover(p,execute=True)
    replace=m._replace
    def crash(source,target):
        replace(source,target)
        raise KeyboardInterrupt('power loss')
    # Repeated invocations progress even when the done record was never saved.
    monkeypatch.setattr(m,'_replace',crash)
    for _ in range(8):
        try:
            if rollback(p)['phase']=='rolled_back': break
        except KeyboardInterrupt: pass
    monkeypatch.setattr(m,'_replace',replace)
    assert rollback(p)['phase']=='rolled_back'
    assert live.read_bytes()==original


def test_real_barrier_collector_requires_pinned_script_and_fresh_nonce(tmp_path):
    from scripts.full_merge.cutover import _observe_barrier
    script=tmp_path/'collector.py'
    script.write_text('import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({"nonce":r["nonce"],"reachable":True}))\n'); script.chmod(0o600)
    plan={'barrier_probe':{'script':str(script),'python':os.sys.executable,'sha256':hashlib.sha256(script.read_bytes()).hexdigest()}}
    assert _observe_barrier(plan)['reachable']
    script.write_text('print("{}")')
    with pytest.raises(ValueError,match='changed'): _observe_barrier(plan)
    plan['barrier_probe']['sha256']=hashlib.sha256(script.read_bytes()).hexdigest()
    with pytest.raises(ValueError,match='stale'): _observe_barrier(plan)


@pytest.mark.parametrize('phase',['prepared','source_frozen','verified','local_readonly'])
def test_phase_receipt_power_loss_restores_without_activation(setup, monkeypatch, phase):
    m,p,plan,receipt,live,paths=setup
    from scripts.full_merge.rollback import rollback
    original=live.read_bytes(); write=m._write
    def crash(path,value):
        write(path,value)
        if value.get('phase')==phase: raise KeyboardInterrupt('power failure')
    monkeypatch.setattr(m,'_write',crash)
    with pytest.raises(KeyboardInterrupt): m.cutover(p,execute=True)
    monkeypatch.setattr(m,'_write',write)
    assert rollback(p)['phase']=='rolled_back'
    assert live.read_bytes()==original


def test_modified_candidate_quarantine_or_generation_refuses_before_swap(setup):
    m,p,plan,receipt,live,paths=setup
    original=live.read_bytes()
    with closing(sqlite3.connect(paths.database)) as c,c:
        c.execute('UPDATE full_merge_ledger SET owner_generation=2')
    assert not m.cutover(p)['ready']
    assert live.read_bytes()==original


def test_backup_and_ownership_helpers_close_all_database_handles(tmp_path):
    from scripts.full_merge.backup import create_snapshot
    from scripts.full_merge.cutover import _closed
    from scripts.full_merge.ownership import prepare_ownership
    from services.research_activation import candidate_hash, validate_activation, claim_activation
    from backend.tests.test_full_merge_ownership import fixture_activation
    paths,report=fixture_activation(tmp_path)
    import gc
    gc.collect()  # Close only the older shared fixture's setup connection.
    prepare_ownership(paths,snapshot_id='snap',dataset_id='dataset',owner_generation=1,backup_verified=True)
    candidate_hash(paths.database)
    assert validate_activation(paths,report)
    claim_activation(paths,report)
    create_snapshot(tmp_path/'backup',databases=[paths.database])
    # No GC between production calls and OS handle inventory: actual lifetime test.
    _closed(paths.database,tmp_path/'backup/databases/0.db')


@pytest.mark.parametrize('point',['activation_intent','credential_published','active_receipt'])
def test_uncertain_activation_never_overwrites_owned_database(setup, monkeypatch, point):
    m,p,plan,receipt,live,paths=setup
    from scripts.full_merge.rollback import rollback
    m.cutover(p,execute=True)
    plan['target_phase']='local_active';private(p,plan)
    write=m._write
    def crash(path,value):
        write(path,value)
        hit=(point=='activation_intent' and value.get('activation_started') and value.get('phase')=='local_readonly'
             or point=='credential_published' and Path(path).name=='activation.json'
             or point=='active_receipt' and value.get('phase')=='local_active')
        if hit:raise KeyboardInterrupt('power failure')
    monkeypatch.setattr(m,'_write',crash)
    with pytest.raises(KeyboardInterrupt):m.cutover(p,execute=True)
    monkeypatch.setattr(m,'_write',write)
    before=live.read_bytes()
    result=rollback(p)
    assert result['phase']=='reconciliation_required'
    assert result['source_restart_allowed'] is False
    assert live.read_bytes()==before


def test_post_activation_repeat_backup_detects_new_rows(setup):
    m,p,plan,receipt,live,paths=setup
    from scripts.full_merge.rollback import rollback
    from scripts.full_merge.backup import database_stats
    m.cutover(p,execute=True)
    plan['target_phase']='local_active';private(p,plan);m.cutover(p,execute=True)
    first=rollback(p)
    with closing(sqlite3.connect(live)) as c,c:c.execute('CREATE TABLE late_increment(value TEXT)')
    second=rollback(p)
    snapshot=Path(second['incremental_snapshot'])/'databases/0.db'
    assert database_stats(snapshot)==database_stats(live)
    assert first['incremental_snapshot']!=second['incremental_snapshot']


def test_pinned_roster_mismatch_rejected_even_with_matching_source_hash(setup):
    m,p,plan,receipt,live,paths=setup
    plan['source_roster_sha256']='f'*64;private(p,plan)
    receipt['roster_sha256']='e'*64
    assert not m.cutover(p)['ready']
