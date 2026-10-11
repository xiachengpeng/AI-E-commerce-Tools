"""Operator commands for bounded Rabbit Hole diagnostics."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import inspect
import json
import os
import sys
import tempfile
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import asdict, is_dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol, cast
from urllib.parse import urlencode
from uuid import UUID

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright
from pydantic import BaseModel, ValidationError

from rabbit_hole.config import Settings, get_settings
from rabbit_hole.domain.legacy import Job
from rabbit_hole.integrations.collectors.meta import (
    MetaPageHealthError,
    MetaQuery,
    PlaywrightMetaPage,
)
from rabbit_hole.integrations.feishu import FeishuClient, TriggerPoller, bootstrap_base
from rabbit_hole.persistence.database import create_database_engine
from rabbit_hole.persistence.evidence_store import EvidenceStore
from rabbit_hole.persistence.legacy_jobs import (
    ActiveLeaseError,
    JobNotRequeueableError,
    JobRepository,
)
from rabbit_hole.persistence.storage_factory import create_storage_client
from rabbit_hole.worker import Worker, WorkerRunResult

_META_LIBRARY_URL = "https://www.facebook.com/ads/library/"


class RuntimeConfigurationError(RuntimeError):
    """A production-only command is missing an explicit runtime adapter."""


class OperatorRuntime(Protocol):
    async def poll_once(self) -> int: ...

    async def worker_once(self) -> WorkerRunResult: ...

    async def bootstrap_feishu(self, *, dry_run: bool) -> object: ...

    async def requeue(self, job_id: UUID) -> object: ...

    async def purge_expired_evidence(self, *, dry_run: bool) -> list[str]: ...

    async def aclose(self) -> None: ...


class DefaultOperatorRuntime:
    """Validated, lazily destructive operator dependencies.

    Standard collector/browser composition is provided by ``runtime``. An
    optional ``RABBIT_HOLE_WORKER_FACTORY=module:callable`` remains available
    for controlled adapter injection.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.engine = create_database_engine(self.settings)
        self.jobs = JobRepository(self.engine)
        self.feishu = FeishuClient(
            self.settings.feishu_app_id,
            self.settings.feishu_app_secret,
            self.settings.feishu_base_app_token,
        )

    async def poll_once(self) -> int:
        return await TriggerPoller(self.feishu, self.jobs).poll_once()

    async def build_worker(self) -> Worker:
        reference = os.environ.get("RABBIT_HOLE_WORKER_FACTORY", "").strip()
        if not reference:
            from rabbit_hole.runtime.legacy import build_worker

            return await build_worker(
                settings=self.settings, jobs=self.jobs, feishu=self.feishu
            )
        module_name, separator, attribute = reference.partition(":")
        if not separator or not module_name or not attribute:
            raise RuntimeConfigurationError(
                "RABBIT_HOLE_WORKER_FACTORY must name module:callable"
            )
        try:
            module = importlib.import_module(module_name)
            factory = cast(Any, getattr(module, attribute))
        except (AttributeError, ImportError) as exc:
            raise RuntimeConfigurationError(
                "RABBIT_HOLE_WORKER_FACTORY cannot be imported"
            ) from exc
        candidate: object = factory(
            settings=self.settings,
            jobs=self.jobs,
            feishu=self.feishu,
        )
        if inspect.isawaitable(candidate):
            candidate = await cast(Awaitable[object], candidate)
        if not isinstance(candidate, Worker):
            raise RuntimeConfigurationError(
                "RABBIT_HOLE_WORKER_FACTORY did not return Worker"
            )
        return candidate

    async def worker_once(self) -> WorkerRunResult:
        return await (await self.build_worker()).run_once()

    async def bootstrap_feishu(self, *, dry_run: bool) -> object:
        return await bootstrap_base(self.feishu, dry_run=dry_run)

    async def requeue(self, job_id: UUID) -> Job:
        return await self.jobs.requeue(job_id)

    async def purge_expired_evidence(self, *, dry_run: bool) -> list[str]:
        if not dry_run:
            raise RuntimeConfigurationError(
                "CLI evidence purge requires explicit dry-run mode"
            )
        client = create_storage_client(self.settings)
        store = EvidenceStore(
            client,
            bucket=self.settings.s3_bucket,
            collector_version="phase1-v1",
        )
        return await asyncio.to_thread(
            store.purge_expired,
            datetime.now(UTC),
            True,
        )

    async def aclose(self) -> None:
        await self.feishu.aclose()
        await self.engine.dispose()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rabbit_hole.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    smoke = commands.add_parser(
        "meta-smoke", help="run a bounded, read-only Meta Ad Library smoke check"
    )
    smoke.add_argument("--market", choices=("US",), required=True)
    smoke.add_argument("--query", required=True)
    smoke.add_argument("--limit", type=int, choices=range(1, 501), required=True)
    commands.add_parser("poll-once", help="enqueue explicit Feishu trigger rows once")
    commands.add_parser("worker-once", help="lease and execute at most one job")
    bootstrap = commands.add_parser(
        "bootstrap-feishu", help="create missing Feishu Base schema components"
    )
    bootstrap.add_argument("--dry-run", action="store_true")
    requeue = commands.add_parser("requeue", help="explicitly requeue a failed job")
    requeue.add_argument("job_id", type=_job_id)
    purge = commands.add_parser(
        "purge-expired-evidence",
        help="list raw evidence past its immutable retention date",
    )
    purge.add_argument(
        "--dry-run",
        action="store_true",
        required=True,
        help="required safety fence; this command does not delete objects",
    )
    return parser


def _job_id(value: str) -> UUID:
    try:
        return UUID(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("job-id must be a UUID") from exc


def _source_url(query: MetaQuery) -> str:
    fixture = os.environ.get("RABBIT_HOLE_META_SMOKE_FIXTURE")
    if fixture:
        return Path(fixture).resolve(strict=True).as_uri()
    parameters = urlencode(
        {
            "active_status": "active",
            "ad_type": "all",
            "country": query.market,
            "media_type": "video",
            "q": query.actual_queries[0],
            "search_type": "keyword_exact_phrase",
        }
    )
    return f"{_META_LIBRARY_URL}?{parameters}"


def _write_screenshot(payload: bytes) -> dict[str, str | int]:
    directory_value = os.environ.get("RABBIT_HOLE_META_SMOKE_EVIDENCE_DIR")
    directory = Path(directory_value) if directory_value else Path.cwd()
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(
        prefix="meta-smoke-", suffix=".png", dir=directory
    )
    try:
        os.write(descriptor, payload)
    finally:
        os.close(descriptor)
    return {
        "path": str(Path(filename).resolve()),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
    }


async def _meta_smoke(*, market: str, query: str, limit: int) -> dict[str, Any]:
    request = MetaQuery(query=query, market=cast(Literal["US"], market), max_ads=limit)
    source_url = _source_url(request)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            context = await browser.new_context(
                locale="en-US",
                timezone_id="America/New_York",
                service_workers="block",
            )
            page = await context.new_page()
            page.set_default_timeout(10_000)
            await page.goto(source_url, wait_until="domcontentloaded", timeout=20_000)
            from rabbit_hole.integrations.collectors.meta_live import PublicMetaPage

            page_type = (
                PlaywrightMetaPage if source_url.startswith("file:") else PublicMetaPage
            )
            meta_page = page_type(page, source_url=source_url, settle_timeout_ms=10_000)
            expected_filters = {
                "market": market,
                "status": "active",
                "media_type": "video",
                "search_mode": "exact_phrase",
                "query": request.actual_queries[0],
            }
            for name, value in expected_filters.items():
                await meta_page.apply_filter(name, value)
                await meta_page.health_check()
            displayed_filters = await meta_page.displayed_filters()
            if displayed_filters != expected_filters:
                raise MetaPageHealthError("displayed_filters_mismatch")

            ads_by_id: dict[str, Any] = {}
            no_new_scrolls = 0
            while len(ads_by_id) < limit:
                before = len(ads_by_id)
                for ad in await meta_page.read_batch(query=request.actual_queries[0]):
                    ads_by_id.setdefault(ad.ad_id, ad)
                    if len(ads_by_id) == limit:
                        break
                if len(ads_by_id) == limit or await meta_page.at_end():
                    break
                no_new_scrolls = no_new_scrolls + 1 if len(ads_by_id) == before else 0
                if no_new_scrolls >= 3:
                    break
                await meta_page.scroll()
                await meta_page.health_check()

            if not ads_by_id:
                code = (
                    "no_results"
                    if await meta_page.no_results_confirmed()
                    else "empty_results"
                )
                raise MetaPageHealthError(code)
            screenshot = _write_screenshot(await meta_page.screenshot())
            return {
                "ok": True,
                "market": market,
                "query": request.query,
                "limit": limit,
                "ads": [ad.model_dump(mode="json") for ad in ads_by_id.values()],
                "displayed_filters": displayed_filters,
                "screenshot_evidence": screenshot,
            }
        finally:
            await browser.close()


def _error_payload(error_type: str, code: str) -> dict[str, Any]:
    return {"ok": False, "error": {"type": error_type, "code": code}}


async def _operator_command(
    arguments: argparse.Namespace,
    runtime: OperatorRuntime | None,
) -> dict[str, Any]:
    selected = runtime or DefaultOperatorRuntime()
    try:
        if arguments.command == "poll-once":
            result: object = {"enqueued": await selected.poll_once()}
        elif arguments.command == "worker-once":
            result = await selected.worker_once()
        elif arguments.command == "bootstrap-feishu":
            result = await selected.bootstrap_feishu(dry_run=arguments.dry_run)
        elif arguments.command == "requeue":
            result = await selected.requeue(arguments.job_id)
        elif arguments.command == "purge-expired-evidence":
            object_ids = await selected.purge_expired_evidence(
                dry_run=arguments.dry_run
            )
            result = {
                "dry_run": True,
                "count": len(object_ids),
                "object_ids": object_ids,
            }
        else:  # pragma: no cover - argparse constrains the command set
            raise AssertionError(f"unsupported operator command: {arguments.command}")
        return {
            "ok": True,
            "command": arguments.command,
            "result": _json_value(result),
        }
    finally:
        await selected.aclose()


def _json_value(value: object) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if is_dataclass(value) and not isinstance(value, type):
        return _json_value(asdict(cast(Any, value)))
    if isinstance(value, Mapping):
        return {str(name): _json_value(item) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value, UUID):
        return str(value)
    return value


def main(
    argv: Sequence[str] | None = None,
    *,
    runtime: OperatorRuntime | None = None,
) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "meta-smoke":
            payload = asyncio.run(
                asyncio.wait_for(
                    _meta_smoke(
                        market=arguments.market,
                        query=arguments.query,
                        limit=arguments.limit,
                    ),
                    timeout=60,
                )
            )
        else:
            payload = asyncio.run(_operator_command(arguments, runtime))
    except MetaPageHealthError as exc:
        payload = _error_payload("meta_health", str(exc))
    except PlaywrightTimeoutError:
        payload = _error_payload("meta_access", "timeout")
    except TimeoutError:
        payload = _error_payload("meta_access", "overall_timeout")
    except OSError as exc:
        payload = _error_payload("operator_io", type(exc).__name__)
    except ValidationError:
        payload = _error_payload("configuration", "invalid_settings")
    except RuntimeConfigurationError as exc:
        payload = _error_payload("configuration", str(exc))
    except ActiveLeaseError:
        payload = _error_payload("operator_state", "active_lease")
    except JobNotRequeueableError:
        payload = _error_payload("operator_state", "job_not_requeueable")
    except Exception as exc:  # noqa: BLE001 -- operator boundary must stay typed
        payload = _error_payload("unexpected", type(exc).__name__)
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0 if payload["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
