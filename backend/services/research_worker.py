"""Explicit local worker; production activation remains denied until signed handoff."""
from __future__ import annotations

import argparse
import asyncio
import inspect
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


def deny_activation(runtime: ResearchRuntime) -> bool:
    return False


def build_local_worker_services(runtime: ResearchRuntime) -> LocalWorkerServices:
    """Task9/10 wire adapters here; called after authorization and ownership."""
    raise RuntimeError('research_worker_configuration_not_ready')


async def serve_local_worker(runtime: ResearchRuntime, *, mode: str,
                             activation_validator: Callable[[ResearchRuntime], bool | Awaitable[bool]]) -> None:
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
    if mode == 'active':
        def factory() -> tuple[WorkerLoop, WorkerLoop]:
            services = build_local_worker_services(runtime)
            if not isinstance(services, LocalWorkerServices):
                raise TypeError('research_worker_configuration_not_ready')
            return services.runner, services.sync
        await serve_workbench(runtime.engine, service_factory=factory)
    else:
        await serve_workbench(runtime.engine, services.runner, services.sync)


async def _run(database: Path, data_root: Path, mode: str) -> None:
    paths = resolve_runtime_paths(database, data_root)
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        task = asyncio.create_task(serve_local_worker(runtime, mode=mode, activation_validator=deny_activation))
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
    parser.add_argument('--mode', choices=('paused', 'active'), default='paused')
    args = parser.parse_args()
    try:
        asyncio.run(_run(args.database, args.data_root, args.mode))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:  # noqa: BLE001 -- never expose credentials or upstream payloads
        # Never expose credential-bearing source errors or traceback details.
        print('research_worker_failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
