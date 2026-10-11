"""Read-only, allowlisted projections of durable worker state."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine

from rabbit_hole.monitoring import runtime_health
from rabbit_hole.persistence.database import job_checkpoints, runtime_jobs

STAGES = (
    ("identify_link", "识别输入"),
    ("meta", "Meta 广告"),
    ("landing", "商品页面"),
    ("trends", "趋势研究"),
    ("extract", "结构化提取"),
    ("evaluate", "业务评估"),
    ("writeback", "飞书写回"),
)
FAILURES = {
    "access_restricted": "来源访问受限，请查看来源是否限流或要求人工验证。",
    "delayed_retry": "采集暂未完成，系统将按队列时间重试。",
    "timeout": "来源响应超时。请留意重试结果。",
    "unexpected_pipeline_error": "历史任务发生运行异常，需要人工排查；不要把它当作业务淘汰。",
    "input_changed": "输入在运行期间发生变化，请核对飞书资料后重新触发。",
}


async def read_dashboard(
    engine: AsyncEngine, *, worker_max_age: int = 180
) -> dict[str, Any]:
    now = datetime.now(UTC)
    async with engine.connect() as connection:
        counts = {
            str(state): int(count)
            for state, count in (
                await connection.execute(
                    select(runtime_jobs.c.status, func.count()).group_by(
                        runtime_jobs.c.status
                    )
                )
            ).all()
        }
        jobs = (
            (
                await connection.execute(
                    select(runtime_jobs)
                    .order_by(runtime_jobs.c.created_at.desc())
                    .limit(100)
                )
            )
            .mappings()
            .all()
        )
        checkpoints = (
            (
                await connection.execute(
                    select(job_checkpoints).where(
                        job_checkpoints.c.job_id.in_([job["id"] for job in jobs])
                    )
                )
            )
            .mappings()
            .all()
            if jobs
            else []
        )
        stamp = (
            await connection.execute(
                select(runtime_health.c.updated_at).where(
                    runtime_health.c.component == "worker"
                )
            )
        ).scalar_one_or_none()
    grouped: dict[Any, dict[str, Any]] = defaultdict(dict)
    for checkpoint in checkpoints:
        grouped[checkpoint["job_id"]][checkpoint["stage"]] = checkpoint["data"]
    items = []
    for job in jobs:
        saved = grouped[job["id"]]
        inputs = job["payload"].get("data", {})
        title = next(
            (
                inputs.get(key)
                for key in (
                    "AUTO｜实际搜索词",
                    "人工｜产品名称",
                    "人工｜通用产品词",
                    "人工｜大类",
                )
                if isinstance(inputs.get(key), str) and inputs[key]
            ),
            "未命名任务",
        )
        result = saved.get("writeback", {}).get("result", {})
        stage_items = []
        for key, label in STAGES:
            data = saved.get(key, {})
            state = data.get("status", "unknown")
            if state not in {
                "complete",
                "failed",
                "skipped",
                "retryable",
                "needs_human",
            }:
                state = "unknown"
            stage_items.append({"key": key, "label": label, "state": state})
        # Only count a completed source response, not provisional scroll checkpoints.
        meta = saved.get("meta", {})
        ads = (
            len(meta.get("value", {}).get("ads", []))
            if meta.get("status") == "complete"
            else None
        )
        items.append(
            {
                "id": str(job["id"]),
                "title": title[:200],
                "kind": job["kind"],
                "status": job["status"],
                "attempt": job["attempt"],
                "updated_at": job["updated_at"].isoformat(),
                "created_at": job["created_at"].isoformat(),
                "retry_at": job["available_at"].isoformat()
                if job["status"] == "delayed"
                else None,
                "message": FAILURES.get(
                    job["failure_code"], "请核对任务证据与飞书待补充项。"
                )
                if job["failure_code"]
                else None,
                "result": str(result.get("status") or "")[:100],
                "ads": ads,
                "stages": stage_items,
                "record_id": str(job["payload"].get("record_id") or "")[:100],
            }
        )
    return {
        "updated_at": now.isoformat(),
        "counts": counts,
        "jobs": items,
        "worker": "online"
        if stamp is not None and 0 <= (now - stamp).total_seconds() <= worker_max_age
        else "offline",
        "worker_updated_at": stamp.isoformat() if stamp else None,
        "limit": 100,
    }
