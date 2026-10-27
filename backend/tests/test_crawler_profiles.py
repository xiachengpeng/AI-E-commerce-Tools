"""Competitor account safety, tested only against isolated SQLite."""
import asyncio
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from db import Base, FirecrawlConfig
from services.crawler_config_service import CrawlerConfigService


@pytest.fixture
def service(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'profiles.db'}")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        session.add(FirecrawlConfig(api_key='fc-test-account-a', api_url='https://api.firecrawl.dev/v1/scrape'))
        session.commit()
        yield CrawlerConfigService(session)
    engine.dispose()


def add(service, name='备用账号', key='fc-test-account-b'):
    return service.save(None, {'name': name, 'api_key': key})


def test_read_is_masked_and_does_not_write(service):
    from db import AppSetting
    current = service.read()
    assert current['profile_id'] == 'default'
    assert current['active_profile_id'] == 'default'
    assert 'fc-test-account-a' not in str(current)
    assert service.db.query(AppSetting).count() == 0


def test_create_and_edit_do_not_activate_and_blank_preserves(service):
    backup = add(service)
    assert backup['profile_id'] != 'default'
    assert service.read()['profile_id'] == 'default'
    edited = service.save(backup['profile_id'], {'name':'备用改名', 'api_key':'', 'expected_version':backup['version']})
    assert edited['has_api_key']
    assert service.credentials(edited['profile_id'], edited['version'])[1] == 'fc-test-account-b'
    assert service.db.query(FirecrawlConfig).first().api_key == 'fc-test-account-a'


def test_activation_version_and_legacy_bridge(service):
    backup = add(service)
    active = service.activate(backup['profile_id'], backup['version'], backup['active_version'])
    assert active['active_profile_id'] == backup['profile_id']
    assert service.db.query(FirecrawlConfig).first().api_key == 'fc-test-account-b'
    with pytest.raises(Exception, match='已变化'):
        service.activate('default', 1, backup['active_version'])
    service.save(None, {'api_key':'fc-test-updated'}, legacy=True)
    assert service.credentials(backup['profile_id'], service.read()['version'])[1] == 'fc-test-updated'


def test_stale_updates_and_duplicate_names_rejected(service):
    backup = add(service)
    with pytest.raises(Exception): add(service)
    service.save(backup['profile_id'], {'name':'更新', 'expected_version':backup['version']})
    with pytest.raises(Exception, match='已变化'):
        service.save(backup['profile_id'], {'name':'过期更新','expected_version':backup['version']})


def test_test_result_bound_to_exact_saved_credentials(service):
    backup = add(service)
    creds = service.credentials(backup['profile_id'], backup['version'])
    service.record_test(backup['profile_id'], backup['version'], creds, True, 12, '连接成功')
    assert service.read(backup['profile_id'])['last_test_status'] == 'success'
    assert service.read()['last_test_status'] is None
    service.save(backup['profile_id'], {'api_key':'fc-changed', 'expected_version':backup['version']})
    assert not service.record_test(backup['profile_id'], backup['version'], creds, False, 10, '旧失败')
    assert service.read(backup['profile_id'])['last_test_status'] is None


def test_no_account_key_fallback_for_empty_selfhost(service):
    backup = service.save(None, {'name':'本地', 'api_url':'http://localhost:3002/v1/scrape'})
    assert service.credentials(backup['profile_id'], backup['version'])[1] == ''


def test_analysis_snapshot_is_scoped_and_survives_switch(monkeypatch):
    import services.firecrawl as firecrawl
    current = ['https://example.com/api', 'key-a']
    monkeypatch.setattr(firecrawl, 'FIRECRAWL_API_URL', current[0])
    monkeypatch.setattr(firecrawl, 'FIRECRAWL_API_KEY', current[1])
    @firecrawl.with_crawler_snapshot
    async def analysis():
        before = firecrawl.get_firecrawl_config()
        firecrawl.FIRECRAWL_API_KEY = 'key-b'
        await asyncio.sleep(0)
        return before, firecrawl.get_firecrawl_config()
    before, after = asyncio.run(analysis())
    assert before == after == tuple(current)
    assert firecrawl.get_firecrawl_config()[1] == 'key-b'

@pytest.fixture
def api(service):
    from main import app, get_db
    from fastapi.testclient import TestClient
    from routes.research import _session_token
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = lambda: service.db
    with TestClient(app, base_url='http://127.0.0.1:9503', client=('127.0.0.1',54321)) as client:
        client.headers.update({'X-Research-Token':_session_token,'Origin':'http://127.0.0.1:9502'})
        yield client
    app.dependency_overrides.clear();app.dependency_overrides.update(previous)


def test_route_profile_roundtrip_reveal_and_test_isolation(service, api, monkeypatch):
    from unittest.mock import AsyncMock
    import main
    probe = AsyncMock(return_value=(True, 11, '连接成功'))
    monkeypatch.setattr(main,'test_firecrawl_connection',probe)
    created=api.post('/api/settings/crawler/profiles',json={'name':'HTTP备用','api_key':'fake-http-backup'}).json()
    pid=created['profile_id']
    assert api.get('/api/settings/crawler').json()['profile_id']=='default'
    read=api.get(f'/api/settings/crawler/profiles/{pid}').json()
    assert read['name']=='HTTP备用'
    assert 'fake-http-backup' not in str(read)
    tested=api.post('/api/settings/crawler/test',json={'profile_id':pid,'expected_version':created['version']})
    assert tested.status_code==200 and tested.json()['persisted'] is True
    assert probe.call_args.kwargs['api_key']=='fake-http-backup'
    assert api.get('/api/settings/crawler').json()['last_test_status'] is None
    reveal=api.post('/api/settings/secrets/reveal',json={'category':'crawler','field':'api_key','profile_id':pid,'expected_version':created['version']})
    assert reveal.json()['secret']=='fake-http-backup'
    assert reveal.headers['cache-control']=='no-store'
    activate=api.post(f'/api/settings/crawler/profiles/{pid}/activate',json={'expected_version':created['version'],'expected_active_version':created['active_version']})
    assert activate.status_code==200
    assert service.db.query(FirecrawlConfig).first().api_key=='fake-http-backup'


def test_mutations_reject_cross_site_and_bad_types(service, api):
    assert api.post('/api/settings/crawler/profiles',json={'name':'bad'},headers={'Origin':'https://evil.example'}).status_code==403
    assert api.post('/api/settings/crawler/profiles',json={'name':{'bad':'value'}}).status_code==422
    assert api.post('/api/settings/crawler/profiles',json={'name':'bad','api_url':'file:///etc/passwd'}).status_code==400


def test_draft_probe_never_updates_saved_badge(service, api, monkeypatch):
    from unittest.mock import AsyncMock
    import main
    monkeypatch.setattr(main,'test_firecrawl_connection',AsyncMock(return_value=(True,3,'连接成功')))
    result=api.post('/api/settings/crawler/test',json={'profile_id':'default','expected_version':1,'api_key':'fake-draft-key'})
    assert result.json()['persisted'] is False
    assert service.read()['last_test_status'] is None


def test_old_binary_change_is_read_authority_and_next_write_keeps_backups(service):
    backup=add(service)
    cfg=service.db.query(FirecrawlConfig).first();cfg.api_key='fake-old-binary-edit';service.db.commit()
    assert service.credentials()[1]=='fake-old-binary-edit'
    assert service.read()['version']==2
    service.save(backup['profile_id'],{'name':'备用二','expected_version':backup['version']})
    assert service.credentials()[1]=='fake-old-binary-edit'
    assert len(service.read()['profiles'])==2


def test_active_selfhost_empty_key_never_borrows_environment_secret(service, monkeypatch):
    import services.firecrawl as firecrawl
    backup=service.save(None,{'name':'无密钥自建服务','api_url':'http://localhost:3002/v1/scrape'})
    service.activate(backup['profile_id'],backup['version'],backup['active_version'])
    # Establish fake defaults without invoking monkeypatch's explicit test override.
    monkeypatch.setattr(firecrawl,'FIRECRAWL_API_KEY','fake-environment-secret')
    monkeypatch.setattr(firecrawl,'_ORIG_FIRECRAWL_API_KEY','fake-environment-secret')
    assert firecrawl.get_firecrawl_config(db=service.db)==('http://localhost:3002/v1/scrape','')
