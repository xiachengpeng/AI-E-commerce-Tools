"""Finite approval survives process restarts and counts submitted attempts."""
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC,datetime,timedelta
from pathlib import Path
from uuid import uuid4
import json
import pytest
from services.research_polling_policy import SessionBudgetStore


def store(tmp_path,**options):
    root=tmp_path/'sessions';root.mkdir(mode=0o700)
    return SessionBudgetStore.create(root,str(uuid4()),scope_ids=['scope-a'],
        limits=options.get('limits',{'text_ai':2}),expires_at=datetime.now(UTC)+timedelta(hours=1))


def test_network_attempts_count_individually_and_replay_is_not_permission(tmp_path):
    budget=store(tmp_path)
    assert budget.reserve('scope-a','op', 'text_ai',1).permit_network is True
    assert budget.reserve('scope-a','op', 'text_ai',1).permit_network is False
    assert budget.reserve('scope-a','op', 'text_ai',2).permit_network is True
    with pytest.raises(ValueError,match='budget_exhausted'):budget.reserve('scope-a','op','text_ai',3)


def test_restart_preserves_used_budget(tmp_path):
    budget=store(tmp_path,limits={'text_ai':1})
    budget.reserve('scope-a','op','text_ai',1)
    reopened=SessionBudgetStore(budget.root,budget.session_id,expected_policy_digest=budget.policy_digest)
    with pytest.raises(ValueError,match='budget_exhausted'):reopened.reserve('scope-a','other','text_ai',1)


def test_parallel_last_slot_has_only_one_permission(tmp_path):
    budget=store(tmp_path,limits={'text_ai':1})
    def reserve(i):
        try:return budget.reserve('scope-a',f'op-{i}','text_ai',1).permit_network
        except ValueError:return False
    with ThreadPoolExecutor(max_workers=8) as executor:
        assert sum(executor.map(reserve,range(8)))==1


def test_scope_expiry_and_tampered_policy_refused(tmp_path):
    budget=store(tmp_path)
    with pytest.raises(ValueError,match='scope'):budget.reserve('scope-other','op','text_ai',1)
    raw=json.loads(budget.path.read_text());raw['policy']['limits']['text_ai']=12
    budget.path.write_text(json.dumps(raw))
    with pytest.raises(ValueError,match='policy'):budget.reserve('scope-a','op','text_ai',1)
    with pytest.raises(ValueError):SessionBudgetStore.create(budget.root,str(uuid4()),scope_ids=['a'],limits={'text_ai':1},expires_at=datetime.now(UTC)-timedelta(seconds=1))


def test_symlink_and_excess_approval_are_refused(tmp_path):
    budget=store(tmp_path)
    alias=tmp_path/'alias';alias.symlink_to(budget.root)
    with pytest.raises(ValueError):SessionBudgetStore(alias,budget.session_id,expected_policy_digest=budget.policy_digest)
    with pytest.raises(ValueError):SessionBudgetStore.create(budget.root,str(uuid4()),scope_ids=['a'],limits={'apify':2},expires_at=datetime.now(UTC)+timedelta(hours=1))
    original=budget.path;original.rename(original.with_suffix('.saved'));original.symlink_to(original.with_suffix('.saved'))
    with pytest.raises(ValueError):budget.reserve('scope-a','op','text_ai',1)


@pytest.mark.asyncio
async def test_provider_submission_gate_counts_before_transport_and_rejects_replay(tmp_path):
    from types import SimpleNamespace
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.integrations.provider_budget import reserve_submission
    budget=store(tmp_path,limits={'apify':1})
    runner=SimpleNamespace(submission_budget=budget)
    action={'id':'action-one','project_id':'scope-a','attempt':1}
    reserve_submission(runner,action,'apify','apify-run')
    with pytest.raises(ValueError):reserve_submission(runner,action,'apify','apify-run')
    with pytest.raises(ValueError):reserve_submission(runner,{**action,'id':'action-two'},'apify','apify-run')


@pytest.mark.asyncio
async def test_ai_each_actual_retry_requires_new_budget_admission(tmp_path):
    from services.research_ai_adapter import ResearchAIAdapter
    from models.research_ai import ResearchAIRequest
    from pydantic import BaseModel
    budget=store(tmp_path,limits={'text_ai':1})
    # Explicit non-project direction scope, not arbitrary unbound research calls.
    root=tmp_path/'directions';root.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=['direction'],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(hours=1))
    submitted=[]
    class Output(BaseModel):
        direction:str
    class Router:
        async def generate(self,capability,payload,**kwargs):
            for attempt in [1,2]:
                await kwargs['attempt_observer']({'status':'submitted','network_attempt':attempt})
                submitted.append(attempt)
            return {'candidates':[{'content':{'parts':[{'text':'{"direction":"fixture"}'}]}}]}
    adapter=ResearchAIAdapter(router=Router(),allow_external=True,submission_budget=budget)
    request=ResearchAIRequest(operation='direction',schema=Output,system_instruction='fixture',untrusted_data='fixture',action_id=None,attempt=1)
    with pytest.raises(ValueError) as failure:await adapter.generate(request)
    assert failure.value.code=='budget'
    assert submitted==[1]


def test_configured_budget_requires_private_fixed_root_and_external_anchor(tmp_path):
    from services.research_polling_policy import configured_budget
    root=tmp_path/'private';root.mkdir(mode=0o700);sessions=root/'closeout-sessions';sessions.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(sessions,str(uuid4()),scope_ids=['scope-a'],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(hours=1))
    assert configured_budget(root,{}) is None
    cfg={'closeout_session':{'id':budget.session_id,'policy_digest':budget.policy_digest}}
    loaded=configured_budget(root,cfg)
    assert loaded.session_id==budget.session_id
    with pytest.raises(ValueError):configured_budget(root,{'closeout_session':{**cfg['closeout_session'],'root':'elsewhere'}})


@pytest.mark.asyncio
async def test_observe_never_enqueues_and_execute_uses_exact_version_hash_state(tmp_path):
    from types import SimpleNamespace
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.integrations.feishu import TriggerRecord,protected_input_hash
    from services.research_polling_policy import PollingPolicy,TriggerScope,poll_with_policy
    fields={'人工｜关键词':'fixture'}
    record=TriggerRecord('关键词库','new-record','待扫描','v1',fields)
    calls=[]
    class Source:
        async def list_trigger_records(self):return [record,TriggerRecord('关键词库','old-record','待扫描','v1',fields)]
    class Jobs:
        async def enqueue_with_receipt(self,payload):calls.append(payload);return SimpleNamespace(created=True)
    runtime=SimpleNamespace(feishu=Source(),jobs=Jobs())
    outcome=await poll_with_policy(runtime,PollingPolicy())
    assert outcome.seen==2 and outcome.enqueued==0 and calls==[]
    scope=TriggerScope(record.table,record.record_id,record.version,protected_input_hash(fields),record.state)
    root=tmp_path/'call-budget';root.mkdir(mode=0o700)
    runtime.submission_budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=[scope.budget_scope_id],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(minutes=5))
    policy=PollingPolicy('execute',(scope,),datetime.now(UTC)+timedelta(minutes=5),1)
    outcome=await poll_with_policy(runtime,policy)
    assert outcome.enqueued==1 and len(calls)==1 and calls[0].record_id=='new-record'
    record.fields['人工｜关键词']='changed'
    assert (await poll_with_policy(runtime,policy)).enqueued==0


def test_execute_policy_without_scope_or_deadline_is_denied():
    from services.research_polling_policy import PollingPolicy
    with pytest.raises(ValueError):PollingPolicy('execute')


@pytest.mark.asyncio
async def test_lease_scope_denies_old_queues_before_mutating_rows(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine,initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.domain.legacy import JobPayload,JobKind
    engine=create_engine('sqlite+aiosqlite:///'+str(tmp_path/'jobs.db'))
    await initialize_sqlite(engine)
    try:
        jobs=JobRepository(engine,lease_scope=lambda:())
        payload=JobPayload(kind=JobKind.KEYWORD_SCAN,record_id='new',input_version='v1',protected_input_hash='a'*64,data={})
        new=await jobs.enqueue(payload)
        assert await jobs.lease_next('test',lease_for=timedelta(seconds=30)) is None
        assert (await jobs.get(new.id)).status.value=='ready'
        jobs.lease_scope=lambda:(('new','v1','b'*64,JobKind.KEYWORD_SCAN.value),)
        assert await jobs.lease_next('test',lease_for=timedelta(seconds=30)) is None
        jobs.lease_scope=lambda:(('new','v1','a'*64,JobKind.KEYWORD_SCAN.value),)
        assert (await jobs.lease_next('test',lease_for=timedelta(seconds=30))).id==new.id
    finally:await engine.dispose()


@pytest.mark.asyncio
async def test_real_router_retry_stops_before_second_transport_submission(tmp_path,monkeypatch):
    import httpx
    from unittest.mock import AsyncMock
    from backend.tests.test_ai_router import snapshot
    from services.research_ai_adapter import ResearchAIAdapter
    from services.ai_router import AIRouter,AIObserverError
    from models.research_ai import ResearchAIRequest
    from pydantic import BaseModel
    root=tmp_path/'direction-budget';root.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=['direction'],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(hours=1))
    transport=AsyncMock()
    request=httpx.Request('POST','https://provider.invalid/generate')
    transport.generate.side_effect=httpx.HTTPStatusError('temporary limit',request=request,response=httpx.Response(429,request=request))
    monkeypatch.setattr('services.ai_router.get_adapter',lambda protocol:transport)
    monkeypatch.setattr('services.ai_router.asyncio.sleep',AsyncMock())
    class Output(BaseModel):direction:str
    ai=ResearchAIAdapter(router=AIRouter(),allow_external=True,submission_budget=budget)
    token=ai._snapshot.set(snapshot(max_retries=3))
    try:
        req=ResearchAIRequest(operation='direction',schema=Output,system_instruction='fixture',untrusted_data='fixture',action_id=None,attempt=1)
        with pytest.raises(AIObserverError) as failure:await ai.generate(req)
        assert failure.value.code=='budget'
        assert transport.generate.await_count==1
    finally:ai._snapshot.reset(token)


@pytest.mark.asyncio
async def test_execute_scope_without_approved_call_budget_does_not_enqueue():
    from types import SimpleNamespace
    from services.research_polling_policy import PollingPolicy,TriggerScope,poll_with_policy
    class Source:
        async def list_trigger_records(self):return []
    with pytest.raises(ValueError,match='budget'):
        await poll_with_policy(SimpleNamespace(feishu=Source(),jobs=None),PollingPolicy('execute',(TriggerScope('关键词库','new','v1','a'*64,'待扫描'),),datetime.now(UTC)+timedelta(minutes=1),1))


def test_all_native_runner_factories_inherit_budget_from_injected_ai_adapter():
    from types import SimpleNamespace
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.application.runner import WorkbenchRunner
    budget=object()
    runner=WorkbenchRunner(None,None,None,ai_adapter=SimpleNamespace(submission_budget=budget))
    assert runner.submission_budget is budget


def test_owned_legacy_operator_keeps_same_approved_budget():
    from types import SimpleNamespace
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.cli import DefaultOperatorRuntime
    budget=object()
    runtime=SimpleNamespace(diagnostics=(),engine=object(),business_settings=SimpleNamespace(admission=None),non_ai_integrations=SimpleNamespace(feishu=object()),submission_budget=budget)
    assert DefaultOperatorRuntime(local_runtime=runtime).submission_budget is budget


def test_legacy_submission_rechecks_current_execution_window(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from dataclasses import asdict
    from services.research_polling_policy import PollingPolicy,TriggerScope,require_legacy_execution
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.domain.legacy import JobKind
    scope=TriggerScope('关键词库','record','v1','a'*64,'待扫描')
    root=tmp_path/'finite';root.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=[scope.budget_scope_id],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(hours=1))
    cfg={'closeout_session':{'id':budget.session_id,'policy_digest':budget.policy_digest},'feishu_polling_policy':{'mode':'execute','allowed_triggers':[asdict(scope)],'max_new_jobs':1,'expires_at':(datetime.now(UTC)+timedelta(minutes=5)).isoformat()}}
    monkeypatch.setattr('services.research_client.load_research_config',lambda:cfg)
    payload=SimpleNamespace(record_id='record',input_version='v1',protected_input_hash='a'*64,kind=JobKind.KEYWORD_SCAN)
    require_legacy_execution(budget,payload)
    cfg['feishu_polling_policy']['expires_at']=(datetime.now(UTC)-timedelta(seconds=1)).isoformat()
    with pytest.raises(ValueError):require_legacy_execution(budget,payload)


@pytest.mark.asyncio
async def test_owned_operator_connects_policy_budget_and_durable_queue(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from dataclasses import asdict
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine,initialize_sqlite
    from rabbit_hole.cli import DefaultOperatorRuntime
    from rabbit_hole.integrations.feishu import TriggerRecord,protected_input_hash
    from services.research_polling_policy import TriggerScope
    fields={'人工｜关键词':'fixture'}
    record=TriggerRecord('关键词库','approved','待扫描','v1',fields)
    scope=TriggerScope(record.table,record.record_id,record.version,protected_input_hash(fields),record.state)
    root=tmp_path/'approved-session';root.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=[scope.budget_scope_id],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(minutes=5))
    cfg={'closeout_session':{'id':budget.session_id,'policy_digest':budget.policy_digest},'feishu_polling_policy':{'mode':'execute','allowed_triggers':[asdict(scope)],'max_new_jobs':1,'expires_at':(datetime.now(UTC)+timedelta(minutes=5)).isoformat()}}
    monkeypatch.setattr('services.research_client.load_research_config',lambda:cfg)
    class Source:
        async def list_trigger_records(self):return [record,TriggerRecord('关键词库','old-unapproved','待扫描','v1',fields)]
    engine=create_engine('sqlite+aiosqlite:///'+str(tmp_path/'operator.db'))
    await initialize_sqlite(engine)
    try:
        runtime=SimpleNamespace(diagnostics=(),engine=engine,business_settings=SimpleNamespace(admission=None),non_ai_integrations=SimpleNamespace(feishu=Source()),submission_budget=budget)
        operator=DefaultOperatorRuntime(local_runtime=runtime)
        assert await operator.poll_once()==1
        assert await operator.poll_once()==0
        job=await operator.jobs.lease_next('test',lease_for=timedelta(seconds=30))
        assert job.payload.record_id=='approved'
        cfg['feishu_polling_policy']['mode']='observe'
        assert await operator.jobs.lease_next('test',lease_for=timedelta(seconds=30)) is None
    finally:await engine.dispose()


def test_status_budget_reader_never_creates_lock_or_reserves_calls(tmp_path):
    budget=store(tmp_path,limits={'text_ai':1})
    budget.reserve('scope-a','first','text_ai',1)
    lock=budget.root/(budget.session_id+'.lock');lock.unlink()
    before=budget.path.read_bytes()
    readonly=SessionBudgetStore(budget.root,budget.session_id,expected_policy_digest=budget.policy_digest,read_only=True)
    summary=readonly.summary()
    assert readonly.approved_scopes()==frozenset({'scope-a'})
    assert summary['providers']['text_ai']=={'limit':1,'used':1,'remaining':0}
    with pytest.raises(ValueError):readonly.reserve('scope-a','new','text_ai',1)
    assert not lock.exists() and before==budget.path.read_bytes()

def test_native_runner_with_stale_none_budget_cannot_bypass_new_declared_session(tmp_path,monkeypatch):
    from services.research_runtime import _research_imports
    from services.research_ai_adapter import ResearchAIAdapter
    _research_imports()
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.integrations.provider_budget import reserve_submission
    from types import SimpleNamespace
    budget=store(tmp_path,limits={'apify':0})
    monkeypatch.setattr('services.research_client.load_research_config',lambda:{'data_root':str(budget.root.parent),'closeout_session':{'id':budget.session_id,'policy_digest':budget.policy_digest}})
    runner=WorkbenchRunner(SimpleNamespace(),None,None,ai_adapter=ResearchAIAdapter(allow_external=True))
    with pytest.raises(ValueError) as error:reserve_submission(runner,{'project_id':'scope-a','id':'action','attempt':1},'apify','apify-run')
    assert getattr(error.value,'code',None)=='budget'
    assert budget.summary()['providers']['apify']['used']==0


@pytest.mark.asyncio
async def test_stale_ai_without_loaded_budget_stops_before_real_router_transport(tmp_path,monkeypatch):
    from unittest.mock import AsyncMock
    from backend.tests.test_ai_router import snapshot
    from services.research_ai_adapter import ResearchAIAdapter
    from services.ai_router import AIRouter,AIObserverError
    from models.research_ai import ResearchAIRequest
    from pydantic import BaseModel
    budget=store(tmp_path,limits={'text_ai':0})
    monkeypatch.setattr('services.research_client.load_research_config',lambda:{'data_root':str(budget.root.parent),'closeout_session':{'id':budget.session_id,'policy_digest':budget.policy_digest}})
    transport=AsyncMock();transport.generate.return_value={'text':'{"direction":"fixture"}'}
    monkeypatch.setattr('services.ai_router.get_adapter',lambda protocol:transport)
    class Output(BaseModel):direction:str
    ai=ResearchAIAdapter(router=AIRouter(),allow_external=True)
    token=ai._snapshot.set(snapshot(max_retries=0))
    try:
        with pytest.raises(AIObserverError):await ai.generate(ResearchAIRequest(operation='direction',schema=Output,system_instruction='fixture',untrusted_data='fixture',action_id=None,attempt=1))
        assert transport.generate.await_count==0
    finally:ai._snapshot.reset(token)

def test_unreadable_current_config_never_becomes_unlimited_submission(tmp_path,monkeypatch):
    from services.research_polling_policy import require_current_submission_budget
    config=tmp_path/'research.json';config.write_text('{broken');config.chmod(0o600)
    monkeypatch.setenv('RESEARCH_INTEGRATION_CONFIG',str(config))
    with pytest.raises(ValueError):require_current_submission_budget(None)
