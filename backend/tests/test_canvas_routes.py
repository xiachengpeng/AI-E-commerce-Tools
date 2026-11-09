import base64
import io

from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routes import canvas
from services.canvas_store import CanvasStore


def test_project_asset_and_restore_api_uses_injected_isolated_store(tmp_path,monkeypatch):
    store=CanvasStore(tmp_path);monkeypatch.setattr(canvas,'get_canvas_store',lambda:store)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    response=client.post('/api/canvas/projects',json={'title':'项目'});assert response.status_code==200
    p=response.json();buf=io.BytesIO();Image.new('RGB',(2,2),'red').save(buf,format='PNG')
    upload=client.post(f"/api/canvas/projects/{p['id']}/assets",json={'data':base64.b64encode(buf.getvalue()).decode(),'mime_type':'image/png'})
    assert upload.status_code==200;asset=upload.json();image=client.get(f"/api/canvas/projects/{p['id']}/assets/{asset['id']}")
    assert image.content==buf.getvalue();assert image.headers['content-type']=='image/png'
    result=client.put(f"/api/canvas/projects/{p['id']}",json={'revision':0,'document':{'images':[{'asset_id':asset['id']}]}});assert result.status_code==200
    assert client.get(f"/api/canvas/projects/{p['id']}").json()['document']==result.json()['document']


def test_task_route_uses_confirmed_snapshot_and_never_calls_twice(tmp_path,monkeypatch):
    from services.ai_config_service import ProviderSnapshot
    def snapshot():
        return ProviderSnapshot(id=1,incarnation_id='inc',capability='image',name='fake',protocol='openai_compatible',base_url='https://example.invalid',api_key='secret',vertex_project_id=None,vertex_location=None,vertex_key_path=None,model='fake-model',timeout_seconds=30,max_retries=0,config_version=1,image_generation_mode='text_to_image')
    from services.canvas_ai_service import confirm_canvas_snapshot
    store=CanvasStore(tmp_path);monkeypatch.setattr(canvas,'get_canvas_store',lambda:store);monkeypatch.setattr(canvas,'resolve_image_snapshot',snapshot)
    calls=[];buf=io.BytesIO();Image.new('RGB',(2,2),'blue').save(buf,format='PNG')
    async def generate(payload,selected):
        calls.append(payload);return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':base64.b64encode(buf.getvalue()).decode()}}]}}]}
    monkeypatch.setattr(canvas,'generate_canvas_image',generate)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    p=client.post('/api/canvas/projects',json={'title':'项目'}).json()
    request={'operation_key':'unique','operation':'generate','prompt':'a','reference_ids':[],'mask_id':None,'expected_provider':confirm_canvas_snapshot(snapshot())}
    first=client.post(f"/api/canvas/projects/{p['id']}/tasks",json=request);second=client.post(f"/api/canvas/projects/{p['id']}/tasks",json=request)
    assert first.status_code==200 and first.json()['status']=='complete';assert first.json()['id']==second.json()['id'];assert len(calls)==1
    task=client.get(f"/api/canvas/projects/{p['id']}/tasks/by-operation/unique")
    assert task.json()['status']=='complete';assert task.json()['result_asset_id']


def test_canvas_generation_disables_router_and_adapter_retries(monkeypatch):
    import asyncio
    from services.ai_config_service import ProviderSnapshot
    from services.ai_service import ai_router
    snapshot=ProviderSnapshot(id=1,incarnation_id='inc',capability='image',name='fake',protocol='openai_compatible',base_url='https://example.invalid',api_key='secret',vertex_project_id=None,vertex_location=None,vertex_key_path=None,model='fake',timeout_seconds=30,max_retries=4,config_version=1,image_generation_mode='text_to_image')
    seen={}
    async def fake(capability,payload,*,snapshot):
        seen.update(payload=payload,snapshot=snapshot);return {}
    monkeypatch.setattr(ai_router,'generate',fake)
    asyncio.run(canvas.generate_canvas_image({},snapshot))
    assert seen['snapshot'].max_retries==0
    assert seen['payload']['disable_image_format_fallback'] is True


def test_canvas_preflight_selects_operation_by_reference_count(monkeypatch):
    from services.ai_config_service import ProviderSnapshot
    snap=ProviderSnapshot(id=1,incarnation_id='inc',capability='image',name='fake',protocol='openai_compatible',base_url='https://example.invalid',api_key='secret',vertex_project_id=None,vertex_location=None,vertex_key_path=None,model='fake-model',timeout_seconds=30,max_retries=0,config_version=1,image_generation_mode='image_to_image')
    monkeypatch.setattr(canvas,'resolve_image_snapshot',lambda:snap)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    text=client.post('/api/canvas/preflight',json={'operation':'generate','reference_count':0,'has_mask':False}).json()
    image=client.post('/api/canvas/preflight',json={'operation':'generate','reference_count':1,'has_mask':False}).json()
    assert text['supported'] and text['provider']['image_generation_mode']=='text_to_image'
    assert image['supported'] and image['provider']['image_generation_mode']=='image_to_image'


def test_canvas_explicit_provider_selection_keeps_other_binding_unchanged(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from db import Base
    from services.ai_config_service import create_provider,set_binding,get_snapshot
    engine=create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool);Base.metadata.create_all(engine)
    Session=sessionmaker(bind=engine)
    with Session() as db:
        a=create_provider(db,dict(name='A',protocol='openai_compatible',base_url='https://example.invalid',api_key='not-real',image_model='model-a',supports_image=True,supports_text=False))
        b=create_provider(db,dict(name='B',protocol='openai_compatible',base_url='https://example.invalid',api_key='not-real',image_model='model-b',supports_image=True,supports_text=False))
        set_binding(db,'image',a.id);bid=b.id
    monkeypatch.setattr(canvas,'SessionLocal',Session)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    choices=client.get('/api/canvas/providers').json()
    assert len(choices['providers'])==2 and 'not-real' not in str(choices)
    result=client.post('/api/canvas/preflight',json={'operation':'generate','reference_count':0,'has_mask':False,'provider_id':bid,'model':'chosen-model'}).json()
    assert result['provider']['id']==bid and result['provider']['model']=='chosen-model'
    with Session() as db: assert get_snapshot(db,'image').name=='A'


def test_canvas_dispatch_uses_explicit_provider_and_reference_mode(tmp_path,monkeypatch):
    from dataclasses import replace
    from services.ai_config_service import ProviderSnapshot
    from services.canvas_ai_service import confirm_canvas_snapshot
    snap=ProviderSnapshot(id=2,incarnation_id='inc',capability='image',name='B',protocol='openai_compatible',base_url='https://example.invalid',api_key='secret',vertex_project_id=None,vertex_location=None,vertex_key_path=None,model='chosen',timeout_seconds=30,max_retries=0,config_version=1,image_generation_mode='image_to_image')
    store=CanvasStore(tmp_path);monkeypatch.setattr(canvas,'get_canvas_store',lambda:store)
    monkeypatch.setattr(canvas,'resolve_canvas_snapshot',lambda provider_id,model,count:replace(snap,model=model or snap.model,image_generation_mode='image_to_image' if count else 'text_to_image'))
    received=[];buf=io.BytesIO();Image.new('RGB',(2,2),'blue').save(buf,format='PNG')
    async def generate(payload,selected):
        received.append((selected.model,selected.image_generation_mode,len(payload['contents'][0]['parts'])-1))
        return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':base64.b64encode(buf.getvalue()).decode()}}]}}]}
    monkeypatch.setattr(canvas,'generate_canvas_image',generate)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    p=client.post('/api/canvas/projects',json={'title':'项目'}).json();asset=store.put_asset(p['id'],buf.getvalue())
    for key,refs,mode in [('text',[],'text_to_image'),('image',[asset['id']],'image_to_image')]:
        request={'operation_key':key,'operation':'generate','prompt':'x','reference_ids':refs,'mask_id':None,'expected_provider':confirm_canvas_snapshot(replace(snap,image_generation_mode=mode)),'provider_id':2,'model':'chosen'}
        result=client.post(f"/api/canvas/projects/{p['id']}/tasks",json=request);assert result.status_code==200 and result.json()['status']=='complete'
    assert received==[('chosen','text_to_image',0),('chosen','image_to_image',1)]


def test_canvas_model_catalog_api_does_not_expose_or_change_provider_secrets(tmp_path,monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from db import Base
    from services.ai_config_service import create_provider,set_binding
    engine=create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool);Base.metadata.create_all(engine);Session=sessionmaker(bind=engine)
    with Session() as db:
        provider=create_provider(db,dict(name='Channel',protocol='openai_compatible',base_url='https://example.invalid',api_key='private-test-secret',image_model='default-model',supports_image=True,supports_text=False));pid=provider.id;set_binding(db,'image',pid)
    monkeypatch.setattr(canvas,'SessionLocal',Session);monkeypatch.setattr(canvas,'get_canvas_store',lambda:CanvasStore(tmp_path))
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    response=client.post(f'/api/canvas/providers/{pid}/models',json={'model':'extra-model'});assert response.status_code==200
    choices=client.get('/api/canvas/providers').json();assert choices['providers'][0]['models']==['default-model','extra-model'];assert 'private-test-secret' not in str(choices)
    assert client.post(f'/api/canvas/providers/{pid}/models',json={'model':'invalid model!'}).status_code==422
    assert client.delete(f'/api/canvas/providers/{pid}/models/extra-model').status_code==200
    assert client.get('/api/canvas/providers').json()['providers'][0]['models']==['default-model']
