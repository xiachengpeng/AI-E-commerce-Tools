"""Local facade uses actual prepared Store and never an HTTP transport."""
import json
import sqlite3
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from services.research_client import ResearchError
from services.research_facade import ResearchFacade
from services.research_mapper import build_marketing_preview
from services.research_runtime import open_research_runtime, resolve_runtime_paths


@pytest_asyncio.fixture
async def local(tmp_path, monkeypatch):
    from backend.migrations.full_merge_v1 import prepare_schema
    def forbidden(*args, **kwargs):
        pytest.fail('local research invoked HTTP transport')
    monkeypatch.setattr(httpx.AsyncClient, '__init__', forbidden)
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', forbidden)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, 'handle_async_request', forbidden)
    database = tmp_path / 'history.db'
    sqlite3.connect(database).close()
    prepare_schema(database, backup_verified=True)
    root = tmp_path / 'research'
    root.mkdir(mode=0o700)
    paths = resolve_runtime_paths(database, root)
    for directory in (paths.evidence_root, paths.keys_root, paths.browser_root, paths.lock_root):
        directory.mkdir(mode=0o700)
    key = paths.keys_root / 'evidence-signing.key'
    key.write_bytes(bytes(range(32)))
    key.chmod(0o600)
    namespace = paths.keys_root / 'evidence-namespace.json'
    namespace.write_text(json.dumps({'version': 1, 'evidence_bucket': 'fixture-bucket', 'collector_version': 'fixture-collector'}))
    namespace.chmod(0o600)
    async with open_research_runtime(paths, allow_commands=True, offline_commands=True) as runtime:
        state = await runtime.store.create('Fixture project', 'Fixture direction', 'US', str(uuid4()))
        facade = ResearchFacade(runtime)
        project = await facade.command(state['id'], state['version'], str(uuid4()), 'add_product', {'name': 'Pouch', 'url': 'https://example.com/p'})
        yield facade, project, paths


@pytest.mark.asyncio
async def test_actual_store_dto_and_original_mapper(local):
    facade, project, _ = local
    from rabbit_hole.application.integration_contracts import (
        product_snapshot,
        project_snapshot,
    )
    raw = await facade.runtime.store.get(project['id'])
    from models.research import ProductSnapshot, ProjectSnapshot
    assert project == ProjectSnapshot.model_validate(project_snapshot(raw)).model_dump(mode='json')
    product_id = project['products'][0]['source_ref']['product_id']
    product = await facade.get_product(project['id'], product_id)
    assert product == ProductSnapshot.model_validate(product_snapshot(raw, raw['products'][0])).model_dump(mode='json')
    assert product['facts'][0]['state'] == 'inferred'
    assert build_marketing_preview(product, {})['fields'] == []
    page = await facade.list_projects()
    assert page['projects'][0]['id'] == project['id']
    assert (await facade.list_projects(project['id']))['projects'] == []
    assert (await facade.request('GET', '/projects/' + project['id'] + '/report'))['confirmed_fact_count'] == 0


@pytest.mark.asyncio
async def test_idempotency_and_user_action_allowlist(local):
    facade, project, _ = local
    command_id = str(uuid4())
    payload = {'text': 'cotton pouch', 'type': 'category'}
    first = await facade.command(project['id'], project['source_version'], command_id, 'add_keyword', payload)
    assert await facade.command(project['id'], project['source_version'], command_id, 'add_keyword', payload) == first
    with pytest.raises(ResearchError) as error:
        await facade.command(project['id'], first['source_version'], command_id, 'add_keyword', {'text': 'other', 'type': 'category'})
    assert error.value.status == 409
    with pytest.raises(ResearchError) as error:
        await facade.command(project['id'], first['source_version'], str(uuid4()), 'confirm_marketing_fact', {})
    assert error.value.status == 422


@pytest.mark.asyncio
async def test_fact_confirmation_identity_country_version_and_preview(local):
    facade, project, _ = local
    product = project['products'][0]
    payload = {'product_id': product['source_ref']['product_id'], 'identity_revision': 1, 'market': 'US', 'key': 'material', 'value': 'Cotton', 'source_url': 'https://example.com/p', 'own_product': True}
    path = '/projects/' + project['id'] + '/confirm-fact'
    for changed in ({'identity_revision': 2}, {'market': 'GB'}, {'source_url': ''}, {'own_product': False}):
        with pytest.raises(ResearchError) as error:
            await facade.request('POST', path, {'command_id': str(uuid4()), 'expected_version': project['source_version'], 'payload': {**payload, **changed}})
        assert error.value.status in {409, 422}
    result = await facade.request('POST', path, {'command_id': str(uuid4()), 'expected_version': project['source_version'], 'payload': payload})
    preview = build_marketing_preview(result['products'][0], {'productNameInput': 'Merchant name'})
    assert preview['fields'][0]['value'] == '材质: Cotton'
    assert preview['fields'][0]['selected'] is False
    with pytest.raises(ResearchError) as error:
        await facade.command(project['id'], project['source_version'], str(uuid4()), 'add_keyword', {'text': 'stale'})
    assert error.value.status == 409


@pytest.mark.asyncio
async def test_readonly_runtime_and_explicit_routing_no_fallback(local, monkeypatch):
    facade, project, paths = local
    async with open_research_runtime(paths) as readonly:
        reader = ResearchFacade(readonly)
        assert await reader.get_project(project['id']) == project
        with pytest.raises(ResearchError) as error:
            await reader.command(project['id'], project['source_version'], str(uuid4()), 'add_keyword', {'text': 'blocked'})
        assert error.value.status == 503
    from routes import research
    monkeypatch.setattr(research, 'load_research_config', lambda: {'enabled': True, 'mode': 'local'})
    with pytest.raises(Exception) as error:
        research.client()
    assert error.value.status_code == 503
    assert isinstance(research.client(runtime=facade.runtime), ResearchFacade)


@pytest.mark.asyncio
async def test_all_local_v1_routes_reuse_lifecycle_and_session(local, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research
    facade, project, _ = local
    monkeypatch.setattr(research, 'load_research_config', lambda: {'enabled': True, 'mode': 'local'})
    app = FastAPI()
    app.state.research_runtime = facade.runtime
    app.include_router(research.router)
    with TestClient(app, client=('127.0.0.1', 50000), base_url='http://127.0.0.1:9503') as browser:
        base = '/api/research/v1'
        session = browser.get(base + '/session').json()
        assert session['embed_url'] is None
        headers = {'X-Research-Token': session['csrf_token']}
        project_path = base + '/projects/' + project['id']
        product_id = project['products'][0]['source_ref']['product_id']
        product_path = project_path + '/products/' + product_id
        owned = browser.get(product_path, headers=headers)
        assert owned.status_code == 200
        assert owned.json() == await facade.get_product(project['id'], product_id)
        assert browser.get(product_path).status_code == 401
        assert browser.get(project_path + '/products/' + str(uuid4()), headers=headers).status_code == 404
        assert browser.get(base + '/projects/' + str(uuid4()) + '/products/' + product_id, headers=headers).status_code == 404
        for suffix in ('', '/report', '/actions'):
            assert browser.get(project_path + suffix, headers=headers).status_code == 200
        preview_payload = {'expected_source_version': project['source_version'], 'expected_identity_revision': 1, 'expected_market': 'US', 'existing': {'productNameInput': 'Merchant name'}}
        assert browser.post(product_path + '/preview', headers=headers, json=preview_payload).json()['fields'] == []
        for changed in ({'expected_source_version': 999}, {'expected_identity_revision': 2}, {'expected_market': 'GB'}):
            assert browser.post(product_path + '/preview', headers=headers, json={**preview_payload, **changed}).status_code == 409
        command_id = str(uuid4())
        confirm = {'command_id': command_id, 'expected_version': project['source_version'], 'identity_revision': 1, 'market': 'US', 'key': 'product_name', 'value': 'Verified pouch', 'source_url': 'https://example.com/p', 'own_product': True}
        result = browser.post(product_path + '/confirm-fact', headers=headers, json=confirm)
        assert result.status_code == 200
        for suffix in ('/confirmations/', '/commands/'):
            assert browser.get(project_path + suffix + command_id, headers=headers).json()['state'] == 'committed'
        preview_payload['expected_source_version'] = result.json()['source_version']
        name = browser.post(product_path + '/preview', headers=headers, json=preview_payload).json()['fields'][0]
        assert name['existing'] == 'Merchant name' and name['selected'] is False
        command_id = str(uuid4())
        body = {'expected_version': result.json()['source_version'], 'command_id': command_id, 'market': 'GB', 'action': 'add_keyword', 'payload': {'text': 'cotton pouch', 'type': 'category'}}
        assert browser.post(project_path + '/commands', headers=headers, json=body).status_code == 409
        body['market'] = 'US'
        assert browser.post(project_path + '/commands', headers=headers, json=body).status_code == 200
        assert browser.get(project_path + '/commands/' + command_id, headers=headers).json()['state'] == 'committed'
        app.state.research_runtime = None
        assert browser.get(project_path, headers=headers).status_code == 503
        assert browser.get(product_path, headers=headers).status_code == 503


@pytest.mark.asyncio
@pytest.mark.parametrize('changed,state', [({'provenance': 'ai'}, 'unknown'), ({'operator': 'automation'}, 'unknown'), ({'own_product': False}, 'unknown'), ({'identity_revision': 2}, 'stale'), ({'market': 'GB'}, 'stale'), ({'confirmed_at': '2999-01-01T00:00:00+00:00'}, 'unknown'), ({'valid_until': '2000-01-01T00:00:00+00:00'}, 'stale'), ({'source_url': ''}, 'unknown')])
async def test_original_fact_projection_retains_unknown_and_stale(local, changed, state):
    from services.research_mapper import map_product_snapshot
    facade, project, _ = local
    raw = await facade.runtime.store.get(project['id'])
    product = raw['products'][0]
    product['marketing_facts'] = [{
        'key': 'material', 'value': 'Cotton', 'identity_revision': 1, 'market': 'US',
        'provenance': 'manual', 'own_product': True, 'operator': 'local_user',
        'confirmed_at': '2026-10-09T00:00:00+00:00', 'source_url': 'https://example.com/p', **changed}]
    snapshot = map_product_snapshot(raw, product)
    assert snapshot['facts'][1]['state'] == state
    assert build_marketing_preview(snapshot, {})['fields'] == []


@pytest.mark.asyncio
async def test_saved_legacy_fact_fixture_matches_local_projection(local):
    from services.research_mapper import map_product_snapshot

    from backend.tests.test_research_integration import snapshot as saved_fixture
    facade, project, _ = local
    raw = await facade.runtime.store.get(project['id'])
    product = raw['products'][0]
    product['marketing_facts'] = [{'key': 'material', 'value': 'Cotton', 'identity_revision': 1, 'market': 'US', 'provenance': 'manual', 'own_product': True, 'operator': 'local_user', 'confirmed_at': '2026-10-09T00:00:00+00:00', 'source_url': 'https://example.com/p'}]
    projected = map_product_snapshot(raw, product)
    saved = saved_fixture()
    saved['source_ref'] = projected['source_ref']
    # The original source always also emits its inferred name and SOP steps.
    saved['facts'].insert(0, projected['facts'][0])
    saved['steps'] = projected['steps']
    from models.research import ProductSnapshot
    saved = ProductSnapshot.model_validate(saved).model_dump(mode='json')
    assert projected == saved
    assert build_marketing_preview(projected, {}) == build_marketing_preview(saved, {})


@pytest.mark.asyncio
async def test_local_dispatch_invalid_and_missing_never_calls_remote(local):
    facade, project, _ = local
    for path in ('/other', '/projects/../secret', '/projects/' + project['id'] + '/unsupported'):
        with pytest.raises(ResearchError) as error:
            await facade.request('GET', path)
        assert error.value.status == 422
    with pytest.raises(ResearchError) as error:
        await facade.get_product(project['id'], str(uuid4()))
    assert error.value.status == 404
    with pytest.raises(ResearchError) as error:
        await facade.get_project(str(uuid4()))
    assert error.value.status == 404


@pytest.mark.asyncio
async def test_confirmed_preview_matches_readonly_without_writes(local):
    facade, project, paths = local
    product_id = project['products'][0]['source_ref']['product_id']
    command_id = str(uuid4())
    await facade.request('POST', '/projects/' + project['id'] + '/confirm-fact', {
        'command_id': command_id, 'expected_version': project['source_version'],
        'payload': {'product_id': product_id, 'identity_revision': 1, 'market': 'US',
                    'key': 'material', 'value': 'Cotton', 'source_url': 'https://example.com/p', 'own_product': True}})
    product = await facade.get_product(project['id'], product_id)
    expected = build_marketing_preview(product, {'productNameInput': 'Merchant name'})
    async with open_research_runtime(paths) as runtime:
        reader = ResearchFacade(runtime)
        assert runtime.commands_enabled is False
        assert build_marketing_preview(await reader.get_product(project['id'], product_id), {'productNameInput': 'Merchant name'}) == expected
        from sqlalchemy import text
        async with runtime.engine.connect() as connection:
            assert await connection.scalar(text('PRAGMA query_only')) == 1
        assert (await reader.request('GET', '/projects/' + project['id'] + '/confirmations/' + command_id))['state'] == 'committed'
