"""Guard against remote secret exposure, unbounded reads, and forged facts."""
from uuid import uuid4
import httpx
import pytest


def snapshot(state='confirmed'):
    return {'contract_version': 1, 'source_ref': {'system': 'rabbit_hole', 'project_id': str(uuid4()), 'product_id': str(uuid4()), 'identity_revision': 1, 'source_version': 2},
            'market': 'US', 'name': 'Pouch', 'url': 'https://example.com/p', 'merged': False,
            'decision': None, 'steps': [], 'facts': [
                {'key': 'material', 'value': 'Cotton', 'state': state, 'confirmation_method': 'manual' if state=='confirmed' else None,
                 'confirmed_at': '2026-10-09T00:00:00+00:00' if state=='confirmed' else None, 'evidence_refs': ['https://example.com/p']}]}


@pytest.mark.asyncio
async def test_client_rejects_malformed_contract_and_hides_upstream_secrets():
    from services.research_client import ResearchClient, ResearchError
    config={'base_url':'http://127.0.0.1:19503', 'token':'private-service-token'}
    transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'contract_version': 99, 'token': 'upstream-secret'}))
    with pytest.raises(ResearchError) as e:
        await ResearchClient(config,transport=transport).get_product(str(uuid4()),str(uuid4()))
    assert 'upstream-secret' not in str(e.value)
    assert 'private-service-token' not in str(e.value)


@pytest.mark.asyncio
async def test_client_never_retries_mutation_after_read_timeout():
    from services.research_client import ResearchClient, ResearchError
    calls=[]
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout('private-upstream-url',request=request)
    with pytest.raises(ResearchError) as e:
        await ResearchClient({'base_url':'http://127.0.0.1:19503','token':'test'},transport=httpx.MockTransport(handler)).request('POST','/commands',{'command_id':str(uuid4())})
    assert len(calls)==1
    assert e.value.code=='outcome_unknown'
    assert 'private-upstream-url' not in str(e.value)


@pytest.mark.asyncio
async def test_client_bounded_response_rejects_oversized_body():
    from services.research_client import ResearchClient, ResearchError
    transport=httpx.MockTransport(lambda request:httpx.Response(200,content=b'a'*2100000))
    with pytest.raises(ResearchError):
        await ResearchClient({'base_url':'http://127.0.0.1:19503','token':'test'},transport=transport).request('GET','/projects')


@pytest.mark.parametrize('url',['http://192.168.31.112:8000','http://example.com','file:///tmp/a','http://user:pass@127.0.0.1:19503','http://127.0.0.1:19503/evil'])
def test_plain_remote_or_credentialed_endpoint_rejected(url):
    from services.research_client import ResearchClient, ResearchError
    with pytest.raises(ResearchError):
        ResearchClient({'base_url':url,'token':'test'})


@pytest.mark.parametrize('state',['unknown','inferred','stale'])
def test_mapper_does_not_promote_unverified_facts(state):
    from services.research_mapper import build_marketing_preview
    assert build_marketing_preview(snapshot(state),{})['fields']==[]


def test_mapper_keeps_existing_input_and_records_source():
    from services.research_mapper import build_marketing_preview
    preview=build_marketing_preview(snapshot(),{'productFactsText':'Existing merchant facts'})
    assert preview['fields'][0]['target']=='productFactsText'
    assert preview['fields'][0]['existing']=='Existing merchant facts'
    assert preview['fields'][0]['selected'] is False
    assert preview['source_ref']['system']=='rabbit_hole'


def test_mapper_requires_confirmation_metadata_even_with_confirmed_label():
    from services.research_mapper import build_marketing_preview
    data=snapshot();data['facts'][0]['confirmation_method']=None
    assert build_marketing_preview(data,{})['fields']==[]


def test_research_routes_cannot_be_called_cross_site_or_without_session():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.research import router
    app=FastAPI();app.include_router(router)
    client=TestClient(app,base_url='http://127.0.0.1:9503')
    assert client.get('/api/research/v1/session',headers={'Origin':'https://evil.example'}).status_code==403
    assert client.get('/api/research/v1/projects').status_code==401
    session=client.get('/api/research/v1/session').json()
    result=client.post('/api/research/v1/math/logistics',headers={'X-Research-Token':session['csrf_token']},json={'actual_weight_kg':1,'dimensions_cm':[30,20,10],'divisor_cm3_per_kg':5000})
    assert result.status_code==200
    assert result.json()['chargeable_weight_kg']==1.2


@pytest.mark.asyncio
async def test_pagination_cursor_is_forwarded_as_query_not_target_url():
    from services.research_client import ResearchClient
    cursor=str(uuid4());seen=[]
    def handler(request):
        seen.append(request.url)
        return httpx.Response(200,json={'contract_version':1,'projects':[],'next_cursor':None})
    await ResearchClient({'base_url':'http://127.0.0.1:19503','token':'test'},transport=httpx.MockTransport(handler)).list_projects(cursor,3)
    assert seen[0].params['cursor']==cursor
    assert seen[0].params['limit']=='3'


@pytest.mark.asyncio
async def test_product_response_cannot_cross_requested_project_identity():
    from services.research_client import ResearchClient,ResearchError
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json=snapshot()))
    with pytest.raises(ResearchError):
        await ResearchClient({'base_url':'http://127.0.0.1:19503','token':'test'},transport=transport).get_product(str(uuid4()),str(uuid4()))


def test_explicit_local_origin_works_when_browser_labels_alias_cross_site():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.research import router
    app = FastAPI(); app.include_router(router)
    client = TestClient(app, base_url='http://127.0.0.1:9503')
    assert client.get('/api/research/v1/session', headers={'Origin': 'http://localhost:9502', 'Sec-Fetch-Site': 'cross-site'}).status_code == 200
    assert client.get('/api/research/v1/session', headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403


def test_private_config_rejects_oversized_valid_json(tmp_path, monkeypatch):
    from services.research_client import load_research_config
    import json
    path = tmp_path / 'research.json'
    path.write_text(json.dumps({'enabled': True, 'padding': ' ' * 8100}) + ' ' * 100)
    path.chmod(0o600)
    monkeypatch.setenv('RESEARCH_INTEGRATION_CONFIG', str(path))
    assert load_research_config() == {}


@pytest.mark.parametrize('mode', [0o644, 0o666])
def test_private_config_rejects_public_permissions(tmp_path, monkeypatch, mode):
    from services.research_client import load_research_config
    path = tmp_path / 'research.json'; path.write_text('{"enabled":true}')
    path.chmod(mode); monkeypatch.setenv('RESEARCH_INTEGRATION_CONFIG', str(path))
    assert load_research_config() == {}


def test_route_preview_rejects_changed_source_before_handoff(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research
    data = snapshot()
    class Stub:
        async def get_product(self, *args): return data
    monkeypatch.setattr(research, 'client', lambda: Stub())
    app = FastAPI(); app.include_router(research.router)
    client = TestClient(app, base_url='http://127.0.0.1:9503')
    token = client.get('/api/research/v1/session').json()['csrf_token']
    ref = data['source_ref']
    response = client.post(f"/api/research/v1/projects/{ref['project_id']}/products/{ref['product_id']}/preview", headers={'X-Research-Token': token}, json={
        'expected_source_version': 1, 'expected_identity_revision': 1, 'expected_market': 'US', 'existing': {}})
    assert response.status_code == 409


def test_confirmation_status_proxy_checks_requested_command_identity(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research
    project_id, command_id = str(uuid4()), str(uuid4())
    class Stub:
        async def request(self, *args): return {'contract_version': 1, 'project_id': project_id, 'command_id': str(uuid4()), 'state': 'committed'}
    monkeypatch.setattr(research, 'client', lambda: Stub())
    app = FastAPI(); app.include_router(research.router)
    client = TestClient(app, base_url='http://127.0.0.1:9503')
    token = client.get('/api/research/v1/session').json()['csrf_token']
    response = client.get(f'/api/research/v1/projects/{project_id}/confirmations/{command_id}', headers={'X-Research-Token': token})
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_definitive_confirmation_validation_error_is_not_unknown_outcome():
    from services.research_client import ResearchClient, ResearchError
    transport = httpx.MockTransport(lambda request: httpx.Response(422, json={'detail': 'private payload'}))
    with pytest.raises(ResearchError) as error:
        await ResearchClient({'base_url': 'http://127.0.0.1:19503', 'token': 'test'}, transport=transport).request('POST', '/projects/confirm-fact', {})
    assert error.value.status == 422
    assert error.value.code == 'invalid_input'
    assert 'private payload' not in str(error.value)


@pytest.mark.asyncio
async def test_project_projection_cannot_contain_foreign_product_reference():
    from services.research_client import ResearchClient, ResearchError
    project_id = str(uuid4())
    body = {'contract_version': 1, 'id': project_id, 'title': 'Travel', 'direction': 'Packing', 'market': 'US',
            'source_version': 2, 'updated_at': '2026-10-09T00:00:00+00:00', 'products': [snapshot()], 'keyword_count': 0}
    with pytest.raises(ResearchError):
        await ResearchClient({'base_url': 'http://127.0.0.1:19503', 'token': 'test'}, transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))).get_project(project_id)


@pytest.mark.parametrize('changes', [{'token': 123}, {'base_url': {}}, {'token': []}])
def test_malformed_private_config_returns_safe_error(changes):
    from services.research_client import ResearchClient, ResearchError
    with pytest.raises(ResearchError):
        ResearchClient({'base_url': 'http://127.0.0.1:19503', 'token': 'test', **changes})


def test_direct_product_route_is_guarded_and_ownership_validated(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import research
    data=snapshot();ref=data['source_ref'];calls=[]
    class Stub:
        async def get_product(self, project_id, product_id):
            calls.append((str(project_id),str(product_id)))
            return data
    monkeypatch.setattr(research,'client',lambda:Stub())
    app=FastAPI();app.include_router(research.router)
    with TestClient(app,base_url='http://127.0.0.1:9503') as client:
        path=f"/api/research/v1/projects/{ref['project_id']}/products/{ref['product_id']}"
        assert client.get(path).status_code==401
        assert calls==[]
        client.headers['X-Research-Token']=client.get('/api/research/v1/session').json()['csrf_token']
        response=client.get(path)
        assert response.status_code==200
        from models.research import ProductSnapshot
        assert response.json()==ProductSnapshot.model_validate(data).model_dump(mode='json')
        assert calls==[(ref['project_id'],ref['product_id'])]
        assert client.get(f"/api/research/v1/projects/{uuid4()}/products/{ref['product_id']}").status_code==503
        assert client.get(f"/api/research/v1/projects/{ref['project_id']}/products/{uuid4()}").status_code==503
