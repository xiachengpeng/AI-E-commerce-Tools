"""Explicit, private acceptance journal. Default prepare; never automatically replay writes.

Actual paid transports remain owned by the application's submission budget and
retry controller. This helper preflights that same budget, writes intent before
one local API submission, and subsequently only checks the original receipt.
It does not enable workers, retry actions, synchronize Feishu, or alter settings.
"""
from __future__ import annotations
from contextlib import contextmanager, closing
from datetime import UTC, datetime
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
from uuid import UUID, uuid4

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from services.research_polling_policy import MAX_APPROVED, SessionBudgetStore, digest

MAX_BYTES=2*1024*1024
TABLES={'runtime_jobs':'needs_human','feishu_outbox':'needs_human','workbench_actions':'blocked'}


def _uuid(value):
    if not isinstance(value,str) or str(UUID(value))!=value:raise ValueError('acceptance_identity_invalid')
    return value


def protected_rows(database:Path, identities=None):
    path=Path(database).absolute()
    if path.is_symlink() or not path.is_file():raise ValueError('acceptance_database_unavailable')
    result={}
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as connection:
        connection.row_factory=sqlite3.Row
        for table,status in TABLES.items():
            if identities is None:
                rows=connection.execute(f'SELECT * FROM {table} WHERE status=?',(status,)).fetchall()
            else:
                wanted=list(identities[table]);rows=[]
                for identity in wanted:
                    rows.extend(connection.execute(f'SELECT * FROM {table} WHERE id=?',(identity,)).fetchall())
            result[table]={str(row['id']):hashlib.sha256(repr(tuple(row)).encode()).hexdigest() for row in rows}
    return result


def _read(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('acceptance_file_not_private')
        raw=stream.read(MAX_BYTES+1)
        if len(raw.encode())>MAX_BYTES:raise ValueError('acceptance_file_too_large')
        return json.loads(raw)


def _write(path,value):
    fd,name=tempfile.mkstemp(prefix=path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(value,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)


def _validate(plan):
    if (not isinstance(plan,dict) or set(plan)!={'schema_version','project_id','expires_at','operations'}
            or plan['schema_version']!=1):raise ValueError('acceptance_plan_invalid')
    _uuid(plan['project_id'])
    expiry=datetime.fromisoformat(plan['expires_at'])
    if expiry.tzinfo is None:raise ValueError('acceptance_expiry_invalid')
    if not isinstance(plan['operations'],list) or not 1<=len(plan['operations'])<=100:raise ValueError('acceptance_operations_invalid')
    from routes.research_workbench import USER_ACTIONS
    names=set();totals={}
    for op in plan['operations']:
        if (not isinstance(op,dict) or set(op)!={'name','route','body','providers'}
                or not isinstance(op['name'],str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}',op['name'])
                or op['name'] in names or op['route'] not in {'commands','actions'}
                or not isinstance(op['body'],dict) or not isinstance(op['providers'],dict)):
            raise ValueError('acceptance_operation_invalid')
        names.add(op['name']);body=op['body']
        if type(body.get('version')) is not int or body['version']<1:raise ValueError('acceptance_version_invalid')
        if op['route']=='commands':
            if set(body)!={'action','version','payload','command_id'} or body['action'] not in USER_ACTIONS or not isinstance(body['payload'],dict):raise ValueError('acceptance_command_invalid')
            _uuid(body['command_id'])
        elif body.get('kind') not in {'scan','landing','trends','keywords','expand','verify'} or any(k in body for k in ('retry','retry_of','fresh_retry_of')):
            raise ValueError('acceptance_action_invalid')
        for provider,count in op['providers'].items():
            if provider not in MAX_APPROVED or type(count)is not int or not 0<count<=MAX_APPROVED[provider]:raise ValueError('acceptance_budget_invalid')
            totals[provider]=totals.get(provider,0)+count
            if totals[provider]>MAX_APPROVED[provider]:raise ValueError('acceptance_budget_invalid')
        if op['route']=='actions' and not op['providers']:raise ValueError('acceptance_budget_missing')
    if len(json.dumps(plan).encode())>MAX_BYTES:raise ValueError('acceptance_file_too_large')
    return plan


class AcceptanceSession:
    def __init__(self,root:Path,*,expected_plan_digest:str):
        self.root=SessionBudgetStore._root(root)
        self.plan=_validate(_read(self.root/'plan.json'))
        self.plan_digest=expected_plan_digest
        if digest(self.plan)!=expected_plan_digest:raise ValueError('acceptance_plan_tampered')
        self.protected=_read(self.root/'protected.json')
        if not isinstance(self.protected,dict) or set(self.protected)!=set(TABLES):raise ValueError('acceptance_protected_invalid')
        state=_read(self.root/'state.json')
        if state.get('plan_digest')!=self.plan_digest:raise ValueError('acceptance_state_invalid')

    @classmethod
    def prepare(cls,root,plan,*,database):
        value=json.loads(json.dumps(plan))
        for op in value.get('operations',[]):
            if op.get('route')=='commands' and 'command_id' not in op.get('body',{}):op['body']['command_id']=str(uuid4())
        _validate(value)
        if datetime.fromisoformat(value['expires_at'])<=datetime.now(UTC):raise ValueError('acceptance_expired')
        baseline=protected_rows(database);root=Path(root).absolute()
        if root.is_symlink() or any(p.is_symlink() for p in root.parents if str(p)!='/var'):raise ValueError('acceptance_root_invalid')
        # Parent must already be a private session directory; no arbitrary root creation.
        SessionBudgetStore._root(root.parent)
        root.mkdir(mode=0o700,exist_ok=False)
        _write(root/'plan.json',value);_write(root/'protected.json',baseline)
        _write(root/'state.json',{'plan_digest':digest(value),'operations':{}})
        return cls(root,expected_plan_digest=digest(value))

    @contextmanager
    def _lock(self):
        SessionBudgetStore._root(self.root)
        fd=os.open(self.root/'acceptance.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(fd)
            if info.st_uid!=os.getuid() or info.st_mode&0o077 or not stat.S_ISREG(info.st_mode):raise ValueError('acceptance_lock_invalid')
            fcntl.flock(fd,fcntl.LOCK_EX);yield
        finally:fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)

    def run(self,name,*,budget,client,database):
        with self._lock():
            # Recheck the immutable external anchor before every local submission.
            if digest(_read(self.root/'plan.json'))!=self.plan_digest:raise ValueError('acceptance_plan_tampered')
            if protected_rows(database,self.protected)!=self.protected:raise ValueError('acceptance_protected_changed')
            op=next((o for o in self.plan['operations'] if o['name']==name),None)
            if op is None:raise ValueError('acceptance_operation_unknown')
            state=_read(self.root/'state.json')
            if state.get('plan_digest')!=self.plan_digest:raise ValueError('acceptance_state_invalid')
            previous=state['operations'].get(name)
            if previous is not None:
                # A crash after intent persistence is an unknown submission, never permission to retry.
                receipt=client.receipt(self.plan['project_id'],op,previous.get('submission'))
                return self._save_receipt(state,name,receipt,previous.get('submission'))
            if datetime.fromisoformat(self.plan['expires_at'])<=datetime.now(UTC):raise ValueError('acceptance_expired')
            if self.plan['project_id'] not in budget.approved_scopes():raise ValueError('acceptance_budget_scope_denied')
            summary=budget.summary()
            if any(summary['providers'].get(p,{}).get('remaining',0)<n for p,n in op['providers'].items()):raise ValueError('acceptance_budget_exhausted')
            # Does not reserve a provider call here: real transport-level hooks own that reservation.
            state['operations'][name]={'state':'intent','at':datetime.now(UTC).isoformat()}
            _write(self.root/'state.json',state)
            submission=None
            try:
                response=client.submit(self.plan['project_id'],op['route'],op['body'])
                if isinstance(response,dict) and isinstance(response.get('id'),str):submission=_uuid(response['id'])
                self._save_receipt(state,name,{'state':'submitted'},submission)
                receipt=client.receipt(self.plan['project_id'],op,submission)
                return self._save_receipt(state,name,receipt,submission)
            except Exception:
                return self._save_receipt(state,name,{'state':'uncertain'},submission)

    def _save_receipt(self,state,name,receipt,submission):
        allowed={'committed','complete','queued','ready','running','blocked','uncertain','not_observed','submitted','failed','stopped','retry_wait'}
        value={'state':receipt.get('state') if isinstance(receipt,dict) and receipt.get('state') in allowed else 'uncertain','at':datetime.now(UTC).isoformat()}
        if submission:value['submission']=submission
        state['operations'][name]=value;_write(self.root/'state.json',state)
        return value

    def verify(self,*,database):
        state=_read(self.root/'state.json');unchanged=protected_rows(database,self.protected)==self.protected
        rows=[state['operations'].get(o['name'],{'state':'not_run'})['state'] for o in self.plan['operations']]
        return {'contract_version':1,'protected_unchanged':unchanged,'operations':len(rows),
                'states':rows,'complete':unchanged and all(r in {'committed','complete'} for r in rows)}


class LocalClient:
    def __init__(self,*,budget,transport=None):
        import httpx
        self.client=httpx.Client(base_url='http://127.0.0.1:9503/api/research/workbench/v1',
                                 timeout=30,follow_redirects=False,trust_env=False,transport=transport)
        response=self.client.get('/session',headers={'Origin':'http://127.0.0.1:9502'})
        response.raise_for_status()
        self.client.headers.update({'Origin':'http://127.0.0.1:9502','X-Research-Token':response.json()['csrf_token']})
        status=self.client.get('/runtime-status');status.raise_for_status()
        data=status.json()
        expected=budget.summary();actual=data.get('budget') or {}
        if data.get('contract_version')!=1 or actual.get('bound_to_api') is not True or any(actual.get(key)!=expected[key] for key in ('providers','expires_at')):
            self.client.close();raise ValueError('acceptance_runtime_budget_not_loaded')

    def submit(self,project,route,body):
        if route=='actions':
            status=self.client.get('/runtime-status');status.raise_for_status()
            if (status.json().get('budget') or {}).get('bound_to_worker') is not True:
                raise ValueError('acceptance_worker_budget_not_loaded')
        response=self.client.post(f'/projects/{_uuid(project)}/{route}',json=body)
        response.raise_for_status();return response.json()

    def receipt(self,project,operation,submission):
        if operation['route']=='commands':
            command=_uuid(operation['body']['command_id'])
            response=self.client.get(f'/projects/{_uuid(project)}/commands/{command}');response.raise_for_status()
            return {'state':response.json().get('state')}
        if not submission:return {'state':'uncertain'}
        response=self.client.get(f'/projects/{_uuid(project)}/actions',params={'limit':100});response.raise_for_status()
        item=next((a for a in response.json().get('actions',[]) if a.get('id')==submission),None)
        return {'state':item['status'] if item else 'not_observed'}

    def close(self):self.client.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--prepare',type=Path,metavar='PLAN_JSON');mode.add_argument('--run',metavar='OPERATION');mode.add_argument('--verify',action='store_true')
    parser.add_argument('--session',type=Path,required=True);parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--plan-digest');parser.add_argument('--research-config',type=Path)
    args=parser.parse_args()
    if args.prepare:
        created=AcceptanceSession.prepare(args.session,json.loads(args.prepare.read_text()),database=args.database)
        print(json.dumps({'prepared':True,'plan_digest':created.plan_digest,'external_calls':0}));return 0
    if not args.run and not args.verify:parser.error('default is prepare: supply --prepare PLAN_JSON; no implicit run')
    if not args.plan_digest:parser.error('an external --plan-digest is required')
    current=AcceptanceSession(args.session,expected_plan_digest=args.plan_digest)
    if args.verify:
        result=current.verify(database=args.database);print(json.dumps(result));return 0 if result['complete'] else 2
    if not args.research_config:parser.error('--run requires --research-config with the approved current budget')
    from services.research_polling_policy import configured_budget
    config=_read(args.research_config);budget=configured_budget(Path(config['data_root']),config)
    if budget is None:raise ValueError('acceptance_budget_not_configured')
    client=LocalClient(budget=budget)
    try:print(json.dumps(current.run(args.run,budget=budget,client=client,database=args.database)))
    finally:client.close()
    return 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print('Acceptance stopped: configuration, identity or data check failed. No automatic replay.',file=sys.stderr)
        raise SystemExit(1)
