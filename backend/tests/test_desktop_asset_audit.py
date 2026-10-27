"""Read-only inventory; candidates do not authorize file replacement."""
import json
import sqlite3
from pathlib import Path
import pytest
from scripts.desktop.audit_assets import audit_assets


def make_data(tmp_path):
    root = tmp_path/'data';(root/'static/outputs').mkdir(parents=True)
    with sqlite3.connect(root/'history.db') as db:
        db.execute('CREATE TABLE render_history(id INTEGER PRIMARY KEY,image_base64 TEXT,metadata_info TEXT)')
        db.execute('INSERT INTO render_history VALUES(1,?,NULL)',('/static/outputs/missing.png',))
    return root


def test_missing_asset_candidates_are_evidence_not_automatic_recovery(tmp_path):
    data=make_data(tmp_path); backup=tmp_path/'backup';(backup/'outputs').mkdir(parents=True)
    (backup/'outputs/missing.png').write_bytes(b'not-a-valid-image')
    before=(data/'history.db').read_bytes()
    report=audit_assets(data, backup_roots=(backup,))
    assert report['index_complete'] is True
    assert report['missing_count']==1
    row=report['assets'][0]
    assert row['path']=='outputs/missing.png'
    assert row['status']=='missing' and len(row['candidates'])==1
    assert row['candidates'][0]['media_valid'] is False
    assert row['recovered'] is False
    assert before==(data/'history.db').read_bytes()
    assert not (data/'static/outputs/missing.png').exists()


def test_duplicate_backup_candidates_report_hash_conflict(tmp_path):
    data=make_data(tmp_path);roots=[]
    for i in range(2):
        root=tmp_path/str(i);(root/'outputs').mkdir(parents=True)
        (root/'outputs/missing.png').write_bytes(bytes([i]));roots.append(root)
    report=audit_assets(data, backup_roots=roots)
    assert report['assets'][0]['candidate_conflict'] is True


def test_symlink_data_root_is_rejected(tmp_path):
    data=make_data(tmp_path);alias=tmp_path/'alias';alias.symlink_to(data)
    with pytest.raises(ValueError):audit_assets(alias)


def test_missing_database_never_created(tmp_path):
    root=tmp_path/'empty';root.mkdir()
    with pytest.raises(ValueError):audit_assets(root)
    assert list(root.iterdir())==[]
