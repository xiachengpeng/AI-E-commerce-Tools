"""Explicit runtime must never prepare a database or private evidence implicitly."""
import json
import sqlite3
from pathlib import Path

import pytest
from services.research_runtime import open_research_runtime, resolve_runtime_paths
from sqlalchemy import text


def test_absolute_paths_and_private_boundaries(tmp_path):
    root = tmp_path / 'research'
    paths = resolve_runtime_paths(tmp_path / 'history.db', root)
    assert paths.database.is_absolute()
    assert paths.evidence_root == root / 'evidence'
    assert paths.keys_root == root / 'keys'
    assert paths.browser_root == root / 'browser'
    assert paths.lock_root == root / 'locks'
    assert not root.exists()
    with pytest.raises(ValueError):
        resolve_runtime_paths(tmp_path / 'history.db', tmp_path / '..' / 'escape')
    with pytest.raises(ValueError):
        resolve_runtime_paths(tmp_path / 'history.db', tmp_path / 'backend' / 'static')


def test_symlink_and_permission_fail_closed(tmp_path):
    private = tmp_path / 'private'
    private.mkdir(mode=0o700)
    linked = tmp_path / 'linked'
    linked.symlink_to(private, target_is_directory=True)
    with pytest.raises(ValueError):
        resolve_runtime_paths(tmp_path / 'db', linked)
    private.chmod(0o755)
    with pytest.raises(ValueError):
        resolve_runtime_paths(tmp_path / 'db', private)


@pytest.mark.asyncio
async def test_missing_configuration_never_initializes_second_database(tmp_path):
    paths = resolve_runtime_paths(tmp_path / 'history.db', tmp_path / 'research')
    async with open_research_runtime(paths, allow_commands=False, allow_external=False) as runtime:
        assert runtime.engine is None
        assert runtime.store is None
        assert runtime.evidence_store is None
        assert runtime.diagnostics == ('database_missing',)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_unprepared_schema_is_readonly_and_refuses_commands(tmp_path):
    database = tmp_path / 'history.db'
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE original (value TEXT)')
        connection.execute("INSERT INTO original VALUES ('preserved')")
    before = database.read_bytes()
    paths = resolve_runtime_paths(database, tmp_path / 'research')
    async with open_research_runtime(paths, allow_commands=False, allow_external=False) as runtime:
        assert runtime.diagnostics == ('schema_unprepared',)
        async with runtime.engine.connect() as connection:
            assert await connection.scalar(text('SELECT value FROM original')) == 'preserved'
            with pytest.raises(Exception, match='readonly'):
                await connection.execute(text("INSERT INTO original VALUES ('bad')"))
    assert database.read_bytes() == before
    assert not paths.evidence_root.parent.exists()
    with pytest.raises(ValueError, match='not prepared'):
        async with open_research_runtime(paths, allow_commands=True, offline_commands=True, allow_external=False):
            pass


@pytest.mark.asyncio
async def test_api_worker_share_database_across_cwd(tmp_path, monkeypatch):
    database = tmp_path / 'history.db'
    sqlite3.connect(database).close()
    paths = resolve_runtime_paths(database, tmp_path / 'research')
    for name in ('api', 'worker'):
        directory = tmp_path / name
        directory.mkdir()
        monkeypatch.chdir(directory)
        async with open_research_runtime(paths, allow_commands=False, allow_external=False) as runtime:
            assert Path(runtime.engine.url.database.split('?', 1)[0].removeprefix('file:')) == database
            assert runtime.paths.lock_root == tmp_path / 'research' / 'locks'


@pytest.mark.asyncio
async def test_prepared_fixture_requires_original_key_and_explicit_directories(tmp_path):
    from backend.migrations.full_merge_v1 import prepare_schema
    database = tmp_path / 'history.db'
    sqlite3.connect(database).close()
    prepare_schema(database, backup_verified=True)
    root = tmp_path / 'research'
    root.mkdir(mode=0o700)
    paths = resolve_runtime_paths(database, root)
    for directory in (paths.evidence_root, paths.keys_root, paths.browser_root, paths.lock_root):
        directory.mkdir(mode=0o700)
    with pytest.raises(ValueError, match='namespace configuration'):
        async with open_research_runtime(paths, allow_commands=True, offline_commands=True, allow_external=False):
            pass
    namespace = paths.keys_root / 'evidence-namespace.json'
    namespace.write_text(json.dumps({'version': 1, 'evidence_bucket': 'fixture-bucket',
                                     'collector_version': 'fixture-collector'}))
    namespace.chmod(0o600)
    with pytest.raises(ValueError, match='signing material'):
        async with open_research_runtime(paths, allow_commands=True, offline_commands=True, allow_external=False):
            pass
    key = paths.keys_root / 'evidence-signing.key'
    key.write_bytes(b'x' * 32)
    key.chmod(0o600)
    before = set(root.rglob('*'))
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True, allow_external=False) as runtime:
        assert runtime.store is not None
        assert runtime.evidence_store is not None
        assert runtime.engine.get_execution_options()["research_lock_root"] == paths.lock_root
    assert set(root.rglob('*')) == before
    assert key.read_bytes() == b'x' * 32
    assert not (paths.evidence_root / '.signing-key').exists()
    with pytest.raises(ValueError, match='external execution'):
        async with open_research_runtime(paths, allow_commands=True, allow_external=True):
            pass


@pytest.mark.asyncio
async def test_marker_alone_cannot_unlock_commands(tmp_path):
    database = tmp_path / 'history.db'
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE full_merge_schema (id INTEGER PRIMARY KEY, revision INTEGER)')
        connection.execute('INSERT INTO full_merge_schema VALUES (1, 1)')
    paths = resolve_runtime_paths(database, tmp_path / 'research')
    with pytest.raises(ValueError, match='not prepared'):
        async with open_research_runtime(paths, allow_commands=True, offline_commands=True, allow_external=False):
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize('damage', ['column', 'unique'])
async def test_structural_damage_refuses_runtime_commands(tmp_path, damage):
    from sqlalchemy import MetaData, UniqueConstraint, create_engine

    from backend.migrations.full_merge_v1 import prepare_schema, research_metadata

    database = tmp_path / 'history.db'
    sqlite3.connect(database).close()
    prepare_schema(database, backup_verified=True)
    engine = create_engine(f'sqlite:///{database}')
    with engine.begin() as c:
        if damage == 'column':
            c.exec_driver_sql('ALTER TABLE daily_usage DROP COLUMN scans')
        else:
            original = research_metadata().tables['runtime_jobs']
            clone = original.to_metadata(MetaData())
            for constraint in list(clone.constraints):
                if isinstance(constraint, UniqueConstraint):
                    clone.constraints.remove(constraint)
            original.drop(c)
            clone.create(c)
    engine.dispose()
    before = database.read_bytes()
    paths = resolve_runtime_paths(database, tmp_path / 'research')
    async with open_research_runtime(paths, allow_commands=False) as runtime:
        assert runtime.diagnostics == ('schema_unprepared',)
        assert runtime.store is None
    with pytest.raises(ValueError, match='not prepared'):
        async with open_research_runtime(paths, allow_commands=True, offline_commands=True):
            pass
    assert database.read_bytes() == before
    assert not paths.evidence_root.parent.exists()
