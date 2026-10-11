"""Bounded queue worker for the Rabbit Hole pipeline."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import timedelta
from typing import Literal, Protocol
from uuid import UUID

from rabbit_hole.domain.legacy import Job, JobKind, JobStatus
from rabbit_hole.persistence.legacy_jobs import StaleLeaseError
from rabbit_hole.pipeline import (
    PipelineResult,
    RetryablePipelineError,
    TerminalPipelineError,
)


class WorkerJobRepository(Protocol):
    async def lease_next(self, worker: str, *, lease_for: timedelta) -> Job | None: ...

    async def renew(
        self,
        job_id: UUID,
        *,
        worker: str,
        lease_token: UUID | None,
        lease_for: timedelta,
    ) -> Job: ...

    async def checkpoint(
        self,
        job_id: UUID,
        stage: str,
        data: dict[str, object],
        *,
        worker: str,
        lease_token: UUID | None,
    ) -> None: ...

    async def get_checkpoint(
        self, job_id: UUID, stage: str
    ) -> dict[str, object] | None: ...

    async def complete(
        self,
        job_id: UUID,
        *,
        worker: str,
        lease_token: UUID | None,
    ) -> Job: ...

    async def retry(
        self,
        job_id: UUID,
        *,
        failure: str,
        detail: str,
        attempt: int,
        worker: str,
        lease_token: UUID | None,
        kind: JobKind | None = None,
    ) -> Job: ...

    async def needs_human(
        self,
        job_id: UUID,
        *,
        failure: str,
        detail: str,
        worker: str,
        lease_token: UUID | None,
    ) -> Job: ...


class PipelineRunner(Protocol):
    async def run(self, job: Job) -> PipelineResult: ...


class TriggerPoller(Protocol):
    async def poll_once(self) -> int: ...


@dataclass(frozen=True, slots=True)
class WorkerRunResult:
    outcome: Literal["idle", "succeeded", "retry", "needs_human", "lease_lost"]
    job_id: UUID | None = None
    failure_code: str | None = None


class Worker:
    """Run one poller and a browser-bounded set of queue consumers."""

    def __init__(
        self,
        *,
        jobs: WorkerJobRepository,
        pipeline: PipelineRunner,
        poller: TriggerPoller | None,
        worker_id: str,
        browser_concurrency: int,
        poll_seconds: float,
        lease_for: timedelta = timedelta(minutes=5),
        renew_seconds: float | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        maintenance: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        if not worker_id.strip():
            raise ValueError("worker_id must not be empty")
        if browser_concurrency < 1:
            raise ValueError("browser_concurrency must be positive")
        if poll_seconds < 10:
            raise ValueError("poll_seconds must be at least 10")
        if lease_for <= timedelta(0):
            raise ValueError("lease_for must be positive")
        selected_renew_seconds = renew_seconds or lease_for.total_seconds() / 3
        if selected_renew_seconds <= 0:
            raise ValueError("renew_seconds must be positive")
        if selected_renew_seconds >= lease_for.total_seconds():
            raise ValueError("renew_seconds must be shorter than the lease")

        self._jobs = jobs
        self._pipeline = pipeline
        self._poller = poller
        self._worker_id = worker_id
        self._browser_concurrency = browser_concurrency
        self._poll_seconds = poll_seconds
        self._lease_for = lease_for
        self._renew_seconds = selected_renew_seconds
        self._sleep = sleep
        self._maintenance = maintenance

    @property
    def consumer_count(self) -> int:
        """The hard runtime bound: at most two browser consumers."""

        return min(2, self._browser_concurrency)

    async def poll_once(self) -> int:
        if self._poller is None:
            return 0
        return await self._poller.poll_once()

    async def run_once(self) -> WorkerRunResult:
        queued = await self._jobs.lease_next(
            self._worker_id,
            lease_for=self._lease_for,
        )
        if queued is None:
            return WorkerRunResult(outcome="idle")
        try:
            result = await self._run_with_lease_renewal(queued)
            if result.retryable:
                return await self._record_retry(
                    queued,
                    result.failure_code or "pipeline_retry",
                    "pipeline returned a retryable result",
                    attempt=result.retry_attempt,
                    retry_kind=result.retry_kind,
                )
            if result.needs_human:
                return await self._record_terminal(
                    queued,
                    result.failure_code or "pipeline_needs_human",
                    "pipeline returned a terminal result",
                )
            checkpoint = await self._jobs.get_checkpoint(queued.id, "writeback")
            if (
                result.checkpoint_stage != "writeback"
                or checkpoint is None
                or checkpoint.get("status") != "complete"
            ):
                raise TerminalPipelineError(
                    "missing_writeback_checkpoint",
                    "pipeline returned before its durable writeback checkpoint",
                )
            await self._jobs.complete(
                queued.id,
                worker=self._worker_id,
                lease_token=queued.lease_token,
            )
            return WorkerRunResult(outcome="succeeded", job_id=queued.id)
        except StaleLeaseError:
            return WorkerRunResult(
                outcome="lease_lost",
                job_id=queued.id,
                failure_code="stale_lease",
            )
        except RetryablePipelineError as error:
            return await self._record_retry(
                queued,
                error.code,
                error.detail,
                attempt=error.attempt,
                retry_kind=error.retry_kind,
            )
        except TerminalPipelineError as error:
            return await self._record_terminal(queued, error.code, error.detail)
        except Exception as error:  # noqa: BLE001 -- worker boundary must fail closed
            # Unknown exceptions fail closed. The exception type is enough for
            # diagnosis without persisting possibly sensitive exception text.
            return await self._record_terminal(
                queued,
                "unexpected_pipeline_error",
                type(error).__name__,
            )

    async def run_forever(self, *, stop_event: asyncio.Event | None = None) -> None:
        """Run exactly one poller and up to two consumers until stopped."""

        stop = stop_event or asyncio.Event()
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(self._poll_loop(stop), name="rabbit-hole-poller")
            if self._maintenance is not None:
                tasks.create_task(
                    self._maintenance_loop(stop), name="rabbit-hole-maintenance"
                )
            for index in range(self.consumer_count):
                tasks.create_task(
                    self._consume_loop(stop),
                    name=f"rabbit-hole-consumer-{index + 1}",
                )

    async def _run_with_lease_renewal(self, queued: Job) -> PipelineResult:
        pipeline_task = asyncio.create_task(
            self._pipeline.run(queued),
            name=f"rabbit-hole-job-{queued.id}",
        )
        renew_task = asyncio.create_task(
            self._renew_lease(queued, pipeline_task),
            name=f"rabbit-hole-renew-{queued.id}",
        )
        try:
            done, _ = await asyncio.wait(
                {pipeline_task, renew_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if renew_task in done:
                try:
                    renew_task.result()
                except StaleLeaseError:
                    raise
                except Exception as exc:
                    raise StaleLeaseError(
                        f"job {queued.id} lease renewal failed"
                    ) from exc
                if pipeline_task in done:
                    return pipeline_task.result()
                raise StaleLeaseError(f"job {queued.id} lease renewal stopped")
            return pipeline_task.result()
        finally:
            for task in (pipeline_task, renew_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(pipeline_task, renew_task, return_exceptions=True)

    async def _renew_lease(
        self,
        queued: Job,
        pipeline_task: asyncio.Task[PipelineResult],
    ) -> None:
        while not pipeline_task.done():
            await self._sleep(self._renew_seconds)
            if pipeline_task.done():
                return
            try:
                await self._jobs.renew(
                    queued.id,
                    worker=self._worker_id,
                    lease_token=queued.lease_token,
                    lease_for=self._lease_for,
                )
            except StaleLeaseError:
                raise
            except Exception as exc:
                raise StaleLeaseError(f"job {queued.id} lease renewal failed") from exc

    async def _record_retry(
        self,
        queued: Job,
        code: str,
        detail: str,
        *,
        attempt: int | None = None,
        retry_kind: JobKind | None = None,
    ) -> WorkerRunResult:
        next_attempt = attempt or (queued.attempt + 1)
        try:
            await self._failure_checkpoint(queued, "retry", code, detail, next_attempt)
            retried = await self._jobs.retry(
                queued.id,
                failure=code,
                detail=detail,
                attempt=next_attempt,
                worker=self._worker_id,
                lease_token=queued.lease_token,
                kind=retry_kind,
            )
        except StaleLeaseError:
            return WorkerRunResult(
                outcome="lease_lost", job_id=queued.id, failure_code="stale_lease"
            )
        outcome: Literal["retry", "needs_human"] = (
            "needs_human" if retried.status is JobStatus.NEEDS_HUMAN else "retry"
        )
        return WorkerRunResult(
            outcome=outcome,
            job_id=queued.id,
            failure_code=code,
        )

    async def _record_terminal(
        self, queued: Job, code: str, detail: str
    ) -> WorkerRunResult:
        try:
            await self._failure_checkpoint(queued, "needs_human", code, detail)
            await self._jobs.needs_human(
                queued.id,
                failure=code,
                detail=detail,
                worker=self._worker_id,
                lease_token=queued.lease_token,
            )
        except StaleLeaseError:
            return WorkerRunResult(
                outcome="lease_lost", job_id=queued.id, failure_code="stale_lease"
            )
        return WorkerRunResult(
            outcome="needs_human",
            job_id=queued.id,
            failure_code=code,
        )

    async def _failure_checkpoint(
        self,
        queued: Job,
        outcome: Literal["retry", "needs_human"],
        code: str,
        detail: str,
        attempt: int | None = None,
    ) -> None:
        await self._jobs.checkpoint(
            queued.id,
            "worker_failure",
            {
                "status": outcome,
                "code": code,
                "detail": detail,
                "attempt": attempt or (queued.attempt + 1),
            },
            worker=self._worker_id,
            lease_token=queued.lease_token,
        )

    async def _poll_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.poll_once()
            await self._wait_or_stop(stop)

    async def _maintenance_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                assert self._maintenance is not None
                await self._maintenance()
            except Exception:  # noqa: BLE001 -- retry maintenance without losing active jobs
                # The persistent outbox/alert record is retried on the next tick.
                # No provider error text (which may carry credentials) is logged.
                logging.getLogger(__name__).warning("runtime_maintenance_retry")
            await self._wait_or_stop(stop)

    async def _consume_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            result = await self.run_once()
            if result.outcome == "idle":
                await self._wait_or_stop(stop)

    async def _wait_or_stop(self, stop: asyncio.Event) -> None:
        with suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=self._poll_seconds)


async def _run_production_worker() -> None:
    # Imported lazily so the reusable Worker remains independent of CLI wiring.
    from rabbit_hole.cli import DefaultOperatorRuntime

    runtime = DefaultOperatorRuntime()
    try:
        worker = await runtime.build_worker()
        await worker.run_forever()
    finally:
        await runtime.aclose()


def main() -> int:
    """Run the long-lived worker, failing closed on invalid deployment config."""

    from pydantic import ValidationError

    from rabbit_hole.cli import RuntimeConfigurationError

    try:
        asyncio.run(_run_production_worker())
    except KeyboardInterrupt:
        return 0
    except ValidationError:
        payload = {
            "ok": False,
            "error": {"type": "configuration", "code": "invalid_settings"},
        }
    except RuntimeConfigurationError as error:
        payload = {
            "ok": False,
            "error": {"type": "configuration", "code": str(error)},
        }
    else:
        return 0
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 2


if __name__ == "__main__":
    sys.exit(main())
