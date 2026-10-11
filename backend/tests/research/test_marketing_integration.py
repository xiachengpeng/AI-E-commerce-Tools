from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI


async def test_integration_denies_missing_token_before_reading_store():
    from rabbit_hole.api.integration import create_integration_router
    app = FastAPI()
    app.include_router(create_integration_router(token_loader=lambda: 'x' * 48))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        assert (await client.get('/internal/integration/v1/projects')).status_code == 401
        assert (await client.get('/internal/integration/v1/projects', headers={'Authorization': 'Bearer wrong'})).status_code == 401


async def test_disabled_integration_fails_closed():
    from rabbit_hole.api.integration import create_integration_router
    app = FastAPI()
    app.include_router(create_integration_router(token_loader=lambda: None))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        assert (await client.get('/internal/integration/v1/projects')).status_code == 503


async def test_real_store_is_projected_without_state_or_events(db_engine):
    from rabbit_hole.api.integration import create_integration_router
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    p = await store.create('Packing', 'Travel', 'GB', str(uuid4()))
    p = await store.command(p['id'], 0, str(uuid4()), 'add_product', {'name': 'Pouch', 'url': 'https://shop.example/products/pouch'})
    app = FastAPI()
    app.state.workbench_store = store
    app.include_router(create_integration_router(token_loader=lambda: 'x' * 48))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test', headers={'Authorization': 'Bearer ' + 'x' * 48}) as client:
        page = (await client.get('/internal/integration/v1/projects?limit=1')).json()
        assert page['contract_version'] == 1
        assert page['projects'][0]['market'] == 'GB'
        assert 'state' not in page['projects'][0]
        detail = (await client.get('/internal/integration/v1/projects/' + p['id'])).json()
        assert len(detail['products']) == 1
        assert 'events' not in detail
        assert detail['products'][0]['facts'][0]['state'] == 'inferred'
        assert (await client.get('/internal/integration/v1/provider-settings')).status_code == 404


def test_projection_cannot_trust_automatic_or_stale_confirmations():
    from rabbit_hole.application.integration_contracts import product_snapshot
    p = {'id': str(uuid4()), 'market': 'US', 'version': 4}
    product = {'id': str(uuid4()), 'name': 'Pouch', 'url': 'https://example.com/p', 'identity_revision': 2,
               'marketing_facts': [{'key': 'material', 'value': 'Cotton', 'identity_revision': 1, 'market': 'US', 'provenance': 'manual', 'own_product': True, 'confirmed_at': '2026-10-09T01:00:00+00:00', 'source_url': 'https://example.com/p'}]}
    snapshot = product_snapshot(p, product)
    assert next(f for f in snapshot['facts'] if f['key'] == 'material')['state'] == 'stale'
    product['marketing_facts'][0]['identity_revision'] = 2
    product['marketing_facts'][0]['provenance'] = 'automatic'
    assert next(f for f in product_snapshot(p, product)['facts'] if f['key'] == 'material')['state'] != 'confirmed'


async def test_manual_fact_confirmation_requires_own_product_and_current_identity(db_engine):
    from rabbit_hole.persistence.projects import WorkbenchStore
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.application.integration_contracts import product_snapshot
    store=WorkbenchStore(db_engine)
    p=await store.create('Travel','Packing','US',str(uuid4()))
    p=await store.command(p['id'],0,str(uuid4()),'add_product',{'name':'Pouch','url':'https://example.com/p'})
    product=p['products'][0]
    payload={'product_id':product['id'],'key':'material','value':'Cotton','source_url':'https://example.com/p',
             'own_product':True,'identity_revision':1,'market':'US'}
    p=await store.command(p['id'],p['version'],str(uuid4()),'confirm_marketing_fact',payload)
    fact=next(f for f in product_snapshot(p,p['products'][0])['facts'] if f['key']=='material')
    assert fact['state']=='confirmed'
    assert fact['confirmation_method']=='manual'
    with pytest.raises(WorkbenchError):
        await store.command(p['id'],p['version'],str(uuid4()),'confirm_marketing_fact',{**payload,'own_product':False})
    with pytest.raises(WorkbenchError):
        await store.command(p['id'],p['version'],str(uuid4()),'confirm_marketing_fact',{**payload,'identity_revision':2})
    with pytest.raises(WorkbenchError):
        await store.command(p['id'],p['version'],str(uuid4()),'confirm_marketing_fact',payload,actor='automation')


async def test_fact_endpoint_is_idempotent_and_checks_command_conflict(db_engine):
    from rabbit_hole.api.integration import create_integration_router
    from rabbit_hole.persistence.projects import WorkbenchStore
    store=WorkbenchStore(db_engine)
    p=await store.create('Travel','Packing','US',str(uuid4()))
    p=await store.command(p['id'],0,str(uuid4()),'add_product',{'name':'Pouch','url':'https://example.com/p'})
    app=FastAPI();app.state.workbench_store=store
    app.include_router(create_integration_router(token_loader=lambda:'x'*48,confirmations_enabled=lambda:True))
    body={'expected_version':p['version'],'command_id':str(uuid4()),'payload':{'product_id':p['products'][0]['id'],
          'key':'material','value':'Cotton','source_url':'https://example.com/p','own_product':True,'identity_revision':1,'market':'US'}}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://test',headers={'Authorization':'Bearer '+'x'*48}) as client:
        path='/internal/integration/v1/projects/'+p['id']+'/confirm-fact'
        first=await client.post(path,json=body)
        assert first.status_code==200
        duplicate=await client.post(path,json=body)
        assert duplicate.json()['source_version']==first.json()['source_version']
        assert (await client.post(path,json={**body,'payload':{**body['payload'],'value':'Steel'}})).status_code==409


@pytest.mark.parametrize('expiry', ['bad-date', '2020-01-01T00:00:00+00:00', '2028-01-01T00:00:00'])
def test_invalid_expiry_cannot_promote_fact(expiry):
    from rabbit_hole.application.integration_contracts import product_snapshot
    p = {'id': str(uuid4()), 'market': 'US', 'version': 4}
    product = {'id': str(uuid4()), 'name': 'Pouch', 'identity_revision': 2, 'marketing_facts': [
        {'key': 'material', 'value': 'Cotton', 'identity_revision': 2, 'market': 'US',
         'provenance': 'manual', 'own_product': True, 'operator': 'local_user',
         'confirmed_at': '2026-10-08T00:00:00+00:00', 'valid_until': expiry, 'source_url': 'https://example.com/p'}]}
    fact = next(f for f in product_snapshot(p, product)['facts'] if f['key'] == 'material')
    assert fact['state'] != 'confirmed'


async def test_report_and_confirmation_status_are_bounded_read_models(db_engine):
    from rabbit_hole.api.integration import create_integration_router
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    p = await store.create('Travel', 'Packing', 'US', str(uuid4()))
    p = await store.command(p['id'], 0, str(uuid4()), 'add_product', {'name': 'Pouch', 'url': 'https://example.com/p'})
    command_id = str(uuid4())
    p = await store.command(p['id'], p['version'], command_id, 'confirm_marketing_fact', {
        'product_id': p['products'][0]['id'], 'key': 'material', 'value': 'Cotton', 'source_url': 'https://example.com/p',
        'own_product': True, 'identity_revision': 1, 'market': 'US'})
    app = FastAPI(); app.state.workbench_store = store
    app.include_router(create_integration_router(token_loader=lambda: 'x' * 48))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test', headers={'Authorization': 'Bearer ' + 'x' * 48}) as client:
        report = await client.get('/internal/integration/v1/projects/' + p['id'] + '/report')
        assert report.status_code == 200
        assert report.json()['confirmed_fact_count'] == 1
        assert 'payload' not in report.text and 'events' not in report.text
        status = await client.get('/internal/integration/v1/projects/' + p['id'] + '/confirmations/' + command_id)
        assert status.json()['state'] == 'committed'
        missing = await client.get('/internal/integration/v1/projects/' + p['id'] + '/confirmations/' + str(uuid4()))
        assert missing.json()['state'] == 'not_observed'
        assert (await store.get(p['id']))['version'] == p['version']


def test_source_reference_preserves_product_identity_without_tracking_secrets():
    from rabbit_hole.application.integration_contracts import source_url
    assert source_url('https://example.com/detail?p=123&sku=BLUE&token=secret&utm_source=ad#private') == 'https://example.com/detail?p=123&sku=BLUE'
