"""Static assets are built locally and served through a bounded allowlist."""
import httpx
import pytest

from rabbit_hole.runtime.server import create_app


@pytest.mark.asyncio
async def test_compiled_frontend_is_served_without_exposing_source_files():
    app = create_app(checks={})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1") as client:
        page = await client.get("/")
        assert "/workbench/app.css" in page.text
        css = await client.get("/workbench/app.css")
        assert css.status_code == 200
        assert "text/css" in css.headers["content-type"]
        assert "--color-brand" in css.text
        script = await client.get("/workbench/workbench.js")
        assert script.status_code == 200
        assert "function focusCurrentWord" in script.text
        assert (await client.get("/workbench/build.mjs")).status_code == 404
        assert (await client.get("/workbench/package.json")).status_code == 404
