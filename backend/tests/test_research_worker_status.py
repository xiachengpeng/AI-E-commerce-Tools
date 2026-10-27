"""Read-only operational state must not infer liveness from configuration."""
from datetime import UTC,datetime,timedelta
from types import SimpleNamespace
import hashlib
import fcntl
import sqlite3
import pytest
from services.research_worker_status import read_worker_status


def fixture(tmp_path):
    db=tmp_path/'history.db';locks=tmp_path/'locks';locks.mkdir(mode=0o700)
    with sqlite3.connect(db) as c:
        c.execute('CREATE TABLE runtime_health(component TEXT PRIMARY KEY,updated_at TEXT)')
        for table in ('runtime_jobs','feishu_outbox','workbench_actions','workbench_sync_runs'):
            c.execute('CREATE TABLE '+table+'(status TEXT)')
        c.execute("INSERT INTO runtime_jobs VALUES('needs_human')")
    return SimpleNamespace(database=db,lock_root=locks)


def test_active_without_owner_or_heartbeat_is_not_running(tmp_path):
    paths=fixture(tmp_path);before=paths.database.read_bytes()
    result=read_worker_status(paths,{'enabled':True,'worker_mode':'active'})
    assert result['worker_state']=='not_running'
    assert result['queues']['needs_attention']==1
    assert before==paths.database.read_bytes()
    assert list(paths.lock_root.iterdir())==[]


def test_stale_success_cannot_show_healthy_and_live_requires_owner(tmp_path):
    paths=fixture(tmp_path);now=datetime.now(UTC)
    lock=paths.lock_root/(hashlib.sha256(b'727481063').hexdigest()+'.lock')
    lock.write_bytes(b'')
    with lock.open('rb') as held:
        fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with sqlite3.connect(paths.database) as c:
            c.executemany('INSERT INTO runtime_health VALUES(?,?)',[('workbench_worker',now.isoformat()),('feishu_poll_ok',(now-timedelta(hours=1)).isoformat())])
        result=read_worker_status(paths,{'enabled':True,'worker_mode':'active','feishu_polling_enabled':True},now=now)
        assert result['worker_state']=='degraded' and result['polling']['state']=='stale'
        with sqlite3.connect(paths.database) as c:c.execute('UPDATE runtime_health SET updated_at=? WHERE component=?',(now.isoformat(),'feishu_poll_ok'))
        assert read_worker_status(paths,{'enabled':True,'worker_mode':'active','feishu_polling_enabled':True},now=now)['worker_state']=='running'
    assert read_worker_status(paths,{'enabled':True,'worker_mode':'active'},now=now)['worker_state']=='not_running'


def test_unreadable_database_returns_unknown_without_creating_state(tmp_path):
    paths=SimpleNamespace(database=tmp_path/'absent.db',lock_root=tmp_path/'absent-locks')
    result=read_worker_status(paths,{'worker_mode':'paused'})
    assert result['worker_state']=='unknown' and result['queues'] is None
    assert list(tmp_path.iterdir())==[]


def test_paused_owner_is_reported_as_not_yet_stopped(tmp_path):
    paths=fixture(tmp_path);lock=paths.lock_root/(hashlib.sha256(b'727481063').hexdigest()+'.lock');lock.write_bytes(b'')
    with lock.open('rb') as held:
        fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
        result=read_worker_status(paths,{'worker_mode':'paused'})
        assert result['worker_state']=='degraded' and 'owner_still_present' in result['reason_codes']
    assert read_worker_status(paths,{'worker_mode':'paused'})['worker_state']=='paused'


def test_expired_execution_window_is_not_shown_as_live_poll_execution(tmp_path):
    from services.research_polling_policy import TriggerScope
    from dataclasses import asdict
    paths=fixture(tmp_path);now=datetime.now(UTC)
    lock=paths.lock_root/(hashlib.sha256(b'727481063').hexdigest()+'.lock');lock.write_bytes(b'')
    with lock.open('rb') as held:
        fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with sqlite3.connect(paths.database) as c:
            c.executemany('INSERT INTO runtime_health VALUES(?,?)',[('workbench_worker',now.isoformat()),('feishu_poll_ok',now.isoformat())])
        cfg={'enabled':True,'worker_mode':'active','feishu_polling_enabled':True,'feishu_polling_policy':{'mode':'execute','allowed_triggers':[asdict(TriggerScope('关键词库','record','v1','a'*64,'待扫描'))],'max_new_jobs':1,'expires_at':(now-timedelta(minutes=1)).isoformat()}}
        result=read_worker_status(paths,cfg,now=now)
        assert result['polling']['state']=='scope_expired'
        assert result['worker_state']=='degraded'

def test_declared_budget_is_not_reported_bound_until_this_api_loaded_it(tmp_path):
    from uuid import uuid4
    from services.research_polling_policy import SessionBudgetStore
    paths=fixture(tmp_path);root=tmp_path/'closeout-sessions';root.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=['project'],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(hours=1))
    config={'worker_mode':'paused','closeout_session':{'id':budget.session_id,'policy_digest':budget.policy_digest}}
    result=read_worker_status(paths,config)
    assert result['budget']['bound_to_api'] is False
    assert 'budget_restart_required' in result['reason_codes']
    loaded=read_worker_status(paths,config,runtime_budget=budget)
    assert loaded['budget']['bound_to_api'] is True
    assert 'budget_restart_required' not in loaded['reason_codes']
    assert not list(root.glob('*.next'))

def test_worker_budget_binding_is_independent_of_api_binding(tmp_path):
    from uuid import uuid4
    from services.research_polling_policy import SessionBudgetStore,submission_budget_identity
    paths=fixture(tmp_path);root=tmp_path/'closeout-sessions';root.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=['project'],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(hours=1))
    config={'enabled':True,'worker_mode':'active','closeout_session':{'id':budget.session_id,'policy_digest':budget.policy_digest}}
    now=datetime.now(UTC);lock=paths.lock_root/(hashlib.sha256(b'727481063').hexdigest()+'.lock');lock.write_bytes(b'')
    with lock.open('rb') as held:
        fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with sqlite3.connect(paths.database) as c:
            c.executemany('INSERT INTO runtime_health VALUES(?,?)',[('workbench_worker',now.isoformat()),('workbench_budget:none',now.isoformat())])
        result=read_worker_status(paths,config,runtime_budget=budget,now=now)
        assert result['budget']['bound_to_api'] is True
        assert result['budget']['bound_to_worker'] is False
        assert result['worker_state']=='degraded'
        with sqlite3.connect(paths.database) as c:
            c.execute("DELETE FROM runtime_health WHERE component LIKE 'workbench_budget:%'")
            c.execute('INSERT INTO runtime_health VALUES(?,?)',('workbench_budget:'+submission_budget_identity(budget),now.isoformat()))
        result=read_worker_status(paths,config,runtime_budget=budget,now=now)
        assert result['budget']['bound_to_worker'] is True and result['worker_state']=='running'


@pytest.mark.asyncio
async def test_actual_worker_publishes_and_cleans_its_loaded_budget_under_owner(tmp_path):
    import asyncio
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine,initialize_sqlite
    from rabbit_hole.runtime.workbench_worker import serve_workbench
    from sqlalchemy import text
    engine=create_engine('sqlite+aiosqlite:///'+str(tmp_path/'worker.db'))
    await initialize_sqlite(engine)
    identity='b'*64;engine.update_execution_options(workbench_submission_budget_identity=identity)
    entered=asyncio.Event();stop=asyncio.Event()
    class Idle:
        async def loop(self):entered.set();await asyncio.Event().wait()
    task=asyncio.create_task(serve_workbench(engine,Idle(),Idle(),stop=stop))
    try:
        await asyncio.wait_for(entered.wait(),2)
        async with engine.connect() as c:
            rows=(await c.execute(text("SELECT component FROM runtime_health WHERE component LIKE 'workbench_budget:%'"))).scalars().all()
        assert rows==['workbench_budget:'+identity]
    finally:
        stop.set();await asyncio.wait_for(task,2)
        async with engine.connect() as c:assert (await c.execute(text("SELECT COUNT(*) FROM runtime_health WHERE component LIKE 'workbench_budget:%'"))).scalar_one()==0
        await engine.dispose()
