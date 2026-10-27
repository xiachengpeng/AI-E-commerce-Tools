"""Private finite-call ledger. Admission only; never retries or sends requests.

A reservation permits exactly one first submission. Its replay is NOT permission
for another network call, including after a crash with an unknown result.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
from uuid import UUID, uuid4

MAX_APPROVED = {'apify':1, 'serpapi':2, 'firecrawl':1, 'text_ai':12}
MAX_LEDGER_BYTES = 1024 * 1024


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def timestamp(value):
    if not isinstance(value,datetime) or value.tzinfo is None:
        raise ValueError('budget_expiry_invalid')
    return value.astimezone(UTC)


@dataclass(frozen=True)
class Reservation:
    permit_network: bool
    provider: str
    network_attempt: int


class SessionBudgetStore:
    def __init__(self,root:Path,session_id:str,*,expected_policy_digest:str,read_only=False):
        if type(read_only) is not bool:raise ValueError('budget_mode_invalid')
        self.read_only=read_only
        self.root=self._root(root)
        if str(UUID(session_id)) != session_id:
            raise ValueError('budget_session_invalid')
        if not isinstance(expected_policy_digest,str) or len(expected_policy_digest)!=64:
            raise ValueError('budget_policy_anchor_invalid')
        self.session_id=session_id
        self.path=self.root/(session_id+'.json')
        self.policy_digest=expected_policy_digest
        if read_only:self._read()
        else:
            with self._lock():self._read()

    @staticmethod
    def _root(root):
        path=Path(root).absolute()
        if path.is_symlink():raise ValueError('budget_root_invalid')
        # Resolve system /var alias before checking the private directory tree.
        resolved=path.resolve()
        if any(p.is_symlink() for p in path.parents if str(p)!='/var'):
            raise ValueError('budget_root_invalid')
        info=resolved.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
            raise ValueError('budget_root_not_private')
        return resolved

    @classmethod
    def create(cls,root,session_id,*,scope_ids,limits,expires_at):
        root=cls._root(root)
        if str(UUID(session_id))!=session_id:raise ValueError('budget_session_invalid')
        if (not isinstance(scope_ids,(list,tuple)) or not scope_ids or len(set(scope_ids))!=len(scope_ids)
                or any(not isinstance(s,str) or not 0<len(s)<=160 for s in scope_ids)):
            raise ValueError('budget_scope_invalid')
        if (not isinstance(limits,dict) or not limits or any(p not in MAX_APPROVED or type(n)is not int
                or not 0<=n<=MAX_APPROVED[p] for p,n in limits.items())):
            raise ValueError('budget_limits_invalid')
        expiry=timestamp(expires_at)
        if expiry<=datetime.now(UTC):raise ValueError('budget_expired')
        policy={'scope_ids':list(scope_ids),'limits':limits,'expires_at':expiry.isoformat()}
        ledger={'schema_version':1,'session_id':session_id,'policy':policy,'reservations':{}}
        # UUID new-file creation is exclusive; an existing session is never reset.
        fd=os.open(root/(session_id+'.json'),os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as handle:
            json.dump(ledger,handle);handle.flush();os.fsync(handle.fileno())
        directory=os.open(root,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
        return cls(root,session_id,expected_policy_digest=digest(policy))

    @contextmanager
    def _lock(self):
        self._root(self.root)
        fd=os.open(self.root/(self.session_id+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
                raise ValueError('budget_lock_invalid')
            fcntl.flock(fd,fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)

    def _read(self):
        try:
            fd=os.open(self.path,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'r') as handle:
                info=os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
                    raise ValueError('budget_ledger_invalid')
                raw=handle.read(MAX_LEDGER_BYTES+1)
                if len(raw.encode())>MAX_LEDGER_BYTES:raise ValueError('budget_ledger_invalid')
                value=json.loads(raw)
            if (not isinstance(value,dict) or value.get('schema_version')!=1 or value.get('session_id')!=self.session_id
                    or digest(value.get('policy'))!=self.policy_digest or not isinstance(value.get('reservations'),dict)):
                raise ValueError('budget_policy_or_ledger_invalid')
            for key,row in value['reservations'].items():
                if (not isinstance(key,str) or len(key)!=64 or not isinstance(row,dict)
                        or set(row)!={'provider','scope_id','network_attempt'}
                        or row['provider'] not in value['policy']['limits']
                        or row['scope_id'] not in value['policy']['scope_ids']
                        or type(row['network_attempt']) is not int or row['network_attempt']<1):
                    raise ValueError('budget_ledger_invalid')
            for provider,maximum in value['policy']['limits'].items():
                if sum(r['provider']==provider for r in value['reservations'].values())>maximum:
                    raise ValueError('budget_ledger_invalid')
            return value
        except (OSError,TypeError,KeyError,json.JSONDecodeError):
            raise ValueError('budget_ledger_unavailable') from None

    def summary(self):
        ledger=self._read()
        policy=ledger['policy']
        expired=datetime.fromisoformat(policy['expires_at'])<=datetime.now(UTC)
        providers={}
        for provider,limit in policy['limits'].items():
            used=sum(row['provider']==provider for row in ledger['reservations'].values())
            providers[provider]={'limit':limit,'used':used,'remaining':max(0,limit-used)}
        state='expired' if expired else 'available' if any(p['remaining']>0 for p in providers.values()) else 'exhausted'
        return {'state':state,'providers':providers,'expires_at':policy['expires_at']}

    def approved_scopes(self):
        if self.read_only:policy=self._read()['policy']
        else:
            with self._lock():policy=self._read()['policy']
        if datetime.fromisoformat(policy['expires_at'])<=datetime.now(UTC):return frozenset()
        return frozenset(policy['scope_ids'])

    def reserve(self,scope_id:str,operation_id:str,provider:str,network_attempt:int)->Reservation:
        if self.read_only:raise ValueError('budget_read_only')
        if (not isinstance(operation_id,str) or not 0<len(operation_id)<=512
                or type(network_attempt)is not int or network_attempt<1):
            raise ValueError('budget_operation_invalid')
        with self._lock():
            ledger=self._read();policy=ledger['policy']
            if scope_id not in policy['scope_ids']:raise ValueError('budget_scope_denied')
            if datetime.fromisoformat(policy['expires_at'])<=datetime.now(UTC):raise ValueError('budget_expired')
            if provider not in policy['limits']:raise ValueError('budget_provider_denied')
            key=digest([scope_id,operation_id,provider,network_attempt])
            if key in ledger['reservations']:return Reservation(False,provider,network_attempt)
            used=sum(row['provider']==provider for row in ledger['reservations'].values())
            if used>=policy['limits'][provider]:raise ValueError('budget_exhausted')
            ledger['reservations'][key]={'provider':provider,'scope_id':scope_id,'network_attempt':network_attempt}
            temp=self.root/(self.session_id+'.'+str(uuid4())+'.tmp')
            fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
            try:
                with os.fdopen(fd,'w') as handle:
                    json.dump(ledger,handle);handle.flush();os.fsync(handle.fileno())
                if self.path.is_symlink():raise ValueError('budget_ledger_unavailable')
                os.replace(temp,self.path)
                directory=os.open(self.root,os.O_RDONLY)
                try:os.fsync(directory)
                finally:os.close(directory)
            finally:temp.unlink(missing_ok=True)
            return Reservation(True,provider,network_attempt)


class SubmissionBudgetError(ValueError):
    def __init__(self,code,message):
        self.code=code
        super().__init__(message)


def require_submission(store,scope_id,operation_id,provider,network_attempt):
    try:
        reservation=store.reserve(scope_id,operation_id,provider,network_attempt)
    except ValueError as exc:
        if str(exc) in {'budget_exhausted','budget_expired'}:
            raise SubmissionBudgetError('budget','本次批准的调用次数或时间已用完，未继续发送请求。') from None
        raise SubmissionBudgetError('not_configured','无法确认本次调用授权范围，未发送请求。') from None
    if reservation.permit_network is not True:
        raise SubmissionBudgetError('submission_uncertain','该请求已预留提交，结果需先核对；未重复发送。')


def configured_budget(private_root,config):
    """Only private server configuration can select an already-approved ledger."""
    session=config.get('closeout_session')
    if session is None:return None
    if not isinstance(session,dict) or set(session)!={'id','policy_digest'}:
        raise ValueError('budget_configuration_invalid')
    return SessionBudgetStore(Path(private_root)/'closeout-sessions',session['id'],expected_policy_digest=session['policy_digest'])


@dataclass(frozen=True)
class TriggerScope:
    table: str
    record_id: str
    input_version: str
    protected_input_hash: str
    expected_state: str

    def __post_init__(self):
        if (any(not isinstance(v,str) or not 0<len(v)<=160 for v in (self.table,self.record_id,self.input_version,self.expected_state))
                or not isinstance(self.protected_input_hash,str) or len(self.protected_input_hash)!=64
                or any(c not in '0123456789abcdef' for c in self.protected_input_hash)):
            raise ValueError('polling_scope_invalid')

    @property
    def budget_scope_id(self):
        from rabbit_hole.integrations.feishu import trigger_job_kind
        kind=trigger_job_kind(self.table,self.expected_state)
        return legacy_scope_id(self.record_id,self.input_version,self.protected_input_hash,kind.value) if kind is not None else None


def legacy_scope_id(record_id,version,fingerprint,kind):
    return 'legacy:'+digest([record_id,version,fingerprint,kind])


@dataclass(frozen=True)
class PollingPolicy:
    mode: str = 'observe'
    allowed_triggers: tuple[TriggerScope,...] = ()
    expires_at: datetime|None = None
    max_new_jobs: int = 0

    def __post_init__(self):
        if (self.mode not in {'observe','execute'} or type(self.max_new_jobs)is not int
                or not 0<=self.max_new_jobs<=20 or not isinstance(self.allowed_triggers,tuple)
                or any(not isinstance(s,TriggerScope) for s in self.allowed_triggers)
                or len(set(self.allowed_triggers))!=len(self.allowed_triggers)):
            raise ValueError('polling_policy_invalid')
        if self.mode=='execute' and (not self.allowed_triggers or self.expires_at is None
                or len(self.allowed_triggers)>self.max_new_jobs):
            raise ValueError('polling_execute_requires_finite_scope')
        if self.expires_at is not None:timestamp(self.expires_at)

    @property
    def execution_allowed(self):
        return self.mode=='execute' and self.expires_at is not None and timestamp(self.expires_at)>datetime.now(UTC)

    def lease_scopes(self):
        if not self.execution_allowed:return ()
        from rabbit_hole.integrations.feishu import trigger_job_kind
        result=[]
        for scope in self.allowed_triggers:
            kind=trigger_job_kind(scope.table,scope.expected_state)
            if kind is not None:result.append((scope.record_id,scope.input_version,scope.protected_input_hash,kind.value))
        return tuple(result)


@dataclass(frozen=True)
class PollOutcome:
    seen: int
    enqueued: int
    skipped: int


def load_polling_policy(config):
    raw=config.get('feishu_polling_policy')
    if raw is None:return PollingPolicy()
    if not isinstance(raw,dict) or set(raw)-{'mode','allowed_triggers','expires_at','max_new_jobs'}:
        raise ValueError('polling_configuration_invalid')
    try:
        expiry=datetime.fromisoformat(raw['expires_at']) if raw.get('expires_at') is not None else None
        return PollingPolicy(raw.get('mode','observe'),tuple(TriggerScope(**item) for item in raw.get('allowed_triggers',[])),expiry,raw.get('max_new_jobs',0))
    except (TypeError,KeyError):raise ValueError('polling_configuration_invalid') from None


async def poll_with_policy(runtime,policy):
    from rabbit_hole.integrations.feishu import TriggerPoller,protected_input_hash
    budget=getattr(runtime,'submission_budget',None)
    if policy.execution_allowed and budget is None:raise ValueError('polling_execute_requires_call_budget')
    records=await runtime.feishu.list_trigger_records()
    if not policy.execution_allowed:return PollOutcome(len(records),0,len(records))
    approved=budget.approved_scopes()
    selected=[record for record in records if any(
        scope.budget_scope_id in approved and scope.table==record.table and scope.record_id==record.record_id
        and scope.input_version==record.version and scope.expected_state==record.state
        and scope.protected_input_hash==protected_input_hash(record.fields)
        for scope in policy.allowed_triggers)]
    class SelectedSource:
        async def list_trigger_records(self):
            return selected if policy.execution_allowed else []
    count=await TriggerPoller(SelectedSource(),runtime.jobs).poll_once()
    return PollOutcome(len(records),count,len(records)-count)


def current_lease_scopes(budget=None):
    from services.research_client import load_research_config
    try:
        config=load_research_config();policy=load_polling_policy(config)
        if budget is None or not policy.execution_allowed:return ()
        configured=config.get('closeout_session') or {}
        if configured.get('id')!=budget.session_id or configured.get('policy_digest')!=budget.policy_digest:return ()
        approved=budget.approved_scopes()
        return tuple(row for row in policy.lease_scopes() if legacy_scope_id(*row) in approved)
    except (OSError,ValueError,TypeError):return ()


def require_legacy_execution(budget,payload):
    expected=(payload.record_id,payload.input_version,payload.protected_input_hash,payload.kind.value)
    if expected not in current_lease_scopes(budget):
        raise SubmissionBudgetError('input_changed','本次后台执行范围已停止、过期或变化，未继续发送请求。')


def require_current_submission_budget(budget):
    """Integrated submit-time fence; a running old process cannot skip a new limit."""
    from services.research_client import load_research_config
    config=load_research_config()
    if not config:
        path=Path(os.environ.get('RESEARCH_INTEGRATION_CONFIG',str(Path.home()/'.local/share/ai-ecommerce-merge/research.json')))
        if path.exists() or path.is_symlink():
            raise SubmissionBudgetError('budget','当前执行配置无法核对，未发送请求；请检查本地配置后重试。')
    declared=config.get('closeout_session')
    if declared is None:return
    try:
        if not isinstance(declared,dict) or set(declared)!={'id','policy_digest'}:raise ValueError()
        if (budget is None or budget.session_id!=declared['id'] or budget.policy_digest!=declared['policy_digest']
                or budget.root!=(Path(config['data_root'])/'closeout-sessions').resolve()):raise ValueError()
    except (KeyError,TypeError,ValueError,AttributeError):
        raise SubmissionBudgetError('budget','当前服务尚未载入本次调用上限，未发送请求；请正常退出并重新打开客户端。') from None


def submission_budget_identity(budget):
    return digest([budget.session_id,budget.policy_digest]) if budget is not None else 'none'
