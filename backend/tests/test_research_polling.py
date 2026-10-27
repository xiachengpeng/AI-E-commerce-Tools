"""Synthetic polling contracts: no network, no real credentials or user queues."""
import asyncio
from types import SimpleNamespace

import pytest
from backend.tests.test_research_worker_local import paths


@pytest.mark.asyncio
async def test_poll_tick_records_failure_then_success_without_exception_payload(paths, caplog):
    from services.research_runtime import open_research_runtime
    from services.research_worker import FeishuPollingLoop
    from sqlalchemy import text
    class Operator:
        calls = 0
        async def poll_once(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError('test-secret-token-do-not-log')
            return 2
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        loop = FeishuPollingLoop(Operator(), runtime.engine, 60)
        assert await loop.tick() is False
        async with runtime.engine.connect() as c:
            rows = (await c.execute(text("SELECT component FROM runtime_health WHERE component LIKE 'feishu_poll_%'"))).scalars().all()
        assert rows == ['feishu_poll_failed']
        assert await loop.tick() is True
        async with runtime.engine.connect() as c:
            rows = (await c.execute(text("SELECT component FROM runtime_health WHERE component LIKE 'feishu_poll_%'"))).scalars().all()
        assert rows == ['feishu_poll_ok']
    assert 'test-secret-token' not in caplog.text


@pytest.mark.asyncio
async def test_poll_loop_respects_interval_after_failure_and_is_cancellable(paths):
    from services.research_runtime import open_research_runtime
    from services.research_worker import FeishuPollingLoop
    calls, waits = [], []
    reached = asyncio.Event()
    class Operator:
        async def poll_once(self):
            calls.append(1)
            if len(calls) == 1: raise OSError('private upstream diagnostic')
            reached.set()
            return 0
    async def wait(seconds):
        waits.append(seconds)
        if len(calls) == 1: return
        await asyncio.Event().wait()
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        task = asyncio.create_task(FeishuPollingLoop(Operator(), runtime.engine, 60, wait=wait).loop())
        await asyncio.wait_for(reached.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
    assert len(calls) == 2
    assert waits[0] == 60


@pytest.mark.asyncio
async def test_poll_cancel_during_remote_read_is_not_swallowed(paths):
    from services.research_runtime import open_research_runtime
    from services.research_worker import FeishuPollingLoop
    entered = asyncio.Event()
    class Operator:
        async def poll_once(self):
            entered.set()
            await asyncio.Event().wait()
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        task = asyncio.create_task(FeishuPollingLoop(Operator(), runtime.engine, 60).loop())
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task


@pytest.mark.asyncio
async def test_poll_timeout_marks_failure_and_does_not_start_consumer(paths):
    from services.research_runtime import open_research_runtime
    from services.research_worker import FeishuPollingLoop
    class Operator:
        async def poll_once(self): await asyncio.Event().wait()
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        assert await FeishuPollingLoop(Operator(), runtime.engine, 60, timeout_seconds=.01).tick() is False


@pytest.mark.asyncio
@pytest.mark.parametrize('enabled', [False, True])
async def test_unified_runner_only_adds_poller_when_explicitly_enabled(monkeypatch, enabled):
    from services.research_worker import UnifiedResearchRunner
    from services.research_runtime import _research_imports
    _research_imports()
    entered = set()
    ready = asyncio.Event()
    async def enter(name):
        entered.add(name)
        if len(entered) == (3 if enabled else 2): ready.set()
        await asyncio.Event().wait()
    class Native:
        async def loop(self): await enter('native')
    class Legacy:
        async def run_forever(self): await enter('legacy')
    class Operator:
        def __init__(self, **kw): assert kw['local_runtime'] is runtime
        async def build_worker(self): return Legacy()
    class Poller:
        def __init__(self, operator, engine, seconds):
            assert isinstance(operator, Operator) and engine is runtime.engine and seconds == 60
        async def loop(self): await enter('poller')
    monkeypatch.setattr('rabbit_hole.cli.DefaultOperatorRuntime', Operator)
    monkeypatch.setattr('services.research_worker.FeishuPollingLoop', Poller)
    runtime = SimpleNamespace(engine=object(), business_settings=SimpleNamespace(poll_seconds=60))
    task = asyncio.create_task(UnifiedResearchRunner(runtime, Native(), poll_feishu=enabled).loop())
    await asyncio.wait_for(ready.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert entered == ({'native','legacy','poller'} if enabled else {'native','legacy'})


@pytest.mark.parametrize('choice', [None, False, 'true', 1, True])
def test_launcher_polling_requires_exact_true_and_active_owner(tmp_path, choice):
    import json
    import run
    from backend.tests.test_full_merge_ownership import fixture_activation
    from services.research_activation import claim_activation
    paths, report = fixture_activation(tmp_path)
    activation = paths.keys_root / 'activation.json'
    activation.write_text(json.dumps(report)); activation.chmod(0o600)
    claim_activation(paths)
    config = {'enabled':True, 'worker_mode':'active', 'data_root':str(paths.evidence_root.parent), 'feishu_polling_enabled':choice}
    command = run.local_worker_command(config, paths.database)
    assert ('--poll-feishu' in command) is (choice is True)
    assert run.local_worker_command({**config, 'worker_mode':'paused'}, paths.database) is None


@pytest.mark.parametrize('choice', [None, False, 'true', 1, True])
def test_desktop_worker_forwards_only_exact_polling_opt_in(tmp_path, monkeypatch, choice):
    import desktop_entry
    import run
    from services import research_client, research_worker
    called = []
    monkeypatch.setattr(desktop_entry, 'configure_environment', lambda *_: None)
    monkeypatch.setenv('SQLITE_DB_PATH', str(tmp_path / 'history.db'))
    monkeypatch.setattr(research_client, 'load_research_config', lambda:{'worker_mode':'active', 'feishu_polling_enabled':choice})
    monkeypatch.setattr(run, 'local_worker_command', lambda *_:['owned'])
    async def capture(*args, **kwargs): called.append(kwargs.get('poll_feishu', False))
    monkeypatch.setattr(research_worker, '_run', capture)
    assert desktop_entry.main(['--mode','worker','--data-dir',str(tmp_path),'--resources-dir',str(tmp_path / 'resources')]) == 0
    assert called == [choice is True]


@pytest.mark.asyncio
async def test_repeated_ticks_preserve_needs_human_job_and_daily_budget(paths):
    from services.research_runtime import open_research_runtime
    from services.research_worker import FeishuPollingLoop
    from rabbit_hole.integrations.feishu import TriggerPoller, TriggerRecord
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.persistence.database import runtime_jobs, daily_usage
    from rabbit_hole.domain.legacy import BusinessStatus
    from rabbit_hole.persistence.sql import write_transaction
    from sqlalchemy import select, update
    class Source:
        async def list_trigger_records(self):
            return [TriggerRecord('关键词库','synthetic-record',BusinessStatus.KEYWORD_PENDING_SCAN.value,'1',{'人工｜关键词':'spark plug'})]
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        operator = TriggerPoller(Source(), JobRepository(runtime.engine))
        poller = FeishuPollingLoop(operator, runtime.engine, 60)
        assert await poller.tick() is True
        async with write_transaction(runtime.engine) as c:
            await c.execute(update(runtime_jobs).values(status='needs_human'))
        async with runtime.engine.connect() as c:
            before = (await c.execute(select(runtime_jobs))).all()
            budget = (await c.execute(select(daily_usage))).all()
        assert await poller.tick() is True
        async with runtime.engine.connect() as c:
            assert (await c.execute(select(runtime_jobs))).all() == before
            assert (await c.execute(select(daily_usage))).all() == budget
        assert len(before) == 1


@pytest.mark.asyncio
async def test_paused_worker_with_polling_opt_in_still_does_no_work(paths, monkeypatch):
    from services.research_runtime import open_research_runtime
    from services.research_worker import serve_local_worker
    def forbidden(*args, **kwargs): raise AssertionError('paused constructed external services')
    monkeypatch.setattr('services.research_worker.build_local_worker_services', forbidden)
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        task = asyncio.create_task(serve_local_worker(runtime, mode='paused', activation_validator=forbidden, poll_feishu=True))
        await asyncio.sleep(.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
