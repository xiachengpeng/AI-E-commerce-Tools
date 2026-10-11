from uuid import uuid4
from unittest.mock import AsyncMock
import httpx
import pytest
from fastapi import FastAPI


async def test_bounded_command_reuses_native_idempotency_and_rejects_automation(db_engine):
    from rabbit_hole.api.integration import create_integration_router
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    p = await store.create('Packing', 'Travel', 'GB', str(uuid4()))
    app = FastAPI(); app.state.workbench_store = store
    app.include_router(create_integration_router(token_loader=lambda:'x'*48,commands_enabled=lambda:True))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://localhost',headers={'Authorization':'Bearer '+'x'*48}) as client:
        path='/internal/integration/v1/projects/'+p['id']
        body={'command_id':str(uuid4()),'expected_version':0,'market':'GB','action':'add_keyword','payload':{'text':'travel pouch','type':'function'}}
        first=await client.post(path+'/commands',json=body)
        assert first.status_code==200
        assert (await client.post(path+'/commands',json=body)).json()==first.json()
        assert (await client.get(path+'/commands/'+body['command_id'])).json()['state']=='committed'
        body['payload']['text']='changed'
        assert (await client.post(path+'/commands',json=body)).status_code==409
        body['action']='start_worker'
        assert (await client.post(path+'/commands',json=body)).status_code==422
        body['action']='add_keyword'; body['market']='US'
        assert (await client.post(path+'/commands',json=body)).status_code==409
        page=(await client.get(path+'/actions')).json()
        assert page['actions']==[]


async def test_only_dedicated_frame_entry_allows_main_ancestors():
    from rabbit_hole.runtime.server import create_app
    app=create_app(checks={})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://localhost:8000') as client:
        original=await client.get('/')
        embedded=await client.get('/marketing-workbench')
        assert original.status_code==embedded.status_code==200
        assert "frame-ancestors 'none'" in original.headers['content-security-policy']
        assert 'frame-ancestors http://127.0.0.1:9502' in embedded.headers['content-security-policy']
        assert (await client.get('/marketing-workbench',headers={'host':'evil.example'})).status_code==403
        alias=await client.get('/marketing-workbench',headers={'sec-fetch-site':'cross-site','sec-fetch-dest':'iframe'})
        assert alias.status_code==200
        assert 'http://localhost:9502' in alias.headers['content-security-policy']
        assert (await client.get('/workbench/api/session',headers={'sec-fetch-site':'cross-site'})).status_code==403


async def test_marketing_adapter_is_explicit_typed_and_one_call():
    from rabbit_hole.integrations.marketing_ai_adapter import generate_hypotheses,MarketingHypotheses
    generator=AsyncMock(return_value=MarketingHypotheses(hypotheses=['待核实受众']))
    assert (await generate_hypotheses(generator,title='Travel',market='GB')).hypotheses==['待核实受众']
    assert generator.await_count==1
    with pytest.raises(ValueError):
        await generate_hypotheses(generator,title='Travel',market='XX')
    assert generator.await_count==1
