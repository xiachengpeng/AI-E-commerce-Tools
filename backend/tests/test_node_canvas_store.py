from services.canvas_store import CanvasStore


def test_formats_separate_legacy_and_node_projects_after_upgrade(tmp_path):
    store=CanvasStore(tmp_path)
    legacy=store.create_project('existing')
    original=store.save_project(legacy['id'],legacy['revision'],{'canvas':{'layers':[1]}})
    node=store.create_project('node',format='node-v1')
    assert node['format']=='node-v1'
    assert {p['id'] for p in store.list_projects(format='invoke-v1')}=={legacy['id']}
    assert {p['id'] for p in store.list_projects(format='node-v1')}=={node['id']}
    reopened=CanvasStore(tmp_path).get_project(legacy['id'])
    assert reopened['format']=='invoke-v1' and reopened['document']==original['document']


def test_upgrade_preserves_a_preexisting_database(tmp_path):
    import sqlite3
    db=sqlite3.connect(tmp_path/'canvas.sqlite3')
    db.execute('CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL)')
    db.execute('INSERT INTO projects VALUES (?,?,?,?)',('old','旧画布',3,'{"canvas":{"x":2}}'))
    db.commit();db.close()
    project=CanvasStore(tmp_path).get_project('old')
    assert project['format']=='invoke-v1' and project['revision']==3 and project['document']=={'canvas':{'x':2}}


def test_node_documents_keep_connections_and_viewport_and_reject_stale_revision(tmp_path):
    import pytest
    s=CanvasStore(tmp_path);p=s.create_project('节点',format='node-v1')
    document={'nodes':[{'id':'a'},{'id':'b'}],'connections':[{'from':'a','to':'b'}],'viewport':{'x':4,'y':8,'k':0.75}}
    result=s.save_project(p['id'],0,document)
    assert CanvasStore(tmp_path).get_project(p['id'])['document']==document
    with pytest.raises(ValueError):s.save_project(p['id'],0,{})
    assert result['format']=='node-v1'


def test_project_api_filters_formats_and_defaults_to_legacy(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import canvas
    store=CanvasStore(tmp_path);monkeypatch.setattr(canvas,'get_canvas_store',lambda:store)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    legacy=client.post('/api/canvas/projects',json={'title':'旧'}).json()
    new=client.post('/api/canvas/projects',json={'title':'新','format':'node-v1'}).json()
    assert new['format']=='node-v1'
    assert [p['id'] for p in client.get('/api/canvas/projects').json()['projects']]==[legacy['id']]
    assert [p['id'] for p in client.get('/api/canvas/projects?format=node-v1').json()['projects']]==[new['id']]


def test_node_project_accepts_client_id_and_rejects_collision(tmp_path):
    import pytest
    store=CanvasStore(tmp_path)
    p=store.create_project('A',format='node-v1',project_id='node-123_x')
    assert p['id']=='node-123_x'
    with pytest.raises(ValueError):store.create_project('B',format='node-v1',project_id='node-123_x')
    with pytest.raises(ValueError):store.create_project('bad',format='node-v1',project_id='../other')
    assert store.get_project(p['id'])['title']=='A'


def test_archived_node_project_remains_recoverable_and_keeps_its_assets(tmp_path):
    import io
    from PIL import Image
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1')
    data=io.BytesIO();Image.new('RGB',(1,1),'blue').save(data,format='PNG')
    image=store.put_asset(p['id'],data.getvalue());store.archive_project(p['id'])
    assert store.list_projects(format='node-v1')==[]
    assert store.get_project(p['id'])['archived'] is True
    assert store.read_asset(p['id'],image['id'])==data.getvalue()
    store.restore_project(p['id'])
    assert store.list_projects(format='node-v1')[0]['id']==p['id']


def test_canvas_model_catalog_is_scoped_to_provider_incarnation(tmp_path):
    store=CanvasStore(tmp_path)
    store.add_provider_model('incarnation-a','image-model-1')
    store.add_provider_model('incarnation-a','image-model-2')
    store.add_provider_model('incarnation-b','image-model-3')
    assert store.provider_models('incarnation-a')==['image-model-1','image-model-2']
    store.delete_provider_model('incarnation-a','image-model-1')
    assert store.provider_models('incarnation-a')==['image-model-2']
    assert store.provider_models('incarnation-b')==['image-model-3']
    import pytest
    with pytest.raises(ValueError):store.add_provider_model('incarnation-a','bad model!')
