"""Bounded, resumable SSE delivery of already-persisted execution logs."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Protocol


class StreamRequest(Protocol):
    async def is_disconnected(self) -> bool: ...


async def stream_logs(
    request: StreamRequest,
    reader: Callable[[int], Awaitable[list[dict[str, Any]]]],
    *, after: int, pause: float = 1, duration: float = 60,
) -> AsyncIterator[str]:
    cursor = after
    deadline = time.monotonic() + duration
    yield "retry: 3000\n\n"
    while time.monotonic() < deadline and not await request.is_disconnected():
        try:
            async with asyncio.timeout(10):
                rows = await reader(cursor)
        except Exception:  # noqa: BLE001 -- streaming cannot expose database/provider errors
            yield 'event: unavailable\ndata: {"message":"日志连接中断，将改用查询恢复"}\n\n'
            return
        if rows:
            cursor = rows[-1]["id"]
            payload = json.dumps({"logs": rows, "cursor": cursor}, ensure_ascii=False)
            yield f"id: {cursor}\nevent: logs\ndata: {payload}\n\n"
        else:
            yield ": heartbeat\n\n"
        await asyncio.sleep(pause)
