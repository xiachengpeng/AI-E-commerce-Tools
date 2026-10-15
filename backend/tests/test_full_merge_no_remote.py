"""Local consolidation contracts; all inputs synthetic, no remote operations."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request


def test_old_remote_config_is_read_as_local(tmp_path, monkeypatch):
    from services.research_client import load_research_config
    path = tmp_path / 'research.json'
    path.write_text(json.dumps({'enabled': True, 'mode': 'remote', 'base_url': 'http://127.0.0.1:19503'}))
    path.chmod(0o600)
    monkeypatch.setenv('RESEARCH_INTEGRATION_CONFIG', str(path))
    assert load_research_config()['mode'] == 'local'


def test_compatibility_client_cannot_activate_remote(monkeypatch):
    from routes import research
    from services.research_facade import ResearchFacade
    from services.research_runtime import _research_imports
    _research_imports()
    monkeypatch.setattr('services.research_client.ResearchClient', lambda *_: pytest.fail('remote client activated'))
    result = research.client(runtime=SimpleNamespace(engine=object(), diagnostics=(), store=object()), config={'enabled': True, 'mode': 'remote'})
    assert isinstance(result, ResearchFacade)


@pytest.mark.parametrize('peer', ['192.168.1.7', '10.0.0.4', 'testclient', None])
def test_spoofed_local_host_does_not_admit_lan_peer(peer):
    from services.research_security import require_research_session
    request = Request({'type': 'http', 'method': 'GET', 'path': '/',
                       'headers': [(b'host', b'127.0.0.1:9503')],
                       'client': (peer, 1234) if peer else None})
    with pytest.raises(HTTPException) as error:
        require_research_session(request, write=False, bootstrap=True)
    assert error.value.status_code == 403


@pytest.mark.parametrize('peer', ['127.0.0.1', '::1'])
def test_loopback_bootstrap_remains_supported(peer):
    from services.research_security import require_research_session
    require_research_session(Request({'type': 'http', 'method': 'GET', 'path': '/',
        'headers': [(b'host', b'127.0.0.1:9503')], 'client': (peer, 1234)}), write=False, bootstrap=True)


def test_archived_tunnel_entry_is_inert(monkeypatch):
    from services import research_tunnel
    monkeypatch.setattr(__import__('subprocess'), 'Popen', lambda *_a, **_kw: pytest.fail('SSH started'))
    research_tunnel.main()


def test_legacy_default_operator_cannot_construct_another_consumer(monkeypatch):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.cli import DefaultOperatorRuntime, RuntimeConfigurationError
    monkeypatch.setattr('rabbit_hole.config.get_settings', lambda: pytest.fail('source environment read'))
    with pytest.raises(RuntimeConfigurationError, match='owned_local_runtime_required'):
        DefaultOperatorRuntime()


@pytest.mark.asyncio
async def test_owned_legacy_builder_consumes_only_and_ignores_old_factory(monkeypatch):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.cli import DefaultOperatorRuntime
    from rabbit_hole.config import AdmissionLimits
    from rabbit_hole.persistence.sql import create_engine
    engine = create_engine('sqlite+aiosqlite:///:memory:')
    runtime = SimpleNamespace(diagnostics=(), engine=engine,
        business_settings=SimpleNamespace(admission=AdmissionLimits(), browser_concurrency=2, poll_seconds=60, market=SimpleNamespace(), public_dns='system', trend_thresholds=SimpleNamespace()),
        non_ai_integrations=SimpleNamespace(feishu=SimpleNamespace()),
        evidence_store=object(), ai_adapter=object())
    monkeypatch.setenv('RABBIT_HOLE_WORKER_FACTORY', 'nonexistent:unsafe')
    try:
        worker = await DefaultOperatorRuntime(local_runtime=runtime).build_worker()
        assert worker._jobs._database is engine
        assert worker._pipeline.pipeline._storage is runtime.evidence_store
        assert worker._pipeline.pipeline._extractor.ai_adapter is runtime.ai_adapter
        assert worker._poller is None
        assert worker._maintenance is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_native_and_legacy_loops_share_owned_runner(monkeypatch):
    import asyncio
    from services.research_worker import UnifiedResearchRunner
    entered = []
    class Native:
        async def loop(self):
            entered.append('native')
            await asyncio.Event().wait()
    class Legacy:
        async def run_forever(self):
            entered.append('legacy')
            await asyncio.Event().wait()
    async def build(self):
        assert self.local_runtime is runtime
        return Legacy()
    from rabbit_hole.cli import DefaultOperatorRuntime
    monkeypatch.setattr(DefaultOperatorRuntime, '__init__', lambda self, **kw: setattr(self, 'local_runtime', kw['local_runtime']))
    monkeypatch.setattr(DefaultOperatorRuntime, 'build_worker', build)
    runtime = object()
    task = asyncio.create_task(UnifiedResearchRunner(runtime, Native()).loop())
    await asyncio.sleep(.01)
    assert set(entered) == {'native', 'legacy'}
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_idle_sync_does_not_resolve_external_credentials(monkeypatch):
    from services.research_integrations import ResearchSync
    from sqlalchemy.ext.asyncio import create_async_engine
    from rabbit_hole.application.sync import runs
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as c:
        await c.run_sync(runs.create)
    sync = ResearchSync(SimpleNamespace(engine=engine), None, allow_external=True)
    monkeypatch.setattr(sync, '_service', lambda **_: pytest.fail('idle external resolution'))
    try:
        assert await sync.run_once() is False
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_ai_fence_budget_unknown_and_context_reset(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from services.research_ai_adapter import ResearchAIAdapter
    from services.research_legacy_ai import reserve_legacy_ai, record_legacy_ai
    from datetime import timedelta
    engine = create_engine('sqlite+aiosqlite:///' + str(tmp_path / 'jobs.db'))
    await initialize_sqlite(engine)
    jobs = JobRepository(engine)
    try:
        queued = await jobs.enqueue(JobPayload(kind=JobKind.KEYWORD_SEED, record_id='fixture', input_version='v1'))
        leased = await jobs.lease_next('owner', lease_for=timedelta(minutes=5))
        rid = await reserve_legacy_ai(jobs, leased, 'extract')
        await record_legacy_ai(jobs, leased, rid, 'uncertain')
        with pytest.raises(ValueError, match='unknown'):
            await reserve_legacy_ai(jobs, leased, 'extract')
        from dataclasses import replace
        with pytest.raises(Exception, match='leased'):
            await reserve_legacy_ai(jobs, replace(leased, leased_by='intruder'), 'extract')
        adapter = ResearchAIAdapter()
        assert adapter._legacy.get() is None
        with pytest.raises(RuntimeError):
            with adapter.legacy_context(jobs, leased):
                assert adapter._legacy.get() == (jobs, leased)
                raise RuntimeError('reset')
        assert adapter._legacy.get() is None
        assert queued.payload.estimated_ai_calls == 60
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_router_unknown_is_not_replayed(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from services.research_ai_adapter import ResearchAIAdapter
    from models.research_ai import ResearchAIRequest, ResearchDirection
    from datetime import timedelta
    from unittest.mock import AsyncMock
    engine = create_engine('sqlite+aiosqlite:///' + str(tmp_path / 'jobs.db'))
    await initialize_sqlite(engine)
    jobs = JobRepository(engine)
    router = AsyncMock()
    async def unknown(*args, **kwargs):
        await kwargs['attempt_observer']({'status':'uncertain', 'network_attempt':1, 'terminal':True})
        pytest.fail('observer must stop unknown submission')
    router.generate.side_effect = unknown
    adapter = ResearchAIAdapter(router=router, allow_external=True)
    try:
        await jobs.enqueue(JobPayload(kind=JobKind.KEYWORD_SEED, record_id='fixture', input_version='v1'))
        leased = await jobs.lease_next('owner', lease_for=timedelta(minutes=5))
        request = ResearchAIRequest(operation='extract', schema=ResearchDirection, system_instruction='fixture', untrusted_data='fixture', action_id=None, attempt=0)
        with adapter.legacy_context(jobs, leased):
            with pytest.raises(ValueError):
                await adapter.generate(request)
            with pytest.raises(ValueError, match='unknown'):
                await adapter.generate(request)
        assert router.generate.await_count == 1
        assert router.generate.call_args.args[1]['operation_id'].startswith('research-legacy:')
    finally:
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['niche_discovery', 'niche_research', 'keyword_seed', 'keyword_scan', 'link_validation', 'meta_scan', 'landing_scan', 'trends_scan', 'evaluate', 'feishu_writeback'])
async def test_all_legacy_kinds_keep_actual_baseline_queue_behavior(tmp_path, kind):
    from services.research_runtime import _research_imports
    _research_imports()
    from tests.research import test_pipeline as f
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.worker import Worker
    from rabbit_hole.integrations.feishu import protected_input_hash
    from sqlalchemy import select
    from rabbit_hole.persistence.database import runtime_jobs
    card = {'generic_term':'pet travel', 'representative_keywords':['dog care','cat care','pet grooming','pet enrichment','pet travel'],
        'target_audience':'owners', 'core_problem':'cleanup', 'filming_scenarios':['car'], 'potential_price_band':'unknown',
        'logistics_warnings':[], 'compliance_warnings':[], 'trends':{'source':'fixture'},
        'meta':{'source':'fixture','representative_keywords':['dog care','cat care','pet grooming','pet enrichment','pet travel']}}
    data = {'人工｜大类':'home organization','人工｜状态':'待生成'}
    if kind == 'niche_research':
        data = {'人工｜状态':'待研究', 'AUTO｜研究证据卡':json.dumps(card)}
    elif kind == 'keyword_seed':
        data = {'人工｜状态':'已启用','AUTO｜细分领域':'pet travel','人工｜研究证据已确认':True,'人工｜研究证据卡':json.dumps(card)}
    elif kind == 'keyword_scan':
        data = {'AUTO｜实际搜索词':'portable blender', '人工｜状态':'待扫描'}
    elif kind == 'link_validation':
        data = {'link':'https://shop.example/products/portable-blender?utm_source=ad','query':'portable blender','人工｜状态':'开始验证','evaluation':f.complete_evaluation()}
    class Generator:
        count = 0
        async def generate(self, *, schema, **kwargs):
            self.count += 1
            if schema is f.NicheCandidate:
                return schema(name=f'niche-{self.count}', ai_rationale='fixture')
            return schema(query=f'fixture product term {self.count}')
    engine = create_engine('sqlite+aiosqlite:///' + str(tmp_path / 'jobs.db'))
    await initialize_sqlite(engine)
    jobs = JobRepository(engine, f.FrozenClock())
    service, _, feishu = f.pipeline(data=data, meta=f.FakeMeta(f.meta_success()), landing=f.FakeLanding(f.landing_success()), trends=f.FakeTrends(f.trends_success()), extractor=f.FakeExtractor(), niche_generator=Generator())
    service._jobs = jobs
    try:
        queued = await jobs.enqueue(JobPayload(kind=JobKind(kind), record_id='source-1', input_version='v1', data=data, protected_input_hash=protected_input_hash(data)))
        worker = Worker(jobs=jobs, pipeline=service, poller=None, worker_id='fixture-worker', browser_concurrency=1, poll_seconds=60)
        outcome = await worker.run_once()
        async with engine.connect() as c:
            row = (await c.execute(select(runtime_jobs).where(runtime_jobs.c.id == queued.id))).mappings().one()
        if kind in {'meta_scan','landing_scan','trends_scan','evaluate','feishu_writeback'}:
            assert outcome.outcome == 'needs_human'
            assert row['failure_code'] == 'unsupported_job_kind'
            assert feishu.mutations == {}
            assert await jobs.get_checkpoint(queued.id, 'writeback') is None
        else:
            assert outcome.outcome == 'succeeded'
            assert row['status'] == 'succeeded'
            receipt = await jobs.get_checkpoint(queued.id, 'writeback')
            assert receipt['status'] == 'complete'
            assert receipt['result']['status'] in {'待研究','待人工选择','已启用','待人工复核'}
        assert await worker.run_once() == __import__('rabbit_hole.worker', fromlist=['WorkerRunResult']).WorkerRunResult(outcome='idle')
    finally:
        await engine.dispose()


def test_legacy_cli_queue_report_is_readonly_and_does_not_build_worker(tmp_path, monkeypatch, capsys):
    import sqlite3
    from rabbit_hole import cli
    path = tmp_path / 'old.db'
    with sqlite3.connect(path) as c:
        c.execute('CREATE TABLE runtime_jobs(kind TEXT,status TEXT,attempt INTEGER)')
        c.execute("INSERT INTO runtime_jobs VALUES ('meta_scan','needs_human',3)")
    before = path.read_bytes()
    monkeypatch.setattr(cli, 'DefaultOperatorRuntime', lambda: pytest.fail('worker construction'))
    assert cli.main(['queue-report', '--database', str(path)]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report['result']['jobs'] == [{'kind':'meta_scan', 'status':'needs_human', 'count':1, 'max_attempt':3}]
    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_completed_historical_writeback_receipt_is_read_without_replay(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.persistence.database import job_checkpoints
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from rabbit_hole.pipeline import Pipeline, PipelineResult
    from rabbit_hole.worker import Worker
    from datetime import UTC, datetime
    engine = create_engine('sqlite+aiosqlite:///' + str(tmp_path / 'jobs.db'))
    await initialize_sqlite(engine)
    jobs = JobRepository(engine)
    try:
        queued = await jobs.enqueue(JobPayload(kind=JobKind.FEISHU_WRITEBACK, record_id='fixture', input_version='v1'))
        receipt = {'status':'complete','result':PipelineResult(status='待人工复核').model_dump(mode='json')}
        async with engine.begin() as c:
            await c.execute(job_checkpoints.insert().values(job_id=queued.id,stage='writeback',data=receipt,created_at=datetime.now(UTC)))
        worker = Worker(jobs=jobs,pipeline=Pipeline(jobs=jobs,feishu=None),poller=None,worker_id='fixture',browser_concurrency=1,poll_seconds=60)
        assert (await worker.run_once()).outcome == 'succeeded'
        assert await jobs.get_checkpoint(queued.id,'writeback') == receipt
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_unknown_legacy_ai_worker_stops_manual_not_retry(tmp_path, monkeypatch):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from rabbit_hole.runtime.legacy import _MeasuredPipeline
    from rabbit_hole.worker import Worker
    from services.research_ai_adapter import ResearchAIAdapter
    from models.research_ai import ResearchAIRequest, ResearchDirection
    from unittest.mock import AsyncMock
    engine = create_engine('sqlite+aiosqlite:///' + str(tmp_path / 'jobs.db'))
    await initialize_sqlite(engine)
    jobs = JobRepository(engine)
    import httpx
    from services.ai_router import AIRouter
    from tests.test_ai_router import snapshot
    transport = AsyncMock()
    transport.generate.side_effect = httpx.ReadTimeout('synthetic unknown')
    monkeypatch.setattr('services.ai_router.get_adapter', lambda _: transport)
    adapter=ResearchAIAdapter(router=AIRouter(),allow_external=True)
    adapter._snapshot.set(snapshot())
    class FakeIOPipeline:
        async def run(self, job):
            await adapter.generate(ResearchAIRequest(operation='extract',schema=ResearchDirection,system_instruction='fixture',untrusted_data='fixture',action_id=None,attempt=0))
    try:
        queued=await jobs.enqueue(JobPayload(kind=JobKind.KEYWORD_SEED,record_id='fixture',input_version='v1'))
        measured=_MeasuredPipeline(FakeIOPipeline(),AsyncMock(),jobs=jobs,ai_adapter=adapter)
        worker=Worker(jobs=jobs,pipeline=measured,poller=None,worker_id='fixture',browser_concurrency=1,poll_seconds=60)
        result=await worker.run_once()
        assert result.outcome=='needs_human'
        assert result.failure_code=='legacy_ai_manual_reconciliation'
        assert transport.generate.await_count==1
        assert (await worker.run_once()).outcome=='idle'
        assert (await jobs.get_checkpoint(queued.id,'main_ai_usage'))['calls'][0]['status']=='uncertain'
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_ai_cannot_exceed_original_admitted_calls(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from services.research_legacy_ai import reserve_legacy_ai, record_legacy_ai
    from datetime import timedelta
    engine=create_engine('sqlite+aiosqlite:///'+str(tmp_path/'jobs.db'))
    await initialize_sqlite(engine)
    jobs=JobRepository(engine)
    try:
        await jobs.enqueue(JobPayload(kind=JobKind.LINK_VALIDATION,record_id='fixture',input_version='v1'))
        job=await jobs.lease_next('owner',lease_for=timedelta(minutes=5))
        rid=await reserve_legacy_ai(jobs,job,'extract')
        await record_legacy_ai(jobs,job,rid,'succeeded')
        with pytest.raises(ValueError,match='budget'):
            await reserve_legacy_ai(jobs,job,'extract')
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_real_idle_unified_worker_holds_one_owner_without_external_probes(tmp_path, monkeypatch):
    import asyncio
    from models.research_ai import ResearchBusinessSettings
    from tests.test_research_ai_adapter import business_values
    from tests.test_full_merge_ownership import fixture_activation
    from services.research_runtime import open_research_runtime
    from services.research_worker import serve_local_worker
    from unittest.mock import Mock
    paths, _ = fixture_activation(tmp_path)
    namespace=paths.keys_root/'evidence-namespace.json'
    namespace.write_text(json.dumps({'version':1,'evidence_bucket':'fixture','collector_version':'fixture'}));namespace.chmod(0o600)
    forbidden=Mock(side_effect=AssertionError('idle worker opened HTTP transport'))
    monkeypatch.setattr('httpx.AsyncClient.__init__',forbidden)
    async with open_research_runtime(paths,allow_commands=True,offline_commands=True,business_settings=ResearchBusinessSettings.model_validate(business_values())) as runtime:
        from rabbit_hole.runtime.workbench_worker import is_worker_live, WorkerAlreadyRunning
        task=asyncio.create_task(serve_local_worker(runtime,mode='active',activation_validator=lambda _:True))
        try:
            for _ in range(100):
                if await is_worker_live(runtime.engine):
                    break
                await asyncio.sleep(.01)
            assert await is_worker_live(runtime.engine)
            # Both actual default queue loops were constructed under this lock.
            for _ in range(100):
                names={t.get_name() for t in asyncio.all_tasks()}
                if {'research-native-actions','research-legacy-queue'} <= names:
                    break
                await asyncio.sleep(.01)
            assert {'research-native-actions','research-legacy-queue'} <= names
            with pytest.raises(WorkerAlreadyRunning):
                await serve_local_worker(runtime,mode='active',activation_validator=lambda _:True)
            forbidden.assert_not_called()
            assert not task.done()
        finally:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)
        assert not await is_worker_live(runtime.engine)


@pytest.mark.asyncio
async def test_legacy_fence_preserves_central_controller_known_failure_retry(tmp_path):
    from services.research_runtime import _research_imports
    _research_imports()
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from services.research_ai_adapter import ResearchAIAdapter
    from models.research_ai import ResearchAIRequest, ResearchDirection
    from datetime import timedelta
    from unittest.mock import AsyncMock
    engine=create_engine('sqlite+aiosqlite:///'+str(tmp_path/'jobs.db'))
    await initialize_sqlite(engine)
    jobs=JobRepository(engine)
    router=AsyncMock()
    async def central_retry(*args, **kwargs):
        observer=kwargs['attempt_observer']
        for status, number in [('submitted',1),('failed',1),('retrying',1),('submitted',2),('received',2)]:
            await observer({'status':status,'network_attempt':number})
        return {'candidates':[{'content':{'parts':[{'text':'{"direction":"verified fixture"}'}]}}]}
    router.generate.side_effect=central_retry
    adapter=ResearchAIAdapter(router=router,allow_external=True)
    try:
        await jobs.enqueue(JobPayload(kind=JobKind.LINK_VALIDATION,record_id='fixture',input_version='v1'))
        job=await jobs.lease_next('owner',lease_for=timedelta(minutes=5))
        with adapter.legacy_context(jobs,job):
            value=await adapter.generate(ResearchAIRequest(operation='extract',schema=ResearchDirection,system_instruction='fixture',untrusted_data='fixture',action_id=None,attempt=0))
        assert value.direction=='verified fixture'
        assert router.generate.await_count==1
        calls=(await jobs.get_checkpoint(job.id,'main_ai_usage'))['calls']
        assert len(calls)==1 and calls[0]['status']=='succeeded'
    finally:
        await engine.dispose()
