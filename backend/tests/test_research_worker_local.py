"""Only prepared temporary runtimes and process-owned fake loops are exercised."""
import asyncio
import json
import sqlite3

import pytest
from services.research_runtime import open_research_runtime, resolve_runtime_paths
from services.research_worker import serve_local_worker


@pytest.fixture
def paths(tmp_path):
    from backend.migrations.full_merge_v1 import prepare_schema
    database = tmp_path / 'history.db'
    sqlite3.connect(database).close()
    prepare_schema(database, backup_verified=True)
    root = tmp_path / 'research'
    root.mkdir(mode=0o700)
    result = resolve_runtime_paths(database, root)
    for directory in (result.evidence_root, result.keys_root, result.browser_root, result.lock_root):
        directory.mkdir(mode=0o700)
    key = result.keys_root / 'evidence-signing.key'
    key.write_bytes(b't' * 32)
    key.chmod(0o600)
    namespace = result.keys_root / 'evidence-namespace.json'
    namespace.write_text(json.dumps({'version': 1, 'evidence_bucket': 'test-bucket', 'collector_version': 'test-worker'}))
    namespace.chmod(0o600)
    return result


@pytest.mark.asyncio
async def test_paused_does_not_validate_or_claim(paths):
    def forbidden(_):
        raise AssertionError('paused must not activate')
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        project, _word, queued = await queued_scan(runtime)
        from rabbit_hole.application.actions import get_action
        before = await get_action(runtime.engine, project['id'], queued['id'])
        task = asyncio.create_task(serve_local_worker(runtime, mode='paused', activation_validator=forbidden))
        await asyncio.sleep(.05)
        assert not task.done()
        from sqlalchemy import text
        async with runtime.engine.connect() as connection:
            assert await connection.scalar(text('SELECT COUNT(*) FROM workbench_actions')) == 1
        assert await get_action(runtime.engine, project['id'], queued['id']) == before
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_active_rejection_precedes_service_construction(paths):
    def reject(_):
        raise PermissionError('activation denied')
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        with pytest.raises(PermissionError, match='activation denied'):
            await serve_local_worker(runtime, mode='active', activation_validator=reject)


@pytest.mark.asyncio
async def test_invalid_mode_is_rejected(paths):
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        with pytest.raises(ValueError, match='mode'):
            await serve_local_worker(runtime, mode='unsafe', activation_validator=lambda _: None)


@pytest.mark.asyncio
@pytest.mark.parametrize('authorized', [False, None, 1, 'yes'])
async def test_only_exact_true_authorizes(paths, monkeypatch, authorized):
    from services import research_worker
    monkeypatch.setattr(research_worker, 'build_local_worker_services', lambda _: pytest.fail('factory before authorization'))
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        with pytest.raises(PermissionError):
            await serve_local_worker(runtime, mode='active', activation_validator=lambda _: authorized)


@pytest.mark.asyncio
async def test_true_without_configured_dependencies_fails_closed(paths):
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        with pytest.raises(RuntimeError, match='configuration_not_ready'):
            await serve_local_worker(runtime, mode='active', activation_validator=lambda _: True)


async def queued_scan(runtime):
    from uuid import uuid4

    from rabbit_hole.application.actions import enqueue_action
    store = runtime.store
    project = await store.create('synthetic worker', 'test fixture', 'US', str(uuid4()))
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word, 'approved': True})
    queued = await enqueue_action(store, project['id'], {'kind': 'scan', 'version': project['version'], 'keyword_id': word})
    return project, word, queued


@pytest.mark.asyncio
async def test_expired_lease_stops_inflight_fake_browser_and_cannot_commit(paths, monkeypatch):
    from datetime import UTC, datetime, timedelta
    from uuid import UUID

    from sqlalchemy import update
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        from rabbit_hole.application.actions import actions, get_action
        from rabbit_hole.application.runner import WorkbenchRunner
        project, _word, queued = await queued_scan(runtime)
        runner = WorkbenchRunner(runtime.store, runtime.settings, runtime.evidence_store)
        started, closed = asyncio.Event(), asyncio.Event()
        async def fake_browser(action, project):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        monkeypatch.setattr(runner, 'execute', fake_browser)
        task = asyncio.create_task(runner.run_once())
        await asyncio.wait_for(started.wait(), 2)
        async with runtime.engine.begin() as connection:
            await connection.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(lease_until=datetime.now(UTC) - timedelta(seconds=1)))
        try:
            await asyncio.wait_for(closed.wait(), 2)
            assert await asyncio.wait_for(task, 2)
            action = await get_action(runtime.engine, project['id'], queued['id'])
            assert action['status'] == 'running'
            assert action['result'] is None
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['stop', 'new_attempt', 'cancel'])
async def test_stale_attempt_and_cancellation_preserve_project(paths, monkeypatch, change):
    from uuid import UUID

    from sqlalchemy import update
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        from rabbit_hole.application.actions import actions, get_action, stop_action
        from rabbit_hole.application.runner import WorkbenchRunner
        project, word, queued = await queued_scan(runtime)
        runner = WorkbenchRunner(runtime.store, runtime.settings, runtime.evidence_store)
        started, resume = asyncio.Event(), asyncio.Event()
        async def fake_browser(action, _):
            started.set()
            await resume.wait()
            await runner.save(action, 'keyword_state', {'keyword_id': word, 'status': 'running'}, suffix='late')
            return {'ads': 1}
        monkeypatch.setattr(runner, 'execute', fake_browser)
        task = asyncio.create_task(runner.run_once())
        await asyncio.wait_for(started.wait(), 2)
        if change == 'stop':
            await stop_action(runtime.store, project['id'], queued['id'], 1)
        elif change == 'new_attempt':
            async with runtime.engine.begin() as connection:
                await connection.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(attempt=2))
        else:
            task.cancel()
        before = await runtime.store.get(project['id'])
        resume.set()
        if change == 'cancel':
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            assert await asyncio.wait_for(task, 2)
        assert await runtime.store.get(project['id']) == before
        assert (await get_action(runtime.engine, project['id'], queued['id']))['result'] is None


@pytest.mark.asyncio
async def test_active_uses_existing_runner_and_sync_and_closes_fake_browser(paths, monkeypatch):
    from types import SimpleNamespace

    from services import research_worker
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        from rabbit_hole.application.runner import WorkbenchRunner
        from rabbit_hole.application.sync import WorkbenchSync
        from rabbit_hole.runtime.workbench_worker import (
            WorkerAlreadyRunning,
            is_worker_live,
        )
        await queued_scan(runtime)
        runner = WorkbenchRunner(runtime.store, runtime.settings, runtime.evidence_store)
        sync = WorkbenchSync(runtime.store, SimpleNamespace(base_token='synthetic-only'))
        started, closed = asyncio.Event(), asyncio.Event()
        async def fake_browser(action, project):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        monkeypatch.setattr(runner, 'execute', fake_browser)
        monkeypatch.setattr(research_worker, 'build_local_worker_services', lambda _: research_worker.LocalWorkerServices(runner, sync))
        task = asyncio.create_task(serve_local_worker(runtime, mode='active', activation_validator=lambda _: True))
        try:
            await asyncio.wait_for(started.wait(), 2)
            assert await is_worker_live(runtime.engine)
            monkeypatch.setattr(research_worker, 'build_local_worker_services', lambda _: pytest.fail('standby must not construct clients'))
            with pytest.raises(WorkerAlreadyRunning):
                await serve_local_worker(runtime, mode='active', activation_validator=lambda _: True)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert closed.is_set()
        assert not await is_worker_live(runtime.engine)


@pytest.mark.asyncio
async def test_two_owned_processes_across_cwd_health_stop_and_restart(paths, tmp_path):
    import os
    import signal
    import subprocess
    import sys
    from pathlib import Path
    backend = Path(__file__).resolve().parents[1]
    env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(backend), str(backend.parent), os.environ.get('PYTHONPATH', ''))))
    command = [sys.executable, '-m', 'services.research_worker', '--database', str(paths.database), '--data-root', str(paths.evidence_root.parent), '--mode', 'paused']
    first_cwd, second_cwd = tmp_path / 'first', tmp_path / 'second'
    first_cwd.mkdir()
    second_cwd.mkdir()
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        from rabbit_hole.runtime.workbench_worker import is_worker_live
        async def live():
            for _ in range(100):
                if await is_worker_live(runtime.engine):
                    return
                await asyncio.sleep(.02)
            raise AssertionError('owned child failed to report health')
        first = await asyncio.to_thread(subprocess.Popen, command, cwd=first_cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            await live()
            second = await asyncio.to_thread(subprocess.run, command, cwd=second_cwd, env=env, capture_output=True, timeout=5)
            assert second.returncode == 1
            assert first.poll() is None
            assert await is_worker_live(runtime.engine)
            first.send_signal(signal.SIGTERM)
            await asyncio.to_thread(first.communicate, timeout=5)
            assert first.returncode == 0
            assert not await is_worker_live(runtime.engine)
            restarted = await asyncio.to_thread(subprocess.Popen, command, cwd=second_cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                await live()
                restarted.send_signal(signal.SIGTERM)
                await asyncio.to_thread(restarted.communicate, timeout=5)
                assert restarted.returncode == 0
            finally:
                if restarted.poll() is None:
                    restarted.kill()
                    await asyncio.to_thread(restarted.communicate, timeout=5)
            assert not await is_worker_live(runtime.engine)
        finally:
            if first.poll() is None:
                first.kill()
                await asyncio.to_thread(first.communicate, timeout=5)


@pytest.mark.asyncio
@pytest.mark.parametrize('lease', ['expired', 'missing'])
async def test_save_itself_fences_missing_or_expired_lease(paths, lease):
    from datetime import UTC, datetime, timedelta
    from uuid import UUID

    from sqlalchemy import select, update
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        from rabbit_hole.application.actions import SourceFailure, actions
        from rabbit_hole.application.runner import WorkbenchRunner
        project, word, queued = await queued_scan(runtime)
        before = await runtime.store.get(project['id'])
        async with runtime.engine.begin() as c:
            await c.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(
                status='running', attempt=1,
                lease_until=datetime.now(UTC) - timedelta(seconds=1) if lease == 'expired' else None))
            action = dict((await c.execute(select(actions).where(actions.c.id == UUID(queued['id'])))).mappings().one())
        runner = WorkbenchRunner(runtime.store, runtime.settings, runtime.evidence_store)
        with pytest.raises(SourceFailure, match='input_changed'):
            await runner.save(action, 'keyword_state', {'keyword_id': word, 'status': 'running'}, suffix='expired')
        assert await runtime.store.get(project['id']) == before


@pytest.mark.asyncio
async def test_readonly_runtime_refuses_even_true_authorization(paths):
    async with open_research_runtime(paths, allow_commands=False) as runtime:
        with pytest.raises(ValueError, match='prepared command runtime'):
            await serve_local_worker(runtime, mode='active', activation_validator=lambda _: True)


@pytest.mark.asyncio
async def test_missing_common_lock_root_refuses_before_authorization(paths):
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        runtime.engine.update_execution_options(research_lock_root=None)
        with pytest.raises(ValueError, match='common worker lock root'):
            await serve_local_worker(runtime, mode='active', activation_validator=lambda _: pytest.fail('wrong root'))


@pytest.mark.asyncio
async def test_owned_active_process_stops_fake_browser_without_committing(paths, tmp_path):
    import os
    import signal
    import subprocess
    import sys
    from pathlib import Path
    backend = Path(__file__).resolve().parents[1]
    env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(backend), str(backend.parent), os.environ.get('PYTHONPATH', ''))))
    child_script = tmp_path / 'synthetic_worker.py'
    child_script.write_text('''import asyncio, signal, sys
from pathlib import Path
from types import SimpleNamespace
from services.research_runtime import open_research_runtime, resolve_runtime_paths
from services import research_worker
async def run():
    paths = resolve_runtime_paths(Path(sys.argv[1]), Path(sys.argv[2]))
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        from rabbit_hole.application.runner import WorkbenchRunner
        from rabbit_hole.application.sync import WorkbenchSync
        runner = WorkbenchRunner(runtime.store, runtime.settings, runtime.evidence_store)
        async def fake_browser(action, project):
            Path(sys.argv[3]).write_text('started')
            try:
                await asyncio.Event().wait()
            finally:
                Path(sys.argv[4]).write_text('closed')
        runner.execute = fake_browser
        sync = WorkbenchSync(runtime.store, SimpleNamespace(base_token='synthetic-only'))
        research_worker.build_local_worker_services = lambda _: research_worker.LocalWorkerServices(runner, sync)
        task = asyncio.create_task(research_worker.serve_local_worker(runtime, mode='active', activation_validator=lambda _: True))
        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGTERM, task.cancel)
        try:
            await task
        except asyncio.CancelledError:
            pass
asyncio.run(run())
''')
    started, closed = tmp_path / 'fake-browser-started', tmp_path / 'fake-browser-closed'
    async with open_research_runtime(paths, allow_commands=True) as runtime:
        from rabbit_hole.application.actions import get_action
        from rabbit_hole.runtime.workbench_worker import is_worker_live
        project, _word, queued = await queued_scan(runtime)
        process = await asyncio.to_thread(subprocess.Popen, [sys.executable, str(child_script), str(paths.database), str(paths.evidence_root.parent), str(started), str(closed)], cwd=tmp_path, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if started.exists():
                    break
                await asyncio.sleep(.02)
            assert started.exists()
            assert await is_worker_live(runtime.engine)
            process.send_signal(signal.SIGTERM)
            await asyncio.to_thread(process.communicate, timeout=5)
            assert process.returncode == 0
            assert closed.read_text() == 'closed'
            assert not await is_worker_live(runtime.engine)
            action = await get_action(runtime.engine, project['id'], queued['id'])
            assert action['status'] == 'running' and action['attempt'] == 1
            assert action['result'] is None
        finally:
            if process.poll() is None:
                process.kill()
                await asyncio.to_thread(process.communicate, timeout=5)
