from uuid import uuid4

import pytest


async def test_stopping_known_apify_run_requests_cloud_abort(db_engine, tmp_path, monkeypatch):
    import httpx

    import rabbit_hole.integrations.provider_budget as provider
    from rabbit_hole.integrations.provider_jobs import read_logs
    from rabbit_hole.integrations.provider_settings import ProviderSecrets

    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    ProviderSecrets().update({'apify': 'test-token'})
    requests = []
    real_client = httpx.AsyncClient

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'data': {'status': 'ABORTING'}})

    monkeypatch.setattr(provider.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    project_id, action_id = str(uuid4()), str(uuid4())
    await provider.abort_apify_run(db_engine, project_id, action_id, 1, 'run-one')
    assert len(requests) == 1
    assert requests[0].method == 'POST'
    assert requests[0].url.path.endswith('/actor-runs/run-one/abort')
    assert requests[0].headers['Authorization'] == 'Bearer test-token'
    logs = await read_logs(db_engine, project_id, 0)
    assert any('请求停止' in row['message'] for row in logs)
    assert all('test-token' not in row['message'] for row in logs)


async def test_modes_are_frozen_and_logs_survive(db_engine):
    from rabbit_hole.application.actions import enqueue_action, get_action
    from rabbit_hole.integrations.provider_jobs import append_log, read_logs
    from rabbit_hole.persistence.projects import WorkbenchStore

    store = WorkbenchStore(db_engine)
    p = await store.create('provider-test', 'test', 'US', str(uuid4()))
    p = await store.command(p['id'], p['version'], str(uuid4()), 'configure_collection', {'meta': 'api', 'trends': 'ui'})
    p = await store.command(p['id'], p['version'], str(uuid4()), 'add_keyword', {'text': 'organizer', 'type': 'function'})
    word = p['keywords'][0]
    p = await store.command(p['id'], p['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word['id'], 'approved': True})
    q = await enqueue_action(store, p['id'], {'kind': 'scan', 'version': p['version'], 'keyword_id': word['id']})
    row = await get_action(db_engine, p['id'], q['id'])
    assert row['execution_mode'] == 'api'
    p = await store.get(p['id'])
    p = await store.command(p['id'], p['version'], str(uuid4()), 'configure_collection', {'meta': 'ui', 'trends': 'ui'})
    second = await enqueue_action(store, p['id'], {'kind': 'scan', 'version': p['version'], 'keyword_id': word['id']})
    assert second['id'] != q['id']
    assert (await get_action(db_engine, p['id'], second['id']))['execution_mode'] == 'ui'
    p = await store.get(p['id'])
    p = await store.command(p['id'], p['version'], str(uuid4()), 'configure_collection', {'meta': 'api', 'trends': 'ui'})
    third = await enqueue_action(store, p['id'], {'kind': 'scan', 'version': p['version'], 'keyword_id': word['id']})
    assert third['id'] not in {q['id'], second['id']}
    await append_log(db_engine, p['id'], q['id'], 1, 'request', '请求已提交')
    logs = await read_logs(db_engine, p['id'], 0)
    assert logs[0]['message'] == '请求已提交'
    assert await read_logs(db_engine, str(uuid4()), 0) == []
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id.in_([UUID(q['id']), UUID(second['id']), UUID(third['id'])])).values(status='complete'))


async def test_api_missing_key_is_logged_without_browser_fallback(db_engine, tmp_path, monkeypatch):
    from types import SimpleNamespace

    from rabbit_hole.application.actions import enqueue_action, get_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.integrations.provider_jobs import read_logs
    from rabbit_hole.persistence.projects import WorkbenchStore

    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    store = WorkbenchStore(db_engine)
    p = await store.create('no-key', 'test', 'US', str(uuid4()))
    p = await store.command(p['id'], p['version'], str(uuid4()), 'configure_collection', {'meta': 'api', 'trends': 'api'})
    p = await store.command(p['id'], p['version'], str(uuid4()), 'add_keyword', {'text': 'organizer', 'type': 'function'})
    word = p['keywords'][0]
    p = await store.command(p['id'], p['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word['id'], 'approved': True})
    q = await enqueue_action(store, p['id'], {'kind': 'scan', 'version': p['version'], 'keyword_id': word['id']})
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    async def forbidden(*args):
        raise AssertionError('browser fallback forbidden')
    monkeypatch.setattr(runner, 'scan', forbidden)
    await runner.run_once()
    row = await get_action(db_engine, p['id'], q['id'])
    assert row['status'] == 'blocked'
    assert '密钥' in row['diagnostic']
    assert any('密钥' in r['message'] for r in await read_logs(db_engine, p['id'], 0))


@pytest.mark.parametrize('market', ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP'])
async def test_apify_run_resumes_original_id_and_empty_is_not_failure(db_engine, tmp_path, monkeypatch, market):
    from types import SimpleNamespace

    import rabbit_hole.integrations.provider_budget as provider
    from rabbit_hole.application.actions import enqueue_action, get_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.integrations.provider_jobs import read_logs
    from rabbit_hole.integrations.provider_settings import ProviderSecrets
    from rabbit_hole.persistence.projects import WorkbenchStore

    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    ProviderSecrets().update({'apify': 'test-token'})
    store = WorkbenchStore(db_engine)
    p = await store.create('api-empty', 'test', market, str(uuid4()))
    p = await store.command(p['id'], p['version'], str(uuid4()), 'configure_collection', {'meta': 'api', 'trends': 'ui'})
    p = await store.command(p['id'], p['version'], str(uuid4()), 'add_keyword', {'text': 'rare phrase', 'type': 'function'})
    word = p['keywords'][0]
    p = await store.command(p['id'], p['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word['id'], 'approved': True})
    q = await enqueue_action(store, p['id'], {'kind': 'scan', 'version': p['version'], 'keyword_id': word['id']})
    calls = []
    async def fake_request(client, method, url, **kwargs):
        calls.append((method, url))
        if method == 'POST':
            from urllib.parse import parse_qs, urlsplit
            filters = parse_qs(urlsplit(kwargs['json']['urls'][0]['url']).query)
            assert filters['country'] == [market]
            assert filters['q'] == ['"rare phrase"']
            return {'data': {'id': 'run-one', 'defaultDatasetId': 'dataset-one', 'startedAt': '2026-10-02T00:00:00Z', 'buildId': 'build-one'}}
        if 'actor-runs/' in url:
            return {'data': {'id': 'run-one', 'defaultDatasetId': 'dataset-one', 'status': 'SUCCEEDED', 'usageTotalUsd': 0.001}}
        assert 'dataset-one' in url
        return [{'errorCode': 'ADS_NOT_FOUND'}]
    monkeypatch.setattr(provider, 'request_json', fake_request)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    assert await runner.run_once()
    assert (await get_action(db_engine, p['id'], q['id']))['status'] == 'ready'
    async with db_engine.begin() as c:
        from uuid import UUID

        from sqlalchemy import update

        from rabbit_hole.application.actions import actions
        await c.execute(update(actions).where(actions.c.id == UUID(q['id'])).values(lease_until=None))
    assert await runner.run_once()
    result = await get_action(db_engine, p['id'], q['id'])
    assert result['status'] == 'complete'
    assert result['result']['empty'] is True
    assert len([call for call in calls if call[0] == 'POST']) == 1
    assert 'run-one' in calls[1][1]
    assert any('0条' in r['message'] for r in await read_logs(db_engine, p['id'], 0))
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(q['id'])).values(payload={}))


@pytest.mark.parametrize('market', ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP'])
async def test_serpapi_two_windows_are_saved_without_ui_fallback(db_engine, tmp_path, monkeypatch, market):
    from types import SimpleNamespace

    import rabbit_hole.integrations.provider_budget as provider
    from rabbit_hole.application.actions import enqueue_action, get_action
    from rabbit_hole.application.runner import WorkbenchRunner
    from rabbit_hole.integrations.provider_settings import ProviderSecrets
    from rabbit_hole.persistence.projects import WorkbenchStore

    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    ProviderSecrets().update({'serpapi': 'test-token'})
    store = WorkbenchStore(db_engine)
    p = await store.create('trends-test', 'test', market, str(uuid4()))
    p = await store.command(p['id'], p['version'], str(uuid4()), 'configure_collection', {'meta': 'ui', 'trends': 'api'})
    p = await store.command(p['id'], p['version'], str(uuid4()), 'add_product', {'name': 'Organizer', 'url': 'https://shop.example/products/organizer'})
    product = p['products'][0]
    queued = await enqueue_action(store, p['id'], {'kind': 'trends', 'version': p['version'], 'product_id': product['id'], 'query': 'organizer'})
    calls = []
    async def fake_request(client, method, url, **kwargs):
        params = kwargs['params']
        assert params['geo'] == market
        calls.append(params['date'])
        count = 53 if params['date'] == 'today 12-m' else 262
        rows = [{'timestamp': str(1700000000 + i*604800), 'values': [{'query': 'organizer', 'value': '30', 'extracted_value': 30}]} for i in range(count)]
        rows[-1]['partial_data'] = True
        return {'search_metadata': {'status': 'Success', 'id': 'search-'+str(count), 'created_at': '2026-10-02 15:35:04 UTC'}, 'search_parameters': {'q': 'organizer', 'geo': market, 'date': params['date']}, 'interest_over_time': {'timeline_data': rows}}
    monkeypatch.setattr(provider, 'request_json', fake_request)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    await runner.run_once()
    row = await get_action(db_engine, p['id'], queued['id'])
    assert row['status'] == 'complete'
    assert calls == ['today 12-m', 'today 5-y']
    p = await store.get(p['id'])
    evidence = next(x for x in p['products'] if x['id'] == product['id'])['automatic_trends']
    assert len(evidence) == 2
    assert all(e['market'] == market and f'geo={market}' in e['source_url'] for e in evidence)
    from uuid import UUID

    from sqlalchemy import update

    from rabbit_hole.application.actions import actions
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(queued['id'])).values(payload={}))
