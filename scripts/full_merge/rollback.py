"""Recover interrupted rename journals; after activation preserve all new data.

Never starts a source or local process, changes auto-restart, or copies an old DB
on top of an activated target. Actual code rollback/reconciliation is separate.
"""
from pathlib import Path
import hashlib
from uuid import uuid4
from scripts.full_merge.rehearse import _write_private

from scripts.full_merge import cutover as engine
from scripts.full_merge.backup import create_snapshot


def rollback(plan: Path, *, preserve_new_writes: bool=True) -> dict:
    value,digest = engine._load(plan)
    with engine._owner(value):
        ledger=engine._read_ledger(value,digest)
        if ledger is None: raise ValueError('cutover ledger required')
        if ledger['phase']=='rolled_back': return {'phase':'rolled_back','source_restart_allowed':False}
        engine._closed(Path(value['database']),engine._paths(value).database,
                       Path(value['recovery_root'])/'history.db')
        if ledger.get('activation_started') or ledger['phase'] in {'local_active','reconciliation_required'}:
            if not preserve_new_writes: raise ValueError('must preserve new writes after activation')
            ledger['phase']='rollback_frozen'; engine._write(Path(value['ledger']),ledger)
            engine._closed(Path(value['database']))
            # Every invocation captures current data. Never reuse an older backup
            # after an interrupted reconciliation or later operator writes.
            destination=Path(value['recovery_root'])/('post-activation-'+uuid4().hex)
            create_snapshot(destination,databases=[Path(value['database'])],object_roots=[Path(value['data_root'])])
            anchor=destination.with_suffix('.anchor')
            _write_private(anchor,hashlib.sha256((destination/'manifest.json').read_bytes()).hexdigest().encode())
            engine._sync(anchor.parent)
            engine._verified_snapshot(destination)
            ledger.setdefault('incremental_snapshots',[]).append(str(destination))
            engine._write(Path(value['ledger']),ledger)
            # Remove only published activation so ordinary startup remains read-only.
            activation=Path(value['data_root'])/'keys/activation.json'
            if activation.exists():
                target=Path(value['recovery_root'])/'suspended-activation.json'
                if target.exists(): raise ValueError('existing suspended activation requires reconciliation')
                engine._replace(activation,target)
            ledger['phase']='reconciliation_required'; engine._write(Path(value['ledger']),ledger)
            return {'phase':ledger['phase'],'incremental_snapshot':str(destination),'source_restart_allowed':False}
        # Read-only SQLite may create empty WAL/SHM after installation. Preserve
        # these separately before restoring the original group; never mix frames.
        installed = any(op['target']==value['database'] and not op.get('reversed') for op in ledger['operations'])
        if installed:
            for suffix in ('-wal','-shm','-journal'):
                sidecar=Path(value['database']+suffix)
                saved=Path(value['recovery_root'])/('candidate'+suffix)
                if sidecar.exists():
                    if saved.exists(): raise ValueError('sidecar recovery conflict')
                    engine._replace(sidecar,saved)
        # Reverse persisted intents, including a rename whose done receipt was lost.
        for op in reversed(ledger['operations']):
            if op.get('reversed'): continue
            source,target=Path(op['source']),Path(op['target'])
            if source.exists() and not target.exists():
                if engine._identity(source)!=op['sha256']: raise ValueError('rollback source changed')
                op['reversed']=True; engine._write(Path(value['ledger']),ledger)
                continue
            if target.exists() and not source.exists():
                if engine._identity(target)!=op['sha256']: raise ValueError('rollback target changed')
                engine._replace(target,source)
                op['reversed']=True; engine._write(Path(value['ledger']),ledger)
                continue
            raise ValueError('ambiguous rollback resource; preserve both copies')
        ledger['phase']='rolled_back'; engine._write(Path(value['ledger']),ledger)
        return {'phase':'rolled_back','source_restart_allowed':False}
