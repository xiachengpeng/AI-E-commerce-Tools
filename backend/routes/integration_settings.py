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

    async def profile_body(request: Request):
        require_research_session(request, True)
        import json
        try:
            raw = await request.body()
            if len(raw) > 16384:
                raise ValueError()
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except (ValueError, TypeError):
            raise HTTPException(422, "配置参数无效") from None

    def profile_response(operation):
        try:
            return JSONResponse(operation(), headers={"Cache-Control": "no-store"})
        except (ValueError, TypeError):
            raise HTTPException(422, "配置不完整、名称重复或已被更新，请重新读取后核对。") from None

    @router.get('/{provider}/{purpose}/profiles/{profile_id}')
    def read_profile(request: Request, provider: str, purpose: str, profile_id: str):
        require_research_session(request, False)
        return profile_response(lambda: service(request).profile(provider, purpose, profile_id))

    @router.post('/{provider}/{purpose}/profiles')
    async def create_profile(request: Request, provider: str, purpose: str):
        body = await profile_body(request)
        return profile_response(lambda: service(request).create_profile(provider, purpose, body.get('name'), body.get('changes', {})))

    @router.patch('/{provider}/{purpose}/profiles/{profile_id}')
    async def edit_profile(request: Request, provider: str, purpose: str, profile_id: str):
        body = await profile_body(request)
        return profile_response(lambda: service(request).update_profile(provider, purpose, profile_id, body.get('name'), body.get('changes', {}), expected_version=body.get('expected_version')))

    @router.post('/{provider}/{purpose}/activate')
    async def activate_profile(request: Request, provider: str, purpose: str):
        body = await profile_body(request)
        return profile_response(lambda: service(request).activate_profile(provider, purpose, body.get('profile_id'), expected_version=body.get('expected_version'), profile_version=body.get('profile_version')))

    @router.post('/{provider}/{purpose}/reveal')
    async def reveal_secret(request: Request, provider: str, purpose: str):
        body = await profile_body(request)
        return profile_response(lambda: service(request).reveal(provider, purpose, body.get('profile_id'), body.get('field'), expected_version=body.get('expected_version')))

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

    @router.post("/{provider}/{purpose}/test")
    async def test_saved(request: Request, provider: str, purpose: str):
        require_research_session(request, True)
        from services.integration_connection import test_connection
        import asyncio
        try:
            if purpose != "research":
                raise ValueError("invalid purpose")
            body = await request.body()
            import json
            args = json.loads(body) if body else {}
            if not isinstance(args, dict) or len(body) > 16384:
                raise ValueError('invalid profile')
            if args.get('profile_id'):
                store = service(request)
                # Resolve a version-bound saved profile without changing the active account.
                selected = await asyncio.to_thread(store.profile, provider, purpose, args['profile_id'])
                if selected['version'] != args.get('expected_version'):
                    raise ValueError('stale profile')
                credentials = await asyncio.to_thread(store.profile_credentials, provider, purpose, args['profile_id'], expected_version=selected['version'])
            else:
                credentials = await asyncio.to_thread(service(request).resolve, provider, purpose)
            outcome = await asyncio.wait_for(test_connection(provider, credentials), timeout=18)
            return JSONResponse(outcome, headers={"Cache-Control": "no-store"})
        except ValueError:
            raise HTTPException(422, "请核对服务配置") from None
        except Exception:
            return JSONResponse({"success": False, "message": "连接测试未完成，请检查配置与网络后重试。"}, headers={"Cache-Control": "no-store"})

    return router


router = create_integration_settings_router()
