"""Private local settings APIs; never return backend credentials or raw failures."""

from fastapi import APIRouter, HTTPException, Request
from services.research_security import require_research_session
from starlette.responses import JSONResponse


def create_integration_settings_router() -> APIRouter:
    from routes.research_workbench import ResearchPrivateRoute

    router = APIRouter(
        prefix="/api/settings/integrations", route_class=ResearchPrivateRoute
    )

    def service(request: Request):
        store = getattr(request.app.state, "integration_settings", None)
        if store is None:
            raise HTTPException(503, "集成配置尚未就绪")
        return store

    @router.get("/{provider}/{purpose}")
    def public(request: Request, provider: str, purpose: str):
        require_research_session(request, False)
        try:
            return JSONResponse(
                service(request).public(provider, purpose),
                headers={"Cache-Control": "no-store"},
            )
        except ValueError as exc:
            raise HTTPException(
                503 if "unprepared" in str(exc) else 422,
                "集成配置尚未就绪" if "unprepared" in str(exc) else "集成配置参数无效",
            ) from None

    @router.patch("/{provider}/{purpose}")
    async def update(request: Request, provider: str, purpose: str):
        require_research_session(request, True)
        try:
            raw = await request.body()
            if len(raw) > 16384:
                raise ValueError("invalid input")
            import json

            changes = json.loads(raw)
            return JSONResponse(
                service(request).update(provider, purpose, changes),
                headers={"Cache-Control": "no-store"},
            )
        except ValueError as exc:
            raise HTTPException(
                503 if "unprepared" in str(exc) else 422,
                "集成配置尚未就绪" if "unprepared" in str(exc) else "集成配置参数无效",
            ) from None

    return router


router = create_integration_settings_router()
