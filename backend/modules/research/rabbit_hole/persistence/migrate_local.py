"""Verified offline storage migration; never overwrite an occupied destination."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import MetaData, Table, inspect, select
from sqlalchemy.ext.asyncio import AsyncEngine

from rabbit_hole.persistence.local_objects import LocalObjectClient
from rabbit_hole.persistence.sql import initialize_sqlite, write_transaction


def canonical(value: Any) -> Any:
    if isinstance(value,datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value,(UUID,Decimal,date)):
        return str(value)
    if isinstance(value,dict):
        return {k:canonical(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)):
        return [canonical(v) for v in value]
    return value


def rows_hash(rows: list[dict[str,Any]]) -> str:
    values=sorted(json.dumps(canonical(row),sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False) for row in rows)
    return sha256("\n".join(values).encode()).hexdigest()


async def migrate_database(source: AsyncEngine, target: AsyncEngine) -> dict[str,Any]:
    if target.dialect.name != "sqlite":
        raise ValueError("destination must be SQLite")
    await initialize_sqlite(target, migration=True)
    from rabbit_hole.persistence.database import metadata
    tables=list(metadata.sorted_tables)
    async with source.connect() as src:
        if source.dialect.name == "postgresql":
            await src.execution_options(isolation_level="REPEATABLE READ")
        async with src.begin():
            names=await src.run_sync(lambda c: inspect(c).get_table_names())
            unknown=set(names)-set(metadata.tables)-{"alembic_version"}
            if unknown:
                raise ValueError("source has unsupported tables")
            missing=set(metadata.tables)-set(names)
            if missing:
                raise ValueError("source schema is incomplete")
            schema=None
            if "alembic_version" in names:
                schema=await src.run_sync(lambda c: Table("alembic_version",MetaData(),autoload_with=c))
            if schema is not None:
                async with write_transaction(target) as dst:
                    await dst.run_sync(lambda c: schema.create(c,checkfirst=True))
                tables.append(schema)
            report={}
            async with write_transaction(target) as dst:
                for table in tables:
                    if await dst.scalar(select(table).limit(1)) is not None:
                        raise ValueError("destination must be empty")
                for table in tables:
                    source_rows=[dict(row) for row in (await src.execute(select(table))).mappings()]
                    # Batches keep parameter limits and memory bounded per table.
                    for start in range(0,len(source_rows),100):
                        await dst.execute(table.insert(),source_rows[start:start+100])
                    target_rows=[dict(row) for row in (await dst.execute(select(table))).mappings()]
                    expected,actual=rows_hash(source_rows),rows_hash(target_rows)
                    matched=expected == actual and len(source_rows) == len(target_rows)
                    report[table.name]={"count":len(source_rows),"sha256":expected,"matched":matched}
                    if not matched:
                        raise ValueError("database content verification failed")
                integrity=await dst.exec_driver_sql("PRAGMA integrity_check")
                if integrity.scalar() != "ok":
                    raise ValueError("SQLite integrity verification failed")
                foreign_keys=await dst.exec_driver_sql("PRAGMA foreign_key_check")
                if foreign_keys.first() is not None:
                    raise ValueError("SQLite foreign-key verification failed")
    return report


def object_versions(client: Any,bucket: str) -> list[dict[str,Any]]:
    records: list[dict[str,Any]] = []
    request={"Bucket":bucket}
    while True:
        response=client.list_object_versions(**request)
        for group,deleted in (("Versions",False),("DeleteMarkers",True)):
            records.extend({**r,"DeleteMarker":deleted} for r in response.get(group,[]))
        if not response.get("IsTruncated"):
            return records
        key,version=response.get("NextKeyMarker"),response.get("NextVersionIdMarker")
        if not isinstance(key,str) or not isinstance(version,str):
            raise TypeError("invalid version pagination")
        request={**request,"KeyMarker":key,"VersionIdMarker":version}


def version_manifest(client: Any,bucket: str) -> list[dict[str,Any]]:
    records=[]
    for item in object_versions(client,bucket):
        row={k:item[k] for k in ("Key","VersionId","DeleteMarker","IsLatest","LastModified")}
        if not item["DeleteMarker"]:
            response=client.get_object(Bucket=bucket,Key=item["Key"],VersionId=item["VersionId"])
            stream=response["Body"]
            try:
                raw=stream.read()
            finally:
                stream.close()
            row.update(sha256=sha256(raw).hexdigest(),Size=len(raw),ETag=response["ETag"],
                       Metadata=response.get("Metadata",{}),ContentType=response.get("ContentType","application/octet-stream"))
        records.append(row)
    return records


def migrate_objects(source: Any,target: LocalObjectClient,bucket: str) -> dict[str,Any]:
    if object_versions(target,bucket):
        raise ValueError("destination must be empty")
    expected=version_manifest(source,bucket)
    # Each key is imported oldest first with the authoritative current version last.
    ordered=sorted(expected,key=lambda r:(r["Key"],r["IsLatest"],r["LastModified"],r["VersionId"]))
    for item in ordered:
        raw=None
        if not item["DeleteMarker"]:
            response=source.get_object(Bucket=bucket,Key=item["Key"],VersionId=item["VersionId"])
            stream=response["Body"]
            try:
                raw=stream.read()
            finally:
                stream.close()
            if sha256(raw).hexdigest() != item["sha256"]:
                raise ValueError("source changed during object migration")
        target.import_version(bucket,item["Key"],item,raw)
    actual=version_manifest(target,bucket)
    matched=rows_hash(expected) == rows_hash(actual)
    if not matched:
        raise ValueError("object migration verification failed")
    return {"versions":len(expected),"sha256":rows_hash(expected),"matched":matched}


async def run(destination: str) -> None:
    from rabbit_hole.config import get_settings
    from rabbit_hole.persistence.database import create_database_engine
    from rabbit_hole.persistence.sql import create_engine
    from rabbit_hole.persistence.storage_factory import create_storage_client
    settings=get_settings()
    if settings.storage_backend != "s3" or not settings.database_url.startswith("postgresql"):
        raise ValueError("migration requires the original source configuration")
    root=Path(destination)
    if root.exists():
        raise ValueError("destination directory must not exist")
    root.mkdir(parents=True,mode=0o700)
    source=create_database_engine(settings)
    target=create_engine("sqlite+aiosqlite:///"+str(root/"workbench.db"))
    client=create_storage_client(settings)
    local=LocalObjectClient(root/"evidence")
    local._atomic(root / ".migration-required", b"Verified migration required before runtime startup.")
    try:
        report: dict[str, Any]={"database":await migrate_database(source,target),
                "evidence":await asyncio.to_thread(migrate_objects,client,local,settings.s3_bucket), "verified":True}
        report_path=root/"migration-report.json"
        local._atomic(report_path,json.dumps(report,sort_keys=True,indent=2).encode())
        print("Verified migration: tables="+str(len(report["database"]))+" versions="+str(report["evidence"]["versions"]))
    finally:
        client.close()
        await source.dispose()
        await target.dispose()


if __name__ == "__main__":
    import sys
    asyncio.run(run(sys.argv[1]))
