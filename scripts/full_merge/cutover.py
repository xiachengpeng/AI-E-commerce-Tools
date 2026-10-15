"""Private operator cutover journal. Default is read-only preflight.

The reviewed, hash-pinned barrier collector is a trusted operator input, like the
migration plan. It MUST query both machines live; an unreachable source is not a
freeze. No process killing, scheduler edits, remote writes, or auto-start here.
Database/root moves are recoverable transactions, not an atomic multi-file rename.
Keep both launchers stopped until this journal reaches local_active or rolled_back.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager, closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import time

from scripts.full_merge.backup import database_stats
from scripts.full_merge.import_data import _safe, candidate_directory
from scripts.full_merge.rehearse import _private_file, _verified_snapshot, authenticated_candidate_read


def _digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def _identity(path):
    path = _safe(path)
    if path.is_file():
        return _digest(path)
    if path.is_dir():
        entries = []
        for child in sorted(path.rglob('*')):
            _safe(child)
            if child.is_file():
                entries.append((child.relative_to(path).as_posix(),_digest(child)))
        return hashlib.sha256(json.dumps(entries).encode()).hexdigest()
    raise ValueError('missing operation resource')


def _sync(directory):
    fd = os.open(directory,os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def _write(path, value):
    path = _safe(path)
    temporary = path.with_name(path.name+'.next')
    raw = json.dumps(value,sort_keys=True,allow_nan=False).encode()
    fd = os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary,path)
    _sync(path.parent)


def _replace(source, target):
    os.replace(source,target)
    _sync(Path(source).parent)
    if Path(target).parent != Path(source).parent: _sync(Path(target).parent)


def _load(plan):
    value = json.loads(_private_file(Path(plan)).read_bytes())
    if value.get('version') != 1 or value.get('target_phase') not in {'local_readonly','local_active'}:
        raise ValueError('explicit supported cutover plan required')
    required = ('database','candidate','data_root','ledger','recovery_root','main_snapshot','source_snapshot','activation_report')
    for field in required: _safe(Path(value[field]))
    for field in ('candidate_database','candidate_data_root'):
        relative = Path(value[field])
        if relative.is_absolute() or '..' in relative.parts or str(relative) == '.':
            raise ValueError('candidate child path required')
    paths = [Path(value[k]) for k in ('database','data_root','ledger','recovery_root','candidate')]
    if len(set(paths)) != len(paths) or any(a in b.parents or b in a.parents for i,a in enumerate(paths) for b in paths[i+1:]):
        raise ValueError('cutover paths must be disjoint')
    db = Path(value['database'])
    if db.name != 'history.db' or (db.exists() and db.stat().st_nlink != 1):
        raise ValueError('canonical single-link history.db required')
    # target_phase can be advanced after readonly verification; all other inputs immutable.
    digest = hashlib.sha256(json.dumps({k:v for k,v in value.items() if k != 'target_phase'},sort_keys=True).encode()).hexdigest()
    return value,digest


@contextmanager
def _owner(plan):
    path = _safe(Path(plan['ledger']).with_suffix('.lock'))
    with os.fdopen(os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),'w') as stream:
        try: fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('another cutover owner exists') from None
        try: yield
        finally: fcntl.flock(stream,fcntl.LOCK_UN)


def _observe_barrier(plan):
    """Execute only the exact reviewed private collector, never a shell command.

    Collector receives nonce and plan via stdin, returns bounded JSON. Its source
    digest is pinned in the immutable plan; collector code and concrete freeze/
    recovery actions must undergo controller review before execute=True.
    """
    probe = plan['barrier_probe']
    script = _private_file(Path(probe['script']))
    if _digest(script) != probe['sha256']:
        raise ValueError('barrier collector changed')
    python = Path(probe['python'])
    if not python.is_absolute() or not python.is_file():
        raise ValueError('explicit collector interpreter required')
    nonce = secrets.token_hex(32)
    response = subprocess.run([str(python),'-s',str(script)],input=json.dumps({'nonce':nonce,'plan':plan}),
                              capture_output=True,text=True,timeout=30,check=False)
    if response.returncode or len(response.stdout)>262144:
        raise ValueError('live barrier observation unavailable')
    result = json.loads(response.stdout)
    if result.get('nonce') != nonce:
        raise ValueError('stale barrier observation')
    return result


def _barrier(plan):
    receipt = _observe_barrier(plan)
    frozen = plan['freeze']
    if plan.get('source_roster_sha256') is not None and receipt.get('roster_sha256') != plan['source_roster_sha256']:
        raise ValueError('reviewed source roster mismatch')
    now = time.time()
    if not (receipt.get('reachable') is True and 0 <= now-receipt['observed_at'] < 35
            and 0 < frozen['frozen_since'] <= frozen['snapshot_created_at'] <= now
            and 0 < frozen['max_age_seconds'] <= 86400
            and now-frozen['frozen_since'] <= frozen['max_age_seconds']):
        raise ValueError('source freeze unavailable or expired')
    for key in ('dataset_id','owner_generation','snapshot_id'):
        if receipt.get(key) != plan[key]: raise ValueError('freeze ownership identity mismatch')
    if receipt.get('frozen_since') != frozen['frozen_since'] or receipt.get('source_state_sha256') != frozen['source_state_sha256']:
        raise ValueError('source changed after final snapshot')
    if receipt.get('writers') != [] or receipt.get('inflight') != []:
        raise ValueError('live writers or in-flight operations remain')
    if not frozen['autostart_ids'] or receipt.get('autostart') != {key:False for key in frozen['autostart_ids']}:
        raise ValueError('source auto-restart barrier incomplete')
    return receipt


def _closed(*databases):
    """Reject idle as well as transactional open handles; lock checks alone cannot.

    lsof must be available and successful. macOS/Linux supported. The same-user
    operator must have visibility of ALL inventoried writers on this deployment.
    """
    paths = []
    for database in databases:
        for suffix in ('','-wal','-shm','-journal'):
            path = _safe(Path(str(database)+suffix))
            if path.exists(): paths.append(str(path))
    if not paths: return
    result = subprocess.run(['lsof','-t','--',*paths],capture_output=True,text=True,timeout=15)
    if result.returncode not in (0,1) or result.stderr.strip():
        raise ValueError('database connection inventory unavailable')
    if result.stdout.strip(): raise ValueError('database connections must be closed')


def _checkpoint(database):
    # Only after all open FDs are excluded; old WAL is checkpointed before backup.
    with closing(sqlite3.connect(f'file:{database}?mode=rw',uri=True,timeout=0)) as connection:
        result = connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        if result and result[0]: raise ValueError('checkpoint busy')


def _paths(plan, *, installed=False):
    from services.research_runtime import resolve_runtime_paths
    if installed: return resolve_runtime_paths(Path(plan['database']),Path(plan['data_root']))
    candidate = Path(plan['candidate'])
    return resolve_runtime_paths(candidate/plan['candidate_database'],candidate/plan['candidate_data_root'])


def _report(plan):
    report = json.loads(_private_file(Path(plan['activation_report'])).read_bytes())
    for key in ('dataset_id','owner_generation','snapshot_id'):
        if report.get(key) != plan[key]: raise ValueError('activation identity mismatch')
    if report.get('source_frozen_at') < plan['freeze']['frozen_since'] or report.get('snapshot_created_at') < plan['freeze']['snapshot_created_at']:
        raise ValueError('activation predates freeze')
    return report


def _preflight(plan, ledger=None):
    from services.research_activation import validate_activation
    _barrier(plan)
    if ledger and ledger['phase'] == 'local_active':
        if not validate_activation(_paths(plan,installed=True),_report(plan)):
            raise ValueError('active owner mismatch')
        return
    installed = bool(ledger and ledger['phase']=='local_readonly')
    paths = _paths(plan,installed=installed)
    _closed(Path(plan['database']),paths.database)
    anchors={}
    for name in ('source_snapshot','main_snapshot'):
        _,anchors[name]=_verified_snapshot(Path(plan[name]))
    inputs=json.loads(_private_file(Path(plan['candidate'])/'candidate-inputs.json').read_bytes())
    if (inputs.get('source_anchor')!=anchors['source_snapshot'] or inputs.get('main_anchor')!=anchors['main_snapshot']
            or plan['snapshot_id']!=anchors['source_snapshot']):
        raise ValueError('candidate snapshot identity mismatch')
    if not installed:
        candidate_directory(Path(plan['candidate']))
        main = json.loads((Path(plan['main_snapshot'])/'manifest.json').read_bytes())
        if len(main['databases']) != 1 or database_stats(Path(plan['database'])) != main['databases'][0]['stats']:
            raise ValueError('main changed since final snapshot')
        if (paths.keys_root/'activation.json').exists(): raise ValueError('candidate activation must remain unpublished')
    if not validate_activation(paths,_report(plan)): raise ValueError('candidate activation/quarantine invalid')
    device = Path(plan['database']).parent.stat().st_dev
    for path in (paths.database,paths.evidence_root.parent,Path(plan['ledger']).parent,Path(plan['data_root']).parent):
        if path.stat().st_dev != device: raise ValueError('same filesystem required')
    if not installed and Path(plan['recovery_root']).exists(): raise ValueError('recovery directory already exists')


def _read_ledger(plan,digest):
    file = Path(plan['ledger'])
    if not file.exists(): return None
    value = json.loads(_private_file(file).read_bytes())
    if value.get('plan_sha256') != digest: raise ValueError('cutover plan changed')
    return value


def _move(plan,ledger,source,target):
    _closed(Path(plan['database']),_paths(plan).database)
    _barrier(plan)
    operation = {'source':str(source),'target':str(target),'sha256':_identity(source),'done':False}
    ledger['operations'].append(operation)
    _write(Path(plan['ledger']),ledger)
    _replace(source,target)
    operation['done']=True
    _write(Path(plan['ledger']),ledger)


def cutover(plan: Path, *, execute: bool=False) -> dict:
    value,digest = _load(plan)
    ledger = _read_ledger(value,digest)
    if not execute:
        try:
            if ledger and ledger['phase'] not in {'local_readonly','local_active'}:
                raise ValueError('interrupted transaction requires rollback')
            _preflight(value,ledger)
            return {'dry_run':True,'ready':True,'phase':ledger['phase'] if ledger else 'prepared','blockers':[]}
        except (OSError,ValueError,KeyError,sqlite3.Error,subprocess.SubprocessError):
            # No private exception messages/paths in public dryrun result.
            return {'dry_run':True,'ready':False,'phase':ledger['phase'] if ledger else 'prepared',
                    'blockers':['preflight_failed: inspect private operator evidence; no mutations performed']}
    with _owner(value):
        ledger = _read_ledger(value,digest)
        if ledger and ledger['phase'] not in {'local_readonly','local_active'}:
            raise ValueError('interrupted transaction requires rollback')
        _preflight(value,ledger)
        if ledger is None:
            ledger={'version':1,'database':value['database'],'data_root':value['data_root'],'plan_sha256':digest,'phase':'prepared','operations':[],'activation_started':False}
            _write(Path(value['ledger']),ledger)
            ledger['phase']='source_frozen'; _write(Path(value['ledger']),ledger)
            paths = _paths(value)
            _checkpoint(Path(value['database'])); _checkpoint(paths.database)
            _closed(Path(value['database']),paths.database)
            ledger['phase']='verified'; _write(Path(value['ledger']),ledger)
            recovery = Path(value['recovery_root']); recovery.mkdir(mode=0o700)
            _sync(recovery.parent)
            live = Path(value['database'])
            for suffix in ('-wal','-shm','-journal',''):
                file = Path(str(live)+suffix)
                if file.exists(): _move(value,ledger,file,recovery/('history.db'+suffix))
            root = Path(value['data_root'])
            if root.exists(): _move(value,ledger,root,recovery/'research')
            _move(value,ledger,paths.database,live)
            _move(value,ledger,paths.evidence_root.parent,root)
            installed = _paths(value,installed=True)
            asyncio.run(authenticated_candidate_read(installed.database,installed.evidence_root.parent))
            _closed(installed.database)
            ledger['phase']='local_readonly'; _write(Path(value['ledger']),ledger)
        if value['target_phase']=='local_active' and ledger['phase']!='local_active':
            _preflight(value,ledger)
            paths = _paths(value,installed=True)
            # Durable conservative point of no old-snapshot return BEFORE first claim.
            ledger['activation_started']=True; _write(Path(value['ledger']),ledger)
            from services.research_activation import claim_activation
            report = _report(value)
            claim_activation(paths,report)
            _write(paths.keys_root/'activation.json',report)
            ledger['phase']='local_active'; _write(Path(value['ledger']),ledger)
        return {'dry_run':False,'phase':ledger['phase'],'source_restart_allowed':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plan',type=Path); parser.add_argument('--execute',action='store_true')
    args=parser.parse_args()
    try: print(json.dumps(cutover(args.plan,execute=args.execute)))
    except Exception: raise SystemExit('cutover blocked; inspect private evidence and recovery journal') from None


if __name__=='__main__': main()
