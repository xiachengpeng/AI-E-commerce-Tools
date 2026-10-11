"""Authenticated, versioned integration surface. Disabled without private config."""

from __future__ import annotations

import json
import os
import secrets
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from rabbit_hole.application.integration_contracts import (
    product_snapshot,
    project_snapshot,
)
from rabbit_hole.domain.project import WorkbenchError
from rabbit_hole.persistence.projects import workbench_events, workbench_projects


def load_service_config() -> dict[str, Any]:
    path = Path(
        os.environ.get(
            "RABBIT_HOLE_INTEGRATION_CONFIG",
            str(Path.home() / "rabbit-hole-data" / "integration.json"),
        )
    )
    try:
        if any(p.is_symlink() for p in (path, *path.parents)):
            return {}
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "r") as stream:
            info = os.fstat(stream.fileno())
            if (
                info.st_uid != os.getuid()
                or info.st_mode & 0o077
                or not stat.S_ISREG(info.st_mode)
            ):
                return {}
            raw = stream.read(8193)
            if len(raw) > 8192:
                return {}
            value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, AttributeError, TypeError):
        return {}


def load_service_token() -> str | None:
    value = load_service_config()
    token = value.get("token")
    return (
        token
        if value.get("enabled") is True and isinstance(token, str) and len(token) >= 32
        else None
    )


class ConfirmationCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=0, strict=True)
    command_id: UUID
    payload: dict[str, Any]


class UserCommand(ConfirmationCommand):
    action: str = Field(min_length=1, max_length=60)
    market: str = Field(min_length=2, max_length=2)


def create_integration_router(
    *,
    token_loader: Callable[[], str | None] = load_service_token,
    confirmations_enabled: Callable[[], bool] | None = None,
    commands_enabled: Callable[[], bool] | None = None,
) -> APIRouter:
    async def authorize(request: Request) -> None:
        token = token_loader()
        if not token:
            raise HTTPException(503, "研究集成尚未启用")
        supplied = request.headers.get("authorization", "")
        if request.headers.get("origin") or not secrets.compare_digest(
            supplied.encode(), ("Bearer " + token).encode()
        ):
            raise HTTPException(401, "研究集成认证失败")

    router = APIRouter(
        prefix="/internal/integration/v1", dependencies=[Depends(authorize)]
    )

    def store(request: Request) -> Any:
        service = getattr(request.app.state, "workbench_store", None)
        if service is None:
            raise HTTPException(503, "研究数据尚未就绪")
        return service

    async def get_project(request: Request, project_id: UUID) -> dict[str, Any]:
        try:
            return await store(request).get(str(project_id))  # type: ignore[no-any-return]
        except (WorkbenchError, SQLAlchemyError) as exc:
            if getattr(exc, "code", None) == "not_found":
                raise HTTPException(404, "研究项目不存在") from None
            raise HTTPException(503, "研究读取失败") from None

    @router.get("/projects")
    async def projects(
        request: Request,
        limit: int = Query(20, ge=1, le=50),
        cursor: UUID | None = None,
    ) -> dict[str, Any]:
        table = workbench_projects
        statement = (
            select(
                table.c.id,
                table.c.title,
                table.c.market,
                table.c.version,
                table.c.updated_at,
            )
            .order_by(table.c.id)
            .limit(limit + 1)
        )
        if cursor:
            statement = statement.where(table.c.id > str(cursor))
        async with store(request).engine.connect() as connection:
            rows = (await connection.execute(statement)).mappings().all()
        return {
            "contract_version": 1,
            "projects": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "market": r["market"],
                    "source_version": r["version"],
                    "updated_at": r["updated_at"].isoformat(),
                }
                for r in rows[:limit]
            ],
            "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
        }

    @router.get("/projects/{project_id}")
    async def project(request: Request, project_id: UUID) -> dict[str, Any]:
        return project_snapshot(await get_project(request, project_id))

    @router.get("/projects/{project_id}/products/{product_id}")
    async def product(
        request: Request, project_id: UUID, product_id: UUID
    ) -> dict[str, Any]:
        p = await get_project(request, project_id)
        item = next(
            (v for v in p.get("products", []) if v["id"] == str(product_id)), None
        )
        if not item:
            raise HTTPException(404, "研究商品不存在")
        return product_snapshot(p, item)

    @router.get("/projects/{project_id}/report")
    async def report(request: Request, project_id: UUID) -> dict[str, Any]:
        p = project_snapshot(await get_project(request, project_id))
        return {
            "contract_version": 1,
            "project_id": p["id"],
            "source_version": p["source_version"],
            "market": p["market"],
            "title": p["title"],
            "product_count": len(p["products"]),
            "keyword_count": p["keyword_count"],
            "confirmed_fact_count": sum(
                f["state"] == "confirmed"
                for item in p["products"]
                for f in item["facts"]
            ),
            "truncated": len(p["products"]) == 200,
        }

    @router.get("/projects/{project_id}/confirmations/{command_id}")
    async def confirmation_status(
        request: Request, project_id: UUID, command_id: UUID
    ) -> dict[str, Any]:
        await get_project(request, project_id)
        async with store(request).engine.connect() as connection:
            found = await connection.scalar(
                select(workbench_events.c.id).where(
                    workbench_events.c.project_id == str(project_id),
                    workbench_events.c.command_id == str(command_id),
                    workbench_events.c.action == "confirm_marketing_fact",
                )
            )
        return {
            "contract_version": 1,
            "project_id": str(project_id),
            "command_id": str(command_id),
            "state": "committed" if found else "not_observed",
        }

    @router.post("/projects/{project_id}/confirm-fact")
    async def confirm_fact(
        request: Request, project_id: UUID, body: ConfirmationCommand
    ) -> dict[str, Any]:
        allowed = (
            confirmations_enabled()
            if confirmations_enabled
            else load_service_config().get("allow_confirmations") is True
        )
        if not allowed:
            raise HTTPException(403, "研究事实确认尚未启用")
        try:
            result = await store(request).command(
                str(project_id),
                body.expected_version,
                str(body.command_id),
                "confirm_marketing_fact",
                body.payload,
            )
        except (WorkbenchError, SQLAlchemyError) as exc:
            code = getattr(exc, "code", "")
            if code in {"version_conflict", "idempotency_conflict"}:
                raise HTTPException(
                    409, "研究资料已更新或操作编号已使用，请核对状态"
                ) from None
            if code:
                raise HTTPException(
                    422, "人工事实确认参数无效，请核对商品、国家及来源"
                ) from None
            raise HTTPException(503, "事实确认结果尚未确认，请查询研究状态") from None
        return project_snapshot(result)

    @router.get("/projects/{project_id}/commands/{command_id}")
    async def command_status(
        request: Request, project_id: UUID, command_id: UUID
    ) -> dict[str, Any]:
        await get_project(request, project_id)
        async with store(request).engine.connect() as connection:
            found = await connection.scalar(
                select(workbench_events.c.id).where(
                    workbench_events.c.project_id == str(project_id),
                    workbench_events.c.command_id == str(command_id),
                )
            )
        return {
            "contract_version": 1,
            "project_id": str(project_id),
            "command_id": str(command_id),
            "state": "committed" if found else "not_observed",
        }

    @router.post("/projects/{project_id}/commands")
    async def user_command(
        request: Request, project_id: UUID, body: UserCommand
    ) -> dict[str, Any]:
        from rabbit_hole.api.workbench import USER_ACTIONS

        allowed = (
            commands_enabled()
            if commands_enabled
            else load_service_config().get("allow_commands") is True
        )
        if not allowed:
            raise HTTPException(403, "研究命令入口尚未启用")
        try:
            size = len(json.dumps(body.payload, allow_nan=False).encode())
        except ValueError:
            raise HTTPException(422, "不允许非有限数值") from None
        if body.action not in USER_ACTIONS or size > 64000:
            raise HTTPException(422, "不支持的操作或输入过大")
        current = await get_project(request, project_id)
        if current["market"] != body.market:
            raise HTTPException(409, "目标国家已变更，请重新核对")
        try:
            result = await store(request).command(
                str(project_id),
                body.expected_version,
                str(body.command_id),
                body.action,
                body.payload,
            )
        except (WorkbenchError, SQLAlchemyError) as exc:
            code = getattr(exc, "code", "")
            if code in {"version_conflict", "idempotency_conflict"}:
                raise HTTPException(409, "资料版本或操作编号冲突，请核对状态") from None
            raise HTTPException(
                422 if code else 503, "操作未完成，请核对输入和状态"
            ) from None
        return project_snapshot(result)

    @router.get("/projects/{project_id}/actions")
    async def action_statuses(
        request: Request,
        project_id: UUID,
        limit: int = Query(20, ge=1, le=50),
        cursor: UUID | None = None,
    ) -> dict[str, Any]:
        from rabbit_hole.application.actions import actions

        await get_project(request, project_id)
        fields = ("id", "kind", "status", "attempt", "created_at", "updated_at")
        query = (
            select(*(actions.c[key] for key in fields))
            .where(actions.c.project_id == project_id)
            .order_by(actions.c.id)
            .limit(limit + 1)
        )
        if cursor:
            query = query.where(actions.c.id > cursor)
        async with store(request).engine.connect() as connection:
            rows = (await connection.execute(query)).mappings().all()
        return {
            "contract_version": 1,
            "project_id": str(project_id),
            "actions": [
                {
                    **dict(row),
                    "id": str(row["id"]),
                    "created_at": row["created_at"].isoformat(),
                    "updated_at": row["updated_at"].isoformat(),
                }
                for row in rows[:limit]
            ],
            "next_cursor": str(rows[limit - 1]["id"]) if len(rows) > limit else None,
        }

    return router
