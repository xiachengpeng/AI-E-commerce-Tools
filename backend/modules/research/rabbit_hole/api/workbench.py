"""Same-origin local business commands. No public deployment/auth implied."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

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
ASSETS = Path(__file__).resolve().parents[3] / "frontend" / "dist"
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


def create_workbench_router() -> APIRouter:
    router = APIRouter()
    token = secrets.token_urlsafe(32)
    from rabbit_hole.integrations.ad_translation import TranslationService

    translator = TranslationService()
    media_download_slots = asyncio.Semaphore(2)
    direction_slots = asyncio.Semaphore(1)
    log_stream_slots = asyncio.Semaphore(4)

    def guard(request: Request, *, write: bool = False, frame_entry: bool = False) -> None:
        allowed_hosts = {"127.0.0.1", "localhost", "::1"}
        lan_ip = os.environ.get("RABBIT_HOLE_LAN_IP", "").strip()
        if lan_ip:
            allowed_hosts.add(lan_ip)
        if request.url.hostname not in allowed_hosts:
            raise HTTPException(403, "工作台仅允许已配置的地址访问")
        origin = request.headers.get("origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in {
                "http",
                "https",
            } or parsed.netloc != request.headers.get("host"):
                raise HTTPException(403, "拒绝跨站请求")
        if request.headers.get("sec-fetch-site") == "cross-site" and not frame_entry:
            raise HTTPException(403, "拒绝跨站请求")
        if write and not secrets.compare_digest(
            request.headers.get("x-workbench-token", ""), token
        ):
            raise HTTPException(403, "会话已过期，请刷新页面")

    def store(request: Request) -> Any:
        service = getattr(request.app.state, "workbench_store", None)
        if service is None:
            raise HTTPException(503, "业务数据库尚未就绪")
        return service

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

    @router.get("/")
    async def home() -> HTMLResponse:
        return HTMLResponse(
            ASSETS.joinpath("workbench.html").read_text(),
            headers={
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
            },
        )

    @router.get("/marketing-workbench")
    async def marketing_home(request: Request) -> HTMLResponse:
        # Ancestors are restricted by CSP. This navigation may cross localhost aliases;
        # all API requests still use the original origin/token/fetch-site guard.
        guard(request, frame_entry=True)
        response = await home()
        response.headers["Content-Security-Policy"] = response.headers[
            "Content-Security-Policy"
        ].replace(
            "frame-ancestors 'none'",
            "frame-ancestors http://127.0.0.1:9502 http://localhost:9502 "
            "http://127.0.0.1:9503 http://localhost:9503",
        )
        return response

    @router.get("/workbench/{asset}")
    async def asset_file(asset: str) -> Response:
        if asset not in {"workbench.js", "app.css"}:
            raise HTTPException(404)
        return Response(
            ASSETS.joinpath(asset).read_text(),
            media_type="text/javascript" if asset.endswith(".js") else "text/css",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )


    @router.get("/workbench/ui-icons/{name}.svg")
    async def ui_icon(name: str) -> Response:
        allowed = {
            "search", "folder", "box", "chart-bar", "settings", "chevron-left",
            "chevron-right", "external-link", "file-text", "list-details",
            "circle-check", "link", "photo-off", "circle-dot", "x", "plus",
            "arrow-right",
        }
        if name not in allowed:
            raise HTTPException(404)
        return Response(
            ASSETS.joinpath("ui-icons", name + ".svg").read_bytes(),
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"},
        )

    @router.get("/workbench/api/projects/{project_id}/live-logs")
    async def live_logs(request: Request, project_id: str, after: int = 0) -> JSONResponse:
        guard(request)
        project_id = project_uuid(project_id)
        service = store(request)
        await invoke(service.get(project_id))
        from rabbit_hole.integrations.provider_jobs import read_logs

        rows = await invoke(read_logs(service.engine, project_id, max(0, after)))
        return JSONResponse({"logs": rows, "cursor": rows[-1]["id"] if rows else after}, headers={"Cache-Control": "no-store"})


    @router.get("/workbench/api/projects/{project_id}/log-stream")
    async def log_stream(request: Request, project_id: str, after: int = Query(default=0, ge=0, le=9223372036854775807)) -> StreamingResponse:
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
            return await read_logs(service.engine, project_id, cursor)

        async def events() -> AsyncIterator[str]:
            try:
                async for event in stream_logs(request, read, after=after):
                    yield event
            finally:
                log_stream_slots.release()

        return StreamingResponse(events(), media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no",
                     "X-Content-Type-Options": "nosniff"})

    @router.get("/workbench/api/provider-settings")
    async def provider_settings(request: Request) -> JSONResponse:
        guard(request)
        from rabbit_hole.integrations.provider_settings import ProviderSecrets

        return JSONResponse({"configured": ProviderSecrets().status()}, headers={"Cache-Control": "no-store"})

    @router.post("/workbench/api/provider-settings")
    async def save_provider_settings(request: Request) -> JSONResponse:
        data = await body(request)
        from rabbit_hole.integrations.provider_settings import ProviderSecrets

        try:
            configured = await asyncio.to_thread(ProviderSecrets().update, data)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except OSError:
            raise HTTPException(503, "密钥未保存，请检查后端私有存储权限") from None
        return JSONResponse({"configured": configured}, headers={"Cache-Control": "no-store"})

    @router.get("/workbench/api/ai-settings")
    async def ai_settings(request: Request) -> JSONResponse:
        guard(request)
        from rabbit_hole.integrations.ai_settings import AISettings

        result = await invoke(asyncio.to_thread(AISettings().public))
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.post("/workbench/api/ai-settings")
    async def save_ai_settings(request: Request) -> JSONResponse:
        data = await body(request)
        from rabbit_hole.integrations.ai_settings import AISettings

        try:
            vault = AISettings()
            if data == {"reset": True}:
                result = await asyncio.to_thread(vault.reset)
            else:
                result = await asyncio.to_thread(vault.update, data)
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from None
        except OSError:
            raise HTTPException(503, "AI 配置未保存，请检查后端私有存储权限") from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.post("/workbench/api/project-direction")
    async def project_direction(request: Request) -> JSONResponse:
        data = await body(request)
        from rabbit_hole.integrations.project_direction import (
            DirectionError,
            generate_direction,
        )

        if direction_slots.locked():
            raise HTTPException(429, "AI 正在帮写，请等待当前请求完成")
        async with direction_slots:
            try:
                direction = await generate_direction(data.get("title"), data.get("market"))
            except DirectionError as exc:
                raise HTTPException(exc.status, str(exc)) from None
        return JSONResponse({"direction": direction}, headers={"Cache-Control": "no-store"})

    @router.post("/workbench/api/projects/{project_id}/ads/translate")
    async def translate_ad(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        project = await invoke(store(request).get(project_uuid(project_id)))
        word = next((item for item in project["keywords"] if item["id"] == data.get("keyword_id")), None)
        ad = next((item for item in word.get("ads", []) if item["id"] == data.get("ad_id")), None) if word else None
        if not ad:
            raise HTTPException(404, "未找到这条已保存广告，请刷新页面")
        source = ad.get("primary_text") or ""
        if data.get("expected_text") != source:
            raise HTTPException(409, "广告原文已变化，请刷新后再翻译")
        if not usable_ad_copy(source):
            raise HTTPException(422, "未获取可用广告正文，请打开原广告核对，不能翻译模板占位符")
        from rabbit_hole.integrations.ad_translation import TranslationError

        try:
            result = await asyncio.wait_for(translator.translate(source), timeout=22)
        except TranslationError as exc:
            raise HTTPException(503, str(exc)) from None
        except TimeoutError:
            raise HTTPException(504, "翻译等待超时，请重试；原文已保留") from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.get("/workbench/api/session")
    async def session(request: Request) -> JSONResponse:
        guard(request)
        return JSONResponse(
            {"csrf_token": token}, headers={"Cache-Control": "no-store"}
        )

    @router.get("/workbench/api/projects")
    async def projects(request: Request) -> JSONResponse:
        guard(request)
        return JSONResponse(
            {"projects": await invoke(store(request).list_projects())},
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/workbench/api/projects")
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

    @router.get("/workbench/api/projects/{project_id}")
    async def project(request: Request, project_id: str) -> JSONResponse:
        guard(request)
        return JSONResponse(
            await invoke(store(request).get(project_uuid(project_id))),
            headers={"Cache-Control": "no-store"},
        )

    @router.delete("/workbench/api/projects/{project_id}")
    async def delete_project(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        return JSONResponse(
            await invoke(store(request).delete_project(project_uuid(project_id), data.get("version"), data.get("title"))),
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/workbench/api/projects/{project_id}/commands")
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
        service = getattr(request.app.state, "workbench_sync", None)
        if service is None:
            raise HTTPException(503, "飞书摘要同步尚未配置；本机研究可继续")
        return service

    @router.get("/workbench/api/projects/{project_id}/sync")
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

    @router.post("/workbench/api/projects/{project_id}/sync/preview")
    async def sync_preview(request: Request, project_id: str) -> JSONResponse:
        data = await body(request)
        if type(data.get("version")) is not int:
            raise HTTPException(422, "缺少有效项目版本")
        return JSONResponse(
            await invoke(
                sync_service(request).preview(project_uuid(project_id), data["version"])
            )
        )

    @router.post("/workbench/api/projects/{project_id}/sync")
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

    @router.post("/workbench/api/projects/{project_id}/sync/{run_id}/retry")
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

    @router.get("/workbench/api/sources")
    async def sources(request: Request) -> JSONResponse:
        guard(request)
        configured = getattr(request.app.state, "workbench_sources", {})
        provider = getattr(request.app.state, "integration_status_provider", None)
        integrations = (
            await invoke(provider())
            if provider is not None
            else {
                "meta": {"status": "healthy", "message": "公开页面采集可用。"},
                "trends": {"status": "healthy", "message": "公开数据导入可用。"},
                "ai": {
                    "status": "healthy" if configured.get("ai") else "unconfigured",
                    "message": "AI 建议接口状态未知。",
                },
            }
        )

        from rabbit_hole.integrations.ai_settings import AISettings

        ai_config = await invoke(asyncio.to_thread(AISettings().public))
        if ai_config["source"] == "saved":
            integrations["ai"] = {
                "status": "configured" if ai_config["configured"] else "unconfigured",
                "message": "已保存中转站配置，尚未验证本次连接；建议仍需人工审核。",
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
                        "available": True,
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
                            else "已配置，待核验" if ai_config["source"] == "saved" and ai_config["configured"] else "待配置或暂不可用"
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
                "credential_note": "当前复用本机环境配置。AI配置项：OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL（均带RABBIT_HOLE_前缀）。不在项目中保存或回显密钥。第三方API适配需取得真实接口授权后核验；人工证据流程可先使用。",
            },
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/workbench/api/projects/{project_id}/intelligence")
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

    @router.get("/workbench/api/projects/{project_id}/actions")
    async def actions(request: Request, project_id: str) -> JSONResponse:
        guard(request)
        from rabbit_hole.application.actions import list_actions

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

    @router.post("/workbench/api/projects/{project_id}/actions")
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

    @router.post("/workbench/api/projects/{project_id}/actions/{action_id}/stop")
    async def stop_workbench_action(
        request: Request, project_id: str, action_id: str
    ) -> JSONResponse:
        data = await body(request)
        from rabbit_hole.application.actions import stop_action

        attempt = data.get("attempt")
        if isinstance(attempt, bool) or not isinstance(attempt, int):
            raise HTTPException(422, "任务次数无效")

        return JSONResponse(
            await invoke(stop_action(store(request), project_uuid(project_id), action_id, attempt)),
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/workbench/api/projects/{project_id}/actions/{action_id}/provider-evidence")
    async def provider_evidence(request: Request, project_id: str, action_id: str) -> JSONResponse:
        guard(request)
        from sqlalchemy import select

        from rabbit_hole.application.actions import actions
        try:
            aid = UUID(action_id)
        except ValueError:
            raise HTTPException(404) from None
        async with store(request).engine.connect() as c:
            payload = await c.scalar(select(actions.c.payload).where(actions.c.id == aid, actions.c.project_id == UUID(project_uuid(project_id))))
        if not payload or not payload.get("provider_evidence"):
            raise HTTPException(404, "此动作尚无接口证据")
        return JSONResponse(payload["provider_evidence"], headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @router.get("/workbench/api/projects/{project_id}/actions/{action_id}/screenshot")
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
        reader = getattr(request.app.state, "workbench_screenshot_reader", None)
        if reader is None:
            raise HTTPException(503, "证据存储尚未就绪")
        raw = await invoke(reader(object_id))
        return Response(
            raw,
            media_type="image/png",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )


    @router.get("/workbench/api/projects/{project_id}/media-download")
    async def media_download(request: Request, project_id: str, keyword_id: str,
                             source: str, index: int, product_id: str = "", ad_id: str = "") -> Response:
        guard(request)
        from rabbit_hole.integrations.media_download import (
            MediaDownloadError,
            read_media_download,
            select_media,
        )

        project = await invoke(store(request).get(project_uuid(project_id)))
        try:
            item = select_media(project, keyword_id, product_id, ad_id, source, index)
        except MediaDownloadError as exc:
            raise HTTPException(422, str(exc)) from exc
        async with media_download_slots:
            try:
                raw, mime, extension = await read_media_download(item)
            except MediaDownloadError as exc:
                raise HTTPException(502, str(exc)) from exc
        return Response(raw, media_type=mime, headers={
            "Content-Disposition": f'attachment; filename="rabbit-hole-{source}-{index + 1}.{extension}"',
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        })

    @router.post("/workbench/api/projects/{project_id}/trends-import")
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

    @router.get("/workbench/api/projects/{project_id}/report")
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
