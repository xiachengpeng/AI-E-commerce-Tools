"""Local-only research boundary shared with the existing research session."""

import secrets
from ipaddress import ip_address
from pathlib import PurePosixPath
from urllib.parse import unquote

from fastapi import HTTPException, Request

ORIGINS = frozenset(
    f"http://{host}:{port}"
    for host in ("127.0.0.1", "localhost")
    for port in (9502, 9503)
)


def require_research_session(
    request: Request, write: bool, *, bootstrap: bool = False
) -> None:
    from routes.research import _session_token

    try:
        local_peer = request.client is not None and ip_address(request.client.host).is_loopback
    except ValueError:
        local_peer = False
    if not local_peer:
        raise HTTPException(403, "研究入口只允许本机访问")
    if "http://" + request.headers.get("host", "") not in ORIGINS:
        raise HTTPException(403, "研究入口只允许本机访问")
    origin = request.headers.get("origin")
    if origin is not None and origin not in ORIGINS:
        raise HTTPException(403, "拒绝跨站研究请求")
    if request.headers.get("sec-fetch-site") == "cross-site" and origin not in ORIGINS:
        raise HTTPException(403, "拒绝跨站研究请求")
    if not bootstrap and not secrets.compare_digest(
        request.headers.get("x-research-token", "").encode(), _session_token.encode()
    ):
        raise HTTPException(401, "研究会话已过期，请刷新研究入口")


def validate_evidence_object_id(value: str) -> None:
    decoded = unquote(value)
    path = PurePosixPath(decoded)
    if (
        decoded != value
        or path.is_absolute()
        or "\\" in value
        or ".." in path.parts
        or not value.startswith("evidence/")
    ):
        raise HTTPException(404, "此动作暂无可查看截图")
