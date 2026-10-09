from unittest.mock import AsyncMock
from uuid import uuid4
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.research_repository import ResearchRepository, migrate
from tests.test_research_integration import snapshot


def test_import_revalidates_source_is_idempotent_offline_and_keeps_confirmed_subset(tmp_path,monkeypatch):
    from routes import research
    path=tmp_path/'history.db'; migrate(path)
    repo=ResearchRepository(path)
    monkeypatch.setattr(research,'repository',lambda:repo)
    source=snapshot()
    remote=AsyncMock(); remote.get_product.return_value=source
    monkeypatch.setattr(research,'client',lambda:remote)
    app=FastAPI(); app.include_router(research.router)
    with TestClient(app,base_url='http://localhost:9503') as client:
        token=client.get('/api/research/v1/session').json()['csrf_token']
        client.headers['X-Research-Token']=token
        ref=source['source_ref']
        url=f"/api/research/v1/projects/{ref['project_id']}/products/{ref['product_id']}/imports"
        body={'import_id':str(uuid4()),'name':'Pouch','expected_source_version':2,'expected_identity_revision':1,'expected_market':'US','selected_fields':['material']}
        first=client.post(url,json=body)
        assert first.status_code==200
        assert first.json()['snapshot']['facts'][0]['value']=='Cotton'
        remote.get_product.side_effect=RuntimeError('offline')
        assert client.post(url,json=body).json()==first.json()
        assert remote.get_product.await_count==1
        body['name']='changed'
        assert client.post(url,json=body).status_code==409
        assert len(client.get('/api/research/v1/imports').json()['imports'])==1
        assert client.get('/api/research/v1/imports',headers={'Origin':'null'}).status_code==403


def test_import_rejects_stale_or_unconfirmed_selection(tmp_path,monkeypatch):
    from routes import research
    path=tmp_path/'history.db'; migrate(path)
    repo=ResearchRepository(path); monkeypatch.setattr(research,'repository',lambda:repo)
    source=snapshot('inferred'); remote=AsyncMock(); remote.get_product.return_value=source
    monkeypatch.setattr(research,'client',lambda:remote)
    app=FastAPI();app.include_router(research.router)
    with TestClient(app,base_url='http://localhost:9503') as client:
        client.headers['X-Research-Token']=client.get('/api/research/v1/session').json()['csrf_token']
        ref=source['source_ref']; url=f"/api/research/v1/projects/{ref['project_id']}/products/{ref['product_id']}/imports"
        body={'import_id':str(uuid4()),'name':'Pouch','expected_source_version':2,'expected_identity_revision':1,'expected_market':'US','selected_fields':['material']}
        assert client.post(url,json=body).status_code==409
        body['expected_source_version']=1
        assert client.post(url,json=body).status_code==409
        assert repo.list()['imports']==[]


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
    with TestClient(app,base_url='http://localhost:9503') as client:
        client.headers['X-Research-Token']=client.get('/api/research/v1/session').json()['csrf_token']
        page=client.get('/api/research/v1/artifact-choices?module=listing&limit=1').json()
        assert len(page['items'])==1
        assert page['next_cursor']==3
        assert 'never-return' not in str(page)
        assert client.get('/api/research/v1/artifact-choices?module=providers').status_code==422
