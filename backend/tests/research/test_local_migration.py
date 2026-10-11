"""Migration copies typed rows and validates their content, not only counts."""
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import select

from rabbit_hole.persistence.projects import WorkbenchStore
from test_sqlite_storage import sqlite_engine


async def test_database_migration_preserves_project_events_and_refuses_nonempty(sqlite_engine,tmp_path):
    from rabbit_hole.persistence.sql import create_engine
    from rabbit_hole.persistence.migrate_local import migrate_database
    source = sqlite_engine
    store = WorkbenchStore(source)
    project = await store.create("迁移测试","isolated","US",str(uuid4()))
    project = await store.command(project["id"],project["version"],str(uuid4()),"add_keyword",{"text":"pet","type":"category"})
    target = create_engine("sqlite+aiosqlite:///"+str(tmp_path/"destination.db"))
    try:
        report=await migrate_database(source,target)
        copied = await WorkbenchStore(target).get(project["id"])
        assert copied == project
        assert report["workbench_projects"]["count"] == 1
        assert report["workbench_events"]["count"] == 2
        assert all(r["matched"] for r in report.values())
        with pytest.raises(ValueError,match="empty"):
            await migrate_database(source,target)
    finally:
        await target.dispose()


def test_object_migration_preserves_versions_and_delete_markers(tmp_path):
    from rabbit_hole.persistence.local_objects import LocalObjectClient
    from rabbit_hole.persistence.migrate_local import migrate_objects
    source=LocalObjectClient(tmp_path/"source")
    a=source.put_object(Bucket="private",Key="evidence/a",Body=b"one",Metadata={"x":"one"})
    b=source.put_object(Bucket="private",Key="evidence/a",Body=b"two",Metadata={"x":"two"})
    marker=source.delete_object(Bucket="private",Key="evidence/a")
    source.put_object(Bucket="private",Key="evidence/b",Body=b"live")
    target=LocalObjectClient(tmp_path/"target")
    report=migrate_objects(source,target,"private")
    assert report["versions"] == 4 and report["matched"]
    assert target.get_object(Bucket="private",Key="evidence/a",VersionId=a["VersionId"])["Body"].read() == b"one"
    assert target.get_object(Bucket="private",Key="evidence/a",VersionId=b["VersionId"])["Metadata"] == {"x":"two"}
    with pytest.raises(Exception):
        target.get_object(Bucket="private",Key="evidence/a")
    with pytest.raises(ValueError,match="empty"):
        migrate_objects(source,target,"private")

async def test_failed_object_migration_cannot_start_partial_database(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from rabbit_hole.persistence import migrate_local
    from rabbit_hole.persistence.sql import initialize_sqlite, create_engine
    class Source:
        async def dispose(self): pass
    class Client:
        def close(self): pass
    monkeypatch.setattr("rabbit_hole.config.get_settings", lambda: SimpleNamespace(
        storage_backend="s3", database_url="postgresql://isolated", s3_bucket="private"))
    monkeypatch.setattr("rabbit_hole.persistence.database.create_database_engine", lambda settings: Source())
    monkeypatch.setattr("rabbit_hole.persistence.storage_factory.create_storage_client", lambda settings: Client())
    async def database_copy(source, target):
        await initialize_sqlite(target, migration=True)
        return {"isolated":{"matched":True}}
    monkeypatch.setattr(migrate_local, "migrate_database", database_copy)
    def failed_objects(*args):
        raise OSError("injected incomplete evidence copy")
    monkeypatch.setattr(migrate_local, "migrate_objects", failed_objects)
    destination = tmp_path/"failed-target"
    with pytest.raises(OSError, match="incomplete"):
        await migrate_local.run(str(destination))
    assert (destination/"workbench.db").exists()
    assert not (destination/"migration-report.json").exists()
    engine=create_engine("sqlite+aiosqlite:///"+str(destination/"workbench.db"))
    try:
        with pytest.raises(ValueError, match="migration"):
            await initialize_sqlite(engine)
    finally:
        await engine.dispose()
