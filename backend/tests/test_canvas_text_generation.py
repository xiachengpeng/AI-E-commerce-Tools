import base64
import io
import pytest
from PIL import Image
from services.canvas_store import CanvasStore
from services.ai_config_service import ProviderSnapshot
from services.canvas_ai_service import confirm_canvas_snapshot


def setup(tmp_path):
    store=CanvasStore(tmp_path)
    project=store.create_project('文本',format='node-v1')
    project=store.save_project(project['id'],0,{'nodes':[{'id':'text-1'}],'connections':[]})
    snapshot=ProviderSnapshot(id=1,incarnation_id='test',capability='text',name='测试',protocol='openai_compatible',base_url='https://example.invalid',api_key='secret',vertex_project_id=None,vertex_location=None,vertex_key_path=None,model='text-model',timeout_seconds=30,max_retries=0,config_version=1,image_generation_mode='text_to_image')
    context={'batch_id':'batch-1','node_id':'text-1','project_revision':project['revision'],'node_revision':'v1','connections':[]}
    return store,project,snapshot,context

@pytest.mark.asyncio
async def test_text_task_once_with_image_reference_and_durable_result(tmp_path):
    from services.canvas_text_service import reserve_text_task,run_text_task
    store,project,snapshot,context=setup(tmp_path)
    image=io.BytesIO();Image.new('RGB',(2,2),'red').save(image,format='PNG')
    asset=store.put_asset(project['id'],image.getvalue())
    kw=dict(store=store,project_id=project['id'],operation_key='one',prompt='描述商品',reference_ids=[asset['id']],snapshot=snapshot,expected_provider=confirm_canvas_snapshot(snapshot),node_context=context)
    assert reserve_text_task(**kw)['status']=='prepared'
    calls=[]
    async def fake(payload,snapshot):
        calls.append(payload)
        return {'candidates':[{'content':{'parts':[{'text':'生成的描述'}]}}]}
    result=await run_text_task(**kw,generate=fake)
    assert result['status']=='complete' and result['result_text']=='生成的描述'
    assert await run_text_task(**kw,generate=fake)==result and len(calls)==1
    parts=calls[0]['contents'][0]['parts']
    assert parts[0]['text']=='描述商品' and base64.b64decode(parts[1]['inlineData']['data'])==image.getvalue()

@pytest.mark.asyncio
async def test_text_task_uncertain_result_blocks_new_batch(tmp_path):
    from services.canvas_text_service import reserve_text_task,run_text_task
    store,project,snapshot,context=setup(tmp_path)
    kw=dict(store=store,project_id=project['id'],operation_key='one',prompt='描述',reference_ids=[],snapshot=snapshot,expected_provider=confirm_canvas_snapshot(snapshot),node_context=context)
    reserve_text_task(**kw)
    async def fake(*args): raise TimeoutError()
    assert (await run_text_task(**kw,generate=fake))['status']=='unknown'
    with pytest.raises(ValueError,match='核对'):
        reserve_text_task(**{**kw,'operation_key':'two','node_context':{**context,'batch_id':'batch-2'}})

def test_text_provider_route_exposes_only_public_selection(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from db import Base
    from routes import canvas
    from services.ai_config_service import create_provider,set_binding
    engine=create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool)
    Base.metadata.create_all(engine);Session=sessionmaker(bind=engine)
    with Session() as db:
        p=create_provider(db,dict(name='text-channel',protocol='openai_compatible',base_url='https://example.invalid',api_key='never-expose-this-secret',text_model='text-model',supports_text=True,supports_image=False))
        set_binding(db,'text',p.id)
    monkeypatch.setattr(canvas,'SessionLocal',Session)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    response=client.get('/api/canvas/text-providers')
    assert response.status_code==200 and response.json()['providers'][0]['model']=='text-model'
    assert 'never-expose-this-secret' not in response.text
    preflight=client.post('/api/canvas/text-preflight/1',json={})
    assert preflight.status_code==200 and preflight.json()['provider']['model']=='text-model'
    assert 'never-expose-this-secret' not in preflight.text

def test_text_reference_must_belong_to_the_same_project(tmp_path):
    from services.canvas_text_service import reserve_text_task
    store,project,snapshot,context=setup(tmp_path)
    other=store.create_project('other',format='node-v1')
    data=io.BytesIO();Image.new('RGB',(2,2),'blue').save(data,format='PNG')
    asset=store.put_asset(other['id'],data.getvalue())
    with pytest.raises(ValueError,match='图片不存在'):
        reserve_text_task(store=store,project_id=project['id'],operation_key='foreign',prompt='描述',reference_ids=[asset['id']],snapshot=snapshot,expected_provider=confirm_canvas_snapshot(snapshot),node_context=context)


def test_text_channel_catalog_is_capability_scoped_and_selectable(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from db import Base
    from routes import canvas
    from services.ai_config_service import create_provider,set_binding
    engine=create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool)
    Base.metadata.create_all(engine);Session=sessionmaker(bind=engine);store=CanvasStore(tmp_path)
    with Session() as db:
        p=create_provider(db,dict(name='text-channel',protocol='openai_compatible',base_url='https://example.invalid',api_key='private-secret',text_model='default-text',image_model='default-image',supports_text=True,supports_image=True))
        pid=p.id;set_binding(db,'text',pid);set_binding(db,'image',pid)
    monkeypatch.setattr(canvas,'SessionLocal',Session);monkeypatch.setattr(canvas,'get_canvas_store',lambda:store)
    app=FastAPI();app.include_router(canvas.router);client=TestClient(app)
    assert client.post(f'/api/canvas/text-providers/{pid}/models',json={'model':'extra-text'}).status_code==200
    choices=client.get('/api/canvas/text-providers').json()['providers'][0]['models']
    assert choices==['default-text','extra-text']
    assert 'extra-text' not in client.get('/api/canvas/providers').json()['providers'][0]['models']
    selected=client.post(f'/api/canvas/text-preflight/{pid}',json={'model':'extra-text'})
    assert selected.status_code==200 and selected.json()['provider']['model']=='extra-text'
    assert 'private-secret' not in selected.text
    assert client.post(f'/api/canvas/text-preflight/{pid}',json={'model':'unlisted'}).status_code==400
    assert client.delete(f'/api/canvas/text-providers/{pid}/models/extra-text').status_code==200
