import asyncio
import time

from db import SessionLocal
from services.ai_adapters import get_adapter
from services.ai_config_service import get_snapshot
from services.app_log_service import app_logs


def map_provider_error(exc: Exception) -> str:
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return "AI 提供商请求超时"
    return "AI 提供商请求失败"


class AIRouter:
    def __init__(self, base_delay: float = 2):
        self.base_delay = base_delay

    async def generate(
        self,
        capability: str,
        payload: dict,
        db=None,
    ) -> dict:
        owns_db = db is None
        current_db = SessionLocal() if owns_db else db
        try:
            snapshot = get_snapshot(current_db, capability)
        finally:
            if owns_db:
                current_db.close()

        adapter = get_adapter(snapshot.protocol)
        started = time.monotonic()
        for attempt in range(snapshot.max_retries + 1):
            try:
                result = await adapter.generate(snapshot, payload)
                app_logs.emit(
                    level="success",
                    source="ai",
                    message="AI 请求完成",
                    capability=capability,
                    provider=snapshot.name,
                    model=snapshot.model,
                    duration_ms=round(
                        (time.monotonic() - started) * 1000
                    ),
                    retry=attempt,
                )
                return result
            except Exception as exc:
                if attempt >= snapshot.max_retries:
                    app_logs.emit(
                        level="error",
                        source="ai",
                        message=map_provider_error(exc),
                        capability=capability,
                        provider=snapshot.name,
                        model=snapshot.model,
                        retry=attempt,
                    )
                    raise
                app_logs.emit(
                    level="warning",
                    source="ai",
                    message="AI 请求重试",
                    capability=capability,
                    provider=snapshot.name,
                    model=snapshot.model,
                    retry=attempt + 1,
                )
                await asyncio.sleep(self.base_delay * (2**attempt))
