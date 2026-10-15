import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.research_repository import ResearchRepository
from backend.tests.test_full_merge_schema import candidate  # noqa: F401
from backend.tests.test_research_unit_of_work import local, request_for  # noqa: F401


@pytest.mark.asyncio
async def test_import_revalidates_source_is_idempotent_offline_and_keeps_confirmed_subset(local, monkeypatch):  # noqa: F811
    from routes import research
    facade, project, paths = local
    repo = ResearchRepository(paths.database)
    monkeypatch.setattr(research, 'repository', lambda: repo)
    monkeypatch.setattr(research, 'load_research_config', lambda: {'enabled':True, 'mode':'remote'})
    app=FastAPI();app.state.research_runtime=facade.runtime;app.include_router(research.router)
    before_count=len(repo.list()['imports'])
    data=request_for(project)
    url=f"/api/research/v1/projects/{project['id']}/products/{data['product_id']}/imports"
    body={key:value for key,value in data.items() if key not in {'project_id','product_id'}}
    with TestClient(app, client=('127.0.0.1',50000),base_url='http://localhost:9503') as browser:
        browser.headers['X-Research-Token']=browser.get('/api/research/v1/session').json()['csrf_token']
        first=browser.post(url,json=body)
        assert first.status_code==200
        assert first.json()['snapshot']['facts'][0]['value']=='Cotton'
        app.state.research_runtime=None
        assert browser.post(url,json=body).json()==first.json()
        body['name']='changed'
        assert browser.post(url,json=body).status_code==409
        assert len(browser.get('/api/research/v1/imports').json()['imports'])==before_count+1
        assert browser.get('/api/research/v1/imports',headers={'Origin':'null'}).status_code==403


@pytest.mark.asyncio
async def test_import_rejects_stale_or_unconfirmed_selection(local, monkeypatch):  # noqa: F811
    from routes import research
    facade, project, paths=local
    repo=ResearchRepository(paths.database)
    monkeypatch.setattr(research,'repository',lambda:repo)
    monkeypatch.setattr(research,'load_research_config',lambda:{'enabled':True,'mode':'remote'})
    app=FastAPI();app.state.research_runtime=facade.runtime;app.include_router(research.router)
    before_imports=repo.list()['imports']
    data=request_for(project,confirm=False)
    url=f"/api/research/v1/projects/{project['id']}/products/{data['product_id']}/imports"
    body={key:value for key,value in data.items() if key not in {'project_id','product_id'}}
    with TestClient(app,client=('127.0.0.1',50000),base_url='http://localhost:9503') as browser:
        browser.headers['X-Research-Token']=browser.get('/api/research/v1/session').json()['csrf_token']
        assert browser.post(url,json=body).status_code==409
        body['expected_source_version']-=1
        assert browser.post(url,json=body).status_code==409
        assert repo.list()['imports']==before_imports


def test_artifact_chooser_excludes_business_payloads_and_limits_rows(monkeypatch,tmp_path):
    from routes import research
    from db import ListingHistory
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine=create_engine('sqlite:///'+str(tmp_path/'history.db'),connect_args={'check_same_thread':False})
    ListingHistory.__table__.create(engine)
    sessions=sessionmaker(bind=engine)
    with sessions() as database:
        database.add_all([ListingHistory(product_name='Product '+str(i),result={'raw':'never-return'}) for i in range(3)])
        database.commit()
    monkeypatch.setattr('db.SessionLocal',sessions)
    app=FastAPI();app.include_router(research.router)
    with TestClient(app, client=('127.0.0.1', 50000),base_url='http://localhost:9503') as client:
        client.headers['X-Research-Token']=client.get('/api/research/v1/session').json()['csrf_token']
        page=client.get('/api/research/v1/artifact-choices?module=listing&limit=1').json()
        assert len(page['items'])==1
        assert page['next_cursor']==3
        assert 'never-return' not in str(page)
        assert client.get('/api/research/v1/artifact-choices?module=providers').status_code==422
