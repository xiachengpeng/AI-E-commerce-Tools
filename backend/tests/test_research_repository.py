import sqlite3
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from services.research_repository import ResearchRepository, RepositoryError, migrate


def test_migration_is_explicit_additive_and_idempotent(tmp_path):
    from db import Base
    assert not any(name.startswith('research_') for name in Base.metadata.tables)
    path = tmp_path / 'history.db'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE legacy (value TEXT)')
        db.execute("INSERT INTO legacy VALUES ('keep')")
    repo = ResearchRepository(path)
    with pytest.raises(RepositoryError):
        repo.list()
    migrate(path); migrate(path)
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT value FROM legacy').fetchall() == [('keep',)]
    assert repo.list()['imports'] == []


def test_missing_database_fails_safely_without_creating_file(tmp_path):
    path=tmp_path/'missing.db'
    with pytest.raises(RepositoryError) as error:
        ResearchRepository(path).list()
    assert error.value.status==503
    assert not path.exists()


def test_parallel_import_is_atomic_idempotent_and_conflicts(tmp_path):
    path = tmp_path / 'history.db'; migrate(path)
    repo = ResearchRepository(path)
    operation = str(uuid4())
    snapshot = {'source_ref': {'project_id': str(uuid4()), 'product_id': str(uuid4()), 'source_version': 2}, 'market': 'GB', 'facts': []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: repo.save(operation, 'same-digest', 'Pouch', snapshot), range(4)))
    assert len({r['link_id'] for r in results}) == 1
    assert len(repo.list()['imports']) == 1
    assert repo.lookup(operation, 'same-digest')['snapshot'] == snapshot
    with pytest.raises(RepositoryError) as conflict:
        repo.lookup(operation, 'different')
    assert conflict.value.status == 409
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT count(*) FROM research_links').fetchone()[0] == 1


def test_artifact_links_check_existence_revision_and_preserve_legacy(tmp_path):
    path = tmp_path / 'history.db'; migrate(path)
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE listing_history (id INTEGER PRIMARY KEY, result TEXT, timestamp TEXT)')
        db.execute("INSERT INTO listing_history VALUES (1,'original',NULL)")
    repo = ResearchRepository(path); operation = str(uuid4())
    repo.save(operation,'digest','Pouch',{'source_ref':{},'market':'US','facts':[]})
    with pytest.raises(RepositoryError) as missing:
        repo.attach(operation,1,'listing',2)
    assert missing.value.status == 404
    assert repo.attach(operation,1,'listing',1)['revision'] == 2
    assert repo.attach(operation,1,'listing',1)['revision'] == 2
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT result FROM listing_history').fetchone()[0] == 'original'


def test_reused_history_id_cannot_silently_bind_to_a_new_record(tmp_path):
    path=tmp_path/'history.db';migrate(path)
    repo=ResearchRepository(path);operation=str(uuid4())
    repo.save(operation,'digest','Pouch',{'source_ref':{},'market':'US','facts':[]})
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE listing_history (id INTEGER PRIMARY KEY, timestamp TEXT)')
        db.execute("INSERT INTO listing_history VALUES (1,'2026-10-09 01:00:00')")
    repo.attach(operation,1,'listing',1,'2026-10-09T01:00:00')
    with sqlite3.connect(path) as db:
        db.execute('DELETE FROM listing_history WHERE id=1')
        db.execute("INSERT INTO listing_history VALUES (1,'2026-10-09 02:00:00')")
    with pytest.raises(RepositoryError) as conflict:
        repo.attach(operation,2,'listing',1,'2026-10-09T01:00:00')
    assert conflict.value.status==409


def test_incompatible_schema_fails_closed_and_backup_restores(tmp_path):
    path = tmp_path / 'history.db'; migrate(path)
    repo = ResearchRepository(path)
    repo.save(str(uuid4()),'digest','Product',{'source_ref':{},'market':'US','facts':[]})
    restored = tmp_path/'restored.db'
    with sqlite3.connect(path) as source, sqlite3.connect(restored) as target:
        source.backup(target)
    assert ResearchRepository(restored).list() == repo.list()
    with sqlite3.connect(restored) as db:
        db.execute('UPDATE research_schema SET revision=99')
    with pytest.raises(RepositoryError):
        ResearchRepository(restored).list()
