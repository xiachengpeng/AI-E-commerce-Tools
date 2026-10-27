"""Candidate preparation never installs data or enables execution."""
import json
from pathlib import Path
import sqlite3
import pytest
from scripts.desktop import prepare_data as module


def sources(tmp_path):
    root=tmp_path/'source';root.mkdir()
    db=root/'history.db'
    with sqlite3.connect(db) as c:
        c.execute('create table sample (id integer primary key, value text)')
        c.execute("insert into sample values(1,'fixture')")
    assets=root/'static';(assets/'outputs').mkdir(parents=True)
    (assets/'outputs/image.png').write_bytes(b'fixture-image')
    return db,assets


def test_prepare_is_additive_verified_and_never_installs_or_enables(tmp_path):
    db,assets=sources(tmp_path)
    before=(db.read_bytes(),db.stat().st_mtime_ns)
    config=tmp_path/'research.json';config.write_text(json.dumps({'enabled':True,'worker_mode':'active','token':'synthetic-fixture-secret'}))
    calls=[];target=tmp_path/'private candidate'
    report=module.prepare_candidate(db,assets,target,config_files={'research.json':config},offline_check=lambda *args:calls.append(True))
    assert report['status']=='candidate_verified'
    assert report['execution_allowed'] is False
    assert len(calls)>=2
    assert (target/'backup/databases/0.db').is_file()
    assert (target/'candidate/static/outputs/image.png').read_bytes()==b'fixture-image'
    assert json.loads((target/'candidate/research.json').read_text())['enabled'] is False
    assert before==(db.read_bytes(),db.stat().st_mtime_ns)
    assert json.loads(config.read_text())['enabled'] is True
    assert 'synthetic-fixture-secret' not in json.dumps(report)
    assert module.verify_candidate(target)['verified'] is True
    assert target.stat().st_mode & 0o077 == 0


def test_busy_source_refused_before_target_creation(tmp_path):
    db,assets=sources(tmp_path);target=tmp_path/'candidate'
    def busy(*args):raise ValueError('source still running')
    with pytest.raises(ValueError):module.prepare_candidate(db,assets,target,offline_check=busy)
    assert not target.exists()


def test_never_overwrites_existing_destination(tmp_path):
    db,assets=sources(tmp_path);target=tmp_path/'existing';target.mkdir();(target/'keep').write_text('keep')
    with pytest.raises(FileExistsError):module.prepare_candidate(db,assets,target,offline_check=lambda *a:None)
    assert (target/'keep').read_text()=='keep'


def test_rejects_destination_inside_source_assets(tmp_path):
    db,assets=sources(tmp_path)
    with pytest.raises(ValueError):module.prepare_candidate(db,assets,assets/'candidate',offline_check=lambda *a:None)


def test_parent_segments_cannot_hide_destination_inside_source(tmp_path):
    db,assets=sources(tmp_path)
    alias=tmp_path/'alias';alias.mkdir()
    alternate=alias/'..'/'source'/'static'
    target=assets/'candidate'
    before=module.inventory(assets)
    with pytest.raises(ValueError):
        module.prepare_candidate(db,alternate,target,offline_check=lambda *a:None)
    assert not target.exists()
    assert module.inventory(assets)==before


def test_rejects_asset_symlink(tmp_path):
    db,assets=sources(tmp_path);(assets/'escape').symlink_to(db)
    with pytest.raises(ValueError):module.prepare_candidate(db,assets,tmp_path/'candidate',offline_check=lambda *a:None)


def test_modified_candidate_is_not_accepted(tmp_path):
    db,assets=sources(tmp_path);target=tmp_path/'candidate'
    module.prepare_candidate(db,assets,target,offline_check=lambda *a:None)
    (target/'candidate/static/outputs/image.png').write_bytes(b'changed')
    with pytest.raises(ValueError):module.verify_candidate(target)


def test_sources_changing_after_backup_never_produce_ready_report(tmp_path):
    db,assets=sources(tmp_path);target=tmp_path/'candidate';calls=[]
    def changed(*args):
        calls.append(True)
        if len(calls)==2:(assets/'outputs/image.png').write_bytes(b'new source revision')
    with pytest.raises(ValueError):module.prepare_candidate(db,assets,target,offline_check=changed)
    assert not (target/'candidate-report.json').exists()


def test_research_rows_require_private_evidence_backup(tmp_path):
    db,assets=sources(tmp_path)
    with sqlite3.connect(db) as c:
        c.execute('create table full_merge_ledger (id integer)');c.execute('insert into full_merge_ledger values(1)')
    with pytest.raises(ValueError):module.prepare_candidate(db,assets,tmp_path/'candidate',offline_check=lambda *a:None)


def test_modified_backup_is_not_accepted(tmp_path):
    db,assets=sources(tmp_path);target=tmp_path/'candidate'
    module.prepare_candidate(db,assets,target,offline_check=lambda *a:None)
    (target/'backup/objects/0/outputs/image.png').write_bytes(b'changed')
    with pytest.raises(ValueError):module.verify_candidate(target)


def test_schema_probe_closes_its_source_connection_before_offline_guard(tmp_path,monkeypatch):
    db,assets=sources(tmp_path)
    real_connect=module.sqlite3.connect;opened=[]
    def track(*args,**kwargs):
        connection=real_connect(*args,**kwargs)
        if args and str(args[0]).startswith(db.as_uri()):opened.append(connection)
        return connection
    monkeypatch.setattr(module.sqlite3,'connect',track)
    def guard(*args):
        for connection in opened:
            with pytest.raises(sqlite3.ProgrammingError):connection.execute('SELECT 1')
    module.prepare_candidate(db,assets,tmp_path/'candidate',offline_check=guard)
