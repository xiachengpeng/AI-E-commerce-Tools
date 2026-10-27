"""Explicit local worker; production activation remains denied until signed handoff."""
from __future__ import annotations

import argparse
import asyncio
import inspect
import logging
import signal
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from models.research_runtime import ResearchRuntime

from services.research_runtime import open_research_runtime, resolve_runtime_paths


class WorkerLoop(Protocol):
    async def loop(self) -> None: ...


@dataclass(frozen=True)
class LocalWorkerServices:
    """Explicit execution dependencies supplied only after activation validation.

    Task9/10 supply production adapters and Task19 the signed ownership gate.
    No credentials, network clients or source Settings defaults are inferred here.
    """
    runner: WorkerLoop
    sync: WorkerLoop


class UnifiedResearchRunner:
    """Both queues run beneath the one process owner lock held by serve_workbench."""
    def __init__(self, runtime, native, *, poll_feishu=False):
        if type(poll_feishu) is not bool:
            raise ValueError('explicit boolean polling choice required')
        self.runtime, self.native = runtime, native
        self.poll_feishu = poll_feishu

    async def loop(self):
        from rabbit_hole.cli import DefaultOperatorRuntime
        operator = DefaultOperatorRuntime(local_runtime=self.runtime)
        legacy = await operator.build_worker()
        async with asyncio.TaskGroup() as group:
            group.create_task(self.native.loop(), name='research-native-actions')
            group.create_task(legacy.run_forever(), name='research-legacy-queue')
            if self.poll_feishu:
                poller = FeishuPollingLoop(operator, self.runtime.engine, self.runtime.business_settings.poll_seconds)
                group.create_task(poller.loop(), name='research-feishu-poll')


class FeishuPollingLoop:
    """An opt-in producer under the same owner as both existing consumers.

    Poll failures do not stop native work or expose upstream payloads. Durable
    status contains only a fixed outcome and timestamp, never record contents.
    """
    def __init__(self, operator, engine, poll_seconds, *, wait=asyncio.sleep, timeout_seconds=60):
        if type(poll_seconds) is not int or poll_seconds < 10:
            raise ValueError('poll interval must be at least 10 seconds')
        if not 0 < timeout_seconds <= 120:
            raise ValueError('poll timeout must be bounded')
        self.operator, self.engine = operator, engine
        self.poll_seconds, self.wait, self.timeout_seconds = poll_seconds, wait, timeout_seconds

    async def tick(self):
        from datetime import UTC, datetime
        from sqlalchemy import delete
        from rabbit_hole.monitoring import runtime_health
        from rabbit_hole.persistence.sql import dialect_insert, write_transaction
        try:
            async with asyncio.timeout(self.timeout_seconds):
                await self.operator.poll_once()
            success = True
        except Exception:  # no provider messages, credentials or record contents
            success = False
            logging.getLogger(__name__).warning('research_feishu_poll_failed')
        component = 'feishu_poll_ok' if success else 'feishu_poll_failed'
        async with write_transaction(self.engine) as connection:
            await connection.execute(delete(runtime_health).where(runtime_health.c.component.in_(['feishu_poll_ok', 'feishu_poll_failed'])))
            await connection.execute(dialect_insert(connection, runtime_health).values(component=component, updated_at=datetime.now(UTC)))
        return success

    async def loop(self):
        while True:
            await self.tick()
            await self.wait(self.poll_seconds)


def deny_activation(runtime: ResearchRuntime) -> bool:
    return False


def build_local_worker_services(runtime: ResearchRuntime, *, poll_feishu=False) -> LocalWorkerServices:
    """Task9/10 wire adapters here; called after authorization and ownership."""
    from models.research_ai import ResearchBusinessSettings

    from services.research_ai_adapter import ResearchAIAdapter
    if (runtime.worker_readiness or not isinstance(runtime.business_settings, ResearchBusinessSettings)
            or not isinstance(runtime.ai_adapter, ResearchAIAdapter) or runtime.non_ai_integrations is None
            or runtime.store is None or runtime.evidence_store is None):
        raise RuntimeError('research_worker_configuration_not_ready')
    sync = runtime.workbench_services.get('sync')
    if sync is None:
        raise RuntimeError('research_worker_configuration_not_ready')
    runner = runtime.non_ai_integrations.make_runner(runtime.store, runtime.business_settings,
                                                    runtime.evidence_store, ai_adapter=runtime.ai_adapter)
    return LocalWorkerServices(UnifiedResearchRunner(runtime, runner, poll_feishu=poll_feishu), sync)


async def serve_local_worker(runtime: ResearchRuntime, *, mode: str,
                             activation_validator: Callable[[ResearchRuntime], bool | Awaitable[bool]], poll_feishu=False) -> None:
    if mode not in {'paused', 'active'}:
        raise ValueError('worker mode must be paused or active')
    if runtime.engine is None or runtime.store is None or runtime.evidence_store is None or runtime.diagnostics:
        raise ValueError('prepared command runtime is required')
    if runtime.engine.get_execution_options().get('research_lock_root') != runtime.paths.lock_root:
        raise ValueError('explicit common worker lock root is required')
    if mode == 'active':
        authorized = activation_validator(runtime)
        if inspect.isawaitable(authorized):
            authorized = await authorized
        if authorized is not True:
            raise PermissionError('research_worker_activation_denied')
    else:
        class Paused:
            async def loop(self) -> None:
                await asyncio.Event().wait()
        services = LocalWorkerServices(Paused(), Paused())
    from rabbit_hole.runtime.workbench_worker import serve_workbench
    from services.research_polling_policy import submission_budget_identity
    runtime.engine.update_execution_options(workbench_submission_budget_identity=submission_budget_identity(getattr(runtime,'submission_budget',None)))
    if mode == 'active':
        def factory() -> tuple[WorkerLoop, WorkerLoop]:
            services = build_local_worker_services(runtime, poll_feishu=True) if poll_feishu is True else build_local_worker_services(runtime)
            if not isinstance(services, LocalWorkerServices):
                raise TypeError('research_worker_configuration_not_ready')
            return services.runner, services.sync
        await serve_workbench(runtime.engine, service_factory=factory)
    else:
        await serve_workbench(runtime.engine, services.runner, services.sync)


async def _run(database: Path, data_root: Path, mode: str, business_settings_path: Path | None = None, *, offline_commands: bool = False, poll_feishu=False) -> None:
    from services.research_activation import validate_runtime_activation
    paths = resolve_runtime_paths(database, data_root)
    from services.research_ai_adapter import read_business_settings
    business = read_business_settings(business_settings_path) if business_settings_path is not None else None
    async with open_research_runtime(paths, allow_commands=(mode == 'active' or offline_commands), allow_external=(mode == 'active'), business_settings=business, offline_commands=offline_commands) as runtime:
        task = asyncio.create_task(serve_local_worker(runtime, mode=mode, activation_validator=validate_runtime_activation, poll_feishu=poll_feishu) if mode == 'active' or offline_commands else asyncio.Event().wait())
        loop = asyncio.get_running_loop()
        installed = []
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, task.cancel)
            installed.append(sig)
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            for sig in installed:
                loop.remove_signal_handler(sig)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--business-settings', type=Path)
    parser.add_argument('--mode', choices=('paused', 'active'), default='paused')
    parser.add_argument('--poll-feishu', action='store_true', help='explicitly enable the owned Feishu trigger producer')
    args = parser.parse_args()
    try:
        asyncio.run(_run(args.database, args.data_root, args.mode, args.business_settings, poll_feishu=args.poll_feishu))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:  # noqa: BLE001 -- never expose credentials or upstream payloads
        # Never expose credential-bearing source errors or traceback details.
        print('research_worker_failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
