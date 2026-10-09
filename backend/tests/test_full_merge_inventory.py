import json
import sqlite3
from pathlib import Path

from scripts.full_merge.inventory import inventory
from scripts.full_merge.backup import backup_sqlite, create_snapshot
from scripts.full_merge.verify import verify_snapshot


def test_inventory_has_every_route_and_action(tmp_path):
    (tmp_path / 'app.py').write_text('''from fastapi import APIRouter
router = APIRouter(prefix="/api")
@router.get("/items")
def items(): pass
@router.api_route("/jobs", methods=["GET", "POST"])
def jobs(): pass
USER_ACTIONS = {"research": "private-value", "export": "other"}
job_kind = "research"
''')
    (tmp_path / 'index.html').write_text('<title>private title</title>')
    result = inventory(tmp_path)
    assert {(r['method'], r['path']) for r in result['routes']} == {('GET', '/api/items'), ('GET', '/api/jobs'), ('POST', '/api/jobs')}
    assert result['user_actions'] == ['export', 'research']
    assert result['job_kinds'] == ['research']
    assert result['pages'] == ['index.html']
    assert result['source_hashes']['app.py']


def test_backup_recovers_wal_rows(tmp_path):
    source = tmp_path / 'live.db'
    live = sqlite3.connect(source)
    live.execute('PRAGMA journal_mode=WAL')
    live.execute('CREATE TABLE evidence(id INTEGER PRIMARY KEY, value TEXT)')
    live.execute('INSERT INTO evidence(value) VALUES (?)', ('committed WAL row',))
    live.commit()
    assert Path(str(source) + '-wal').exists()
    result = backup_sqlite(source, tmp_path / 'restored.db')
    assert result['verified']
    restored = sqlite3.connect(tmp_path / 'restored.db')
    assert restored.execute('SELECT value FROM evidence').fetchone() == ('committed WAL row',)
    restored.close()
    live.close()


def test_manifest_never_serializes_secrets(tmp_path):
    root = tmp_path / 'source'
    root.mkdir()
    secret = 'fixture-secret-not-for-manifest'
    (root / '.env').write_text(secret)
    (root / 'app.py').write_text('API_KEY = ' + repr(secret))
    db = sqlite3.connect(root / 'history.db')
    db.execute('CREATE TABLE keys(secret TEXT)')
    db.execute('INSERT INTO keys VALUES (?)', (secret,))
    db.commit()
    db.close()
    assets = root / 'objects'
    assets.mkdir()
    (assets / 'version.bin').write_bytes(secret.encode())
    assert secret not in json.dumps(inventory(root))
    snap = tmp_path / 'snapshot'
    create_snapshot(snap, databases=[root / 'history.db'], object_roots=[assets], key_files=[root / '.env'])
    assert secret not in (snap / 'manifest.json').read_text()
    assert verify_snapshot(snap)['verified']
    (snap / 'objects/0/version.bin').write_bytes(b'corrupted')
    assert not verify_snapshot(snap)['verified']


def test_missing_assets_block_snapshot(tmp_path):
    import pytest
    with pytest.raises(FileNotFoundError):
        create_snapshot(tmp_path / 'snapshot', object_roots=[tmp_path / 'missing'])


def test_schema_and_dynamic_routes_are_explicit(tmp_path):
    (tmp_path / 'app.py').write_text('''from sqlalchemy import Column, String
class Evidence:
    secret = Column(String)
@router.get(PATH)
def dynamic(): pass
''')
    result = inventory(tmp_path)
    assert result['schema'][0]['class'] == 'Evidence'
    assert result['unresolved']


def test_frozen_actions_and_enum_job_kinds(tmp_path):
    (tmp_path / 'app.py').write_text('''USER_ACTIONS = frozenset({"confirm", "review"})
class JobKind(StrEnum):
    COLLECT = "collect"
    ANALYZE = "analyze"
''')
    result = inventory(tmp_path)
    assert result['user_actions'] == ['confirm', 'review']
    assert result['job_kinds'] == ['analyze', 'collect']


def test_truncated_manifest_fails_closed(tmp_path):
    (tmp_path / 'manifest.json').write_text('{}')
    assert verify_snapshot(tmp_path)['verified'] is False


def test_corrupt_database_reports_failure(tmp_path):
    source = tmp_path / 'source.db'
    with sqlite3.connect(source) as db:
        db.execute('CREATE TABLE x(id INTEGER)')
    snapshot = tmp_path / 'snapshot'
    create_snapshot(snapshot, databases=[source])
    (snapshot / 'databases/0.db').write_bytes(b'corrupted database')
    result = verify_snapshot(snapshot)
    assert result['verified'] is False
    assert result['failures']


def test_empty_snapshot_and_symlink_roots_rejected(tmp_path):
    import pytest
    with pytest.raises(ValueError):
        create_snapshot(tmp_path / 'empty')
    real = tmp_path / 'real'
    real.mkdir()
    (real / 'x').write_bytes(b'x')
    link = tmp_path / 'link'
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError):
        create_snapshot(tmp_path / 'snapshot', object_roots=[link])


def test_mutating_copy_is_rejected(tmp_path, monkeypatch):
    import pytest
    import scripts.full_merge.backup as module
    source = tmp_path / 'source'
    source.mkdir()
    file = source / 'x'
    file.write_bytes(b'before')
    original = module.shutil.copyfile
    def mutate(src, dst):
        result = original(src, dst)
        Path(src).write_bytes(b'after')
        return result
    monkeypatch.setattr(module.shutil, 'copyfile', mutate)
    with pytest.raises(ValueError):
        create_snapshot(tmp_path / 'snapshot', object_roots=[source])
    assert not (tmp_path / 'snapshot/manifest.json').exists()
