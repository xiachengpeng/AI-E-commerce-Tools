"""Local business workbench, legacy dashboard, health and metrics service."""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError  # type: ignore[import-untyped]
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST
from sqlalchemy import select, text

from rabbit_hole.api.workbench import create_workbench_router
from rabbit_hole.config import get_settings
from rabbit_hole.dashboard import read_dashboard
from rabbit_hole.integrations.feishu import FeishuClient
from rabbit_hole.monitoring import Telemetry, render_metrics, runtime_health
from rabbit_hole.persistence.database import create_database_engine
from rabbit_hole.persistence.storage_factory import create_storage_client

HealthCheck = Callable[[], Awaitable[bool]]
CORE_DEPENDENCIES = ("database", "storage")
INTEGRATIONS = ("meta", "trends", "ai", "feishu")
INTEGRATION_MESSAGES = {
    "meta": {
        "healthy": "公开页面采集可用；不会绕过验证码或平台限制。",
        "degraded": "Meta 来源当前不可用，可稍后重试或补充人工证据。",
        "unconfigured": "Meta 公开采集尚未配置。",
    },
    "trends": {
        "healthy": "Google Trends 采集或人工 CSV 导入可用。",
        "degraded": "Google Trends 当前不可用，可稍后重试或导入 CSV。",
        "unconfigured": "Google Trends 来源尚未配置。",
    },
    "ai": {
        "healthy": "AI 关键词建议接口已配置。",
        "degraded": "AI 关键词建议接口当前不可用，仍可手动补词。",
        "unconfigured": "AI 接口未配置，仍可手动添加关键词。",
    },
    "feishu": {
        "healthy": "飞书同步接口可用；同步仍需人工触发。",
        "degraded": "飞书当前不可用，不影响本地选品和已保存证据。",
        "unconfigured": "飞书未配置，不影响本地工作台。",
    },
}


def storage_is_private(client: Any, bucket: str) -> bool:
    """Fail closed on unknown privacy/versioning, including unreadable bucket policy."""
    client.head_bucket(Bucket=bucket)
    if client.get_bucket_versioning(Bucket=bucket).get("Status") != "Enabled":
        return False
    grants = client.get_bucket_acl(Bucket=bucket).get("Grants")
    if not isinstance(grants, list) or not grants:
        return False
    if any(grant.get("Grantee", {}).get("Type") != "CanonicalUser" for grant in grants):
        return False
    try:
        policy = json.loads(client.get_bucket_policy(Bucket=bucket)["Policy"])
    except ClientError as exc:
        return exc.response.get("Error", {}).get("Code") in (
            "NoSuchBucketPolicy",
            "NoSuchPolicy",
        )
    statements = policy.get("Statement", [])
    if not isinstance(statements, list):
        return False
    for statement in statements:
        if statement.get("Effect") == "Allow":
            principal = statement.get("Principal")
            if principal == "*" or (
                isinstance(principal, dict)
                and any(
                    value == "*" or (isinstance(value, list) and "*" in value)
                    for value in principal.values()
                )
            ):
                return False
    return True


def create_app(
    *,
    checks: Mapping[str, HealthCheck] | None = None,
    telemetry: Telemetry | None = None,
    readiness_timeout: float = 5,
    dashboard_reader: Callable[[], Awaitable[dict[str, Any]]] | None = None,
) -> FastAPI:
    selected_checks = dict(checks or {})
    selected_telemetry = telemetry
    integration_configured = {
        "meta": True,
        "trends": True,
        "ai": "ai" in selected_checks,
        "feishu": "feishu" in selected_checks,
    }

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal selected_telemetry, dashboard_reader
        if checks is not None or telemetry is not None:
            yield
            return
        settings = get_settings()
        engine = create_database_engine(settings)
        from rabbit_hole.persistence.sql import initialize_sqlite
        await initialize_sqlite(engine)
        feishu = FeishuClient(
            settings.feishu_app_id,
            settings.feishu_app_secret,
            settings.feishu_base_app_token,
        )
        s3 = create_storage_client(settings)
        app.state.workbench_storage_client = s3
        selected_telemetry = Telemetry(engine)

        async def dashboard_snapshot() -> dict[str, Any]:
            return await read_dashboard(
                engine, worker_max_age=max(120, 3 * settings.poll_seconds)
            )

        dashboard_reader = dashboard_snapshot

        async def database() -> bool:
            async with engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
            return True

        async def storage() -> bool:
            return await asyncio.to_thread(storage_is_private, s3, settings.s3_bucket)

        async def token() -> bool:
            return bool(await feishu.probe_token())

        selected_checks.update(database=database, storage=storage, feishu=token)
        integration_configured.update(
            ai=bool(settings.openai_api_key and settings.openai_model),
            feishu=bool(
                settings.feishu_app_id
                and settings.feishu_app_secret
                and settings.feishu_base_app_token
            ),
        )
        from rabbit_hole.persistence.projects import WorkbenchStore

        app.state.workbench_store = WorkbenchStore(engine)
        from rabbit_hole.application.sync import WorkbenchSync

        app.state.workbench_sync = WorkbenchSync(app.state.workbench_store, feishu)
        from rabbit_hole.domain.evidence import read_screenshot

        async def screenshot_reader(object_id: str) -> bytes:
            return await asyncio.to_thread(
                read_screenshot, s3, settings.s3_bucket, object_id
            )

        app.state.workbench_screenshot_reader = screenshot_reader
        app.state.workbench_sources = integration_configured
        try:
            yield
        finally:
            await feishu.aclose()
            s3.close()
            await engine.dispose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(create_workbench_router())
    from rabbit_hole.api.integration import create_integration_router
    app.include_router(create_integration_router())

    async def dependency_healthy(name: str) -> bool:
        check = selected_checks.get(name)
        if check is None:
            return False
        try:
            async with asyncio.timeout(readiness_timeout):
                return await check() is True
        except Exception:  # noqa: BLE001 -- health endpoints expose no internals
            return False

    async def integration_status() -> dict[str, dict[str, str]]:
        async def probe(name: str) -> tuple[str, dict[str, str]]:
            if not integration_configured[name]:
                status = "unconfigured"
            elif name not in selected_checks:
                status = "healthy"
            else:
                status = "healthy" if await dependency_healthy(name) else "degraded"
            return name, {
                "status": status,
                "message": INTEGRATION_MESSAGES[name][status],
            }

        return dict(await asyncio.gather(*(probe(name) for name in INTEGRATIONS)))

    app.state.integration_status_provider = integration_status

    @app.get("/operations", response_class=HTMLResponse)
    async def dashboard() -> HTMLResponse:
        return HTMLResponse(
            (Path(__file__).resolve().parents[3] / "frontend" / "dist" / "dashboard.html").read_text(),
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
            },
        )

    @app.get("/dashboard/data")
    async def dashboard_data() -> JSONResponse:
        try:
            if dashboard_reader is None:
                raise RuntimeError("dashboard unavailable")
            async with asyncio.timeout(readiness_timeout):
                snapshot = await dashboard_reader()
            return JSONResponse(snapshot, headers={"Cache-Control": "no-store"})
        except Exception:  # noqa: BLE001 -- never expose SQL, payloads or credentials
            return JSONResponse(
                {"status": "unavailable"},
                status_code=503,
                headers={"Cache-Control": "no-store"},
            )

    @app.get("/workbench/api/evidence-file")
    async def evidence_file(token: str) -> Response:
        from rabbit_hole.persistence.local_objects import LocalObjectClient
        client = getattr(app.state, "workbench_storage_client", None)
        if not isinstance(client, LocalObjectClient) or len(token) > 4096:
            return Response(status_code=404)
        try:
            raw, content_type = await asyncio.to_thread(client.read_signed, token)
        except Exception:  # noqa: BLE001 -- return no paths or private metadata
            return Response(status_code=404)
        if content_type not in {"image/png", "image/jpeg", "application/json", "text/plain"}:
            content_type = "application/octet-stream"
        return Response(raw, media_type=content_type, headers={"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "Content-Disposition":"attachment; filename=evidence", "Content-Security-Policy":"sandbox; default-src 'none'"})

    @app.get("/favicon.ico")
    async def favicon() -> Response:
        return Response(status_code=204)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready")
    async def ready() -> JSONResponse:
        results = await asyncio.gather(
            *(dependency_healthy(name) for name in CORE_DEPENDENCIES)
        )
        failed = [
            name for name, valid in zip(CORE_DEPENDENCIES, results) if not valid
        ]
        return JSONResponse(
            {"status": "not_ready" if failed else "ready", "failed": failed},
            status_code=503 if failed else 200,
        )

    @app.get("/integrations")
    async def integrations() -> JSONResponse:
        return JSONResponse(
            {"integrations": await integration_status()},
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/metrics")
    async def metrics() -> Response:
        try:
            if selected_telemetry is None:
                raise RuntimeError("metrics unavailable")
            async with asyncio.timeout(readiness_timeout):
                snapshot = await selected_telemetry.snapshot()
            return Response(
                render_metrics(snapshot), headers={"Content-Type": CONTENT_TYPE_LATEST}
            )
        except Exception:  # noqa: BLE001 -- metrics must not serialize database errors
            return JSONResponse({"status": "unavailable"}, status_code=503)

    return app


async def worker_is_live() -> bool:
    settings = get_settings()
    engine = create_database_engine(settings)
    try:
        async with asyncio.timeout(5), engine.connect() as connection:
            stamp = (
                await connection.execute(
                    select(runtime_health.c.updated_at).where(
                        runtime_health.c.component == "worker"
                    )
                )
            ).scalar_one_or_none()
            return stamp is not None and 0 <= (
                datetime.now(UTC) - stamp
            ).total_seconds() <= max(120, 3 * settings.poll_seconds)
    finally:
        await engine.dispose()


def main() -> int:
    if sys.argv[1:] == ["worker-health"]:
        try:
            return 0 if asyncio.run(worker_is_live()) else 1
        except Exception:  # noqa: BLE001 -- health probe returns only an exit code
            return 1
    import uvicorn

    uvicorn.run(
        "rabbit_hole.runtime.server:create_app",
        host="0.0.0.0",
        port=8000,
        factory=True,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
