"""Explicit probes never launch business jobs or expose upstream responses."""
import asyncio
import httpx
import pytest

@pytest.mark.parametrize('provider', ['apify', 'serpapi', 'firecrawl', 'feishu'])
def test_probe_uses_fixed_read_only_endpoints(provider):
    from services.integration_connection import test_connection
    calls = []
    def handle(request):
        calls.append(request)
        if request.url.path.endswith('/internal'):
            return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'private-token'})
        return httpx.Response(200, json={'code': 0, 'data': {}, 'searches_left': 2})
    result = asyncio.run(test_connection(provider, dict(api_key='secret', app_id='id', app_secret='secret', base_app_token='base'), transport=httpx.MockTransport(handle)))
    assert result['success'] is True
    assert 'secret' not in str(result) and 'private-token' not in str(result)
    assert all(r.method == 'GET' or r.url.path.endswith('/internal') for r in calls)
    assert len(calls) == (2 if provider == 'feishu' else 1)

@pytest.mark.parametrize('status', [401, 403, 429, 500])
def test_probe_failure_is_safe_and_not_retried(status):
    from services.integration_connection import test_connection
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(status, json={'error': 'secret-upstream-url'})
    result = asyncio.run(test_connection('apify', {'api_key':'secret'}, transport=httpx.MockTransport(handle)))
    assert not result['success'] and len(calls) == 1
    assert 'secret' not in str(result)

def test_missing_configuration_has_no_network_call():
    from services.integration_connection import test_connection
    def handle(request):
        pytest.fail('unexpected network')
    assert not asyncio.run(test_connection('apify', {}, transport=httpx.MockTransport(handle)))['success']

def test_test_route_requires_origin_and_only_reads_saved_credentials(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.integration_settings import create_integration_settings_router
    from routes.research import _session_token
    from services.integration_settings_service import IntegrationSettingsService
    from backend.tests.test_integration_settings import prepared
    from services import integration_connection
    store = IntegrationSettingsService(prepared(tmp_path))
    store.update('apify','research',{'api_key':'saved-secret'})
    seen=[]
    async def probe(provider, credentials):
        seen.append((provider,credentials))
        return {'success':True,'message':'safe'}
    monkeypatch.setattr(integration_connection,'test_connection',probe)
    app=FastAPI();app.state.integration_settings=store;app.include_router(create_integration_settings_router())
    client=TestClient(app,client=('127.0.0.1',50000),base_url='http://127.0.0.1:9503')
    path='/api/settings/integrations/apify/research/test'
    assert client.post(path).status_code==401
    headers={'X-Research-Token':_session_token,'Origin':'http://127.0.0.1:9502'}
    assert client.post(path,headers={**headers,'Origin':'https://evil.invalid'}).status_code==403
    assert not seen
    response=client.post(path,headers=headers,json={'api_key':'unsaved'})
    assert response.status_code==200 and response.json()['success']
    assert seen==[('apify',{'api_key':'saved-secret'})]
    assert 'secret' not in response.text
    assert store.resolve('apify','research')=={'api_key':'saved-secret'}
    assert response.headers['cache-control']=='no-store'

def test_aliyun_reads_report_without_translating(monkeypatch):
    from services.integration_connection import test_connection
    from alibabacloud_alimt20181012.client import Client
    from types import SimpleNamespace
    calls=[]
    async def read(self,request,runtime):
        calls.append(request)
        assert runtime.autoretry is False
        return SimpleNamespace(body=SimpleNamespace(code=200))
    monkeypatch.setattr(Client,'get_translate_report_with_options_async',read)
    outcome=asyncio.run(test_connection('aliyun',{'access_key_id':'id','access_key_secret':'secret'}))
    assert outcome['success'] and len(calls)==1
    assert calls[0].api_name=='translate_standard' and calls[0].group=='day'

def test_http_request_logs_redact_account_key_and_table_token(caplog):
    import logging
    from services.integration_connection import test_connection
    with caplog.at_level(logging.INFO, logger='httpx'):
        asyncio.run(test_connection('serpapi',{'api_key':'probe-sensitive-value'},transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'searches_left':1}))))
    assert 'probe-sensitive-value' not in caplog.text
