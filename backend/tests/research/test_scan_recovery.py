from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, insert, select, update

from rabbit_hole.application.actions import (
    actions,
    enqueue_action,
    get_action,
    list_actions,
)
from rabbit_hole.application.runner import WorkbenchRunner
from rabbit_hole.domain.project import WorkbenchError
from rabbit_hole.persistence.projects import WorkbenchStore


@pytest.fixture
async def scan_case(db_engine):
    # conftest supplies an isolated PostgreSQL database, never the live Compose DB.
    async with db_engine.begin() as c:
        await c.execute(delete(actions))
    store = WorkbenchStore(db_engine)
    p = await store.create('scan regression', 'test', 'US', str(uuid4()))
    for name, payload in [
        ('configure_collection', {'meta': 'api', 'trends': 'ui'}),
        ('add_keyword', {'text': 'pet travel bag', 'type': 'function'}),
    ]:
        p = await store.command(p['id'], p['version'], str(uuid4()), name, payload)
    word = p['keywords'][0]['id']
    p = await store.command(p['id'], p['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word, 'approved': True})
    q = await enqueue_action(store, p['id'], {'kind': 'scan', 'version': p['version'], 'keyword_id': word})
    yield store, p['id'], word, q['id']
    async with db_engine.begin() as c:
        await c.execute(delete(actions))


async def set_cloud(store, action_id, *, status='FAILED', error='source_error', uncertain=False):
    async with store.engine.begin() as c:
        row = (await c.execute(select(actions).where(actions.c.id == UUID(action_id)))).mappings().one()
        cloud = {'submission': 'uncertain'} if uncertain else {'id': 'old-run', 'dataset': 'old-data', 'status': status, 'started_at': datetime.now(UTC).isoformat()}
        payload = {**row['payload'], 'apify_run': cloud, 'provider_reservations': {'apify-run': {'provider': 'apify', 'day': datetime.now(UTC).date().isoformat()}}}
        await c.execute(update(actions).where(actions.c.id == UUID(action_id)).values(status='blocked', error_code=error, payload=payload))


async def retry(store, project_id, word):
    p = await store.get(project_id)
    return await enqueue_action(store, project_id, {'kind': 'scan', 'version': p['version'], 'keyword_id': word})


@pytest.mark.parametrize(('cloud_status', 'error'), [('ABORTED', 'stopped'), ('FAILED', 'source_error'), ('TIMED-OUT', 'timeout')])
async def test_terminal_api_retry_creates_fresh_run_and_preserves_old_ledger(scan_case, cloud_status, error):
    store, pid, word, old_id = scan_case
    await set_cloud(store, old_id, status=cloud_status, error=error)
    new = await retry(store, pid, word)
    assert new['id'] != old_id
    async with store.engine.connect() as c:
        rows = (await c.execute(select(actions).where(actions.c.project_id == UUID(pid)))).mappings().all()
    old = next(r for r in rows if str(r['id']) == old_id)
    fresh = next(r for r in rows if str(r['id']) == new['id'])
    assert old['status'] == 'blocked'
    assert old['payload']['apify_run']['id'] == 'old-run'
    assert old['payload']['provider_reservations']
    assert 'apify_run' not in fresh['payload']
    assert 'provider_reservations' not in fresh['payload']
    assert fresh['payload']['retry_of'] == old_id
    assert (await retry(store, pid, word))['id'] == new['id']


async def test_restart_obeys_project_scan_budget(scan_case):
    store, pid, word, old = scan_case
    await set_cloud(store, old)
    p = await store.get(pid)
    await store.command(pid, p['version'], str(uuid4()), 'configure_rules', {'rules': {'scan_batch_limit': 1, 'daily_scan_budget': 1}, 'reason': 'isolated limit'})
    with pytest.raises(WorkbenchError, match='预算'):
        await retry(store, pid, word)


async def test_resume_known_cloud_run_keeps_identity(scan_case):
    store, pid, word, old = scan_case
    await set_cloud(store, old, status='RUNNING')
    assert (await get_action(store.engine, pid, old))['recovery_action'] == 'resume'
    assert (await retry(store, pid, word))['id'] == old
    assert (await get_action(store.engine, pid, old))['display_status'] == 'cloud_running'


async def test_uncertain_submission_requires_manual_check(scan_case):
    store, pid, word, old = scan_case
    await set_cloud(store, old, uncertain=True)
    assert (await get_action(store.engine, pid, old))['recovery_action'] == 'manual'
    with pytest.raises(WorkbenchError, match='核对'):
        await retry(store, pid, word)


async def test_keyword_action_survives_twenty_newer_history_rows(scan_case):
    store, pid, word, old = scan_case
    now = datetime.now(UTC)
    async with store.engine.begin() as c:
        for i in range(25):
            await c.execute(insert(actions).values(id=uuid4(), project_id=UUID(pid), dedupe_key=str(uuid4()), kind='keywords', status='complete', input_version=1, payload={}, attempt=1, created_at=now+timedelta(seconds=i), updated_at=now))
    page = await list_actions(store.engine, pid)
    assert len(page['actions']) == 20
    assert old not in {r['id'] for r in page['actions']}
    assert page['keyword_actions'][word]['id'] == old
    assert (await list_actions(store.engine, str(uuid4())))['keyword_actions'] == {}


async def test_new_run_reserves_provider_budget_again(scan_case, monkeypatch):
    from rabbit_hole.integrations.collectors.provider_api import ProviderError
    from rabbit_hole.integrations.provider_budget import reserve
    store, pid, word, old = scan_case
    await set_cloud(store, old)
    new = await retry(store, pid, word)
    monkeypatch.setenv('RABBIT_HOLE_APIFY_DAILY_RUNS', '1')
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(new['id'])).values(status='running', attempt=1))
        row = dict((await c.execute(select(actions).where(actions.c.id == UUID(new['id'])))).mappings().one())
    with pytest.raises(ProviderError, match='预算'):
        await reserve(WorkbenchRunner(store, SimpleNamespace(), None), row, 'apify', 'apify-run')


async def test_logs_include_frozen_keyword_and_mode(scan_case):
    from rabbit_hole.integrations.provider_jobs import append_log, read_logs
    store, pid, word, action_id = scan_case
    await append_log(store.engine, pid, action_id, 1, 'poll', '等待云端')
    row = (await read_logs(store.engine, pid, 0))[0]
    assert row['keyword_text'] == '"pet travel bag"'
    assert row['execution_mode'] == 'api'
    assert row['keyword_id'] == word


async def test_stopped_api_search_submits_new_cloud_run_once_and_saves_bounded_empty(scan_case, monkeypatch, tmp_path):
    import rabbit_hole.integrations.provider_budget as provider
    from rabbit_hole.integrations.provider_settings import ProviderSecrets
    store, pid, word, old = scan_case
    await set_cloud(store, old, error='stopped', status='ABORTED')
    new = await retry(store, pid, word)
    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    ProviderSecrets().update({'apify': 'test-token'})
    calls = []

    async def request(client, method, url, **kwargs):
        calls.append((method, url))
        if method == 'POST':
            return {'data': {'id': 'new-run', 'defaultDatasetId': 'new-dataset', 'startedAt': datetime.now(UTC).isoformat(), 'status': 'READY'}}
        if 'actor-runs/' in url:
            assert url.endswith('/new-run')
            return {'data': {'status': 'SUCCEEDED'}}
        assert '/new-dataset/' in url
        return [{'errorCode': 'ADS_NOT_FOUND'}]

    monkeypatch.setattr(provider, 'request_json', request)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    assert await runner.run_once()
    assert (await get_action(store.engine, pid, new['id']))['display_status'] == 'cloud_running'
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(new['id'])).values(lease_until=None))
    assert await runner.run_once()
    view = await get_action(store.engine, pid, new['id'])
    assert view['status'] == 'complete'
    assert view['result']['run_id'] == 'new-run'
    assert sum(method == 'POST' for method, url in calls) == 1
    p = await store.get(pid)
    message = p['keywords'][0].get('message', '')
    assert '本次采集 0 条' in message
    assert '不能据此判断没有机会' in message


async def test_poll_failure_preserves_reason_and_last_request_stage(scan_case, monkeypatch, tmp_path):
    import httpx

    import rabbit_hole.integrations.provider_budget as provider
    from rabbit_hole.integrations.provider_settings import ProviderSecrets
    store, pid, word, old = scan_case
    await set_cloud(store, old, status='RUNNING')
    await retry(store, pid, word)
    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    ProviderSecrets().update({'apify': 'test-token'})

    async def fail_request(*args, **kwargs):
        raise httpx.ConnectError('SYNTHETIC_SECRET_DO_NOT_EXPORT')

    monkeypatch.setattr(provider, 'request_json', fail_request)
    await WorkbenchRunner(store, SimpleNamespace(), None).run_once()
    view = await get_action(store.engine, pid, old)
    assert view['failure_stage'] == 'poll'
    assert '连接失败' in view['diagnostic']
    assert 'SYNTHETIC_SECRET' not in view['diagnostic']
    assert view['recovery_action'] == 'resume'
