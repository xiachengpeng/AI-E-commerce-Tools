"""Named credentials are opt-in, transactional and never returned in normal DTOs."""
import json
import pytest
from backend.tests.test_integration_settings import prepared
from services.integration_settings_service import IntegrationSettingsService


def test_legacy_default_and_explicit_activation_are_shared_by_all_readers(tmp_path):
    path=prepared(tmp_path);store=IntegrationSettingsService(path)
    store.update('apify','research',{'api_key':'synthetic-original-key','daily_limit':8})
    before=store.public('apify','research')
    assert before['active_profile_id']=='default'
    assert before['profiles'][0]['name']=='原有配置'
    new=store.create_profile('apify','research','备用账户',{'api_key':'synthetic-second-key','daily_limit':4})
    assert store.resolve('apify','research')['api_key']=='synthetic-original-key'
    assert 'synthetic-second-key' not in json.dumps(new)
    store.activate_profile('apify','research',new['profile_id'],expected_version=before['version'])
    assert IntegrationSettingsService(path).resolve('apify','research')=={'api_key':'synthetic-second-key','daily_limit':4}
    store.activate_profile('apify','research','default',expected_version=store.public('apify','research')['version'])
    assert store.resolve('apify','research')['api_key']=='synthetic-original-key'


def test_blank_secret_preserves_only_selected_profile_and_stale_updates_fail(tmp_path):
    store=IntegrationSettingsService(prepared(tmp_path))
    store.update('apify','research',{'api_key':'synthetic-original-key','daily_limit':8})
    draft=store.create_profile('apify','research','新账户',{})
    assert draft['configured'] is False
    with pytest.raises(ValueError):store.activate_profile('apify','research',draft['profile_id'],expected_version=store.public('apify','research')['version'])
    saved=store.update_profile('apify','research',draft['profile_id'],'新账户',{'api_key':'synthetic-second-key','daily_limit':3},expected_version=draft['version'])
    store.update_profile('apify','research',draft['profile_id'],'新名称',{'api_key':''},expected_version=saved['version'])
    with pytest.raises(ValueError):store.update_profile('apify','research',draft['profile_id'],'旧窗口',{'api_key':'wrong'},expected_version=saved['version'])
    assert store.resolve('apify','research')['api_key']=='synthetic-original-key'
    profile=store.profile('apify','research',draft['profile_id'])
    assert store.reveal('apify','research',draft['profile_id'],'api_key',expected_version=profile['version'])['value']=='synthetic-second-key'
    with pytest.raises(ValueError):store.reveal('serpapi','research',draft['profile_id'],'api_key',expected_version=profile['version'])


def test_active_legacy_writes_update_named_profile_but_public_masks_secrets(tmp_path):
    store=IntegrationSettingsService(prepared(tmp_path))
    store.update('apify','research',{'api_key':'synthetic-original-key','daily_limit':8})
    other=store.create_profile('apify','research','工作账户',{'api_key':'synthetic-second-key','daily_limit':4})
    store.activate_profile('apify','research',other['profile_id'],expected_version=store.public('apify','research')['version'])
    store.update('apify','research',{'api_key':'synthetic-edited-key'})
    current=store.profile('apify','research',other['profile_id'])
    assert store.reveal('apify','research',other['profile_id'],'api_key',expected_version=current['version'])['value']=='synthetic-edited-key'
    normal=json.dumps(store.public('apify','research'))
    assert 'synthetic-edited-key' not in normal and 'synthetic-original-key' not in normal
    assert current['secret_previews']['api_key']=='syn••••••key'


def test_profile_routes_and_reveal_require_session_origin_and_no_store(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.integration_settings import create_integration_settings_router
    from routes.research import _session_token
    app=FastAPI();app.state.integration_settings=IntegrationSettingsService(prepared(tmp_path));app.include_router(create_integration_settings_router())
    client=TestClient(app,client=('127.0.0.1',50000),base_url='http://127.0.0.1:9503')
    base='/api/settings/integrations/apify/research';headers={'X-Research-Token':_session_token,'Origin':'http://127.0.0.1:9502'}
    assert client.post(base+'/profiles',json={'name':'新配置','changes':{}}).status_code==401
    created=client.post(base+'/profiles',headers=headers,json={'name':'新配置','changes':{'api_key':'synthetic-secret-key','daily_limit':8}})
    assert created.status_code==200 and 'synthetic-secret-key' not in created.text
    p=created.json();payload={'profile_id':p['profile_id'],'field':'api_key','expected_version':p['version']}
    assert client.post(base+'/reveal',headers={**headers,'Origin':'https://evil.invalid'},json=payload).status_code==403
    revealed=client.post(base+'/reveal',headers=headers,json=payload)
    assert revealed.status_code==200 and revealed.json()['value']=='synthetic-secret-key'
    assert revealed.headers['cache-control']=='no-store'
    assert client.get(base,headers=headers).headers['cache-control']=='no-store'


def test_catalog_is_private_and_stale_activation_cannot_replace_current_account(tmp_path):
    store=IntegrationSettingsService(prepared(tmp_path))
    store.update('apify','research',{'api_key':'synthetic-original-key','daily_limit':8})
    other=store.create_profile('apify','research','备用',{'api_key':'synthetic-second-key','daily_limit':4})
    original=store.public('apify','research')
    store.update('apify','research',{'daily_limit':7})
    with pytest.raises(ValueError):store.activate_profile('apify','research',other['profile_id'],expected_version=original['version'])
    assert store.resolve('apify','research')['daily_limit']==7
    for operation in [store.public,store.resolve]:
        with pytest.raises(ValueError):operation('apify','research__profiles')


def test_older_app_updates_to_active_row_remain_authoritative_after_upgrade(tmp_path):
    path=prepared(tmp_path);store=IntegrationSettingsService(path)
    store.update('apify','research',{'api_key':'synthetic-original-key','daily_limit':8})
    store.create_profile('apify','research','备用',{})
    old=store.public('apify','research')
    # Simulate the previous binary editing its unchanged flat active record.
    import sqlite3
    with sqlite3.connect(path) as db:
        db.execute('UPDATE integration_settings SET value=?,version=version+1 WHERE provider=? AND purpose=?',(json.dumps({'api_key':'synthetic-legacy-edited-key','daily_limit':5}),'apify','research'))
    view=store.public('apify','research')
    assert view['fields']['daily_limit']==5
    assert view['profile_version']>old['profile_version']
    assert store.reveal('apify','research','default','api_key',expected_version=view['profile_version'])['value']=='synthetic-legacy-edited-key'
