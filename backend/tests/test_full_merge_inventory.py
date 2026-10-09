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


def test_backup_refuses_existing_verification_copy(tmp_path):
    import pytest
    source = tmp_path / 'live.db'
    with sqlite3.connect(source) as db:
        db.execute('CREATE TABLE x(id)')
    destination = tmp_path / 'snapshot.db'
    reference = tmp_path / 'snapshot.db.verification-copy'
    reference.write_bytes(b'preserve')
    with pytest.raises(FileExistsError):
        backup_sqlite(source, destination)
    assert reference.read_bytes() == b'preserve'
    assert not destination.exists()
    reference.unlink()
    reference.symlink_to(source)
    with pytest.raises(FileExistsError):
        backup_sqlite(source, destination)
    assert reference.is_symlink()


def test_verification_copy_private_and_cleaned_on_failure(tmp_path, monkeypatch):
    import pytest
    import scripts.full_merge.backup as module
    source = tmp_path / 'live.db'
    with sqlite3.connect(source) as db:
        db.execute('CREATE TABLE x(id)')
    def fail(path):
        reference = tmp_path / 'snapshot.db.verification-copy'
        assert reference.stat().st_mode & 0o777 == 0o600
        raise RuntimeError('fixture failure')
    monkeypatch.setattr(module, 'database_stats', fail)
    with pytest.raises(RuntimeError):
        backup_sqlite(source, tmp_path / 'snapshot.db')
    assert not (tmp_path / 'snapshot.db.verification-copy').exists()


def test_snapshot_requires_anchor_for_completeness(tmp_path):
    import hashlib
    source = tmp_path / 'objects'
    source.mkdir()
    (source / 'a').write_bytes(b'a')
    (source / 'b').write_bytes(b'b')
    snapshot = tmp_path / 'snapshot'
    create_snapshot(snapshot, object_roots=[source])
    digest = hashlib.sha256((snapshot / 'manifest.json').read_bytes()).hexdigest()
    assert verify_snapshot(snapshot)['completeness_verified'] is False
    assert verify_snapshot(snapshot, expected_digest=digest)['completeness_verified'] is True
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    manifest['objects'].pop()
    (snapshot / 'manifest.json').write_text(json.dumps(manifest))
    assert not verify_snapshot(snapshot, expected_digest=digest)['verified']
    assert not verify_snapshot(snapshot)['verified']


def test_full_merge_coverage_matrix():
    from scripts.full_merge.inventory import validate_coverage
    path = Path(__file__).resolve().parents[2] / 'docs/merge-assessment/full-merge-coverage.json'
    matrix = json.loads(path.read_text())
    assert validate_coverage(matrix)['verified']
    import copy
    for mutate in [lambda m: m['coverage'].pop(), lambda m: m['coverage'].append(m['coverage'][0]), lambda m: m['coverage'][0].update(task=999), lambda m: m['coverage'][0].update(target=''), lambda m: m['coverage'][0].update(test='missing'), lambda m: m['coverage'][0].update(id='extra')]:
        invalid = copy.deepcopy(matrix)
        mutate(invalid)
        assert not validate_coverage(invalid)['verified']


def test_removed_category_and_rewritten_roster_fail_anchor(tmp_path):
    import hashlib
    source = tmp_path / 'live.db'
    with sqlite3.connect(source) as db:
        db.execute('CREATE TABLE x(id)')
    key = tmp_path / 'key'
    key.write_bytes(b'private fixture')
    snapshot = tmp_path / 'snapshot'
    create_snapshot(snapshot, databases=[source], key_files=[key])
    digest = hashlib.sha256((snapshot / 'manifest.json').read_bytes()).hexdigest()
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    manifest['keys'] = []
    (snapshot / 'manifest.json').write_text(json.dumps(manifest))
    assert not verify_snapshot(snapshot)['verified']
    manifest['requested_sources'] = [s for s in manifest['requested_sources'] if s['category'] != 'keys']
    manifest['expected_counts']['keys'] = 0
    (snapshot / 'manifest.json').write_text(json.dumps(manifest))
    assert verify_snapshot(snapshot)['integrity_verified']
    assert not verify_snapshot(snapshot)['completeness_verified']
    assert not verify_snapshot(snapshot, expected_digest=digest)['verified']


def test_dynamic_prefix_and_actions_are_unresolved(tmp_path):
    (tmp_path / 'app.py').write_text('''router = APIRouter(prefix=PREFIX)
USER_ACTIONS = build_actions()
@router.get("/items")
def items(): pass
''')
    result = inventory(tmp_path)
    assert {'dynamic_prefix', 'dynamic_user_actions'} <= {e['reason'] for e in result['unresolved']}


def test_router_alias_multiple_mounts(tmp_path):
    (tmp_path / 'routes').mkdir()
    (tmp_path / 'routes/items.py').write_text('''router = APIRouter(prefix="/v1")
@router.get("/items")
def items(): pass
''')
    (tmp_path / 'main.py').write_text('''from routes.items import router as item_routes
app = FastAPI()
app.include_router(item_routes, prefix="/api")
app.include_router(item_routes, prefix="/legacy")
app.include_router(item_routes, prefix=DYNAMIC)
''')
    result = inventory(tmp_path)
    assert {r['path'] for r in result['routes']} == {'/api/v1/items', '/legacy/v1/items'}
    assert result['route_declarations'][0]['path'] == '/v1/items'
    assert 'dynamic_include_router' in {u['reason'] for u in result['unresolved']}


def test_main_mounted_routes_match_sanitized_runtime():
    matrix = json.loads((Path(__file__).resolve().parents[2] / 'docs/merge-assessment/full-merge-coverage.json').read_text())
    assert {tuple(r) for r in matrix['runtime_routes']['main']} == {(r['method'], r['path']) for r in matrix['inventories']['main']['routes']}


def test_task1_operational_gates_preserve_later_acceptance():
    from scripts.full_merge.inventory import validate_coverage
    import copy
    matrix = json.loads((Path(__file__).resolve().parents[2] / 'docs/merge-assessment/full-merge-coverage.json').read_text())
    assert matrix['task1_operational_complete'] is True
    assert matrix['live_backup_executed'] is True
    assert matrix['cutover_allowed'] is False
    assert matrix['source_future_freeze'] is False
    assert matrix['operational_gates']['research_runtime_route_parity'] == 'passed'
    assert len(matrix['runtime_routes']['research']) == 49
    assert all(e['acceptance'].startswith('pending_') for e in matrix['coverage'])
    invalid = copy.deepcopy(matrix)
    invalid['runtime_routes']['research'].pop()
    assert not validate_coverage(invalid)['verified']
