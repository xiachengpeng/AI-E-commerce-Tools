"""Production composition and durable external-service boundaries.

Feishu has no compare-and-swap API. PostgreSQL serializes our writers, while
fresh reads and post-write verification detect user edits. A remote write may
still race a human edit; uncertain outcomes are reconciled or surfaced for a
human, never silently retried as a new create.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, cast
from urllib.parse import urlencode, urlsplit
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import httpx
from playwright.async_api import TimeoutError as BrowserTimeout
from playwright.async_api import async_playwright
from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from rabbit_hole.config import Settings
from rabbit_hole.domain.legacy import Job
from rabbit_hole.extraction import (
    ExtractionGenerationError,
    ExtractionInput,
    PostgresExtractionCache,
    ProductExtraction,
    extract_product,
)
from rabbit_hole.integrations.collectors.base import CollectorResult
from rabbit_hole.integrations.collectors.google import (
    GoogleTrendsCollector,
    TrendsPageError,
)
from rabbit_hole.integrations.collectors.landing import LandingCollector
from rabbit_hole.integrations.collectors.meta import (
    MetaCollector,
    MetaQuery,
    PlaywrightMetaPageFactory,
    SearchBatchResult,
)
from rabbit_hole.integrations.feishu import (
    FIELD_MAPPERS,
    BaseSchema,
    FeishuAPIError,
    FeishuClient,
    RecordVersion,
    TriggerPoller,
    WriteConflict,
    protected_input_hash,
)
from rabbit_hole.monitoring import Monitor, Telemetry
from rabbit_hole.persistence.database import feishu_outbox
from rabbit_hole.persistence.evidence_store import EvidenceStore
from rabbit_hole.persistence.legacy_jobs import JobRepository
from rabbit_hole.persistence.sql import (
    dialect_insert,
    session_lock,
    write_transaction,
)
from rabbit_hole.persistence.storage_factory import create_storage_client
from rabbit_hole.pipeline import (
    FeishuMutation,
    Pipeline,
    PipelineResult,
    RetryablePipelineError,
)
from rabbit_hole.security import SafeUrlClient, google_public_dns
from rabbit_hole.trends import TrendPoint, TrendSeries
from rabbit_hole.worker import Worker

Database = AsyncEngine | AsyncConnection


@asynccontextmanager
async def _transaction(database: Database) -> AsyncIterator[AsyncConnection]:
    if isinstance(database, AsyncConnection):
        if database.in_transaction():
            yield database
        else:
            async with database.begin():
                yield database
        return
    async with write_transaction(database) as connection:
        yield connection


class FeishuWorkflowAdapter:
    """Schema-bound, serialized writes with a durable intent/result journal.

    Production uses an engine: the table-lock transaction and the journal
    transactions use separate connections, so intent commits before HTTP. A
    supplied connection participates in its caller's transaction (test/staging
    injection); its caller owns persistence and must not share it concurrently.
    """

    def __init__(
        self,
        client: FeishuClient,
        database: Database,
        *,
        verify_delays: Sequence[float] = (0.2, 0.5, 1, 2),
    ) -> None:
        self.client, self.database = client, database
        self.verify_delays = tuple(verify_delays)
        self._observed: OrderedDict[tuple[str, str, str], str] = OrderedDict()

    async def get_record(self, table: str, record_id: str) -> RecordVersion:
        record = await self.client.get_record(table, record_id)
        key = (table, record_id, record.version)
        self._observed[key] = protected_input_hash(record.fields)
        self._observed.move_to_end(key)
        while len(self._observed) > 512:
            self._observed.popitem(last=False)
        return record

    async def apply(self, mutation: FeishuMutation) -> str:
        checked = FeishuMutation.model_validate(mutation.model_dump())
        lock_id = int.from_bytes(
            hashlib.sha256(
                f"{self.client.base_token}:{checked.table}".encode()
            ).digest()[:8],
            "big",
            signed=True,
        )
        try:
            # This connection only owns the table lock. Journal transactions
            # below commit independently before making any external mutation.
            async with session_lock(self.database, lock_id, wait=True):
                return await self._apply_locked(checked)
        except (httpx.HTTPError, FeishuAPIError) as exc:
            raise RetryablePipelineError(
                "feishu_writeback_pending",
                "Feishu write outcome requires reconciliation",
            ) from exc

    async def _apply_locked(self, mutation: FeishuMutation) -> str:
        event_id = uuid5(
            NAMESPACE_URL,
            f"rabbit-hole:{self.client.base_token}:{mutation.operation_key}",
        )
        request = mutation.model_dump(mode="json")
        digest = hashlib.sha256(
            json.dumps(request, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        async with _transaction(self.database) as connection:
            row = (
                (
                    await connection.execute(
                        select(feishu_outbox).where(feishu_outbox.c.id == event_id)
                    )
                )
                .mappings()
                .first()
            )
        if row is not None:
            intent = row["payload"]
            if intent.get("digest") != digest:
                raise WriteConflict(
                    "operation key already belongs to a different mutation"
                )
            if row["status"] == "succeeded":
                return str(row["record_id"])
            return await self._reconcile(event_id, mutation, intent)

        record: RecordVersion | None = None
        if mutation.action == "create":
            record = await self._find_unique(mutation)
            if record is not None:
                # Create means create-if-absent, never overwrite a reviewed row.
                await self._save_intent(
                    event_id, mutation, digest, record, status="succeeded"
                )
                return record.record_id
        else:
            record = (
                await self.client.get_record(mutation.table, mutation.record_id)
                if mutation.record_id
                else await self._find_unique(mutation)
            )
            if record is None:
                raise WriteConflict("upsert target no longer exists")
            self._guard(mutation, record)

        await self._save_intent(event_id, mutation, digest, record)
        if record is not None:
            immediate = await self.client.get_record(mutation.table, record.record_id)
            self._guard(mutation, immediate)
            if immediate.version != record.version or protected_input_hash(
                immediate.fields
            ) != protected_input_hash(record.fields):
                await self._finish(event_id, record.record_id, "needs_human")
                raise WriteConflict("protected inputs changed immediately before write")
        record_id = await self.client.write_workflow_record(
            mutation, record_id=record.record_id if record is not None else None
        )
        # Save an ID-only create response before polling eventual consistency.
        await self._finish(event_id, record_id, "ready")
        intent = {
            "protected_hash": self._protected_without_state(
                mutation.table, record.fields
            )
            if record
            else None
        }
        await self._verify(event_id, mutation, record_id, intent)
        return record_id

    def _guard(self, mutation: FeishuMutation, record: RecordVersion) -> None:
        state = record.fields.get(FIELD_MAPPERS[mutation.table]["status"])
        expected_hash = self._observed.get(
            (mutation.table, record.record_id, mutation.expected_version or "")
        )
        if (
            not mutation.expected_version
            or record.version != mutation.expected_version
            or state != mutation.current_state
            or (
                expected_hash is not None
                and protected_input_hash(record.fields) != expected_hash
            )
        ):
            raise WriteConflict("record state, version or protected inputs changed")

    @staticmethod
    def _protected_without_state(table: str, fields: Mapping[str, Any]) -> str:
        return protected_input_hash(
            {
                key: value
                for key, value in fields.items()
                if key != FIELD_MAPPERS[table]["status"]
            }
        )

    async def _find_unique(self, mutation: FeishuMutation) -> RecordVersion | None:
        schema = next(
            item for item in BaseSchema.default().tables if item.name == mutation.table
        )
        field = schema.field_map[schema.logical_key].display_name
        matches = [
            self.client.record_version(row)
            for row in await self.client.list_records(mutation.table)
            if row.get("fields", {}).get(field) == mutation.unique_key
        ]
        if len(matches) > 1:
            raise WriteConflict("multiple remote records have the same logical key")
        return matches[0] if matches else None

    async def _save_intent(
        self,
        event_id: UUID,
        mutation: FeishuMutation,
        digest: str,
        record: RecordVersion | None,
        *,
        status: str = "ready",
    ) -> None:
        now = datetime.now(UTC)
        async with _transaction(self.database) as connection:
            await connection.execute(
                dialect_insert(connection, feishu_outbox).values(
                    id=event_id,
                    record_id=record.record_id if record else "pending-create",
                    record_version=mutation.expected_version or "create",
                    payload={
                        "digest": digest,
                        "mutation": mutation.model_dump(mode="json"),
                        "protected_hash": self._protected_without_state(
                            mutation.table, record.fields
                        )
                        if record
                        else None,
                    },
                    status=status,
                    attempt=1,
                    available_at=now,
                    created_at=now,
                    updated_at=now,
                )
            )

    async def _finish(self, event_id: UUID, record_id: str, status: str) -> None:
        async with _transaction(self.database) as connection:
            result = await connection.execute(
                update(feishu_outbox)
                .where(feishu_outbox.c.id == event_id)
                .values(
                    record_id=record_id, status=status, updated_at=datetime.now(UTC)
                )
                .returning(feishu_outbox.c.payload)
            )
            mutation = result.scalar_one()["mutation"]
            if (
                status == "succeeded"
                and mutation["action"] == "create"
                and mutation["table"] == "产品主表"
            ):
                # Commit the metric with the verified outbox acknowledgement.
                # Reconciliation/replay shares the remote candidate identity;
                # create-if-absent hits never reach this acknowledgement path.
                await Telemetry(connection).record(
                    f"candidate:{self.client.base_token}:{record_id}",
                    source="candidate",
                    success=True,
                )

    async def _reconcile(
        self, event_id: UUID, mutation: FeishuMutation, intent: Mapping[str, Any]
    ) -> str:
        record = (
            await self.client.get_record(mutation.table, mutation.record_id)
            if mutation.record_id
            else await self._find_unique(mutation)
        )
        if record is None:
            await self._finish(event_id, "pending-create", "needs_human")
            raise WriteConflict(
                "remote create outcome is unknown; manual reconciliation required"
            )
        await self._verify(event_id, mutation, record.record_id, intent)
        return record.record_id

    async def _verify(
        self,
        event_id: UUID,
        mutation: FeishuMutation,
        record_id: str,
        intent: Mapping[str, Any],
    ) -> None:
        schema = next(
            item for item in BaseSchema.default().tables if item.name == mutation.table
        )
        expected = dict(mutation.fields)
        expected[schema.field_map["status"].display_name] = mutation.state
        if mutation.unique_key:
            expected[schema.field_map[schema.logical_key].display_name] = (
                mutation.unique_key
            )
        for index, delay in enumerate((0, *self.verify_delays)):
            if delay:
                await asyncio.sleep(delay)
            current = await self.client.get_record(mutation.table, record_id)
            protected = intent.get("protected_hash")
            if protected is not None and protected != self._protected_without_state(
                mutation.table, current.fields
            ):
                break
            definitions = {
                field.display_name: field.style_type
                if field.style_type == "url"
                else field.type
                for field in schema.fields
            }
            if all(
                self._cell_matches(definitions.get(key), value, current.fields.get(key))
                for key, value in expected.items()
            ):
                if mutation.action == "create":
                    try:
                        unique = await self._find_unique(mutation)
                    except WriteConflict:
                        await self._finish(event_id, record_id, "needs_human")
                        raise
                    if unique is None:
                        # Base can expose a just-created record through
                        # batch_get before its list index catches up.
                        continue
                    if unique.record_id != record_id:
                        await self._finish(event_id, record_id, "needs_human")
                        raise WriteConflict(
                            "logical key belongs to another remote record"
                        )
                await self._finish(event_id, record_id, "succeeded")
                return
            if index == len(self.verify_delays):
                break
        await self._finish(event_id, record_id, "needs_human")
        raise WriteConflict(
            "remote state could not be verified; manual reconciliation required"
        )

    @staticmethod
    def _cell_matches(field_type: str | None, expected: Any, actual: Any) -> bool:
        if field_type in {"text", "url"} and expected == "" and actual is None:
            return True
        if (
            field_type == "url"
            and isinstance(expected, str)
            and actual == f"[{expected}]({expected})"
        ):
            return True
        if (
            field_type == "datetime"
            and isinstance(expected, str)
            and isinstance(actual, str)
        ):
            try:
                expected_at = datetime.fromisoformat(expected)
                actual_at = datetime.fromisoformat(actual)
            except ValueError:
                return bool(actual == expected)
            if len(expected) == 10:
                # A date-only write is interpreted in the Base's timezone.
                # Accept only that same local date at precisely midnight.
                return bool(
                    actual_at.date() == expected_at.date()
                    and actual_at.hour
                    == actual_at.minute
                    == actual_at.second
                    == actual_at.microsecond
                    == 0
                )
            if (
                expected_at.tzinfo is None
                or expected_at.utcoffset() is None
                or actual_at.tzinfo is None
                or actual_at.utcoffset() is None
            ):
                return bool(actual == expected)
            return bool(
                int(expected_at.timestamp() * 1000) == int(actual_at.timestamp() * 1000)
            )
        return bool(actual == expected)

    async def reconcile_pending(self) -> None:
        async with _transaction(self.database) as connection:
            rows = (
                (
                    await connection.execute(
                        select(feishu_outbox.c.payload)
                        .where(feishu_outbox.c.status == "ready")
                        .order_by(feishu_outbox.c.created_at)
                        .limit(20)
                    )
                )
                .scalars()
                .all()
            )
        for value in rows:
            if not isinstance(value, dict) or not isinstance(
                value.get("mutation"), dict
            ):
                continue
            try:
                await self.apply(FeishuMutation.model_validate(value["mutation"]))
            except (WriteConflict, RetryablePipelineError):
                continue

    async def emit_alert(
        self,
        key: str,
        code: str,
        message: str,
        created_at: datetime,
        last_seen: datetime,
        occurrence_count: int,
    ) -> None:
        """Persist one idempotent Base row for each durable incident.

        The monitor gives us absolute incident values rather than an increment.
        That makes a replay of an already delivered count harmless, while a new
        count has a new durable outbox operation key.  Base does not offer a
        compare-and-swap primitive, so the normal workflow read/version guard
        and post-write verification are deliberately retained for updates.
        """
        if not key.strip() or not code.strip() or occurrence_count < 1:
            raise ValueError("alert key, code and occurrence count are required")
        if created_at.tzinfo is None or created_at.utcoffset() is None:
            raise ValueError("alert created_at must be timezone-aware")
        if last_seen.tzinfo is None or last_seen.utcoffset() is None:
            raise ValueError("alert last_seen must be timezone-aware")
        if last_seen < created_at:
            raise ValueError("alert last_seen must not precede created_at")

        unique_key = f"alert:{key}"
        operation_key = f"alert:{key}:{occurrence_count}"
        previous = await self._alert_delivery_intent(operation_key)
        if previous is not None:
            # The outbox intent was committed before the first HTTP request.
            # A later monitor observation must reconcile exactly that request,
            # not substitute a newer last_seen into the same operation key.
            await self.apply(previous)
            return
        fields = {
            "AUTO｜记录类型": "运行告警",
            "AUTO｜失败类型": code,
            "AUTO｜错误": message,
            "AUTO｜首次出现": created_at.astimezone(UTC).isoformat(),
            "AUTO｜最后出现": last_seen.astimezone(UTC).isoformat(),
            "AUTO｜累计次数": occurrence_count,
        }
        record = await self._find_unique_key("搜索批次", unique_key)
        if record is None:
            mutation = FeishuMutation(
                operation_key=operation_key,
                table="搜索批次",
                action="create",
                unique_key=unique_key,
                current_state="新建",
                state="需人工处理",
                actor="automation",
                explicit_revalidation=False,
                fields=fields,
            )
        else:
            current_state = record.fields.get(FIELD_MAPPERS["搜索批次"]["status"])
            if current_state != "需人工处理":
                raise WriteConflict(
                    "alert row status changed; manual reconciliation required"
                )
            mutation = FeishuMutation(
                operation_key=operation_key,
                table="搜索批次",
                action="update",
                record_id=record.record_id,
                unique_key=unique_key,
                expected_version=record.version,
                current_state=current_state,
                state=current_state,
                actor="automation",
                explicit_revalidation=False,
                fields=fields,
            )
        await self.apply(mutation)

    async def _alert_delivery_intent(self, operation_key: str) -> FeishuMutation | None:
        """Return the immutable payload for a previously attempted alert send."""

        event_id = uuid5(
            NAMESPACE_URL,
            f"rabbit-hole:{self.client.base_token}:{operation_key}",
        )
        async with _transaction(self.database) as connection:
            payload = (
                await connection.execute(
                    select(feishu_outbox.c.payload).where(
                        feishu_outbox.c.id == event_id
                    )
                )
            ).scalar_one_or_none()
        if payload is None:
            return None
        if not isinstance(payload, dict) or not isinstance(
            payload.get("mutation"), dict
        ):
            raise WriteConflict(
                "alert delivery intent is invalid; manual reconciliation required"
            )
        intent = FeishuMutation.model_validate(payload["mutation"])
        if intent.operation_key != operation_key:
            raise WriteConflict("alert delivery intent operation key does not match")
        return intent

    async def _find_unique_key(
        self, table: str, unique_key: str
    ) -> RecordVersion | None:
        schema = next(
            item for item in BaseSchema.default().tables if item.name == table
        )
        field = schema.field_map[schema.logical_key].display_name
        matches = [
            self.client.record_version(row)
            for row in await self.client.list_records(table)
            if row.get("fields", {}).get(field) == unique_key
        ]
        if len(matches) > 1:
            raise WriteConflict("multiple remote records have the same logical key")
        return matches[0] if matches else None


def parse_trends_timeline(
    raw: str, *, query: str, geo: str, window: str
) -> TrendSeries:
    """Parse observed widget dates and 0–100 values; never fabricate weeks."""
    if window not in {"12m", "5y"} or len(raw.encode()) > 2 * 1024 * 1024:
        raise TrendsPageError("schema_drift")
    try:
        payload = json.loads(raw.removeprefix(")]}'").lstrip(",\n \r"))
        rows = payload["default"]["timelineData"]
        if not isinstance(rows, list) or not 52 <= len(rows) <= 270:
            raise ValueError
        points: list[TrendPoint] = []
        for row in rows:
            values = row["value"]
            if (
                row.get("hasData") != [True]
                or row.get("isPartial", False)
                or len(values) != 1
            ):
                raise ValueError
            value = values[0]
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value <= 100
            ):
                raise ValueError
            timestamp = int(row["time"])
            week = datetime.fromtimestamp(timestamp, UTC).date()
            if points and (week - points[-1].week).days != 7:
                raise ValueError
            points.append(TrendPoint(week=week, value=value))
        if window == "5y" and len(points) < 260:
            raise ValueError
        return TrendSeries(query=query, geo=geo, window=window, points=tuple(points))
    except (KeyError, TypeError, ValueError, OverflowError, OSError) as exc:
        raise TrendsPageError("schema_drift") from exc


class BrowserTrendsStrategy:
    """Read the timeline response produced by the normal Trends explore page.

    No undocumented token requests or stored browser state are injected. A
    missing/changed page response remains an explicit collector failure.
    """

    async def fetch_weekly_series(
        self, query: str, geo: str, window: str
    ) -> TrendSeries:
        from rabbit_hole.domain.markets import MARKETS

        if window not in {"12m", "5y"} or geo not in MARKETS:
            raise TrendsPageError("schema_drift")
        parameters = urlencode(
            {
                "q": query,
                "geo": geo,
                "date": "today 12-m" if window == "12m" else "today 5-y",
                "hl": "en-US",
            }
        )
        try:
            async with asyncio.timeout(45), async_playwright() as playwright:
                browser = await playwright.chromium.launch(headless=True)
                try:
                    context = await browser.new_context(
                        locale="en-US", service_workers="block"
                    )
                    page = await context.new_page()
                    async with page.expect_response(
                        lambda response: (
                            urlsplit(response.url).hostname == "trends.google.com"
                            and urlsplit(response.url).path
                            == "/trends/api/widgetdata/multiline"
                        ),
                        timeout=30_000,
                    ) as captured:
                        navigation = await page.goto(
                            "https://trends.google.com/trends/explore?" + parameters,
                            wait_until="domcontentloaded",
                            timeout=30_000,
                        )
                        if navigation is not None:
                            if navigation.status in {401, 403, 429}:
                                raise TrendsPageError("access_restricted")
                            if navigation.status >= 400:
                                raise TrendsPageError("source_error")
                    response = await captured.value
                    if response.status in {401, 403, 429}:
                        raise TrendsPageError("access_restricted")
                    if response.status != 200:
                        raise TrendsPageError("source_error")
                    return parse_trends_timeline(
                        await response.text(), query=query, geo=geo, window=window
                    )
                finally:
                    await browser.close()
        except (BrowserTimeout, TimeoutError) as exc:
            raise TrendsPageError("timeout") from exc
        except TrendsPageError:
            raise
        except Exception as exc:
            raise TrendsPageError("source_error") from exc


class RuntimeMetaCollector:
    def __init__(
        self, storage: EvidenceStore, jobs: JobRepository, telemetry: Telemetry
    ) -> None:
        self.storage, self.jobs, self.telemetry = storage, jobs, telemetry

    async def collect(
        self,
        query: MetaQuery,
        *,
        job_id: UUID,
        record_id: str,
        worker: str,
        lease_token: UUID | None,
        attempt: int = 1,
        manage_retries: bool = True,
        checkpoint_scope: str | None = None,
    ) -> CollectorResult[SearchBatchResult]:
        started = time.monotonic()
        result: CollectorResult[SearchBatchResult] | None = None
        try:
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(headless=True)
                try:
                    collector = MetaCollector(
                        PlaywrightMetaPageFactory(browser),
                        # The collector's protocols intentionally accept the
                        # narrow method set it invokes.  SQLAlchemy and the
                        # evidence client expose stricter concrete signatures.
                        evidence_store=cast(Any, self.storage),
                        job_repository=cast(Any, self.jobs),
                    )
                    result = await collector.collect(
                        query,
                        job_id=job_id,
                        record_id=record_id,
                        worker=worker,
                        lease_token=lease_token,
                        attempt=attempt,
                        manage_retries=manage_retries,
                        checkpoint_scope=checkpoint_scope,
                    )
                    return result
                finally:
                    await browser.close()
        finally:
            checkpoint_key = (
                f"meta_collect:{checkpoint_scope}"
                if checkpoint_scope
                else "meta_collect"
            )
            checkpoint = await self.jobs.get_checkpoint(job_id, checkpoint_key) or {}
            for event in checkpoint.get("recovery_events", []):
                await self.telemetry.record(
                    f"meta-recovery:{job_id}:{checkpoint_scope}:{event.get('attempt')}:{event.get('action')}:{event.get('failure_code')}",
                    source="meta",
                    success=False,
                    count=0,
                    recoveries=int(
                        event.get("action") in {"refresh", "reopen", "new_context"}
                    ),
                    captcha=event.get("failure_code")
                    in {"captcha", "access_restricted", "access_challenge"},
                )
            await self.telemetry.record(
                f"meta:{job_id}:{checkpoint_scope}:{attempt}",
                source="meta",
                success=bool(result and result.ok),
                duration_seconds=time.monotonic() - started,
            )


class _MeasuredCollector:
    def __init__(self, collector: Any, telemetry: Telemetry, source: str) -> None:
        self.collector, self.telemetry, self.source = collector, telemetry, source

    async def collect(self, *args: Any, **kwargs: Any) -> Any:
        started = time.monotonic()
        success = False
        try:
            result = await self.collector.collect(*args, **kwargs)
            success = result.ok and not getattr(result.value, "errors", ())
            return result
        finally:
            await self.telemetry.record(
                str(uuid4()),
                source=self.source,
                success=success,
                duration_seconds=time.monotonic() - started,
            )


class RuntimeExtractor:
    def __init__(self, settings: Settings, database: Database, telemetry: Telemetry, *, ai_adapter=None) -> None:
        self.settings, self.database, self.telemetry = settings, database, telemetry
        self.ai_adapter = ai_adapter

    async def extract(self, source: ExtractionInput) -> ProductExtraction:
        if self.ai_adapter is None:
            raise ExtractionGenerationError("research AI adapter is not configured")
        failed = False
        try:
            # Snapshot one binding/version for cache key and generation together.
            with self.ai_adapter.extraction_generator() as generator:
                return await extract_product(generator, source, cache=PostgresExtractionCache(self.database))
        except (ValidationError, ExtractionGenerationError):
            failed = True
            raise
        finally:
            await self.telemetry.record(str(uuid4()), source="ai", success=not failed, schema_failure=failed)


class RuntimeDiscoveryGenerator:
    def __init__(self, settings: Settings, *, ai_adapter=None) -> None:
        self.settings, self.ai_adapter = settings, ai_adapter

    async def generate(self, **kwargs: Any) -> Any:
        if self.ai_adapter is None:
            raise ExtractionGenerationError("research AI adapter is not configured")
        with self.ai_adapter.extraction_generator(operation="keywords") as generator:
            return await generator.generate(**kwargs)


class _MeasuredPipeline:
    def __init__(self, pipeline: Pipeline, telemetry: Telemetry) -> None:
        self.pipeline, self.telemetry = pipeline, telemetry

    async def run(self, job: Job) -> PipelineResult:
        started, success = time.monotonic(), False
        try:
            result = await self.pipeline.run(job)
            success = not result.retryable and not result.needs_human
            return result
        finally:
            await self.telemetry.record(
                f"job:{job.id}:{job.lease_token}",
                source="job",
                success=success,
                duration_seconds=time.monotonic() - started,
            )


async def build_worker(
    *,
    settings: Settings,
    jobs: JobRepository,
    feishu: FeishuClient,
    storage: EvidenceStore | None = None,
    pipeline: Pipeline | None = None,
    telemetry: Telemetry | None = None,
    ai_adapter=None,
) -> Worker:
    """Construct the standard worker from validated settings; no factory env required."""
    if ai_adapter is None and pipeline is None:
        raise ValueError(
            "ResearchAIAdapter injection is required for legacy AI execution"
        )
    telemetry = telemetry or Telemetry(jobs._database)
    jobs.admission = settings.admission
    workflow = FeishuWorkflowAdapter(feishu, jobs._database)
    if pipeline is None:
        if storage is None:
            client = create_storage_client(settings)
            storage = await asyncio.to_thread(
                EvidenceStore,
                client,
                bucket=settings.s3_bucket,
                collector_version="phase1-v1",
            )
        pipeline = Pipeline(
            jobs=jobs,
            feishu=workflow,
            meta_collector=RuntimeMetaCollector(storage, jobs, telemetry),
            landing_collector=_MeasuredCollector(
                LandingCollector(
                    SafeUrlClient(
                        resolver=google_public_dns
                        if settings.public_dns == "google"
                        else None
                    )
                ),
                telemetry,
                "landing",
            ),
            trends_collector=_MeasuredCollector(
                GoogleTrendsCollector(
                    BrowserTrendsStrategy(), thresholds=settings.trend_thresholds
                ),
                telemetry,
                "trends",
            ),
            extractor=RuntimeExtractor(settings, jobs._database, telemetry, ai_adapter=ai_adapter),
            discovery_generator=RuntimeDiscoveryGenerator(settings, ai_adapter=ai_adapter),
            storage=cast(Any, storage),
            market=settings.market,
        )
    monitor = Monitor(telemetry, workflow)

    async def maintenance() -> None:
        await workflow.reconcile_pending()
        await monitor.tick()

    return Worker(
        jobs=jobs,
        pipeline=_MeasuredPipeline(pipeline, telemetry),
        poller=TriggerPoller(feishu, jobs),
        worker_id=f"worker-{uuid4().hex}",
        browser_concurrency=settings.browser_concurrency,
        poll_seconds=settings.poll_seconds,
        maintenance=maintenance,
    )
