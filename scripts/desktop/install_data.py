"""Explicit local handoff: offline, recoverable, same research root, paused worker.

Not an application startup hook. Never resumes an external queue. Recovery after
activation requires a new backup/reconciliation, not restoring an old snapshot.
"""
from __future__ import annotations
from contextlib import contextmanager, ExitStack
import asyncio
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from scripts.desktop.prepare_data import (safe_path, files, inventory, verify_candidate,
    source_fingerprint, require_offline)

NAMES=('research.json','history.db','static','.env')


def write_atomic(path, value):
    raw=json.dumps(value,sort_keys=True).encode()
    descriptor,name=tempfile.mkstemp(prefix=path.name+'.',suffix='.next',dir=path.parent)
    temporary=Path(name)
    with os.fdopen(descriptor,'wb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)
    sync(path.parent)


def sync(path):
    descriptor=os.open(path,os.O_RDONLY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def identity(path):
    path=safe_path(path)
    if path.is_dir():return inventory(path)
    if path.is_file():return hashlib.sha256(path.read_bytes()).hexdigest()
    return None


@contextmanager
def runtime_locks(root):
    # Same flock names as desktop_entry; keep API initialization out of handoff.
    with ExitStack() as stack:
        for name in ('api','frontend','worker'):
            path=safe_path(root/(name+'.lock'))
            stream=stack.enter_context(path.open('a'))
            fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield


def verify_research_readonly(database, research_root):
    from services.research_runtime import resolve_runtime_paths
    from services.research_activation import validate_activation
    from scripts.full_merge.rehearse import _runtime_read_check
    paths=resolve_runtime_paths(database,research_root)
    return validate_activation(paths) and asyncio.run(_runtime_read_check(database,research_root))


def _recover(recovery, record):
    if record['phase'] not in ('preparing','rolling_back'):
        raise ValueError('Active data requires fresh backup and write reconciliation')
    root=safe_path(Path(record['data_root']))
    source=safe_path(Path(record['source_config']))
    original=(recovery/'source-config.original').read_bytes()
    fenced=(recovery/'source-config.fenced').read_bytes()
    if source.read_bytes() not in (original,fenced):
        raise ValueError('Source configuration changed; preserve all data for reconciliation')
    temporary=safe_path(source.with_name(source.name+'.desktop-restore'))
    if temporary.exists() and (not temporary.is_file() or temporary.read_bytes()!=original
            or temporary.stat().st_mode & 0o077 or temporary.stat().st_uid!=os.getuid()):
        raise ValueError('Conflicting source restore temporary')
    # Validate all current files before moving any of them. Never overwrite new writes.
    for name in NAMES:
        current=root/name; previous=recovery/'previous'/name
        if previous.exists() or record['previous'][name] is None:
            if current.exists() and identity(current)!=record['installed'][name]:
                raise ValueError('Desktop data changed; recovery requires reconciliation')
        elif identity(current)!=record['previous'][name]:
            raise ValueError('Previous desktop data changed')
    record['phase']='rolling_back';write_atomic(recovery/'handoff.json',record)
    for name in reversed(NAMES):
        current=root/name; previous=recovery/'previous'/name
        if previous.exists() or record['previous'][name] is None:
            if current.exists():os.rename(current,recovery/'failed'/name)
            if previous.exists():os.rename(previous,current)
    # Original file kept in recovery even after restoration.
    if not temporary.exists():
        with temporary.open('xb') as stream:stream.write(original);stream.flush();os.fsync(stream.fileno())
    temporary.chmod(0o600);os.replace(temporary,source);sync(source.parent);sync(root)
    record['phase']='rolled_back';write_atomic(recovery/'handoff.json',record)
    return record


def recover_install(recovery, *, offline_check=require_offline):
    recovery=safe_path(recovery)
    record=json.loads((recovery/'handoff.json').read_text())
    if record['phase'] not in ('preparing','rolling_back'):
        raise ValueError('Activated desktop data cannot be rolled back by snapshot overwrite')
    root=safe_path(Path(record['data_root']))
    with runtime_locks(root):
        recovery_fence(record,offline_check)
        return _recover(recovery,record)


def recovery_fence(record,offline_check):
    root=safe_path(Path(record['data_root']))
    affected=[Path(record['source_config']),*[root/n for n in NAMES if (root/n).exists()],
        *[root/('history.db'+s) for s in ('-wal','-shm','-journal') if (root/('history.db'+s)).exists()]]
    offline_check(Path(record['source_database']),affected)
    offline_check(root/'history.db',affected)
    if any((root/('history.db'+s)).exists() for s in ('-wal','-shm','-journal')):
        raise ValueError('SQLite sidecars require reconciliation before recovery')


def install_candidate(preparation,source_database,source_static,source_config,research_root,data_root,recovery, *,
                      env_file=None,offline_check=require_offline,read_check=verify_research_readonly,
                      step_hook=lambda stage:None):
    preparation,source_database,source_static,source_config,research_root,data_root,recovery=map(safe_path,
        (preparation,source_database,source_static,source_config,research_root,data_root,recovery))
    if recovery.exists():raise FileExistsError('Recovery directory already exists')
    if not data_root.is_dir() or data_root.stat().st_mode & 0o077 or data_root.stat().st_uid!=os.getuid():
        raise ValueError('Private desktop root required')
    candidates=[preparation,source_database,source_static,source_config,research_root,data_root,recovery]
    if env_file is not None:candidates.append(safe_path(env_file))
    if any(a==b or a in b.parents or b in a.parents for i,a in enumerate(candidates) for b in candidates[i+1:]):
        raise ValueError('Handoff paths must be disjoint')
    verify_candidate(preparation)
    configs={'research.json':source_config}
    if env_file is not None:configs['.env']=safe_path(env_file)
    report=json.loads((preparation/'candidate-report.json').read_text())
    if source_fingerprint(source_database,[source_static,research_root],configs)!=report['source_fingerprint_sha256']:
        raise ValueError('Source changed since preparation; create a fresh candidate')
    for name in NAMES:files(data_root/name)
    # A stale WAL cannot silently attach to a replacement database.
    if any((data_root/('history.db'+suffix)).exists() for suffix in ('-journal','-wal','-shm')):
        raise ValueError('Desktop SQLite sidecars require explicit checkpoint/backup')
    desktop_files=[data_root/n for n in NAMES if (data_root/n).exists()]
    offline_check(source_database,[source_static,research_root,*configs.values(),*desktop_files])
    if not read_check(preparation/'candidate/history.db',research_root):
        raise ValueError('Read-only research/activation verification failed')
    config=json.loads(source_config.read_text())
    if config.get('enabled') is not True:raise ValueError('Explicit active source research configuration required')
    with runtime_locks(data_root):
        old_mask=os.umask(0o077)
        try:
            recovery.mkdir(parents=True,mode=0o700,exist_ok=False)
            for name in ('previous','failed','staged'):(recovery/name).mkdir(mode=0o700)
            shutil.copyfile(source_config,recovery/'source-config.original')
            ledger=str(recovery/'handoff.json')
            fenced={**config,'cutover_ledger':ledger}
            write_atomic(recovery/'source-config.fenced',fenced)
            staged=recovery/'staged'
            for name in NAMES:
                source=preparation/'candidate'/name
                if name=='research.json':
                    write_atomic(staged/name,{**config,'data_root':str(research_root),
                        'enabled':True,'worker_mode':'paused','cutover_ledger':ledger})
                elif source.is_dir():shutil.copytree(source,staged/name)
                elif source.is_file():shutil.copyfile(source,staged/name)
            record={'version':1,'phase':'preparing','database':str(data_root/'history.db'),
                'data_root':str(data_root),'source_database':str(source_database),'source_config':str(source_config),
                'worker_mode':'paused','previous':{n:identity(data_root/n) for n in NAMES},
                'installed':{n:identity(staged/n) for n in NAMES}}
            write_atomic(recovery/'handoff.json',record)
            try:
                # Both launchers see the same fail-closed maintenance journal.
                write_atomic(source_config,fenced)
                for name in NAMES:
                    current=data_root/name
                    if current.exists():os.rename(current,recovery/'previous'/name)
                    if (staged/name).exists():os.rename(staged/name,current)
                    sync(data_root);sync(recovery/'previous');step_hook('installed:'+name)
                offline_check(source_database,[source_static,research_root,*configs.values(),
                    *[data_root/n for n in NAMES if (data_root/n).exists()]])
                # Source config changed only to the known maintenance fence.
                if source_fingerprint(source_database,[source_static,research_root],
                    {**configs,'research.json':recovery/'source-config.original'})!=report['source_fingerprint_sha256']:
                    raise ValueError('Source changed during handoff')
                if not read_check(data_root/'history.db',research_root):raise ValueError('Installed read-only verification failed')
                record['phase']='local_active';write_atomic(recovery/'handoff.json',record)
                return record
            except Exception:
                recovery_fence(record,offline_check)
                _recover(recovery,record)
                raise
        finally:os.umask(old_mask)
