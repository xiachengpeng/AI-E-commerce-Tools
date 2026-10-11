"""Durable incremental logs, safe diagnostics and fenced action checkpoints."""
from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Column,
    Identity,
    Index,
    Integer,
    Table,
    Text,
    Uuid,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncEngine

from rabbit_hole.persistence.database import metadata
from rabbit_hole.persistence.sql import UTCDateTime, write_transaction

provider_logs = Table("workbench_provider_logs", metadata,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), Identity(), primary_key=True),
    Column("project_id", Uuid, nullable=False),
    Column("action_id", Uuid, nullable=False),
    Column("attempt", Integer, nullable=False),
    Column("stage", Text, nullable=False),
    Column("message", Text, nullable=False),
    Column("level", Text, nullable=False),
    Column("created_at", UTCDateTime(), nullable=False, default=lambda: datetime.now(UTC)),
    Index("ix_provider_logs_project", "project_id", "id"),
)


class ProviderPending(Exception):
    pass


def diagnostic(exc: Exception) -> str:
    """Classify observable errors without exporting raw exception strings/URLs."""
    import httpx

    from rabbit_hole.application.actions import ERRORS, SourceFailure
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.integrations.collectors.meta import MetaPageHealthError
    from rabbit_hole.integrations.collectors.provider_api import ProviderError

    if isinstance(exc, WorkbenchError):
        if exc.code == "limit_reached" and exc.message == "Evidence nesting is too deep":
            return "保存证据失败：数据嵌套层级超过上限。"
        return {
            "limit_reached": "保存证据失败：数据量超过上限。",
            "text_too_long": "保存证据失败：文本长度超过上限。",
            "invalid_payload": "保存结果失败：数据格式未通过校验。",
            "future_evidence": "保存结果失败：观察时间晚于当前时间。",
            "input_changed": "商品资料已变化，请刷新后重新读取。",
        }.get(exc.code, "业务校验未通过，请核对输入与已保存证据。")
    if isinstance(exc, ProviderError):
        return exc.message
    if isinstance(exc, SourceFailure):
        return ERRORS[exc.code]
    if isinstance(exc, MetaPageHealthError):
        return {
            "captcha": "Meta 页面出现验证码，等待人工处理",
            "access_restricted": "Meta 页面要求登录或限制访问",
            "displayed_filters_mismatch": "Meta 页面筛选条件与请求不一致，未采信结果",
            "missing_results": "Meta 页面没有广告卡片，也没有明确空结果提示",
            "unrecognized_ad_cards": "Meta 广告卡片结构变化，未能解析",
            "empty_query": "搜索词为空，未打开页面",
        }.get(str(exc), "Meta 页面状态未通过核验：原因未确定")
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}：接口请求未成功，请检查权限、额度或来源状态"
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)) or "Timeout" in type(exc).__name__:
        return "等待响应或页面元素超时"
    if isinstance(exc, httpx.ConnectError):
        return "连接失败：请检查网络、DNS或TLS连接"
    raw = str(exc).lower()
    for needle, label in [("err_name_not_resolved", "DNS域名解析失败"), ("err_connection", "页面网络连接失败"), ("executable doesn't exist", "浏览器程序未安装"), ("target closed", "浏览器或页面已关闭"), ("captcha", "页面出现验证限制"), ("filter", "筛选条件核对失败"), ("selector", "页面元素定位失败")]:
        if needle in raw:
            return label
    code = getattr(exc, "code", "")
    if code == "access_restricted":
        return "来源限制访问或要求验证"
    return f"{type(exc).__name__}：原因未确定，见最后完成阶段"


def landing_diagnostic(error: Any) -> str:
    """Export stable collector reasons without raw exceptions or evidence URLs."""
    import re

    code = getattr(error, "code", "")
    if code == "http_status":
        match = re.fullmatch(r"landing page returned HTTP ([1-5][0-9]{2})", getattr(error, "detail", ""))
        return f"商品页返回 HTTP {match[1]}，读取未成功。" if match else "商品页 HTTP 响应未成功。"
    return {
        "timeout": "商品页读取超时。",
        "unsafe_url": "商品页地址或跳转地址未通过访问校验。",
        "redirect_limit": "商品页跳转次数超过上限。",
        "body_too_large": "商品页响应内容超过大小上限。",
        "parse_error": "商品页编码或数据格式无法解析。",
        "network_error": "商品页网络连接失败，需核对网络、DNS或TLS连接。",
    }.get(code, "商品页读取失败，具体原因未确定。")


async def append_log(engine: AsyncEngine, project_id: str, action_id: str, attempt: int, stage: str, message: str, level: str = "info") -> None:
    # Call sites provide controlled messages, never provider response bodies or credentials.
    message = re.sub(r"https?://\S+", "[链接已省略]", message)
    async with write_transaction(engine) as c:
        await c.execute(provider_logs.insert().values(project_id=UUID(project_id), action_id=UUID(action_id), attempt=attempt, stage=stage[:80], message=message[:1000], level=level))


async def read_logs(engine: AsyncEngine, project_id: str, after: int) -> list[dict[str, Any]]:
    from rabbit_hole.application.actions import actions
    async with engine.connect() as c:
        rows = (await c.execute(select(provider_logs, actions.c.keyword_id, actions.c.kind,
            actions.c.payload["keyword_text"].as_string().label("keyword_text"),
            actions.c.payload["execution_mode"].as_string().label("execution_mode"))
            .select_from(provider_logs.outerjoin(actions, (actions.c.id == provider_logs.c.action_id) & (actions.c.project_id == provider_logs.c.project_id)))
            .where(provider_logs.c.project_id == UUID(project_id), provider_logs.c.id > after).order_by(provider_logs.c.id).limit(100))).mappings()
        return [{**dict(r), "execution_mode":r["execution_mode"] or "ui", "project_id":str(r["project_id"]), "action_id":str(r["action_id"]), "created_at":r["created_at"].isoformat()} for r in rows]


async def checkpoint(runner: Any, action: dict[str, Any], **changes: Any) -> None:
    from rabbit_hole.application.actions import actions

    async with write_transaction(runner.store.engine) as c:
        row = (await c.execute(select(actions).where(actions.c.id == action["id"]).with_for_update())).mappings().one()
        if row["attempt"] != action["attempt"] or row["status"] != "running":
            raise RuntimeError("Action lease changed")
        payload = {**row["payload"], **changes}
        await c.execute(update(actions).where(actions.c.id == action["id"]).values(payload=payload, updated_at=datetime.now(UTC)))
        action["payload"] = payload
