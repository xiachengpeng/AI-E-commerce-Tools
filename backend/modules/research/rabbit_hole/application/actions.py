"""Bounded, durable collection actions for the business workbench.

These actions never touch Feishu human fields or buy ads. Claims use row locks
and attempt fences. Source failures wait for explicit retry rather than looping.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import (
    Column,
    Index,
    Integer,
    Table,
    Text,
    Uuid,
    and_,
    case,
    func,
    insert,
    or_,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncEngine

from rabbit_hole.domain.provenance import (
    SourcePassage,
    resolve_source_passage,
)
from rabbit_hole.domain.rules import effective_rules
from rabbit_hole.keyword_phrases import canonical_phrase
from rabbit_hole.persistence.database import json_type, metadata
from rabbit_hole.persistence.sql import UTCDateTime, transaction_lock, write_transaction

actions = Table(
    "workbench_actions",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("dedupe_key", Text, nullable=False, unique=True),
    Column("project_id", Uuid, nullable=False),
    Column("keyword_id", Text),
    Column("product_id", Text),
    Column("kind", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("input_version", Integer, nullable=False),
    Column("payload", json_type, nullable=False),
    Column("result", json_type),
    Column("error_code", Text),
    Column("created_at", UTCDateTime(), nullable=False),
    Column("updated_at", UTCDateTime(), nullable=False),
    Column("lease_until", UTCDateTime()),
    Column("attempt", Integer, nullable=False),
)
Index(
    "ix_workbench_actions_project_created_id",
    actions.c.project_id,
    actions.c.created_at.desc(),
    actions.c.id.desc(),
)
LABELS = {
    "scan": "Meta 精准搜索",
    "landing": "商品页面观察",
    "trends": "Google Trends",
    "keywords": "初始关键词建议",
    "expand": "兔子洞扩词建议",
    "verify": "批量自动核对商品",
}
SEED_POLICY = "rabbit-hole-broad-entry-v2"

ERRORS = {
    "invalid_ai_response": "AI返回没有可用的合法建议，未缓存无效内容。可以在预算允许时手动重试。",
    "budget": "本次执行预算已用完。请核对项目或接口用量上限，恢复后手动重试。",
    "access_restricted": "来源限流或要求验证。可在产品档案补充人工证据，恢复后再点击重试。",
    "timeout": "来源响应超时，已保留进度。请稍后手动重试。",
    "not_configured": "所选数据源或 AI 配置不完整，请到「数据源与配置」核对后重试。",
    "input_changed": "相关输入已变化，本次结果没有覆盖新输入。请重新执行。",
    "source_error": "来源读取未完成，未生成虚假结果。请查看原页面或补充人工证据。",
    "submission_uncertain": "提交结果尚未确认，请到 Apify 按任务标签核对，避免重复收费。",
    "schema_drift": "来源返回格式发生变化，请核对接口结果或补充人工证据。",
    "cancelled": "服务重启中，动作租约到期后恢复。",
    "stopped": "已由你停止；未完成的采集结果不会保存。",
    "source_contract_changed": "扩词来源契约已升级，旧缓存不会自动重放。请点击重试重新生成并核对来源。",
}


def validated_candidates(
    value: Any,
    *,
    source: str | None = None,
    sources: dict[str, SourcePassage] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """Validate before caching; source quotes remain exact, untrusted passages."""
    if not isinstance(value, list):
        return [], 1
    valid: list[dict[str, Any]] = []
    seen: set[str] = set()
    ignored = 0
    for item in value[:60]:
        if not isinstance(item, dict):
            ignored += 1
            continue
        raw, kind = item.get("text"), item.get("type")
        try:
            phrase = canonical_phrase(raw).content
        except (TypeError, ValueError):
            phrase = ""
        meaning = item.get("meaning", "")
        if (
            not phrase
            or len(phrase) > 500
            or not phrase.isascii()
            or not any(c.isalpha() for c in phrase)
            or any(ord(c) < 32 for c in phrase)
            or kind
            not in {"category", "function", "audience", "pain", "scenario", "brand", "pain_scenario", "scenario_audience"}
            or not isinstance(meaning, str)
            or len(meaning) > 1000
            or phrase.casefold() in seen
        ):
            ignored += 1
            continue
        candidate = {"text": phrase, "type": kind}
        if meaning:
            candidate["meaning"] = meaning.strip()
        if sources is not None:
            source_id, source_kind = item.get("source_id"), item.get("source_kind")
            passage = sources.get(source_id) if isinstance(source_id, str) else None
            quote = item.get("source_quote")
            if (
                passage is None
                or source_kind != passage.source_kind
                or not isinstance(quote, str)
                or not quote.strip()
                or len(quote) > 2_000
                or quote not in passage.text
            ):
                ignored += 1
                continue
            candidate.update(
                source_id=passage.source_id,
                source_kind=passage.source_kind,
                source_quote=quote,
            )
        elif source is not None:
            quote = item.get("source_quote")
            if (
                not isinstance(quote, str)
                or not quote.strip()
                or len(quote) > 2000
                or quote not in source
            ):
                ignored += 1
                continue
            candidate["source_quote"] = quote
        seen.add(phrase.casefold())
        valid.append(candidate)
    return valid, ignored + max(0, len(value) - 60)


def ai_usage(rows: Any, now: datetime, *, reservations: bool) -> int:
    day = now.date().isoformat()
    total = 0
    for row in rows:
        ledger = row["payload"].get("ai_usage")
        total += (
            int(ledger.get(day, 0))
            if isinstance(ledger, dict)
            else (int(row["attempt"]) if row["updated_at"].date() == now.date() else 0)
        )
        total += int(
            reservations
            and row["status"] == "ready"
            and row["payload"].get("candidates") is None
            and row["payload"].get("assessment_cache") is None
        )
    return total


def ad_projection(ad: Any) -> dict[str, Any]:
    from rabbit_hole.domain.ad_evidence import normalize_ad_observation
    from rabbit_hole.domain.ad_media import normalize_ad_media

    media = normalize_ad_media([{"kind": "video", "url": getattr(ad, "media_url", None)}])
    observation = normalize_ad_observation(
        {
            "started_at": ad.start_date,
            "ad_age_days": ad.observable_active_days,
            "currently_active": ad.is_active,
            "observed_at": getattr(ad, "observed_at", None),
            "continuity_status": "unknown",
        }
    )
    return {
        "id": ad.ad_id,
        "advertiser": ad.advertiser,
        "start_date": ad.start_date.isoformat() if ad.start_date else None,
        "landing_url": ad.landing_url,
        "primary_text": ad.primary_text[:10000],
        **({"media": media} if media else {}),
        "active": ad.is_active,
        **observation,
    }


def _scan_source_fingerprint(
    project: dict[str, Any], word: dict[str, Any]
) -> dict[str, Any] | None:
    if not word.get("parent_id"):
        return None
    passage = resolve_source_passage(
        project,
        str(word.get("product_id", "")),
        str(word.get("source_id", "")),
        str(word.get("source_kind", "")),
    )
    quote = word.get("source_quote")
    current = bool(
        passage is not None
        and isinstance(quote, str)
        and quote in passage.text
        and word.get("source_content_hash") == passage.content_hash
    )
    return {
        "source_id": word.get("source_id"),
        "source_kind": word.get("source_kind"),
        "source_content_hash": word.get("source_content_hash"),
        "source_quote": quote,
        "resolved_content_hash": passage.content_hash if current and passage else None,
        "current": current,
    }


def target_signature(
    project: dict[str, Any], kind: str, payload: dict[str, Any]
) -> str:
    rules = effective_rules(project)
    if kind == "scan":
        word = next(
            (w for w in project["keywords"] if w["id"] == payload.get("keyword_id")),
            None,
        )
        value = (
            {
                "text": word["text"],
                "approved": word["approved"],
                "source": _scan_source_fingerprint(project, word),
            }
            if word
            else None
        )
    elif kind == "verify":
        from rabbit_hole.domain.verification import batch_signature
        return batch_signature(project, payload.get("product_ids") or payload.get("payload", {}).get("product_ids", []))
    elif kind == "keywords":
        value = {
            "title": project["title"],
            "direction": project["direction"],
            "ai_daily_limit": rules["ai_daily_limit"],
        }
    else:
        p = next(
            (
                p
                for p in project["products"]
                if p["id"] == payload.get("product_id") and not p.get("merged_into")
            ),
            None,
        )
        value = (
            {
                "url": p.get("url"),
                "revision": p.get("revision"),
                "keyword_id": payload.get("keyword_id"),
                "query": payload.get("query")
                or payload.get("payload", {}).get("query"),
                "rules": {
                    key: rules[key]
                    for key in ("max_depth", "expansion_limit", "ai_daily_limit")
                }
                if kind == "expand"
                else None,
            }
            if p
            else None
        )
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def _recovery_action(row: Any) -> str:
    if row["status"] != "blocked":
        return ""
    if row["kind"] != "scan" or row["payload"].get("execution_mode", "ui") != "api":
        return "retry"
    cloud = row["payload"].get("apify_run") or {}
    if cloud and not cloud.get("id"):
        return "manual"
    if row["error_code"] == "stopped" or cloud.get("restart_required") or cloud.get("status") in {"FAILED", "ABORTED", "TIMED-OUT"}:
        return "restart"
    return "resume" if cloud.get("id") else "restart"


def _action_view(row: Any) -> dict[str, Any]:
    recovery = _recovery_action(row)
    cloud = row["payload"].get("apify_run") or {}
    display_status = row["status"]
    if row["status"] in {"ready", "running"} and cloud.get("id"):
        display_status = "cloud_running"
    elif row["status"] == "ready":
        display_status = "queued"
    elif row["status"] == "blocked":
        display_status = "manual_check" if recovery == "manual" else "stopped" if row["error_code"] == "stopped" else "retryable"
    return {
        "display_status": display_status,
        "recovery_action": recovery,
        "error_code": row["error_code"],
        "stage": row["payload"].get("last_stage"),
        "failure_stage": row["payload"].get("last_stage") if row["status"] == "blocked" else None,
        "keyword_text": row["payload"].get("keyword_text"),
        "attempt": row["attempt"],
        "execution_mode": row["payload"].get("execution_mode", "ui"),
        "landing_mode": row["payload"].get("landing_mode", "local") if row["kind"] == "landing" else None,
        "diagnostic": row["payload"].get("diagnostic"),
        "id": str(row["id"]),
        "kind": row["kind"],
        "label": LABELS.get(row["kind"], row["kind"]),
        "status": row["status"],
        "keyword_id": row["keyword_id"],
        "product_id": row["product_id"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
        "observed_at": (row["result"] or {}).get("observed_at")
        if isinstance(row["result"], dict)
        else None,
        "message": ERRORS.get(row["error_code"], "") if row["error_code"] else "",
        "result": row["result"] if row["status"] == "complete" else None,
    }


def _encode_action_cursor(created_at: datetime, action_id: UUID) -> str:
    raw = json.dumps(
        {"created_at": created_at.astimezone(UTC).isoformat(), "id": str(action_id)},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_action_cursor(value: str) -> tuple[datetime, UUID]:
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(payload, dict) or set(payload) != {"created_at", "id"}:
            raise ValueError
        if not isinstance(payload["created_at"], str) or not isinstance(
            payload["id"], str
        ):
            raise TypeError
        created_at = datetime.fromisoformat(payload["created_at"])
        action_id = UUID(payload["id"])
        if created_at.tzinfo is None:
            raise ValueError
        return created_at.astimezone(UTC), action_id
    except (ValueError, KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("invalid action cursor") from None


async def get_action(
    engine: AsyncEngine, project_id: str, action_id: str
) -> dict[str, Any] | None:
    try:
        project_uuid, action_uuid = UUID(project_id), UUID(action_id)
    except ValueError:
        return None
    async with engine.connect() as c:
        row = (
            (
                await c.execute(
                    select(actions).where(
                        actions.c.project_id == project_uuid,
                        actions.c.id == action_uuid,
                    )
                )
            )
            .mappings()
            .first()
        )
    return _action_view(row) if row else None


async def stop_action(
    store: Any, project_id: str, action_id: str, attempt: int
) -> dict[str, Any]:
    """Fence a queued/running action before letting its keyword be retried."""
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.integrations.provider_jobs import append_log

    if type(attempt) is not int or attempt < 0:
        raise WorkbenchError("invalid_attempt", "任务次数无效")
    try:
        action_uuid, project_uuid = UUID(action_id), UUID(project_id)
    except ValueError:
        raise WorkbenchError("not_found", "任务不存在", 404) from None
    async with write_transaction(store.engine) as c:
        await transaction_lock(c, "workbench-action:" + action_id)
        row = (
            await c.execute(
                select(actions)
                .where(actions.c.id == action_uuid, actions.c.project_id == project_uuid)
                .with_for_update()
            )
        ).mappings().first()
        if not row:
            raise WorkbenchError("not_found", "任务不存在", 404)
        if row["attempt"] != attempt:
            raise WorkbenchError("conflict", "任务已经进入新的一次执行，请刷新后重试", 409)
        if row["status"] not in {"ready", "running"}:
            raise WorkbenchError("conflict", "任务已结束，请刷新后核对结果", 409)
        terminal = {"scan": "collection_result", "landing": "landing_result", "trends": "trends_result", "verify": "verification_result"}.get(row["kind"])
        if terminal:
            from rabbit_hole.persistence.projects import workbench_events

            saved = await c.scalar(
                select(workbench_events.c.id).where(
                    workbench_events.c.project_id == project_id,
                    workbench_events.c.command_id == str(uuid5(NAMESPACE_URL, f"{action_id}:{terminal}:")),
                )
            )
            if saved:
                raise WorkbenchError("conflict", "结果已保存，不能停止；请刷新后核对", 409)
        now = datetime.now(UTC)
        payload = {**row["payload"], "diagnostic": ERRORS["stopped"]}
        await c.execute(
            update(actions).where(actions.c.id == action_uuid).values(
                status="blocked", error_code="stopped", lease_until=None,
                updated_at=now, payload=payload,
            )
        )
        keyword_id, kind = row["keyword_id"], row["kind"]
        cloud_run = (row["payload"].get("apify_run") or {}).get("id")
    await append_log(store.engine, project_id, action_id, attempt, "stopped", ERRORS["stopped"])
    if kind == "scan" and keyword_id:
        # A newer active scan owns the display if collection modes changed mid-run.
        async with store.engine.connect() as c:
            newer_active = await c.scalar(
                select(actions.c.id).where(
                    actions.c.project_id == project_uuid,
                    actions.c.keyword_id == keyword_id,
                    actions.c.kind == "scan",
                    actions.c.id != action_uuid,
                    actions.c.status.in_(["ready", "running"]),
                ).limit(1)
            )
        if not newer_active:
            for _ in range(4):
                project = await store.get(project_id)
                word = next((w for w in project["keywords"] if w["id"] == keyword_id), None)
                if not word or word["status"] not in {"queued", "running"}:
                    break
                try:
                    await store.command(
                        project_id, project["version"],
                        str(uuid5(NAMESPACE_URL, f"{action_id}:keyword_state:stopped:{attempt}")),
                        "keyword_state",
                        {"keyword_id": keyword_id, "status": "blocked", "message": ERRORS["stopped"]},
                        actor="automation",
                    )
                    break
                except WorkbenchError as exc:
                    if exc.status != 409:
                        raise
    if kind == "verify":
        for dependency_id in payload.get("owned_dependencies", []):
            dependent = await get_action(store.engine, project_id, dependency_id)
            if dependent and dependent["status"] in {"ready", "running"}:
                try:
                    await stop_action(store, project_id, dependency_id, dependent["attempt"])
                except WorkbenchError as exc:
                    if exc.status != 409:
                        raise
    if cloud_run:
        from rabbit_hole.integrations.provider_budget import abort_apify_run

        await abort_apify_run(store.engine, project_id, action_id, attempt, cloud_run)
    return (await get_action(store.engine, project_id, action_id)) or {}


async def scan_action_stats(
    engine: AsyncEngine, project_id: str
) -> dict[str, dict[str, int]]:
    """Count durable scan attempts and completed actions for one project."""
    async with engine.connect() as connection:
        rows = (
            await connection.execute(
                select(
                    actions.c.keyword_id,
                    func.sum(actions.c.attempt).label("attempts"),
                    func.sum(case((actions.c.status == "complete", 1), else_=0)).label("completed"),
                )
                .where(
                    actions.c.project_id == UUID(project_id),
                    actions.c.kind == "scan",
                    actions.c.keyword_id.is_not(None),
                    actions.c.attempt >= 1,
                )
                .group_by(actions.c.keyword_id)
            )
        ).all()
    return {
        keyword_id: {"attempts": int(attempts), "completed": int(completed)}
        for keyword_id, attempts, completed in rows
    }


async def list_actions(
    engine: AsyncEngine,
    project_id: str,
    limit: int = 20,
    cursor: str | None = None,
) -> dict[str, Any]:
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("action page limit must be an integer from 1 to 100")
    cursor_value = _decode_action_cursor(cursor) if cursor else None
    async with engine.connect() as c:
        conditions = [actions.c.project_id == UUID(project_id)]
        if cursor_value:
            cursor_time, cursor_id = cursor_value
            conditions.append(
                or_(
                    actions.c.created_at < cursor_time,
                    and_(
                        actions.c.created_at == cursor_time,
                        actions.c.id < cursor_id,
                    ),
                )
            )
        rows = (
            (
                await c.execute(
                    select(actions)
                    .where(*conditions)
                    .order_by(actions.c.created_at.desc(), actions.c.id.desc())
                    .limit(limit + 1)
                )
            )
            .mappings()
            .all()
        )
        # Current keyword controls are independent of the history cursor.
        # An active scan owns its controls even if another mode has newer history.
        keyword_rows = (
            await c.execute(
                select(actions)
                .where(actions.c.project_id == UUID(project_id), actions.c.kind == "scan", actions.c.keyword_id.is_not(None))
                .order_by(actions.c.keyword_id, actions.c.status.in_(["ready", "running"]).desc(), actions.c.created_at.desc(), actions.c.id.desc())
            )
        ).mappings().all()
        # Product-page controls must also survive history pagination.
        product_rows = (
            await c.execute(
                select(actions)
                .where(actions.c.project_id == UUID(project_id), actions.c.kind == "landing", actions.c.product_id.is_not(None))
                .order_by(actions.c.product_id, actions.c.status.in_(["ready", "running"]).desc(), actions.c.created_at.desc(), actions.c.id.desc())
            )
        ).mappings().all()
        verification_rows = (await c.execute(select(actions)
            .where(actions.c.project_id == UUID(project_id), actions.c.kind == "verify", actions.c.keyword_id.is_not(None))
            .order_by(actions.c.keyword_id, actions.c.status.in_(["ready", "running"]).desc(), actions.c.created_at.desc(), actions.c.id.desc())
        )).mappings().all()
        keyword_rows = list({r["keyword_id"]: r for r in reversed(keyword_rows)}.values())
        product_rows = list({r["product_id"]: r for r in reversed(product_rows)}.values())
        verification_rows = list({r["keyword_id"]: r for r in reversed(verification_rows)}.values())
        dependency_ids = [UUID(i) for r in verification_rows for i in r["payload"].get("dependencies", [])]
        dependency_rows = (await c.execute(select(actions.c.id, actions.c.status).where(
            actions.c.project_id == UUID(project_id), actions.c.id.in_(dependency_ids)
        ))).all() if dependency_ids else []
    verification_views = {}
    statuses = {str(r.id): r.status for r in dependency_rows}
    for row in verification_rows:
        view = _action_view(row)
        deps = row["payload"].get("dependencies", [])
        view["count"] = len(row["payload"].get("product_ids", []))
        view["progress"] = {"total": len(deps), "complete": sum(statuses.get(i) == "complete" for i in deps),
                            "failed": sum(statuses.get(i) == "blocked" for i in deps)}
        verification_views[row["keyword_id"]] = view
    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = (
        _encode_action_cursor(page[-1]["created_at"], page[-1]["id"])
        if has_more and page
        else None
    )
    return {"actions": [_action_view(row) for row in page], "next_cursor": next_cursor,
            "verification_actions": verification_views,
            "keyword_actions": {row["keyword_id"]: _action_view(row) for row in keyword_rows},
            "product_actions": {row["product_id"]: _action_view(row) for row in product_rows}}


async def enqueue_action(
    store: Any, project_id: str, data: dict[str, Any], *, _verify_guarded: bool = False
) -> dict[str, Any]:
    from rabbit_hole.domain.project import WorkbenchError

    if data.get("kind") == "verify" and not _verify_guarded:
        from rabbit_hole.persistence.sql import session_lock
        async with session_lock(store.engine, "verify-enqueue:" + project_id, wait=True):
            return await enqueue_action(store, project_id, data, _verify_guarded=True)

    project = await store.get(project_id)
    if data.get("version") != project["version"]:
        raise WorkbenchError("conflict", "项目已更新，请刷新后重试", 409)
    kind = data.get("kind")
    if kind == "scan_all":
        batch_limit = int(effective_rules(project)["scan_batch_limit"])
        ids = [
            w["id"]
            for w in project["keywords"]
            if w["approved"] and w["status"] in {"ready", "blocked"}
        ][:batch_limit]
        results = []
        failures = []
        for word_id in ids:
            try:
                latest = await store.get(project_id)
                results.append(
                    await enqueue_action(
                        store,
                        project_id,
                        {
                            "kind": "scan",
                            "version": latest["version"],
                            "keyword_id": word_id,
                        },
                    )
                )
            except Exception as exc:  # noqa: BLE001 -- preserve partial success, never expose raw exceptions
                word = next(w for w in project["keywords"] if w["id"] == word_id)
                failures.append(
                    {
                        "keyword_id": word_id,
                        "text": word["text"],
                        "code": exc.code
                        if isinstance(exc, WorkbenchError)
                        else "source_error",
                        "message": exc.message
                        if isinstance(exc, WorkbenchError)
                        else "此词入队未完成，请刷新核对后重试。",
                    }
                )
        return {
            "requested": len(ids),
            "queued": sum(r["disposition"] != "unchanged" for r in results),
            "unchanged": sum(r["disposition"] == "unchanged" for r in results),
            "failed": failures,
        }
    if kind not in LABELS:
        raise WorkbenchError("invalid_action", "不支持的自动动作")
    word = next(
        (w for w in project["keywords"] if w["id"] == data.get("keyword_id")), None
    )
    product = next(
        (
            p
            for p in project["products"]
            if p["id"] == data.get("product_id") and not p.get("merged_into")
        ),
        None,
    )
    if kind == "scan" and (not word or not word["approved"]):
        raise WorkbenchError("approval_required", "请先审核关键词")
    if kind == "scan" and word and word.get("parent_id"):
        source = _scan_source_fingerprint(project, word)
        if not source or not source["current"]:
            raise WorkbenchError(
                "invalid_expansion_source", "扩展词来源已变化，请重新选择并审核"
            )
    if kind in {"landing", "trends", "expand"} and not product:
        raise WorkbenchError("missing_product", "请选择具体产品")
    if kind == "landing" and not (product or {}).get("url"):
        raise WorkbenchError("missing_url", "请先指定具体商品链接")
    if kind == "trends" and (
        not isinstance(data.get("query"), str)
        or not 1 <= len(data["query"].strip()) <= 200
    ):
        raise WorkbenchError("missing_query", "请输入要验证的当地常用产品搜索词")
    if kind == "expand" and (
        not word
        or not (product or {}).get("identification", {}).get("relevance_confirmed")
    ):
        raise WorkbenchError("missing_evidence", "先确认产品相关性与来源关键词，再扩词")
    if kind == "expand" and (
        (word or {}).get("depth", 0) >= effective_rules(project)["max_depth"]
        or data.get("keyword_id") not in (product or {}).get("source_keyword_ids", [])
    ):
        raise WorkbenchError("depth_limit", "该来源不属于产品或已达到扩词深度上限")
    landing_mode = data.get("landing_mode", "local") if kind == "landing" else None
    if kind == "landing" and landing_mode not in {"local", "firecrawl"}:
        raise WorkbenchError("invalid_payload", "请选择本地读取或 Firecrawl")
    prepared: dict[str, Any] = {}
    if kind == "verify":
        from rabbit_hole.application.verification_jobs import prepare_batch
        prepared = await prepare_batch(store, project, data)
        if "outcome" in prepared:
            outcome: dict[str, Any] = prepared["outcome"]
            return outcome
        data = {**data, **prepared}
    fingerprint = target_signature(project, kind, data)
    mode = project.get("collection_modes", {}).get("meta" if kind == "scan" else "trends", "ui") if kind in {"scan", "trends"} else "ui"
    if kind == "verify":
        mode = "ai"
    if kind == "landing":
        mode = "api" if landing_mode == "firecrawl" else "ui"
    rules = effective_rules(project)
    dedupe = f"{project_id}:{kind}:{data.get('keyword_id', '')}:{data.get('product_id', '')}:{fingerprint}"
    if kind == "landing" and landing_mode == "firecrawl":
        dedupe += ":firecrawl"
    if kind == "keywords":
        # New manual requests use the revised entry policy. Existing actions and
        # partially saved candidate caches keep their original IDs and history.
        dedupe += f":{SEED_POLICY}"
    if kind in {"scan", "trends"} and project.get("collection_modes_version", 0):
        dedupe += f":{mode}:{project['collection_modes_version']}"
    now = datetime.now(UTC)
    # Serialize enqueue checks across consumers for the same project.
    async with write_transaction(store.engine) as c:

        await transaction_lock(c, project_id)
        from rabbit_hole.persistence.projects import workbench_projects
        if not await c.scalar(select(workbench_projects.c.id).where(workbench_projects.c.id == project_id)):
            raise WorkbenchError('not_found', '研究项目不存在', 404)
        if kind == "landing":
            active = (await c.execute(select(actions).where(
                actions.c.project_id == UUID(project_id),
                actions.c.product_id == data["product_id"],
                actions.c.kind == "landing",
                actions.c.status.in_(["ready", "running"]),
            ).with_for_update())).mappings().first()
            if active and active["payload"].get("landing_mode", "local") != landing_mode:
                raise WorkbenchError("already_running", "当前商品正在读取，请先停止，再切换读取方式")
        existing = (
            (
                await c.execute(
                    select(actions)
                    .where(actions.c.dedupe_key == dedupe)
                    .with_for_update()
                )
            )
            .mappings()
            .first()
        )
        if existing is None and kind == "keywords":
            # An in-flight old-policy request still owns its reservation.
            existing = (
                (
                    await c.execute(
                        select(actions)
                        .where(
                            actions.c.dedupe_key == dedupe.removesuffix(f":{SEED_POLICY}"),
                            actions.c.status.in_(["ready", "running"]),
                        )
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
        explicit_verification_retry = bool(kind == "verify" and data.get("retry_review") is True
                                           and existing and existing["status"] == "complete")
        if existing and existing["status"] != "blocked" and not explicit_verification_retry:
            return {
                "id": str(existing["id"]),
                "status": existing["status"],
                "disposition": "unchanged",
            }
        recovery = _recovery_action(existing) if existing else ""
        if recovery == "manual":
            raise WorkbenchError("submission_uncertain", ERRORS["submission_uncertain"])
        fresh_retry_of = str(existing["id"]) if existing and (recovery == "restart" or explicit_verification_retry) else None
        if kind in {"keywords", "expand", "verify"} and not (
            existing and (existing["payload"].get("candidates") is not None or existing["payload"].get("assessment_cache") is not None)
        ):
            usage_rows = (
                await c.execute(
                    select(actions).where(
                        actions.c.project_id == UUID(project_id),
                        actions.c.kind.in_(["keywords", "expand", "verify"]),
                    )
                )
            ).mappings()
            count = ai_usage(usage_rows, now, reservations=True)
            if count >= rules["ai_daily_limit"]:
                raise WorkbenchError(
                    "budget",
                    f"本项目今天的AI建议次数上限{rules['ai_daily_limit']:g}次已用完，可以手动补词",
                )
        if kind == "scan":
            start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
            count = (
                await c.execute(
                    select(func.count())
                    .select_from(actions)
                    .where(
                        actions.c.project_id == UUID(project_id),
                        actions.c.kind == "scan",
                        actions.c.created_at >= start_of_day,
                    )
                )
            ).scalar_one()
            if count >= rules["daily_scan_budget"] and (not existing or fresh_retry_of):
                raise WorkbenchError(
                    "budget", "本项目今日扫描预算已用完，明天可继续处理"
                )
        if fresh_retry_of:
            assert existing is not None
            # Keep the old action, cloud ID and charge reservation immutable.
            # Moving only its dedupe key leaves the current slot idempotent.
            await c.execute(update(actions).where(actions.c.id == existing["id"]).values(
                dedupe_key=f"{dedupe}:history:{fresh_retry_of}"
            ))
            existing = None
        if existing:
            action_id = existing["id"]
            payload = dict(existing["payload"])
            payload.pop("diagnostic", None)
            if kind == "landing":
                payload.pop("firecrawl_submitted", None)
            if kind == "verify":
                payload.update(prepared)
                if data.get("retry_review") is True:
                    payload.pop("assessment_cache", None)
            if existing.get("error_code") == "source_contract_changed":
                payload.pop("candidates", None)
                payload.pop("candidate_cache_version", None)
                payload.pop("ignored_candidates", None)
            if kind in {"keywords", "expand", "verify"}:
                payload.setdefault(
                    "ai_usage",
                    {existing["updated_at"].date().isoformat(): existing["attempt"]},
                )
            await c.execute(
                update(actions)
                .where(actions.c.id == action_id)
                .values(
                    status="ready",
                    error_code=None,
                    updated_at=now,
                    lease_until=None,
                    payload=payload,
                )
            )
        else:
            action_id = uuid4()
            await c.execute(
                insert(actions).values(
                    id=action_id,
                    dedupe_key=dedupe,
                    project_id=UUID(project_id),
                    keyword_id=data.get("keyword_id"),
                    product_id=data.get("product_id"),
                    kind=kind,
                    status="ready",
                    input_version=project["version"],
                    payload={"fingerprint": fingerprint, "query": data.get("query"), "execution_mode": mode,
                             "keyword_text": (word or {}).get("text"),
                             **({"landing_mode": landing_mode} if kind == "landing" else {}),
                             **({"retry_of": fresh_retry_of} if fresh_retry_of else {}),
                             **prepared},
                    created_at=now,
                    updated_at=now,
                    attempt=0,
                )
            )
    if kind == "scan":
        latest = await store.get(project_id)
        try:
            await store.command(
                project_id,
                latest["version"],
                str(uuid5(NAMESPACE_URL, f"{action_id}:queued:{latest['version']}")),
                "keyword_state",
                {"keyword_id": (word or {})["id"], "status": "queued"},
                actor="automation",
            )
        except Exception:  # noqa: BLE001 -- queue remains durable; runner rechecks inputs
            logging.getLogger(__name__).warning(
                "Business action queued; keyword display update deferred"
            )
    return {
        "id": str(action_id),
        "status": "ready",
        **({"count": len(prepared.get("product_ids", []))} if kind == "verify" else {}),
        "disposition": "restarted" if fresh_retry_of else "retried" if existing else "queued",
    }


class SourceFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code if code in ERRORS else "source_error"
        super().__init__(self.code)
