"""File-backed disposable references; never touches live static assets."""
import json
import os
from pathlib import Path
import sqlite3
import time

import pytest


@pytest.fixture
def assets(tmp_path, monkeypatch):
    static = tmp_path / 'static'; (static / 'uploads').mkdir(parents=True)
    database = tmp_path / 'history.db'
    with sqlite3.connect(database) as c:
        c.execute('CREATE TABLE render_history(id INTEGER PRIMARY KEY,image_base64 TEXT,metadata_info JSON)')
    from services import storage_cleanup_service as cleanup
    monkeypatch.setattr(cleanup, 'STATIC_DIR', str(static))
    monkeypatch.setenv('SQLITE_DB_PATH', str(database))
    return database, static


def old_file(static, name):
    path = static / 'uploads' / name; path.write_bytes(b'asset')
    stamp = time.time() - 172800; os.utime(path,(stamp,stamp))
    return path


def test_ttl_preserves_referenced_old_asset_and_removes_orphan(assets):
    db, static = assets
    kept = old_file(static,'kept.png'); orphan = old_file(static,'orphan.png')
    with sqlite3.connect(db) as c:
        c.execute('INSERT INTO render_history VALUES(1,?,?)',('/static/uploads/kept.png',json.dumps({'modules':[{'imageSrc':'/static/uploads/kept.png'}]})))
    from services.storage_cleanup_service import cleanup_expired_static_files
    assert cleanup_expired_static_files() == (1,5)
    assert kept.exists() and not orphan.exists()


def test_invalid_reference_json_fails_closed(assets):
    db, static = assets; item=old_file(static,'kept.png')
    with sqlite3.connect(db) as c: c.execute('INSERT INTO render_history VALUES(1,NULL,?)',('{invalid',))
    from services.storage_cleanup_service import cleanup_expired_static_files
    assert cleanup_expired_static_files() == (0,0)
    assert item.exists()


def test_reference_index_respects_local_origin_and_decoded_traversal(assets):
    from services.asset_reference_service import collect_asset_references
    db, static = assets
    with sqlite3.connect(db) as c:
        c.execute('INSERT INTO render_history VALUES(1,NULL,?)',(json.dumps({'local':'http://127.0.0.1:9503/static/uploads/a%20b.png?x=1','external':'https://example.org/static/uploads/remote.png'}),))
    report=collect_asset_references(db,asset_root=static)
    assert report.complete
    assert static/'uploads/a b.png' in report.protected_paths
    assert static/'uploads/remote.png' not in report.protected_paths
    with sqlite3.connect(db) as c:
        c.execute('INSERT INTO render_history VALUES(2,NULL,?)',(json.dumps({'bad':'/static/%2e%2e/outside.png'}),))
    assert not collect_asset_references(db,asset_root=static).complete


def test_symlink_assets_are_never_deleted(assets,tmp_path):
    db, static=assets
    outside=tmp_path/'outside';outside.mkdir(); victim=outside/'victim.png';victim.write_bytes(b'x');os.utime(victim,(1,1))
    (static/'uploads'/'alias').symlink_to(outside,target_is_directory=True)
    (static/'uploads'/'link.png').symlink_to(victim)
    from services.storage_cleanup_service import cleanup_expired_static_files
    cleanup_expired_static_files()
    assert victim.exists() and (static/'uploads/link.png').is_symlink()


def test_missing_database_fails_closed(assets):
    db,static=assets; old=old_file(static,'kept.png');db.unlink()
    from services.storage_cleanup_service import cleanup_expired_static_files
    assert cleanup_expired_static_files()==(0,0) and old.exists()


def test_unknown_history_table_prevents_ttl_deletion(assets):
    from services.asset_reference_service import collect_asset_references
    db,static=assets
    with sqlite3.connect(db) as c: c.execute('CREATE TABLE future_history(id INTEGER PRIMARY KEY, payload JSON)')
    assert not collect_asset_references(db,asset_root=static).complete


def test_explicit_delete_preserves_shared_referenced_asset(assets):
    db,static=assets; path=old_file(static,'shared.png')
    with sqlite3.connect(db) as c:
        c.execute('INSERT INTO render_history VALUES(1,?,NULL)',('/static/uploads/shared.png',))
    from services.storage_cleanup_service import safe_delete_static_file
    assert safe_delete_static_file('/static/uploads/shared.png') is False
    assert path.exists()


def test_reference_lock_blocks_cleanup_until_committed_reference(assets):
    """A writer that has begun publishing a reference wins before GC reads."""
    import threading
    from sqlalchemy import create_engine, text
    from services.asset_reference_service import install_reference_transaction_lock
    from services.storage_cleanup_service import cleanup_expired_static_files
    db, static = assets
    image = old_file(static, 'new-reference.png')
    engine = create_engine('sqlite:///' + str(db))
    install_reference_transaction_lock(engine, db)
    finished = threading.Event()
    results = []
    with engine.connect() as connection:
        transaction = connection.begin()
        connection.execute(text('INSERT INTO render_history VALUES(1,:url,NULL)'), {'url': '/static/uploads/new-reference.png'})
        def clean():
            results.append(cleanup_expired_static_files())
            finished.set()
        worker = threading.Thread(target=clean, daemon=True)
        worker.start()
        assert not finished.wait(0.1)
        transaction.commit()
    assert finished.wait(3)
    worker.join()
    assert results == [(0, 0)] and image.exists()
    engine.dispose()


def test_reference_lock_releases_after_rollback_and_invalidation(assets):
    import fcntl
    from sqlalchemy import create_engine, text
    from services.asset_reference_service import install_reference_transaction_lock
    db, _ = assets
    engine = create_engine('sqlite:///' + str(db))
    install_reference_transaction_lock(engine, db)
    for invalidate in (False, True):
        with engine.connect() as connection:
            connection.execute(text('SELECT 1'))
            if invalidate:
                connection.invalidate()
            else:
                connection.rollback()
        with open(db.parent / '.asset-reference.lock', 'rb') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle, fcntl.LOCK_UN)
    engine.dispose()


def test_integrated_async_engine_uses_reference_lock_explicitly(assets):
    """Domain-only health probes cannot depend on main services imports."""
    import asyncio
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine
    db, _ = assets
    engine = create_engine('sqlite+aiosqlite:///' + str(db), asset_reference_database=db)
    assert engine.sync_engine._asset_reference_lock_installed is True
    asyncio.run(engine.dispose())


def test_async_reference_lock_cannot_point_at_another_database(assets,tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine
    db, _ = assets
    with pytest.raises(ValueError,match='reference database'):
        create_engine('sqlite+aiosqlite:///' + str(db), asset_reference_database=tmp_path/'other.db')

@pytest.mark.asyncio
async def test_async_database_lock_wait_does_not_block_other_coroutines(assets):
    import asyncio
    import threading
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from services.asset_reference_service import asset_reference_lock, install_reference_transaction_lock
    db,_=assets
    engine=create_async_engine('sqlite+aiosqlite:///'+str(db));install_reference_transaction_lock(engine.sync_engine,db)
    async with engine.connect() as c:await c.execute(text('SELECT 1'))
    held=threading.Event();release=threading.Event()
    def cleanup():
        with asset_reference_lock(db,exclusive=True):held.set();release.wait(2)
    thread=threading.Thread(target=cleanup);thread.start();assert await asyncio.to_thread(held.wait,1)
    safety=threading.Timer(0.6,release.set);safety.start()
    started=time.monotonic();resumed=[]
    async def progress():
        await asyncio.sleep(0.01);resumed.append(time.monotonic()-started);release.set()
    ticker=asyncio.create_task(progress())
    try:
        async with engine.connect() as c:await c.execute(text('SELECT 1'))
        await ticker
        assert resumed[0]<0.3,'file-lock wait froze the event loop'
    finally:
        release.set();safety.cancel();thread.join(2);await engine.dispose()
