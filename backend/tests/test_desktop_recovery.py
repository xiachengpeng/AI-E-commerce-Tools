"""Recovery drills never install or activate a restored database."""
import hashlib
import sqlite3
from pathlib import Path
import pytest
from scripts.full_merge.backup import create_snapshot, database_stats
from scripts.desktop.verify_recovery import verify_recovery


def fixture_snapshot(tmp_path):
    db=tmp_path/'source.db'
    connection=sqlite3.connect(db)
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)')
    connection.execute("INSERT INTO sample VALUES(1,'committed WAL')");connection.commit()
    assets=tmp_path/'static';assets.mkdir();(assets/'a.png').write_bytes(b'fixture')
    private=tmp_path/'private';private.mkdir();(private/'signing-key').write_bytes(b'synthetic-key')
    snapshot=tmp_path/'snapshot'
    create_snapshot(snapshot,databases=[db],object_roots=[assets,private])
    connection.close()
    digest=hashlib.sha256((snapshot/'manifest.json').read_bytes()).hexdigest()
    return snapshot,digest


def test_restores_logical_wal_rows_assets_and_keys_without_activation(tmp_path):
    snapshot,digest=fixture_snapshot(tmp_path)
    result=verify_recovery(snapshot,tmp_path/'drill',expected_digest=digest)
    assert result['verified'] is True and result['execution_allowed'] is False
    assert database_stats(snapshot/'databases/0.db')==database_stats(tmp_path/'drill/databases/0.db')
    assert (tmp_path/'drill/objects/1/signing-key').read_bytes()==b'synthetic-key'
    assert not (tmp_path/'drill/research.json').exists()
    assert (tmp_path/'drill').stat().st_mode & 0o077 == 0


@pytest.mark.parametrize('mode',['tamper','missing','wrong-anchor'])
def test_corruption_refused_before_creating_destination(tmp_path,mode):
    snapshot,digest=fixture_snapshot(tmp_path)
    if mode=='tamper':(snapshot/'objects/0/a.png').write_bytes(b'corrupt')
    elif mode=='missing':(snapshot/'objects/1/signing-key').unlink()
    else:digest='0'*64
    with pytest.raises(ValueError):verify_recovery(snapshot,tmp_path/'drill',expected_digest=digest)
    assert not (tmp_path/'drill').exists()


def test_existing_destination_and_newer_data_are_never_overwritten(tmp_path):
    snapshot,digest=fixture_snapshot(tmp_path)
    target=tmp_path/'drill';target.mkdir();(target/'new-data').write_bytes(b'new')
    with pytest.raises(FileExistsError):verify_recovery(snapshot,target,expected_digest=digest)
    assert (target/'new-data').read_bytes()==b'new'
    with pytest.raises(ValueError):verify_recovery(snapshot,snapshot/'nested',expected_digest=digest)


def test_symlink_source_or_destination_refused(tmp_path):
    snapshot,digest=fixture_snapshot(tmp_path);alias=tmp_path/'alias';alias.symlink_to(snapshot)
    with pytest.raises(ValueError):verify_recovery(alias,tmp_path/'drill',expected_digest=digest)
    target=tmp_path/'drill';target.symlink_to(tmp_path/'missing')
    with pytest.raises(ValueError):verify_recovery(snapshot,target,expected_digest=digest)


def test_partial_copy_never_has_success_report(tmp_path,monkeypatch):
    from scripts.desktop import verify_recovery as module
    snapshot,digest=fixture_snapshot(tmp_path)
    def partial(source,destination):
        destination.write(source.read(1))
        raise OSError('synthetic write failure')
    monkeypatch.setattr(module.shutil,'copyfileobj',partial)
    with pytest.raises(OSError):module.verify_recovery(snapshot,tmp_path/'drill',expected_digest=digest)
    assert not (tmp_path/'drill/recovery-report.json').exists()
    # An interrupted attempt cannot overwrite that partial directory later.
    with pytest.raises(FileExistsError):module.verify_recovery(snapshot,tmp_path/'drill',expected_digest=digest)
