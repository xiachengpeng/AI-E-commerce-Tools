"""Same-origin local business commands. No public deployment/auth implied."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.routing import APIRoute
from services.research_runtime import _research_imports
from services.research_security import require_research_session

_research_imports()
from rabbit_hole.domain.ad_copy import usable_ad_copy

USER_ACTIONS = frozenset(
    {
        "add_keyword",
        "edit_keyword",
        "archive_keyword",
        "restore_keyword",
        "approve_keyword",
        "add_product",
        "merge_products",
        "link_product_offers",
        "split_product_offer",
        "undo_offer_link",
        "triage_product",
        "restore_product",
        "undo_triage_product",
        "focus_product",
        "confirm_product",
        "confirm_creatives",
        "identify",
        "evidence",
        "funnel",
        "add_creative_reference",
        "record_funnel_investigation",
        "economics",
        "add_sales_estimate",
        "evaluate",
        "decide",
        "test_plan",
        "test_result",
        "confirm_test_result",
        "revise_test_result",
        "void_test_result",
        "review",
        "configure_rules",
        "configure_collection",
        "set_logistics_profile",
    }
)
EXTERNAL_SOURCE_FEASIBILITY = {
    "amazon": {
        "automation_state": "approval_required",
        "automation_reason": "官方商品接口需 Associates 准入或卖家授权；本机尚未连接。",
        "next_step": "在商品档案的多渠道验证提交 Amazon 页面链接、观察时间与人工结论。",
        "official_docs_url": "https://affiliate-program.amazon.com/creatorsapi/docs/",
    },
    "tiktok": {
        "automation_state": "not_connected",
        "automation_reason": "此工作台未接入 TikTok 广告 API；Creative Center 不是完整广告样本。",
        "next_step": "在商品档案的多渠道验证提交 TikTok 观察链接与时间，不将其当作自动验证的 API 数据。",
        "official_docs_url": "https://developers.tiktok.com/products/commercial-content-api",
    },
    "pinterest": {
        "automation_state": "approval_required",
        "automation_reason": "Trends API 需申请适用权限，当前未连接。",
        "next_step": "在商品档案的多渠道验证提交 Pinterest 来源、观察时间与趋势结论。",
        "official_docs_url": "https://developers.pinterest.com/docs/analytics-and-reports/trends/",
    },
    "similarweb": {
        "automation_state": "subscription_required",
        "automation_reason": "官方流量 API 需要含 API 权限的订阅与密钥，当前未连接。",
        "next_step": "在商品档案的多渠道验证提交 Similarweb 域名、目标国家/设备/月份范围及来源。",
        "official_docs_url": "https://developers.similarweb.com/reference/desktop-marketing-channels-1",
    },
    "supplier": {
        "automation_state": "supplier_authorization_required",
        "automation_reason": "供应商平台接口需要应用审批及商家授权，当前未连接。",
        "next_step": "在商品档案的成本与风险核算填写人工报价、MOQ、物流和报价日期。",
        "official_docs_url": "https://openapi.alibaba.com/doc/doc.htm",
    },
}


class ResearchPrivateRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def response(request):
            try:
                result = await handler(request)
            except RequestValidationError as exc:
                result = await request_validation_exception_handler(request, exc)
            except HTTPException as exc:
                exc.headers = {**(exc.headers or {}), "Cache-Control": "no-store"}
                raise
            result.headers["Cache-Control"] = "no-store"
            return result

        return response


def create_workbench_router() -> APIRouter:
    router = APIRouter(
        prefix="/api/research/workbench/v1",
        tags=["research-workbench"],
        route_class=ResearchPrivateRoute,
    )
    media_download_slots = asyncio.Semaphore(2)
    direction_slots = asyncio.Semaphore(1)
    log_stream_slots = asyncio.Semaphore(4)

    def guard(request: Request, *, write: bool = False) -> None:
        require_research_session(request, write=write)
        current = getattr(request.app.state, 'research_runtime', None)
        if write and getattr(current, 'commands_enabled', True) is not True:
            raise HTTPException(503, '研究所有权尚未移交，仅允许读取')

    def runtime(request: Request) -> Any:
        value = getattr(request.app.state, "research_runtime", None)
        if value is None or getattr(value, "diagnostics", ()):
            raise HTTPException(503, "业务数据库尚未就绪")
        return value

    def store(request: Request) -> Any:
        value = getattr(runtime(request), "store", None)
        if value is None:
            raise HTTPException(503, "业务数据库尚未就绪")
        return value

    def dependency(request: Request, name: str, message: str) -> Any:
        value = getattr(runtime(request), "workbench_services", {}).get(name)
        if value is None:
            raise HTTPException(503, message)
        return value

    async def body(request: Request) -> dict[str, Any]:
        guard(request, write=True)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 1_000_000:
                raise HTTPException(413, "单次输入不能超过1MB")

        def reject_constant(value: str) -> None:
            raise ValueError("不允许非有限数值")

        try:
            data = json.loads(raw, parse_constant=reject_constant)
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(422, "请输入有效数据") from None
        if not isinstance(data, dict):
            raise HTTPException(422, "输入必须是对象")
        return data

    def project_uuid(value: str) -> str:
        try:
            return str(UUID(value))
        except ValueError:
            raise HTTPException(404, "项目不存在") from None

    async def invoke(awaitable: Any) -> Any:
        try:
            async with asyncio.timeout(20):
                return await awaitable
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 -- project input/SQL must not leak
            if type(exc).__name__ == "WorkbenchError":
                raise HTTPException(
                    getattr(exc, "status", 422),
                    str(getattr(exc, "message", "输入校验失败")),
                ) from None
            raise HTTPException(503, "操作未完成，请刷新确认状态后重试") from None

    @router.get("/history")
    async def history(
        request: Request,
        kind: str = "activity",
        project_id: str | None = None,
        cursor: str | None = Query(default=None, max_length=512),
        limit: int = Query(default=20, ge=1, le=50),
    ) -> JSONResponse:
        guard(request)
        from base64 import urlsafe_b64decode, urlsafe_b64encode
        from binascii import Error as Base64Error

        from rabbit_hole.persistence.projects import (
            workbench_events,
            workbench_projects,
        )
        from sqlalchemy import select, text

        if kind not in {"activity", "report", "import"}:
            raise HTTPException(422, "研究历史类型无效")
        service = store(request)
        scope = str(project_uuid(project_id)) if project_id else None
        if scope:
            await invoke(service.get(scope))
        after = ""
        if cursor:
            try:
                value = json.loads(
                    urlsafe_b64decode(cursor + "=" * ((-len(cursor)) % 4))
                )
                if (
                    not isinstance(value, dict)
                    or set(value) != {"kind", "project_id", "id"}
                    or not isinstance(value["id"], str)
                    or value["kind"] != kind
                    or value["project_id"] != scope
                ):
                    raise ValueError()
                after = str(UUID(value["id"]))
            except (ValueError, TypeError, KeyError, UnicodeDecodeError, Base64Error):
                raise HTTPException(422, "历史游标与分类或项目不匹配") from None
        items = []
        if kind == "activity":
            # Never SELECT event payload/digest or aggregate private project state.
            query = (
                select(
                    workbench_events.c.id,
                    workbench_events.c.project_id,
                    workbench_events.c.action,
                    workbench_events.c.created_at,
                )
                .join(
                    workbench_projects,
                    workbench_projects.c.id == workbench_events.c.project_id,
                )
                .where(workbench_events.c.id > after)
                .order_by(workbench_events.c.id)
                .limit(limit + 1)
            )
            if scope:
                query = query.where(workbench_events.c.project_id == scope)
            async with service.engine.connect() as connection:
                rows = (await connection.execute(query)).mappings().all()
            items = [
                {
                    "id": r["id"],
                    "project_id": r["project_id"],
                    "action": r["action"]
                    if r["action"] in USER_ACTIONS | {"create_project"}
                    else "unknown",
                    "created_at": r["created_at"].isoformat(),
                }
                for r in rows
            ]
        elif kind == "import":
            # Existing immutable receipts and artifacts, never name/facts/raw selected inputs.
            async with service.engine.connect() as connection:
                try:
                    rows = (
                        (
                            await connection.execute(
                                text(
                                    "SELECT e.id,e.created_at,e.snapshot,l.artifacts FROM research_import_events e "
                                    "JOIN research_links l ON l.id=e.link_id JOIN workbench_projects p "
                                    "ON p.id=json_extract(e.snapshot,'$.source_ref.project_id') "
                                    "WHERE e.id>:after AND (:scope IS NULL OR p.id=:scope) ORDER BY e.id LIMIT :limit"
                                ),
                                {"after": after, "scope": scope, "limit": limit + 1},
                            )
                        )
                        .mappings()
                        .all()
                    )
                except Exception:  # noqa: BLE001 -- no raw SQLite/path diagnostics
                    raise HTTPException(503, "研究档案存储尚未就绪") from None
            for row in rows:
                ref = json.loads(row["snapshot"]).get("source_ref", {})
                try:
                    pid, product = (
                        str(UUID(ref["project_id"])),
                        str(UUID(ref["product_id"])),
                    )
                except (KeyError, ValueError, TypeError):
                    raise HTTPException(503, "研究档案引用需核对") from None
                artifacts = []
                for artifact in json.loads(row["artifacts"]):
                    if (
                        artifact.get("module")
                        in {"analysis", "listing", "ads", "details"}
                        and type(artifact.get("history_id")) is int
                    ):
                        public = {
                            "module": artifact["module"],
                            "history_id": artifact["history_id"],
                        }
                        for name in ("timestamp", "history_timestamp", "created_at"):
                            if name in artifact:
                                try:
                                    public[name] = datetime.fromisoformat(
                                        artifact[name]
                                    ).isoformat()
                                except (ValueError, TypeError):
                                    public[name] = None
                        artifacts.append(public)
                items.append(
                    {
                        "id": row["id"],
                        "project_id": pid,
                        "product_id": product,
                        "created_at": row["created_at"],
                        "artifacts": artifacts,
                    }
                )
        # Source reports are derived GETs; no report artifact table or REPORT job kind exists.
        more = len(items) > limit
        items = items[:limit]
        next_cursor = (
            urlsafe_b64encode(
                json.dumps(
                    {"kind": kind, "project_id": scope, "id": items[-1]["id"]}
                ).encode()
            )
            .decode()
            .rstrip("=")
            if more
            else None
        )
        return JSONResponse(
            {
                "kind": kind,
                "project_id": scope,
                "items": items,
                "next_cursor": next_cursor,
            },
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/evidence-file")
    async def evidence_file(
        request: Request, token: str, project_id: str = ""
    ) -> Response:
        guard(request)
        from base64 import urlsafe_b64decode
        from hashlib import sha256

        from rabbit_hole.application.actions import actions
        from rabbit_hole.persistence.local_objects import LocalObjectClient
        from services.research_security import validate_evidence_object_id
        from sqlalchemy import select

        evidence = getattr(runtime(request), "evidence_store", None)
        if (
            evidence is None
            or not isinstance(evidence._client, LocalObjectClient)
            or len(token) > 4096
        ):
            raise HTTPException(404)
        try:
            # Original signed reader verifies signature, expiry and immutable VersionId.
            raw, content_type = await asyncio.to_thread(
                evidence._client.read_signed, token
            )
            encoded = token.split(".")[0]
            payload = json.loads(
                urlsafe_b64decode(encoded + "=" * ((-len(encoded)) % 4))
            )
            object_id = payload["Key"]
            validate_evidence_object_id(object_id)
            record_id = UUID(object_id.split("/")[2])
            async with store(request).engine.connect() as connection:
                row = (
                    (
                        await connection.execute(
                            select(actions).where(actions.c.id == record_id)
                        )
                    )
                    .mappings()
                    .first()
                )
            if not row or (row["result"] or {}).get("evidence_id") != object_id:
                raise ValueError("unbound evidence")
            owner = await store(request).get(str(row["project_id"]))
            if project_id and project_uuid(project_id) != owner["id"]:
                raise ValueError("project mismatch")
            if object_id.split("/")[1] != owner["market"]:
                raise ValueError("market mismatch")
            manifest = await asyncio.to_thread(evidence.structured_evidence, object_id)
            if (
                manifest.get("state") != "committed"
                or manifest.get("raw_deleted") is not False
                or manifest.get("raw_version_id") != payload.get("VersionId")
                or manifest.get("sha256") != sha256(raw).hexdigest()
            ):
                raise ValueError("evidence integrity failure")
        except Exception:  # noqa: BLE001 -- signed read must expose no private paths or metadata
            raise HTTPException(404) from None
        if content_type not in {
            "image/png",
            "image/jpeg",
            "application/json",
            "text/plain",
        }:
            content_type = "application/octet-stream"
        return Response(
            raw,
            media_type=content_type,
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "attachment; filename=evidence",
                "Content-Security-Policy": "sandbox; default-src 'none'",
            },
        )

    @router.get("/projects/{project_id}/live-logs")
    async def live_logs(
        request: Request, project_id: str, after: int = Query(default=0, ge=0, le=9223372036854775807), action_id: UUID | None = None
    ) -> JSONResponse:
        guard(request)
        project_id = project_uuid(project_id)
        service = store(request)
        await invoke(service.get(project_id))
        from rabbit_hole.integrations.provider_jobs import read_logs

        rows = await invoke(read_logs(service.engine, project_id, after, action_id=str(action_id) if action_id else None))
        return JSONResponse(
            {"logs": rows, "cursor": rows[-1]["id"] if rows else after},
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/projects/{project_id}/log-stream")
    async def log_stream(
        request: Request,
        project_id: str,
        after: int = Query(default=0, ge=0, le=9223372036854775807),
        action_id: UUID | None = None,
    ) -> StreamingResponse:
        from rabbit_hole.api.log_stream import stream_logs
        from rabbit_hole.integrations.provider_jobs import read_logs

        guard(request)
        project_id = project_uuid(project_id)
        service = store(request)
        await invoke(service.get(project_id))
        resume = request.headers.get("last-event-id")
        if resume is not None:
            try:
                resume_id = int(resume)
                if not 0 <= resume_id <= 9223372036854775807:
                    raise ValueError
                after = max(after, resume_id)
            except ValueError:
                raise HTTPException(422, "日志游标无效") from None
        if log_stream_slots.locked():
            raise HTTPException(429, "日志推送连接较多，请使用日志查询")
        await log_stream_slots.acquire()

        async def read(cursor: int) -> list[dict[str, Any]]:
            return await read_logs(service.engine, project_id, cursor, action_id=str(action_id) if action_id else None)

        async def events() -> AsyncIterator[str]:
            try:
                async for event in stream_logs(request, read, after=after):
                    yield event
            finally:
                log_stream_slots.release()

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.get("/provider-settings")
    async def provider_settings(request: Request) -> JSONResponse:
        guard(request)

        return JSONResponse(
            {
                "configured": dependency(
                    request, "provider_settings", "集成配置尚未就绪"
                ).status()
            },
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/provider-settings")
    async def save_provider_settings(request: Request) -> JSONResponse:
        data = await body(request)

        try:
            configured = await asyncio.to_thread(
                dependency(request, "provider_settings", "集成配置尚未就绪").update,
                data,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except OSError:
            raise HTTPException(503, "密钥未保存，请检查后端私有存储权限") from None
        return JSONResponse(
            {"configured": configured}, headers={"Cache-Control": "no-store"}
        )

    @router.get("/ai-settings")
    async def ai_settings(request: Request) -> JSONResponse:
        guard(request)

        result = await invoke(
            asyncio.to_thread(
                dependency(request, "ai_settings", "AI 配置尚未就绪").public
            )
        )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.post("/ai-settings")
    async def save_ai_settings(request: Request) -> JSONResponse:
        data = await body(request)

        try:
            vault = dependency(request, "ai_settings", "AI 配置尚未就绪")
            if data == {"reset": True}:
                result = await asyncio.to_thread(vault.reset)
            else:
                result = await asyncio.to_thread(vault.update, data)
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from None
        except OSError:
            raise HTTPException(503, "AI 配置未保存，请检查后端私有存储权限") from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.post("/project-direction")
    async def project_direction(request: Request) -> JSONResponse:
        data = await body(request)
        from rabbit_hole.integrations.project_direction import (
            DirectionError,
        )

        if direction_slots.locked():
            raise HTTPException(429, "AI 正在帮写，请等待当前请求完成")
        async with direction_slots:
            try:
                direction = await dependency(
                    request, "generate_direction", "AI 建议尚未配置"
                )(data.get("title"), data.get("market"))
            except DirectionError as exc:
                raise HTTPException(exc.status, str(exc)) from None
        return JSONResponse(
            {"direction": direction}, headers={"Cache-Control": "no-store"}
        )

    @router.post("/projects/{project_id}/ads/translate")
    async def translate_ad(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        project = await invoke(store(request).get(project_uuid(project_id)))
        word = next(
            (
                item
                for item in project["keywords"]
                if item["id"] == data.get("keyword_id")
            ),
            None,
        )
        ad = (
            next(
                (
                    item
                    for item in word.get("ads", [])
                    if item["id"] == data.get("ad_id")
                ),
                None,
            )
            if word
            else None
        )
        if not ad:
            raise HTTPException(404, "未找到这条已保存广告，请刷新页面")
        source = ad.get("primary_text") or ""
        if data.get("expected_text") != source:
            raise HTTPException(409, "广告原文已变化，请刷新后再翻译")
        if not usable_ad_copy(source):
            raise HTTPException(
                422, "未获取可用广告正文，请打开原广告核对，不能翻译模板占位符"
            )
        from rabbit_hole.integrations.ad_translation import TranslationError

        try:
            result = await asyncio.wait_for(
                dependency(request, "translator", "翻译服务尚未配置").translate(source),
                timeout=22,
            )
        except TranslationError as exc:
            raise HTTPException(503, str(exc)) from None
        except TimeoutError:
            raise HTTPException(504, "翻译等待超时，请重试；原文已保留") from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.get("/session")
    async def session(request: Request) -> JSONResponse:
        from routes.research import _session_token

        require_research_session(request, write=False, bootstrap=True)
        return JSONResponse(
            {"csrf_token": _session_token}, headers={"Cache-Control": "no-store"}
        )

    @router.get("/projects")
    async def projects(request: Request) -> JSONResponse:
        guard(request)
        return JSONResponse(
            {"projects": await invoke(store(request).list_projects())},
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/projects")
    async def create_project(request: Request) -> JSONResponse:
        data = await body(request)
        service = store(request)
        if not all(
            isinstance(data.get(k), str) and data[k].strip()
            for k in ("title", "direction", "command_id")
        ):
            raise HTTPException(422, "请填写项目名称与研究方向")
        result = await invoke(
            service.create(
                data["title"],
                data["direction"],
                data.get("market", "US"),
                data["command_id"],
            )
        )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.get("/projects/{project_id}")
    async def project(request: Request, project_id: str) -> JSONResponse:
        guard(request)
        return JSONResponse(
            await invoke(store(request).get(project_uuid(project_id))),
            headers={"Cache-Control": "no-store"},
        )

    @router.delete("/projects/{project_id}")
    async def delete_project(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        return JSONResponse(
            await invoke(
                store(request).delete_project(
                    project_uuid(project_id), data.get("version"), data.get("title")
                )
            ),
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/projects/{project_id}/commands/{command_id}")
    async def draft_command_receipt(request: Request, project_id: str, command_id: str) -> JSONResponse:
        # The source command ledger is the idempotency receipt, not a client hash
        # or a bounded project-view event list. No payload or replay is exposed.
        from sqlalchemy import select
        from rabbit_hole.persistence.projects import workbench_events

        guard(request)
        project_id, command_id = project_uuid(project_id), project_uuid(command_id)
        service = store(request)
        await invoke(service.get(project_id))
        async def read():
            async with service.engine.connect() as connection:
                return (await connection.execute(
                    select(workbench_events.c.action, workbench_events.c.digest).where(
                        workbench_events.c.project_id == project_id,
                        workbench_events.c.command_id == command_id,
                    )
                )).mappings().first()
        receipt = await invoke(read())
        data = {"contract_version": 1, "project_id": project_id, "command_id": command_id,
                "state": "committed" if receipt else "not_observed"}
        if receipt:
            data.update(action=receipt["action"] if receipt["action"] in USER_ACTIONS | {"create_project"} else "unknown",
                        digest=receipt["digest"])
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @router.post("/projects/{project_id}/commands")
    async def command(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        if not isinstance(data.get("action"), str):
            raise HTTPException(422, "缺少有效操作名称")
        if data.get("action") not in USER_ACTIONS:
            raise HTTPException(403, "此操作不能由浏览器提交")
        if (
            not isinstance(data.get("version"), int)
            or not isinstance(data.get("command_id"), str)
            or not isinstance(data.get("payload"), dict)
        ):
            raise HTTPException(422, "缺少版本或操作参数")
        result = await invoke(
            store(request).command(
                project_uuid(project_id),
                data["version"],
                data["command_id"],
                data["action"],
                data["payload"],
            )
        )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    def sync_service(request: Request) -> Any:
        return dependency(request, "sync", "飞书摘要同步尚未配置；本机研究可继续")

    @router.get("/projects/{project_id}/sync")
    async def sync_status(request: Request, project_id: str) -> JSONResponse:
        guard(request)
        return JSONResponse(
            {
                "runs": await invoke(
                    sync_service(request).status(project_uuid(project_id))
                )
            },
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/projects/{project_id}/sync/preview")
    async def sync_preview(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        if type(data.get("version")) is not int:
            raise HTTPException(422, "缺少有效项目版本")
        return JSONResponse(
            await invoke(
                sync_service(request).preview(project_uuid(project_id), data["version"])
            )
        )

    @router.post("/projects/{project_id}/sync")
    async def sync_enqueue(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        if type(data.get("version")) is not int or not isinstance(
            data.get("digest"), str
        ):
            raise HTTPException(422, "请先预览当前版本")
        return JSONResponse(
            await invoke(
                sync_service(request).enqueue(
                    project_uuid(project_id), data["version"], data["digest"]
                )
            )
        )

    @router.post("/projects/{project_id}/sync/{run_id}/retry")
    async def sync_retry(
        request: Request, project_id: str, run_id: str
    ) -> JSONResponse:
        await body(request)
        return JSONResponse(
            await invoke(
                sync_service(request).retry(
                    project_uuid(project_id), project_uuid(run_id)
                )
            )
        )

    @router.get("/sources")
    async def sources(request: Request) -> JSONResponse:
        guard(request)
        configured = getattr(runtime(request), "workbench_services", {}).get(
            "sources", {}
        )
        provider = getattr(runtime(request), "workbench_services", {}).get(
            "integration_status_provider"
        )
        integrations = (
            await invoke(provider())
            if provider is not None
            else {
                "meta": {"status": "unconfigured", "message": "公开页面采集尚未连接。"},
                "trends": {
                    "status": "unconfigured",
                    "message": "自动采集尚未连接；CSV导入可用。",
                },
                "ai": {
                    "status": "healthy" if configured.get("ai") else "unconfigured",
                    "message": "AI 建议接口状态未知。",
                },
            }
        )

        vault = getattr(runtime(request), "workbench_services", {}).get("ai_settings")
        ai_config = (
            await invoke(asyncio.to_thread(vault.public))
            if vault is not None
            else {"source": "unconfigured", "configured": False}
        )
        if ai_config["source"] in {"saved", "main_binding"}:
            integrations["ai"] = {
                "status": "configured" if ai_config["configured"] else "unconfigured",
                "message": "主AI文本绑定已配置，尚未验证本次连接；建议仍需人工审核。",
            }

        def integration_source(key: str) -> dict[str, Any]:
            value = integrations.get(key, {})
            status = value.get("status", "unconfigured")
            return {
                "status": status,
                "available": status == "healthy",
                "integration_message": value.get("message", "来源状态未知。"),
            }

        return JSONResponse(
            {
                "sources": [
                    {
                        "key": "meta",
                        "name": "Meta 广告资料库",
                        "mode": "公开页面采集",
                        **integration_source("meta"),
                        "note": "不会绕过验证码。素材独立性需要证据确认。",
                    },
                    {
                        "key": "landing",
                        "name": "商品页面",
                        "mode": "公开页面采集",
                        "available": False,
                        "note": "识别与漏斗事实采集，不自动确认产品相关性。",
                    },
                    {
                        "key": "trends",
                        "name": "Google Trends",
                        "mode": "公开页面 / CSV导入",
                        **integration_source("trends"),
                        "note": "可能限流。支持12个月和5年数据分别导入。",
                    },
                    {
                        "key": "ai",
                        "name": "AI 关键词建议",
                        "mode": (
                            "已配置接口"
                            if integrations.get("ai", {}).get("status") == "healthy"
                            else "已配置，待核验"
                            if ai_config["source"] == "saved"
                            and ai_config["configured"]
                            else "待配置或暂不可用"
                        ),
                        **integration_source("ai"),
                        "note": "生成的是待审核建议，不是已验证事实；每次点击最多一次有界请求。",
                    },
                    *[
                        {
                            "key": key,
                            "name": name,
                            "mode": "人工报价" if key == "supplier" else "人工证据导入",
                            "available": True,
                            "note": (
                                "报价在商品成本页录入，不会把公开标价当作到岸成本。"
                                if key == "supplier"
                                else "尚未连接自动接口；提交来源、时间与观察，不会假装已自动验证。"
                            ),
                            **EXTERNAL_SOURCE_FEASIBILITY[key],
                        }
                        for key, name in [
                            ("pinterest", "Pinterest"),
                            ("tiktok", "TikTok"),
                            ("amazon", "Amazon"),
                            ("similarweb", "Similarweb"),
                            ("supplier", "Supplier · 供应商报价"),
                        ]
                    ],
                ],
                "feasibility_checked_at": "2026-09-30",
                "credential_note": "集成配置通过主应用私有配置服务注入；未连接的接口不会自动执行。人工证据流程可先使用，不回显密钥。",
            },
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/projects/{project_id}/intelligence")
    async def intelligence(request: Request, project_id: str) -> JSONResponse:
        guard(request)
        from rabbit_hole.application.actions import scan_action_stats
        from rabbit_hole.application.intelligence import intelligence_snapshot

        service = store(request)
        validated_id = project_uuid(project_id)
        project_data = await invoke(service.get(validated_id))
        stats = await invoke(scan_action_stats(service.engine, validated_id))
        return JSONResponse(
            intelligence_snapshot(project_data, stats, datetime.now(UTC)),
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/projects/{project_id}/actions")
    async def actions(request: Request, project_id: str) -> JSONResponse:
        guard(request)
        from rabbit_hole.application.actions import list_actions

        await invoke(store(request).get(project_uuid(project_id)))
        raw_limit = request.query_params.get("limit")
        raw_cursor = request.query_params.get("cursor")
        try:
            limit = 20 if raw_limit is None else int(raw_limit)
        except ValueError:
            raise HTTPException(422, "limit 必须是整数") from None
        if not 1 <= limit <= 100:
            raise HTTPException(422, "limit 必须在1到100之间")
        try:
            async with asyncio.timeout(20):
                page = await list_actions(
                    store(request).engine,
                    project_uuid(project_id),
                    limit=limit,
                    cursor=raw_cursor,
                )
        except ValueError:
            raise HTTPException(422, "分页游标无效") from None
        except TimeoutError:
            raise HTTPException(503, "操作未完成，请稍后重试") from None
        except Exception:  # noqa: BLE001 -- database failures use a closed local message
            raise HTTPException(503, "操作未完成，请刷新确认状态后重试") from None

        return JSONResponse(
            page,
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/projects/{project_id}/actions")
    async def queue_action(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        if (
            not isinstance(data.get("kind"), str)
            or type(data.get("version")) is not int
        ):
            raise HTTPException(422, "缺少操作类型或项目版本")
        from rabbit_hole.application.actions import enqueue_action

        return JSONResponse(
            await invoke(
                enqueue_action(store(request), project_uuid(project_id), data)
            ),
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/projects/{project_id}/actions/{action_id}/stop")
    async def stop_workbench_action(
        request: Request, project_id: str, action_id: str
    ) -> JSONResponse:
        data = await body(request)
        from rabbit_hole.application.actions import stop_action

        version = data.get("version")
        if "version" in data and type(version) is not int:
            raise HTTPException(422, "项目版本无效")
        attempt = data.get("attempt")
        if isinstance(attempt, bool) or not isinstance(attempt, int):
            raise HTTPException(422, "任务次数无效")

        service = store(request)
        validated_id = project_uuid(project_id)
        from rabbit_hole.application.actions import actions
        from sqlalchemy import select

        async def saved_action(current):
            try:
                action_uuid = UUID(current)
            except (ValueError, TypeError):
                return None
            async with service.engine.connect() as connection:
                return (
                    (
                        await connection.execute(
                            select(actions).where(
                                actions.c.id == action_uuid,
                                actions.c.project_id == UUID(validated_id),
                            )
                        )
                    )
                    .mappings()
                    .first()
                )

        injected = getattr(runtime(request), "workbench_services", {}).get(
            "stop_action"
        )
        if injected is None:
            # Check dependencies too: original verify cancellation recursively stops them.
            pending = [action_id]
            seen = set()
            while pending:
                current = pending.pop()
                if current in seen:
                    continue
                seen.add(current)
                saved = await invoke(saved_action(current))
                if (
                    current == action_id
                    and saved
                    and (attempt < 0 or saved["attempt"] != attempt)
                ):
                    break  # Original handler returns the established 422/409 before any abort.
                if saved and saved["status"] in {"ready", "running"}:
                    payload = saved.get("payload") or {}
                    if (payload.get("apify_run") or {}).get("id"):
                        raise HTTPException(
                            503, "外部任务停止尚未配置，请核对来源任务状态"
                        )
                    pending.extend(payload.get("owned_dependencies") or [])
        return JSONResponse(
            await invoke(
                (injected or stop_action)(service, validated_id, action_id, attempt, **({"version": version} if version is not None else {}))
            ),
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/projects/{project_id}/actions/{action_id}/provider-evidence")
    async def provider_evidence(
        request: Request, project_id: str, action_id: str
    ) -> JSONResponse:
        guard(request)
        from sqlalchemy import select

        await invoke(store(request).get(project_uuid(project_id)))
        from rabbit_hole.application.actions import actions

        try:
            aid = UUID(action_id)
        except ValueError:
            raise HTTPException(404) from None
        async with store(request).engine.connect() as c:
            payload = await c.scalar(
                select(actions.c.payload).where(
                    actions.c.id == aid,
                    actions.c.project_id == UUID(project_uuid(project_id)),
                )
            )
        if not payload or not payload.get("provider_evidence"):
            raise HTTPException(404, "此动作尚无接口证据")
        return JSONResponse(
            payload["provider_evidence"],
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @router.get("/projects/{project_id}/actions/{action_id}/screenshot")
    async def screenshot(request: Request, project_id: str, action_id: str) -> Response:
        guard(request)
        from rabbit_hole.application.actions import get_action

        action = await invoke(
            get_action(store(request).engine, project_uuid(project_id), action_id)
        )
        if action and action["status"] != "complete":
            action = None
        project = await invoke(store(request).get(project_uuid(project_id)))
        object_id = ((action or {}).get("result") or {}).get("evidence_id")
        if not isinstance(object_id, str) or not object_id.startswith(
            f"evidence/{project['market']}/{action_id}/"
        ):
            raise HTTPException(404, "此动作暂无可查看截图")
        reader = getattr(runtime(request), "workbench_services", {}).get(
            "screenshot_reader"
        )
        if reader is None:
            evidence = getattr(runtime(request), "evidence_store", None)
            if evidence is None:
                raise HTTPException(503, "证据存储尚未就绪")
            from rabbit_hole.domain.evidence import read_screenshot

            async def reader(key):
                return await asyncio.to_thread(
                    read_screenshot, evidence._client, evidence._bucket, key
                )

        from services.research_security import validate_evidence_object_id

        validate_evidence_object_id(object_id)
        raw = await invoke(reader(object_id))
        return Response(
            raw,
            media_type="image/png",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @router.get("/projects/{project_id}/media-download")
    async def media_download(
        request: Request,
        project_id: str,
        keyword_id: str,
        source: str,
        index: int,
        product_id: str = "",
        ad_id: str = "",
    ) -> Response:
        guard(request)
        from rabbit_hole.integrations.media_download import (
            MediaDownloadError,
            select_media,
        )

        project = await invoke(store(request).get(project_uuid(project_id)))
        try:
            item = select_media(project, keyword_id, product_id, ad_id, source, index)
        except MediaDownloadError as exc:
            raise HTTPException(422, str(exc)) from exc
        async with media_download_slots:
            try:
                raw, mime, extension = await dependency(
                    request, "media_reader", "媒体读取尚未配置"
                )(item)
            except MediaDownloadError as exc:
                raise HTTPException(502, str(exc)) from exc
        return Response(
            raw,
            media_type=mime,
            headers={
                "Content-Disposition": f'attachment; filename="rabbit-hole-{source}-{index + 1}.{extension}"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.post("/projects/{project_id}/trends-import")
    async def import_trends(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        if type(data.get("version")) is not int or not isinstance(
            data.get("command_id"), str
        ):
            raise HTTPException(422, "缺少项目版本或命令编号，请刷新后重试")
        from rabbit_hole.application.imports import parse_trends_csv

        try:
            evidence = parse_trends_csv(data)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return JSONResponse(
            await invoke(
                store(request).command(
                    project_uuid(project_id),
                    data["version"],
                    data["command_id"],
                    "evidence",
                    evidence,
                )
            ),
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/projects/{project_id}/report")
    async def report(request: Request, project_id: str) -> Response:
        guard(request)
        service = store(request)
        validated_id = project_uuid(project_id)
        project = await invoke(service.get(validated_id))
        from rabbit_hole.application.actions import scan_action_stats
        from rabbit_hole.application.intelligence import intelligence_snapshot
        from rabbit_hole.application.reports import research_report

        stats = await invoke(scan_action_stats(service.engine, validated_id))
        snapshot = intelligence_snapshot(project, stats, datetime.now(UTC))

        return Response(
            research_report(project, snapshot),
            media_type="text/markdown",
            headers={
                "Content-Disposition": 'attachment; filename="research-report.md"',
                "Cache-Control": "no-store",
            },
        )

    return router


router = create_workbench_router()


@asynccontextmanager
async def research_lifespan(app, *, config=None, database=None, data_root=None):
    """Only explicit local mode opens prepared runtime; never migrate or start workers."""
    from services.research_client import load_research_config
    from services.research_runtime import open_research_runtime, resolve_runtime_paths

    app.state.research_runtime = None
    app.state.integration_settings = None
    app.state.research_diagnostics = ()
    config = load_research_config() if config is None else config
    async with AsyncExitStack() as resources:
        if config.get("enabled") is True:
            try:
                if database is None:
                    from db import DB_PATH

                    database = Path(DB_PATH)
                data_root = (
                    Path(data_root)
                    if data_root is not None
                    else Path(config.get("data_root") or Path.home() / ".local/share/ai-ecommerce-tools/research")
                )
                paths = resolve_runtime_paths(Path(database), data_root)
                from services.research_ai_adapter import read_business_settings
                business = read_business_settings(config['business_settings_path']) if config.get('business_settings_path') else None
                from services.research_activation import validate_activation
                authorized = validate_activation(paths)
                app.state.research_runtime = await resources.enter_async_context(
                    open_research_runtime(
                        paths, allow_commands=authorized, allow_external=authorized,
                        **({"business_settings":business} if business is not None else {})
                    )
                )
                app.state.integration_settings = app.state.research_runtime.settings_store
            except Exception:  # noqa: BLE001 -- isolate unavailable research from main app
                # Diagnostics deliberately exclude paths, exception payloads and credentials.
                app.state.research_diagnostics = ("initialization_failed",)
        try:
            yield
        finally:
            app.state.research_runtime = None
            app.state.integration_settings = None
