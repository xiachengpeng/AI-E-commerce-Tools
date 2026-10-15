"""Final acceptance gates use only source copies, temporary databases and fake I/O."""
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize('error_name', ['AIObserverError', 'AIProviderRequestError'])
async def test_real_extractor_records_failed_router_outcomes(tmp_path, error_name):
    from services.research_runtime import _research_imports
    _research_imports()
    from services import ai_router
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.runtime.legacy import RuntimeExtractor
    from rabbit_hole.extraction import ExtractionInput
    from tests.research import test_pipeline as f
    error = getattr(ai_router, error_name)('source_error' if error_name == 'AIObserverError' else 'ambiguous_outcome')
    class Generator:
        model_version = 'synthetic-v1'
        async def generate(self, **kwargs):
            raise error
    class Adapter:
        @contextmanager
        def extraction_generator(self):
            yield Generator()
    engine = create_engine('sqlite+aiosqlite:///' + str(tmp_path / 'extract.db'))
    await initialize_sqlite(engine)
    telemetry = AsyncMock()
    extractor = RuntimeExtractor(None, engine, telemetry, ai_adapter=Adapter())
    try:
        with pytest.raises(type(error)) as caught:
            await extractor.extract(ExtractionInput(landing=f.landing_success().value, captured_at=f.FrozenClock().now()))
        assert caught.value is error
        assert telemetry.record.await_args.kwargs['success'] is False
        assert telemetry.record.await_args.kwargs['schema_failure'] is True
    finally:
        await engine.dispose()


def test_launcher_bounds_real_open_sse_shutdown(tmp_path):
    import subprocess
    import sys
    import time
    import socket
    import httpx
    import run
    fixture = tmp_path / 'fixture.py'
    marker = tmp_path / 'closed'
    fixture.write_text('''import asyncio
from pathlib import Path
from fastapi import FastAPI
from starlette.responses import StreamingResponse
app=FastAPI()
@app.get('/stream')
async def stream():
    async def events():
        try:
            while True:
                yield 'data: fixture\\n\\n'
                await asyncio.sleep(.05)
        finally:
            Path('closed').write_text('closed')
    return StreamingResponse(events(),media_type='text/event-stream')
''')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    command = run.backend_command(str(tmp_path))
    command[command.index('main:app')] = 'fixture:app'
    command[command.index('--port')+1] = str(port)
    log = (tmp_path / 'server.log').open('w')
    process = subprocess.Popen(command, cwd=tmp_path, stdout=log, stderr=log)
    try:
        deadline = time.monotonic()+10
        while True:
            try:
                with socket.create_connection(('127.0.0.1',port), timeout=.1):
                    break
            except OSError:
                assert process.poll() is None
                assert time.monotonic() < deadline
                time.sleep(.05)
        with httpx.stream('GET', f'http://127.0.0.1:{port}/stream', timeout=2) as response:
            lines = response.iter_lines()
            assert next(lines) == 'data: fixture'
            started = time.monotonic()
            process.terminate()
            process.wait(timeout=9)
            assert time.monotonic()-started < 9
        assert marker.read_text() == 'closed'
    finally:
        if process.poll() is None:
            process.kill()  # Disposable fixture process only; never live app.
            process.wait()
        log.close()


@pytest.mark.asyncio
async def test_real_pipeline_unknown_extraction_preserves_failed_checkpoint_and_never_replays(tmp_path, monkeypatch):
    import httpx
    from contextlib import nullcontext
    from datetime import timedelta
    from services.research_runtime import _research_imports
    _research_imports()
    from services.ai_router import AIRouter
    from services.research_ai_adapter import ResearchAIAdapter
    from rabbit_hole.persistence.sql import create_engine, initialize_sqlite
    from rabbit_hole.persistence.legacy_jobs import JobRepository
    from rabbit_hole.domain.legacy import JobPayload, JobKind
    from rabbit_hole.runtime.legacy import RuntimeExtractor, _MeasuredPipeline
    from rabbit_hole.worker import Worker
    from rabbit_hole.integrations.feishu import protected_input_hash
    from tests.research import test_pipeline as f
    from tests.test_ai_router import snapshot
    engine = create_engine('sqlite+aiosqlite:///' + str(tmp_path / 'jobs.db'))
    await initialize_sqlite(engine)
    jobs = JobRepository(engine, f.FrozenClock())
    transport = AsyncMock()
    transport.generate.side_effect = httpx.ReadTimeout('synthetic uncertain submission')
    monkeypatch.setattr('services.ai_router.get_adapter', lambda _: transport)
    adapter = ResearchAIAdapter(router=AIRouter(), allow_external=True, session_factory=lambda: nullcontext(None))
    monkeypatch.setattr('services.ai_config_service.get_snapshot', lambda *_: snapshot())
    telemetry = AsyncMock()
    data = {'link':'https://shop.example/products/portable-blender', 'query':'portable blender', '人工｜状态':'开始验证', 'evaluation':f.complete_evaluation()}
    pipeline, _, feishu = f.pipeline(data=data, meta=f.FakeMeta(f.meta_success()), landing=f.FakeLanding(f.landing_success()), trends=f.FakeTrends(f.trends_success()), extractor=RuntimeExtractor(None, engine, telemetry, ai_adapter=adapter))
    pipeline._jobs = jobs
    try:
        queued = await jobs.enqueue(JobPayload(kind=JobKind.LINK_VALIDATION, record_id='source-1', input_version='v1', data=data, protected_input_hash=protected_input_hash(data)))
        measured = _MeasuredPipeline(pipeline, AsyncMock(), jobs=jobs, ai_adapter=adapter)
        leased_jobs = []
        original_lease = jobs.lease_next
        async def capture_lease(*args, **kwargs):
            leased = await original_lease(*args, **kwargs)
            if leased is not None:
                leased_jobs.append(leased)
            return leased
        monkeypatch.setattr(jobs, 'lease_next', capture_lease)
        worker = Worker(jobs=jobs, pipeline=measured, poller=None, worker_id='fixture', browser_concurrency=1, poll_seconds=60)
        result = await worker.run_once()
        assert result.outcome == 'succeeded'  # Original evidence-failure completion semantics.
        failed = await jobs.get_checkpoint(queued.id, 'extract')
        assert failed['status'] == 'failed'
        assert failed['error']['code'] == 'extraction_error'
        receipt = await jobs.get_checkpoint(queued.id, 'writeback')
        assert receipt['status'] == 'complete'
        usage = await jobs.get_checkpoint(queued.id, 'main_ai_usage')
        assert len(usage['calls']) == 1 and usage['calls'][0]['status'] == 'uncertain'
        assert transport.generate.await_count == 1
        assert (await worker.run_once()).outcome == 'idle'
        # Re-enter the actual Pipeline with the original lease identity: the
        # completed writeback returns unchanged before any extractor/provider I/O.
        mutations = dict(feishu.mutations)
        await pipeline.run(leased_jobs[0])
        assert feishu.mutations == mutations
        assert transport.generate.await_count == 1
        assert telemetry.record.await_args.kwargs['success'] is False
    finally:
        await engine.dispose()


def acceptance_fixture(tmp_path):
    import json
    import shutil
    root = Path(__file__).resolve().parents[2]
    coverage = tmp_path / 'coverage.json'
    shutil.copy2(root / 'docs/merge-assessment/full-merge-coverage.json', coverage)
    (tmp_path / 'main').mkdir()
    (tmp_path / 'research').mkdir()
    # A passing report must name actual test cases, not a manufactured count.
    pointers = [
        'backend/tests/test_full_merge_inventory.py::test_full_merge_coverage_matrix',
        'backend/tests/test_full_merge_data.py::test_all_versions_and_original_key_bytes',
        'backend/tests/test_full_merge_data.py::test_raw_rows_preserved_and_idempotent',
        'backend/tests/test_research_facade.py::test_all_local_v1_routes_reuse_lifecycle_and_session',
        'backend/tests/test_research_workbench_routes.py::test_original_business_route_inventory',
        'backend/tests/test_research_integration.py::test_direct_product_route_is_guarded_and_ownership_validated',
        'backend/tests/test_research_facade.py::test_idempotency_and_user_action_allowlist',
        'backend/tests/test_full_merge_no_remote.py::test_all_legacy_kinds_keep_actual_baseline_queue_behavior',
        'backend/tests/test_research_workbench_routes.py::test_native_history_canonical_projection_cursor_and_private_payload',
        'backend/tests/test_research_workbench_routes.py::test_native_draft_receipt_is_scoped_read_only_and_private',
    ]
    (tmp_path / 'component-results.json').write_text(json.dumps({'main':{'pytest':0,'frontend':0},'research':{'pytest':0,'frontend':0,'ruff':0,'mypy':0,'tailwind':0,'frontend_build':0}}))
    from xml.etree.ElementTree import Element, SubElement, ElementTree
    suite = Element('testsuite')
    for pointer in pointers:
        file, name = pointer.split('::')
        if name == 'test_all_legacy_kinds_keep_actual_baseline_queue_behavior':
            matrix = json.loads(coverage.read_text())
            for kind in matrix['inventories']['research']['job_kinds']:
                SubElement(suite, 'testcase', classname=file[:-3].replace('/','.'), name=name+'['+kind+']')
        else:
            SubElement(suite, 'testcase', classname=file[:-3].replace('/','.'), name=name)
    ElementTree(suite).write(tmp_path / 'main/pytest.xml')
    ElementTree(suite).write(tmp_path / 'research/pytest.xml')
    for kind in ('main','research'):
        (tmp_path / kind / 'frontend.log').write_text('# pass 1\n# fail 0\n')
    return coverage


def test_acceptance_rejects_missing_matrix_row_and_nonexistent_test_report(tmp_path):
    import json
    from scripts.full_merge.acceptance import acceptance
    coverage = acceptance_fixture(tmp_path)
    result = acceptance(coverage, tmp_path)
    assert result['local_code_accepted'], result
    assert result['observation']['status'] == 'pending_actual_use_days'
    assert result['external']['status'] == 'not_verified'
    data = json.loads(coverage.read_text())
    data['coverage'].pop()
    coverage.write_text(json.dumps(data))
    assert not acceptance(coverage, tmp_path)['local_code_accepted']
    (tmp_path / 'main/pytest.xml').unlink()
    assert not acceptance(coverage, tmp_path)['local_code_accepted']


def test_acceptance_rejects_failed_or_absent_case_and_suite(tmp_path):
    import json
    from scripts.full_merge.acceptance import acceptance
    coverage = acceptance_fixture(tmp_path)
    report = tmp_path / 'main/pytest.xml'
    report.write_text('<testsuite><testcase classname="unrelated" name="test_dummy"/></testsuite>')
    assert not acceptance(coverage,tmp_path)['local_code_accepted']
    values = json.loads((tmp_path / 'component-results.json').read_text())
    values['research']['ruff'] = 1
    (tmp_path / 'component-results.json').write_text(json.dumps(values))
    assert not acceptance(coverage,tmp_path)['local_code_accepted']


@pytest.mark.parametrize('kind', ['route','action','page','table','job_kind'])
def test_acceptance_rejects_each_inventory_omission(tmp_path, kind):
    import json
    from scripts.full_merge.acceptance import acceptance
    coverage = acceptance_fixture(tmp_path)
    data = json.loads(coverage.read_text())
    data['coverage'].remove(next(row for row in data['coverage'] if row['kind'] == kind))
    coverage.write_text(json.dumps(data))
    assert not acceptance(coverage,tmp_path)['local_code_accepted']


def test_acceptance_rejects_failed_source_case_despite_zero_component_code(tmp_path):
    from scripts.full_merge.acceptance import acceptance
    coverage = acceptance_fixture(tmp_path)
    (tmp_path / 'research/pytest.xml').write_text('<testsuite><testcase classname="tests.test_source" name="test_source"><failure>fixture</failure></testcase></testsuite>')
    assert not acceptance(coverage,tmp_path)['local_code_accepted']



def test_acceptance_requires_each_actual_legacy_kind_case(tmp_path):
    from scripts.full_merge.acceptance import acceptance
    coverage = acceptance_fixture(tmp_path)
    report = tmp_path / 'main/pytest.xml'
    report.write_text(report.read_text().replace('test_all_legacy_kinds_keep_actual_baseline_queue_behavior[meta_scan]', 'test_unrelated_kind'))
    assert not acceptance(coverage,tmp_path)['local_code_accepted']
