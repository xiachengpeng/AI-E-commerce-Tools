"""Read-only local status: no client construction, queue writes, or lock creation."""
from contextlib import closing
from datetime import UTC,datetime,timedelta
import fcntl
import hashlib
import os
from pathlib import Path
import sqlite3
import stat


def unknown_status():
    return {'contract_version':1,'worker_state':'unknown','observed_at':datetime.now(UTC).isoformat(),
        'heartbeat_at':None,'budget':None,'reason_codes':['status_unavailable'],'queues':None,
        'polling':{'enabled':False,'mode':'unknown','state':'unknown','last_observed_at':None,'next_expected_at':None}}


def owner_held(root):
    root=Path(root)
    if any(p.is_symlink() for p in (root,*root.parents)):raise ValueError('status_path_invalid')
    path=root/(hashlib.sha256(b'727481063').hexdigest()+'.lock')
    try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    except FileNotFoundError:return False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('status_lock_invalid')
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return True
        fcntl.flock(fd,fcntl.LOCK_UN)
        return False
    finally:os.close(fd)


def utc_stamp(value):
    parsed=datetime.fromisoformat(value)
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def read_worker_status(paths,config,*,now=None,poll_seconds=60,runtime_budget=None):
    result=unknown_status();now=now or datetime.now(UTC)
    result['observed_at']=now.isoformat()
    try:
        database=Path(paths.database)
        if not database.is_file() or any(p.is_symlink() for p in (database,*database.parents)):
            return result
        held=owner_held(paths.lock_root)
        with closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=1)) as c:
            c.execute('BEGIN')
            health={key:utc_stamp(value) for key,value in c.execute('SELECT component,updated_at FROM runtime_health WHERE component IN (?,?,?) OR component LIKE ?',('workbench_worker','feishu_poll_ok','feishu_poll_failed','workbench_budget:%'))}
            queues={'queued':0,'running':0,'needs_attention':0}
            for table in ('runtime_jobs','feishu_outbox','workbench_actions','workbench_sync_runs'):
                for status,count in c.execute('SELECT status,COUNT(*) FROM '+table+' GROUP BY status'):
                    if status in {'ready','queued','delayed','retry_wait','pending'}:queues['queued']+=count
                    elif status=='running':queues['running']+=count
                    elif status in {'needs_human','blocked'}:queues['needs_attention']+=count
        result['queues']=queues
        reasons=[];heartbeat=health.get('workbench_worker')
        result['heartbeat_at']=heartbeat.isoformat() if heartbeat else None
        fresh=heartbeat is not None and -5<=(now-heartbeat).total_seconds()<=60
        paused=config.get('enabled') is False or config.get('worker_mode')=='paused'
        active=config.get('enabled') is True and config.get('worker_mode')=='active'
        if paused:
            state='degraded' if held else 'paused'
            if held:reasons.append('owner_still_present')
        elif active:
            if not held:state='not_running';reasons.append('owner_missing')
            elif heartbeat is None:state='starting';reasons.append('heartbeat_pending')
            elif not fresh:state='degraded';reasons.append('heartbeat_stale')
            else:state='running'
        else:state='unknown';reasons.append('configuration_unknown')
        from services.research_polling_policy import load_polling_policy
        try:
            policy=load_polling_policy(config)
            mode=policy.mode
            if mode=='execute' and not policy.execution_allowed:reasons.append('execution_scope_expired')
        except (ValueError,TypeError):
            mode='unknown';reasons.append('polling_policy_invalid')
            if state=='running':state='degraded'
        enabled=config.get('feishu_polling_enabled') is True
        stamps=[(value,key) for key,value in health.items() if key.startswith('feishu_poll_')]
        poll_at,poll_kind=max(stamps) if stamps else (None,None)
        interval=poll_seconds if type(poll_seconds)is int and 10<=poll_seconds<=86400 else 60
        poll_fresh=poll_at is not None and -5<=(now-poll_at).total_seconds()<=max(120,interval*2)
        if enabled and mode=='execute' and 'execution_scope_expired' in reasons and held and fresh:
            poll_state='scope_expired';state='degraded'
        elif not enabled:poll_state='disabled'
        elif state not in {'running','degraded'} or not held or not fresh:poll_state='waiting'
        elif not poll_fresh:
            poll_state='stale';reasons.append('polling_stale');state='degraded'
        elif poll_kind=='feishu_poll_failed':
            poll_state='failed';reasons.append('polling_failed');state='degraded'
        else:poll_state='observing' if mode=='observe' else 'running' if mode=='execute' else 'unknown'
        session=config.get('closeout_session')
        if session is not None:
            try:
                from services.research_polling_policy import SessionBudgetStore
                if not isinstance(session,dict) or set(session)!={'id','policy_digest'}:raise ValueError('invalid budget')
                budget=SessionBudgetStore(Path(paths.lock_root).parent/'closeout-sessions',session['id'],expected_policy_digest=session['policy_digest'],read_only=True)
                result['budget']=budget.summary()
                bound=runtime_budget is not None and getattr(runtime_budget,'session_id',None)==session['id'] and getattr(runtime_budget,'policy_digest',None)==session['policy_digest'] and getattr(runtime_budget,'root',None)==budget.root
                result['budget']['bound_to_api']=bound
                from services.research_polling_policy import submission_budget_identity
                worker_stamp=health.get('workbench_budget:'+submission_budget_identity(budget))
                worker_bound=held and fresh and worker_stamp is not None and -5<=(now-worker_stamp).total_seconds()<=60
                result['budget']['bound_to_worker']=worker_bound
                if held and not worker_bound:
                    reasons.append('budget_worker_restart_required')
                    if state=='running':state='degraded'
                if not bound:
                    reasons.append('budget_restart_required')
                    if state=='running':state='degraded'
            except (OSError,ValueError,TypeError):
                result['budget']={'state':'unavailable','providers':None,'expires_at':None}
                reasons.append('budget_unavailable')
                if state=='running':state='degraded'
        result.update(worker_state=state,reason_codes=reasons,
            polling={'enabled':enabled,'mode':mode,'state':poll_state,
                'last_observed_at':poll_at.isoformat() if poll_at else None,
                'next_expected_at':(poll_at+timedelta(seconds=interval)).isoformat() if poll_fresh and enabled and held and fresh else None})
        return result
    except (OSError,ValueError,TypeError,sqlite3.Error):return unknown_status()
