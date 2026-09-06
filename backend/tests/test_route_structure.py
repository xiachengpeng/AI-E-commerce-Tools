from fastapi.routing import APIRoute

from routes.generation import router as generation_router


def test_generation_endpoints_are_registered_from_route_module():
    routes = {
        route.path: route
        for route in generation_router.routes
        if isinstance(route, APIRoute)
    }

    expected = {
        "/api/translate-text",
        "/api/listing/generate",
        "/api/listing/extract",
        "/api/listing/compliance",
        "/api/ads/generate",
        "/api/watermark-removal",
        "/api/ai/generate",
        "/log",
    }
    assert expected <= routes.keys()
    assert all(
        routes[path].endpoint.__module__ == "routes.generation"
        for path in expected
    )
