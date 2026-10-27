"""Bounded acceptance never replays a write after an uncertain submission."""
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import json
import sqlite3
from uuid import uuid4

import pytest
from scripts.desktop.accept_closeout import AcceptanceSession, protected_rows
from services.research_polling_policy import SessionBudgetStore


def fixture(tmp_path, providers=None):
    db=tmp_path/'source.db'
    with sqlite3.connect(db) as c:
        for table in ('runtime_jobs','feishu_outbox','workbench_actions'):
            c.execute(f'CREATE TABLE {table}(id TEXT PRIMARY KEY,status TEXT,value TEXT)')
            for i in range(3):c.execute(f'INSERT INTO {table} VALUES(?,?,?)',(str(i),'blocked' if table=='workbench_actions' else 'needs_human','original'))
    project=str(uuid4());root=tmp_path/'budgets';root.mkdir(mode=0o700)
    budget=SessionBudgetStore.create(root,str(uuid4()),scope_ids=[project],limits={'text_ai':1},expires_at=datetime.now(UTC)+timedelta(hours=1))
    plan={'schema_version':1,'project_id':project,'expires_at':(datetime.now(UTC)+timedelta(hours=1)).isoformat(),
          'operations':[{'name':'keyword','route':'commands','body':{'action':'add_keyword','version':1,'payload':{'text':'cup'}},'providers':providers or {}}]}
    session=AcceptanceSession.prepare(tmp_path/'acceptance',plan,database=db)
    return session,budget,db


class Client:
    def __init__(self):self.writes=0;self.receipts=[]
    def submit(self, project, route, body):self.writes+=1;return {'id':str(uuid4())}
    def receipt(self, project, operation, submitted):
        self.receipts.append(operation['body']['command_id']);return {'state':'committed','command_id':operation['body']['command_id']}


def test_duplicate_run_and_process_reopen_only_read_original_receipt(tmp_path):
    session,budget,db=fixture(tmp_path);client=Client()
    first=session.run('keyword',budget=budget,client=client,database=db)
    reopened=AcceptanceSession(session.root,expected_plan_digest=session.plan_digest)
    second=reopened.run('keyword',budget=budget,client=client,database=db)
    assert first['state']==second['state']=='committed'
    assert client.writes==1 and len(set(client.receipts))==1
    assert session.verify(database=db)['protected_unchanged'] is True


def test_exhausted_budget_refuses_before_mutation(tmp_path):
    session,budget,db=fixture(tmp_path,{'text_ai':1});client=Client()
    budget.reserve(session.plan['project_id'],'other','text_ai',1)
    with pytest.raises(ValueError,match='budget'):session.run('keyword',budget=budget,client=client,database=db)
    assert client.writes==0


def test_unknown_response_persists_identity_before_send_and_never_replays(tmp_path):
    session,budget,db=fixture(tmp_path);client=Client()
    def uncertain(*args):client.writes+=1;raise TimeoutError('upstream secret must not be stored')
    client.submit=uncertain
    result=session.run('keyword',budget=budget,client=client,database=db)
    assert result['state']=='uncertain'
    assert 'upstream secret' not in (session.root/'state.json').read_text()
    client.receipt=lambda p,o,s:{'state':'not_observed','command_id':o['body']['command_id']}
    reopened=AcceptanceSession(session.root,expected_plan_digest=session.plan_digest)
    result=reopened.run('keyword',budget=budget,client=client,database=db)
    assert result['state']=='not_observed' and client.writes==1
    assert reopened.verify(database=db)['complete'] is False


def test_protected_old_rows_are_exact_readonly_fence(tmp_path):
    session,budget,db=fixture(tmp_path);before=protected_rows(db);client=Client()
    session.run('keyword',budget=budget,client=client,database=db)
    assert protected_rows(db)==before
    with sqlite3.connect(db) as c:c.execute("UPDATE runtime_jobs SET value='changed' WHERE id='1'")
    assert session.verify(database=db)['protected_unchanged'] is False
    with pytest.raises(ValueError,match='protected'):session.run('keyword',budget=budget,client=client,database=db)
    assert client.writes==1


def test_concurrent_calls_are_single_submission(tmp_path):
    session,budget,db=fixture(tmp_path);client=Client()
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _:session.run('keyword',budget=budget,client=client,database=db),range(4)))
    assert client.writes==1


def test_tamper_existing_destination_symlink_and_unbounded_plan_refused(tmp_path):
    session,budget,db=fixture(tmp_path)
    with pytest.raises(FileExistsError):AcceptanceSession.prepare(session.root,session.plan,database=db)
    raw=json.loads((session.root/'plan.json').read_text());raw['project_id']=str(uuid4());(session.root/'plan.json').write_text(json.dumps(raw))
    with pytest.raises(ValueError):AcceptanceSession(session.root,expected_plan_digest=session.plan_digest)
    alias=tmp_path/'alias';alias.symlink_to(session.root)
    with pytest.raises(ValueError):AcceptanceSession(alias,expected_plan_digest=session.plan_digest)
    raw['operations'][0]['providers']={'text_ai':13}
    with pytest.raises(ValueError):AcceptanceSession.prepare(tmp_path/'invalid',raw,database=db)
    assert not (tmp_path/'invalid').exists()

def test_local_client_requires_loaded_matching_runtime_budget_and_never_posts_on_mismatch(tmp_path):
    import httpx
    from scripts.desktop.accept_closeout import LocalClient
    session,budget,db=fixture(tmp_path);requests=[]
    def transport(request):
        requests.append(request)
        assert request.url.path.startswith('/api/research/workbench/v1/')
        if request.url.path.endswith('/session'):return httpx.Response(200,json={'csrf_token':'synthetic-only'})
        return httpx.Response(200,json={'contract_version':1,'budget':{**budget.summary(),'bound_to_api':False}})
    with pytest.raises(ValueError,match='budget'):
        LocalClient(budget=budget,transport=httpx.MockTransport(transport))
    assert all(r.method=='GET' for r in requests)
    assert all(r.url.host=='127.0.0.1' and r.url.port==9503 for r in requests)

def test_local_client_paths_match_actual_native_route_inventory(tmp_path):
    import httpx
    from scripts.desktop.accept_closeout import LocalClient
    from routes.research_workbench import router
    session,budget,db=fixture(tmp_path);seen=[]
    operation=session.plan['operations'][0]
    def transport(request):
        seen.append((request.method,request.url.path))
        if request.url.path.endswith('/session'):return httpx.Response(200,json={'csrf_token':'synthetic-only'})
        if request.url.path.endswith('/runtime-status'):return httpx.Response(200,json={'contract_version':1,'budget':{**budget.summary(),'bound_to_api':True,'bound_to_worker':True}})
        if request.method=='POST':return httpx.Response(200,json={'id':session.plan['project_id']})
        return httpx.Response(200,json={'state':'committed','command_id':operation['body']['command_id']})
    client=LocalClient(budget=budget,transport=httpx.MockTransport(transport))
    try:
        response=client.submit(session.plan['project_id'],'commands',operation['body'])
        assert client.receipt(session.plan['project_id'],operation,response['id'])['state']=='committed'
    finally:client.close()
    for method,path in seen:
        assert any(method in getattr(route,'methods',()) and route.path_regex.fullmatch(path) for route in router.routes),path
