"""Manual, append-only Feishu summaries with durable create-intent fencing."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy import (
    Column,
    Integer,
    Table,
    Text,
    and_,
    insert,
    or_,
    select,
    update,
)

from rabbit_hole.application.reports import selection_funnel
from rabbit_hole.domain.project import WorkbenchError
from rabbit_hole.input_urls import sanitize_research_url_fields
from rabbit_hole.integrations.feishu import (
    API_FIELD_LIST,
    API_RECORD_LIST,
    API_TABLE_LIST,
    FeishuAPIError,
    FeishuClient,
)
from rabbit_hole.persistence.database import json_type, metadata
from rabbit_hole.persistence.projects import WorkbenchStore
from rabbit_hole.persistence.sql import (
    UTCDateTime,
    session_lock,
    transaction_lock,
    write_transaction,
)

runs = Table(
    "workbench_sync_runs",
    metadata,
    Column("id", Text, primary_key=True),
    Column("project_id", Text),
    Column("version", Integer),
    Column("target", Text),
    Column("digest", Text),
    Column("snapshot", json_type),
    Column("status", Text),
    Column("checkpoint", json_type),
    Column("message", Text),
    Column("updated_at", UTCDateTime()),
    Column("attempt_count", Integer, server_default="0"),
    Column("next_attempt_at", UTCDateTime()),
    Column("error_code", Text),
)
RETRY_DELAYS = (5, 30, 120)
RETRYABLE_APPLICATION_CODES = frozenset({1254291})


def definitive_rejection(exc: Exception) -> bool:
    if not isinstance(exc, FeishuAPIError):
        return False
    return (400 <= exc.status_code < 500 and exc.status_code != 408) or (
        exc.status_code == 200
        and isinstance(exc.body, dict)
        and isinstance(exc.body.get("code"), int)
        and exc.body["code"] != 0
        and exc.body["code"] not in RETRYABLE_APPLICATION_CODES
    )


def transient_failure(exc: Exception) -> bool:
    return isinstance(exc, (TimeoutError, httpx.TransportError)) or (
        isinstance(exc, FeishuAPIError)
        and (
            exc.status_code in {408, 429}
            or 500 <= exc.status_code < 600
            or (
                isinstance(exc.body, dict)
                and exc.body.get("code") in RETRYABLE_APPLICATION_CODES
            )
        )
    )


TABLES = ("工作台V2｜项目快照", "工作台V2｜产品快照")
FIELDS = {
    "AUTO｜快照键": "text",
    "AUTO｜项目ID": "text",
    "AUTO｜版本": "number",
    "AUTO｜名称": "text",
    "AUTO｜摘要": "text",
    "AUTO｜规则版本": "number",
}


class SyncRemote:
    """Reuse configured app authentication; never retry non-idempotent creates."""

    def __init__(self, client: FeishuClient):
        self.client = client
        self.base_token = client.base_token

    async def list_tables(self) -> list[dict[str, Any]]:
        return await self.client.list_tables()

    async def list_fields(self, table: str) -> list[dict[str, Any]]:
        return await self.client.list_fields(table)

    async def list_records(self, table: str) -> list[dict[str, Any]]:
        return await self.client.list_records(table)

    async def sync_create_table(self, name: str) -> str:
        response = await self.client._request(
            "POST",
            API_TABLE_LIST.format(base_token=self.base_token),
            json={"name": name},
            retry=False,
        )
        return self._id(response)

    async def sync_create_field(self, table: str, definition: dict[str, Any]) -> str:
        response = await self.client._request(
            "POST",
            API_FIELD_LIST.format(base_token=self.base_token, table_id=table),
            json=definition,
            retry=False,
        )
        return self._id(response)

    async def sync_create_record(self, table: str, cells: dict[str, Any]) -> str:
        if any(key not in FIELDS for key in cells):
            raise ValueError("unowned field")
        response = await self.client._request(
            "POST",
            API_RECORD_LIST.format(base_token=self.base_token, table_id=table)
            + "/batch_create",
            json={"create_records": [cells]},
            retry=False,
        )
        data = response.get("data", {})
        ids = data.get("record_id_list", [])
        if data.get("ignored_fields") or len(ids) != 1 or not isinstance(ids[0], str):
            raise ValueError("unverified create")
        return str(ids[0])

    @staticmethod
    def _id(response: dict[str, Any]) -> str:
        value = response.get("data", {}).get("id")
        if not isinstance(value, str) or not value:
            raise ValueError("unverified create")
        return value


def snapshot(project: dict[str, Any]) -> list[dict[str, Any]]:
    sanitized = sanitize_research_url_fields(project)
    if not isinstance(sanitized, dict):
        raise TypeError("project must be an object")
    project = sanitized
    result = []
    active_products = [
        item for item in project["products"] if not item.get("merged_into")
    ]
    for product in [None, *active_products]:
        item = product or project
        summary = (
            {
                "direction": project["direction"],
                "keywords": len(project["keywords"]),
                "products": len(active_products),
                "todos": len(project["todos"]),
                "selection_funnel": selection_funnel(project),
            }
            if product is None
            else {
                "url": item.get("url"),
                "triage": item.get("triage")
                or {
                    "state": "pending",
                    "reason": "",
                    "decided_at": None,
                    "operator": None,
                    "history": [],
                },
                "steps": [
                    {"step": s["label"], "state": s["state"], "reason": s.get("reason")}
                    for s in item.get("steps", [])
                ],
                "decision": item.get("decision"),
                "score": next(
                    (
                        s
                        for s in reversed(item.get("scores", []))
                        if s.get("revision") == item.get("revision")
                    ),
                    None,
                ),
            }
        )
        encoded = json.dumps(summary, ensure_ascii=False, sort_keys=True)
        if len(encoded) > 10000:
            summary = {
                "note": "摘要超出长度限制，请在本机查看完整报告",
                "steps": summary.get("steps", []),
            }
            encoded = json.dumps(summary, ensure_ascii=False, sort_keys=True)
        result.append(
            {
                "table": TABLES[product is not None],
                "cells": {
                    "AUTO｜快照键": f"{project['id']}:{project['version']}:{item['id']}",
                    "AUTO｜项目ID": project["id"],
                    "AUTO｜版本": project["version"],
                    "AUTO｜名称": item.get("name", project["title"]),
                    "AUTO｜摘要": encoded,
                    "AUTO｜规则版本": project.get("rules_version", 1),
                },
            }
        )
    return result


class WorkbenchSync:
    def __init__(self, store: WorkbenchStore, client: Any):
        self.store = store
        self.remote = SyncRemote(client) if isinstance(client, FeishuClient) else client
        self.target = hashlib.sha256(self.remote.base_token.encode()).hexdigest()
        self.lock_key = int(self.target[:15], 16)

    async def _schema(self) -> dict[str, str]:
        tables = await self.remote.list_tables()
        found = {}
        for name in TABLES:
            matches = [t for t in tables if t["name"] == name]
            if len(matches) > 1:
                raise WorkbenchError("sync_conflict", "飞书存在重名快照表，请先核对")
            if matches:
                found[name] = matches[0]["id"]
                definitions = await self.remote.list_fields(found[name])
                for field, kind in FIELDS.items():
                    existing = [f for f in definitions if f["name"] == field]
                    if len(existing) > 1 or (existing and existing[0]["type"] != kind):
                        raise WorkbenchError(
                            "sync_schema", "飞书快照表字段不兼容，未修改现有字段"
                        )
        return found

    async def preview(self, project_id: str, expected_version: int) -> dict[str, Any]:
        project = await self.store.get(project_id)
        if type(expected_version) is not int or project["version"] != expected_version:
            raise WorkbenchError(
                "version_conflict", "项目已更新，请刷新后重新预览", 409
            )
        rows = snapshot(project)
        digest = hashlib.sha256(
            json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        found = await self._schema()
        return {
            "project_id": project_id,
            "version": expected_version,
            "digest": digest,
            "records": len(rows),
            "tables": [{"name": name, "exists": name in found} for name in TABLES],
            "mode": "append_only",
            "note": "仅新增本版本业务摘要；本机数据为准，不导入飞书编辑。",
        }

    async def enqueue(
        self, project_id: str, expected_version: int, preview_digest: str
    ) -> dict[str, Any]:
        preview = await self.preview(project_id, expected_version)
        if preview["digest"] != preview_digest:
            raise WorkbenchError("preview_changed", "预览已变化，请重新预览", 409)
        project = await self.store.get(project_id)
        rows = snapshot(project)
        if (
            project["version"] != expected_version
            or hashlib.sha256(
                json.dumps(rows, ensure_ascii=False, sort_keys=True).encode()
            ).hexdigest()
            != preview_digest
        ):
            raise WorkbenchError("version_conflict", "项目已更新，请重新预览", 409)
        async with write_transaction(self.store.engine) as conn:
            await transaction_lock(conn, self.lock_key)
            await self.store.lock_project(conn, project_id)
            existing = (
                (
                    await conn.execute(
                        select(runs).where(
                            runs.c.project_id == project_id,
                            runs.c.version == expected_version,
                            runs.c.target == self.target,
                        )
                    )
                )
                .mappings()
                .first()
            )
            if existing:
                if existing["digest"] != preview_digest:
                    raise WorkbenchError(
                        "snapshot_changed",
                        "此版本已有不同快照，请保存新版本后再同步",
                        409,
                    )
                if existing["status"] == "blocked":
                    await conn.execute(
                        update(runs)
                        .where(runs.c.id == existing["id"])
                        .values(
                            status="ready",
                            message="等待重新核对",
                            next_attempt_at=None,
                            error_code=None,
                            updated_at=datetime.now(UTC),
                        )
                    )
                    result = dict(existing)
                    result.update(
                        status="ready",
                        message="等待重新核对",
                        next_attempt_at=None,
                        error_code=None,
                        updated_at=datetime.now(UTC),
                    )
                    return self._public(result)
                return self._public(dict(existing))
            row = {
                "id": str(uuid4()),
                "project_id": project_id,
                "version": expected_version,
                "target": self.target,
                "digest": preview_digest,
                "snapshot": rows,
                "status": "ready",
                "checkpoint": {},
                "message": "等待同步",
                "updated_at": datetime.now(UTC),
                "attempt_count": 0,
                "next_attempt_at": None,
                "error_code": None,
            }
            await conn.execute(insert(runs).values(**row))
            return self._public(row)

    @staticmethod
    def _public(row: dict[str, Any]) -> dict[str, Any]:
        return {
            key: (row[key].isoformat() if isinstance(row[key], datetime) else row[key])
            for key in (
                "id",
                "project_id",
                "version",
                "status",
                "message",
                "updated_at",
                "attempt_count",
                "next_attempt_at",
                "error_code",
            )
        }

    async def status(self, project_id: str) -> list[dict[str, Any]]:
        async with self.store.engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(runs)
                    .where(
                        runs.c.project_id == project_id, runs.c.target == self.target
                    )
                    .order_by(runs.c.updated_at.desc())
                    .limit(10)
                )
            ).mappings()
            return [self._public(dict(row)) for row in rows]

    async def retry(self, project_id: str, run_id: str) -> dict[str, Any]:
        """Retry the already approved immutable snapshot, never replace its intent."""
        await self.store.get(project_id)
        async with write_transaction(self.store.engine) as conn:
            await transaction_lock(conn, self.lock_key)
            await self.store.lock_project(conn, project_id)
            row = (
                (
                    await conn.execute(
                        select(runs)
                        .where(
                            runs.c.id == run_id,
                            runs.c.project_id == project_id,
                            runs.c.target == self.target,
                        )
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if row is None:
                raise WorkbenchError("not_found", "此项目没有该同步记录", 404)
            current = dict(row)
            if current["status"] == "blocked":
                current.update(
                    status="ready",
                    message="等待重新核对原版本快照",
                    error_code=None,
                    next_attempt_at=None,
                    updated_at=datetime.now(UTC),
                )
                await conn.execute(
                    update(runs)
                    .where(runs.c.id == run_id)
                    .values(
                        status=current["status"],
                        message=current["message"],
                        error_code=None,
                        next_attempt_at=None,
                        updated_at=current["updated_at"],
                    )
                )
            return self._public(current)

    async def _save(self, run: dict[str, Any], **values: Any) -> None:
        async with write_transaction(self.store.engine) as conn:
            await conn.execute(
                update(runs)
                .where(runs.c.id == run["id"])
                .values(**values, updated_at=datetime.now(UTC))
            )
        run.update(values)

    async def _create(self, run: dict[str, Any], key: str, operation: Any) -> str:
        checkpoint = dict(run["checkpoint"])
        async with self.store.engine.connect() as conn:
            histories = (await conn.execute(select(runs.c.checkpoint).where(runs.c.target == self.target))).scalars().all()
            prior = any(key in (item or {}) for item in histories)
        if key in checkpoint or prior:
            raise WorkbenchError(
                "uncertain_create",
                "上次写入结果尚未确认，已暂停以避免重复记录；稍后重试将先核对远端",
            )
        checkpoint[key] = "intent"
        await self._save(run, checkpoint=checkpoint)
        try:
            value = str(await operation())
        except Exception as exc:
            if definitive_rejection(exc):
                checkpoint.pop(key, None)
                await self._save(run, checkpoint=checkpoint)
            raise
        checkpoint[key] = value
        await self._save(run, checkpoint=checkpoint)
        return value

    async def _process(self, run: dict[str, Any]) -> None:
        tables = await self._schema()
        pending_errors: list[Exception] = []
        for name in TABLES:
            if name not in tables:
                tables[name] = await self._create(
                    run, "table:" + name, partial(self.remote.sync_create_table, name)
                )
            table = tables[name]
            definitions = await self.remote.list_fields(table)
            for field, kind in FIELDS.items():
                if not any(f["name"] == field for f in definitions):
                    await self._create(
                        run,
                        f"field:{table}:{field}",
                        partial(
                            self.remote.sync_create_field,
                            table,
                            {"name": field, "type": kind},
                        ),
                    )
            records = await self.remote.list_records(table)
            for row in [r for r in run["snapshot"] if r["table"] == name]:
                cells = row["cells"]
                key = cells["AUTO｜快照键"]
                matches = [
                    r for r in records if r.get("fields", {}).get("AUTO｜快照键") == key
                ]
                if len(matches) > 1 or (
                    matches
                    and any(matches[0]["fields"].get(k) != v for k, v in cells.items())
                ):
                    raise WorkbenchError(
                        "sync_conflict", "远端快照重复或内容已改动，未覆盖记录"
                    )
                if not matches:
                    try:
                        await self._create(
                            run,
                            "record:" + key,
                            partial(self.remote.sync_create_record, table, cells),
                        )
                    except WorkbenchError as exc:
                        if exc.code != "uncertain_create":
                            raise
                        pending_errors.append(exc)
        if pending_errors:
            raise pending_errors[0]
        await self._save(
            run,
            status="complete",
            message="本版本摘要已同步；后续修改需再次同步",
            error_code=None,
            next_attempt_at=None,
        )

    async def run_once(self) -> bool:
        async with session_lock(self.store.engine, self.lock_key) as locked:
            if not locked:
                return False
            async with self.store.engine.connect() as conn:
                row = (
                    (
                        await conn.execute(
                            select(runs)
                            .where(
                                runs.c.target == self.target,
                                or_(
                                    runs.c.status.in_(["ready", "running"]),
                                    and_(
                                        runs.c.status == "retry_wait",
                                        runs.c.next_attempt_at <= datetime.now(UTC),
                                    ),
                                ),
                            )
                            .order_by(runs.c.updated_at)
                            .limit(1)
                        )
                    )
                    .mappings()
                    .first()
                )
            if not row:
                return False
            run = dict(row)
            await self._save(
                run,
                status="running",
                message="正在同步本版本摘要",
                attempt_count=run["attempt_count"] + 1,
                next_attempt_at=None,
            )
            try:
                async with asyncio.timeout(240):
                    await self._process(run)
            except Exception as exc:  # noqa: BLE001 -- persist safe failure without credentials
                message = (
                    exc.message
                    if isinstance(exc, WorkbenchError)
                    else "飞书同步未完成，已保留检查点；重试前会核对远端，不影响本机研究"
                )
                if isinstance(exc, FeishuAPIError):
                    code = (
                        exc.body.get("code") if isinstance(exc.body, dict) else None
                    )
                    message += f"（HTTP {exc.status_code}，接口代码 {code if isinstance(code, int) else '未知'}）"
                attempt = run["attempt_count"]
                uncertain = any(
                    value == "intent" for value in run["checkpoint"].values()
                )
                retry = (
                    transient_failure(exc)
                    and not uncertain
                    and attempt <= len(RETRY_DELAYS)
                )
                if uncertain:
                    message = "上次创建的写入结果尚未确认，已暂停以避免重复记录；手动重试将先核对远端"
                error_code = (
                    "uncertain_create"
                    if uncertain
                    else exc.code
                    if isinstance(exc, WorkbenchError)
                    else "temporary_remote_failure"
                    if transient_failure(exc)
                    else "remote_rejected"
                    if definitive_rejection(exc)
                    else "remote_unavailable"
                )
                await self._save(
                    run,
                    status="retry_wait" if retry else "blocked",
                    message=message,
                    error_code=error_code,
                    next_attempt_at=datetime.now(UTC)
                    + timedelta(seconds=RETRY_DELAYS[attempt - 1])
                    if retry
                    else None,
                )
            return True

    async def loop(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception:  # noqa: BLE001 -- database recovery boundary
                logging.getLogger(__name__).warning(
                    "Workbench sync storage unavailable"
                )
            await asyncio.sleep(3)
