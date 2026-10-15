"""Frozen raw groups protect source SHM from SQLite's own reader writes."""
from pathlib import Path
from types import SimpleNamespace
import hashlib
import sqlite3
import subprocess
import sys

import pytest

from scripts.full_merge.collector import source_files
from scripts.full_merge.backup import create_snapshot, database_stats
from backend.tests import test_full_merge_collector as collector_tests

fixture = collector_tests.fixture


def empty_inspector(argv, **kwargs):
    return SimpleNamespace(returncode=1, stdout='', stderr='')


def abrupt_wal(roster):
    db=Path(roster['databases'][0]);db.unlink()
    code="""import sqlite3,os,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA wal_autocheckpoint=0')
c.execute('CREATE TABLE rows(id INTEGER PRIMARY KEY,value TEXT)')
c.execute(\"INSERT INTO rows VALUES(1,'committed only in WAL')\");c.commit();os._exit(0)
"""
    subprocess.run([sys.executable,'-c',code,str(db)],check=True)
    return db


def identities(paths):
    return {str(p):(p.stat().st_ino,p.stat().st_size,p.stat().st_mtime_ns,
                    hashlib.sha256(p.read_bytes()).hexdigest()) for p in paths}


def test_abrupt_wal_backup_never_opens_or_mutates_original_group(fixture,tmp_path,monkeypatch):
    from scripts.full_merge.collector import stage_frozen_databases
    import scripts.full_merge.backup as backup
    roster,resolved,run,calls=fixture;db=abrupt_wal(roster)
    expected=source_files(roster);before=identities(expected)
    staged=stage_frozen_databases(roster,tmp_path/'staged',expected_files=expected,run=empty_inspector)
    original_connect=backup._connect_readonly
    def forbid_source(path):
        assert Path(path)!=db,'SQLite must never open the frozen original'
        return original_connect(path)
    monkeypatch.setattr(backup,'_connect_readonly',forbid_source)
    raw_before=identities(staged['provenance_files'])
    snap=tmp_path/'snapshot'
    manifest=create_snapshot(snap,databases=staged['databases'],key_files=[*staged['provenance_files'],staged['mapping_file']])
    assert before==identities(expected)
    assert raw_before==identities(staged['provenance_files'])
    with sqlite3.connect(snap/'databases/0.db') as c:
        assert c.execute('SELECT * FROM rows').fetchall()==[(1,'committed only in WAL')]
    assert database_stats(snap/'databases/0.db')==manifest['databases'][0]['stats']
    for p in (tmp_path/'staged').rglob('*'):
        assert p.stat().st_mode&0o077==0
    assert all(p.stat().st_nlink==1 for p in staged['provenance_files'])
    assert not set(staged['provenance_files'])&set(staged['databases'])


@pytest.mark.parametrize('failure',['holder','late_holder','missing_sidecar','mutation','copy_error','escaped_stage','symlink'])
def test_frozen_group_capture_fails_closed(fixture,tmp_path,monkeypatch,failure):
    import scripts.full_merge.collector as collector
    roster,resolved,run,calls=fixture;db=abrupt_wal(roster);expected=source_files(roster);destination=tmp_path/'stage'
    inspect=empty_inspector
    if failure=='holder':
        inspect=lambda *a,**k:SimpleNamespace(returncode=0,stdout='77\n',stderr='')
    elif failure=='late_holder':
        counts=[]
        def inspect(*args,**kwargs):
            counts.append(1)
            return SimpleNamespace(returncode=0 if len(counts)>1 else 1,stdout='77\n' if len(counts)>1 else '',stderr='')
    elif failure=='missing_sidecar':Path(str(db)+'-shm').unlink()
    elif failure=='mutation':
        original=collector.shutil.copyfile
        def mutate(src,dst):
            result=original(src,dst);Path(src).write_bytes(b'changed');return result
        monkeypatch.setattr(collector.shutil,'copyfile',mutate)
    elif failure=='copy_error':
        def fail(*a,**k):raise OSError('synthetic copy failure')
        monkeypatch.setattr(collector.shutil,'copyfile',fail)
    elif failure=='escaped_stage':destination=db.parent/'stage'
    elif failure=='symlink':
        original=Path(str(db)+'-wal');saved=tmp_path/'saved-wal';original.rename(saved);original.symlink_to(saved)
    with pytest.raises((ValueError,OSError)):
        collector.stage_frozen_databases(roster,destination,expected_files=expected,run=inspect)
    assert not (destination/'source-map.json').exists()



def test_generic_original_sidecar_guard_is_not_relaxed(fixture,tmp_path):
    roster,resolved,run,calls=fixture;db=abrupt_wal(roster)
    sidecars=[Path(str(db)+suffix) for suffix in ('-wal','-shm')]
    with pytest.raises(ValueError,match='Sources changed during snapshot'):
        create_snapshot(tmp_path/'direct',databases=[db],key_files=sidecars)
    assert not (tmp_path/'direct/manifest.json').exists()
