import base64
import io

import pytest
from PIL import Image
from services.canvas_store import CanvasStore
from services.canvas_ai_service import confirm_canvas_snapshot, run_canvas_task
from services.ai_config_service import ProviderSnapshot

def snapshot(mode='text_to_image'):
    return ProviderSnapshot(id=1,incarnation_id='inc',capability='image',name='fake',protocol='openai_compatible',base_url='https://example.invalid',api_key='secret',vertex_project_id=None,vertex_location=None,vertex_key_path=None,model='fake',timeout_seconds=30,max_retries=0,config_version=1,image_generation_mode=mode)


def png():
    out=io.BytesIO();Image.new('RGB',(2,2),'blue').save(out,format='PNG');return out.getvalue()


@pytest.mark.asyncio
async def test_node_task_freezes_original_node_and_project_revision(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('node',format='node-v1')
    p=store.save_project(p['id'],p['revision'],{'nodes':[{'id':'node-1'}],'connections':[]})
    selected=snapshot('text_to_image');calls=[]
    async def fake(payload,provider):
        calls.append(payload);return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':base64.b64encode(png()).decode()}}]}}]}
    kw=dict(store=store,project_id=p['id'],operation_key='operation-one',operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),generate=fake,node_context={'node_id':'node-1','project_revision':p['revision'],'node_revision':'version-a','connections':[]})
    result=await run_canvas_task(**kw)
    assert result['status']=='complete' and result['request']['node_context']==kw['node_context']
    assert len(calls)==1
    assert (await run_canvas_task(**kw))['id']==result['id'] and len(calls)==1


@pytest.mark.asyncio
async def test_stale_node_project_revision_blocks_provider_call(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('node',format='node-v1')
    store.save_project(p['id'],0,{'nodes':[{'id':'node-1'}]})
    selected=snapshot('text_to_image');calls=[]
    async def fake(*args): calls.append(1);return {}
    with pytest.raises(ValueError,match='画布'):
        await run_canvas_task(store=store,project_id=p['id'],operation_key='stale',operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),generate=fake,node_context={'node_id':'node-1','project_revision':0,'node_revision':'v','connections':[]})
    assert not calls


@pytest.mark.asyncio
async def test_late_result_keeps_original_project_and_never_recreates_deleted_node(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('node',format='node-v1');other=store.create_project('other',format='node-v1')
    p=store.save_project(p['id'],0,{'nodes':[{'id':'n'}],'connections':[]})
    selected=snapshot()
    async def fake(payload,provider):
        store.save_project(p['id'],p['revision'],{'nodes':[],'connections':[]})
        return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':base64.b64encode(png()).decode()}}]}}]}
    task=await run_canvas_task(store=store,project_id=p['id'],operation_key='delayed',operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),generate=fake,node_context={'node_id':'n','project_revision':p['revision'],'node_revision':'v1','connections':[]})
    assert task['status']=='complete' and task['project_id']==p['id']
    assert store.get_project(p['id'])['document']['nodes']==[]
    assert store.read_asset(p['id'],task['result_asset_id'])==png()
    with pytest.raises(ValueError):store.read_asset(other['id'],task['result_asset_id'])


@pytest.mark.asyncio
async def test_reserved_node_task_survives_later_canvas_edits_without_rebinding(tmp_path):
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('node',format='node-v1')
    p=store.save_project(p['id'],0,{'nodes':[{'id':'n','text':'before'}],'connections':[]})
    selected=snapshot();node={'node_id':'n','project_revision':p['revision'],'node_revision':'v1','connections':[]}
    kw=dict(store=store,project_id=p['id'],operation_key='reserved',operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),node_context=node)
    reservation=reserve_node_task(**kw);assert reservation['status']=='prepared'
    store.save_project(p['id'],p['revision'],{'nodes':[{'id':'n','text':'after'}],'connections':[]})
    calls=[]
    async def fake(payload,provider):
        calls.append(1);return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':base64.b64encode(png()).decode()}}]}}]}
    result=await run_canvas_task(**kw,generate=fake)
    assert result['status']=='complete' and result['request']['node_context']==node and calls==[1]
    assert store.get_project(p['id'])['document']['nodes'][0]['text']=='after'


def test_unsubmitted_reservation_can_be_cancelled_but_never_reclaimed(tmp_path):
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1');p=store.save_project(p['id'],0,{'nodes':[{'id':'n'}]});selected=snapshot()
    node={'node_id':'n','project_revision':p['revision'],'node_revision':'v','connections':[]}
    task=reserve_node_task(store=store,project_id=p['id'],operation_key='a',operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),node_context=node)
    store.cancel_reservation(p['id'],'a');assert store.get_task(task['id'])['status']=='failed';assert not store.claim_task(task['id'])

def test_prepared_tasks_block_other_batches_until_cancelled(tmp_path):
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1');p=store.save_project(p['id'],0,{'nodes':[{'id':'n'}]});selected=snapshot()
    node={'node_id':'n','project_revision':p['revision'],'node_revision':'v','connections':[]}
    args=dict(store=store,project_id=p['id'],operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected))
    first={**node,'batch_id':'batch-one'}
    reserve_node_task(**args,operation_key='a',node_context=first)
    reserve_node_task(**args,operation_key='b',node_context=first)
    with pytest.raises(ValueError,match='未提交'):
        reserve_node_task(**args,operation_key='c',node_context={**node,'batch_id':'batch-two'})
    store.cancel_reservation(p['id'],'a')
    store.cancel_reservation(p['id'],'b')
    assert reserve_node_task(**args,operation_key='c',node_context={**node,'batch_id':'batch-two'})['status']=='prepared'


def test_task_history_pages_remain_project_scoped(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1');other=store.create_project('other',format='node-v1')
    for i in range(5):store.create_task(p['id'],f'op-{i}',{'i':i})
    store.create_task(other['id'],'foreign',{})
    page1=store.list_tasks(p['id'],limit=2,offset=0);page2=store.list_tasks(p['id'],limit=2,offset=2)
    assert [item['operation_key'] for item in page1]==['op-4','op-3']
    assert [item['operation_key'] for item in page2]==['op-2','op-1']


def test_unreviewed_uncertain_task_blocks_new_reservation_until_acknowledged(tmp_path):
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1');p=store.save_project(p['id'],0,{'nodes':[{'id':'n'}]});selected=snapshot();node={'node_id':'n','project_revision':p['revision'],'node_revision':'v','connections':[]}
    args=dict(store=store,project_id=p['id'],operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),node_context=node)
    task=reserve_node_task(**args,operation_key='first');assert store.claim_task(task['id']);store.mark_task(task['id'],'unknown')
    with pytest.raises(ValueError,match='核对'):reserve_node_task(**args,operation_key='second')
    store.acknowledge_unknown(p['id'],'first');assert reserve_node_task(**args,operation_key='second')['status']=='prepared'


def test_unreviewed_uncertain_task_on_another_node_does_not_block_reservation(tmp_path):
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1')
    p=store.save_project(p['id'],0,{'nodes':[{'id':'first'},{'id':'second'}],'connections':[]})
    selected=snapshot()
    args=dict(store=store,project_id=p['id'],operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected))
    first=reserve_node_task(**args,operation_key='first-op',node_context={'node_id':'first','project_revision':p['revision'],'node_revision':'v1','connections':[]})
    assert store.claim_task(first['id'])
    store.mark_task(first['id'],'unknown',error_message='provider response was interrupted')
    second=reserve_node_task(**args,operation_key='second-op',node_context={'node_id':'second','project_revision':p['revision'],'node_revision':'v2','connections':[]})
    assert second['status']=='prepared'


def test_unsubmitted_task_on_another_node_does_not_block_reservation(tmp_path):
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1')
    p=store.save_project(p['id'],0,{'nodes':[{'id':'first'},{'id':'second'}],'connections':[]})
    selected=snapshot()
    args=dict(store=store,project_id=p['id'],operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected))
    first=reserve_node_task(**args,operation_key='first-op',node_context={'node_id':'first','project_revision':p['revision'],'node_revision':'v1','connections':[]})
    second=reserve_node_task(**args,operation_key='second-op',node_context={'node_id':'second','project_revision':p['revision'],'node_revision':'v2','connections':[]})
    assert first['status']=='prepared' and second['status']=='prepared'


@pytest.mark.asyncio
async def test_reserved_task_cannot_switch_confirmed_model(tmp_path):
    from dataclasses import replace
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1');p=store.save_project(p['id'],0,{'nodes':[{'id':'n'}]})
    selected=snapshot();node={'node_id':'n','project_revision':p['revision'],'node_revision':'v','connections':[], 'selected_provider_id':selected.id,'selected_model':selected.model}
    kw=dict(store=store,project_id=p['id'],operation_key='bound',operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),node_context=node)
    reserve_node_task(**kw);other=replace(selected,model='different');calls=[]
    async def fake(*args): calls.append(1);return {}
    with pytest.raises(ValueError): await run_canvas_task(**{**kw,'snapshot':other,'expected_provider':confirm_canvas_snapshot(other)},generate=fake)
    assert calls==[]


@pytest.mark.asyncio
async def test_image_options_are_frozen_and_reach_image_request(tmp_path):
    from services.canvas_ai_service import reserve_node_task
    store=CanvasStore(tmp_path);p=store.create_project('P',format='node-v1');p=store.save_project(p['id'],0,{'nodes':[{'id':'n'}]});selected=snapshot()
    settings={'size':'1024x1536','quality':'high','background':'transparent'}
    node={'node_id':'n','project_revision':p['revision'],'node_revision':'v','connections':[],'image_settings':settings}
    kw=dict(store=store,project_id=p['id'],operation_key='opts',operation='generate',prompt='a',reference_ids=[],mask_id=None,snapshot=selected,expected_provider=confirm_canvas_snapshot(selected),node_context=node)
    reserve_node_task(**kw);captured=[]
    async def fake(payload,provider):
        captured.append(payload);return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':base64.b64encode(png()).decode()}}]}}]}
    await run_canvas_task(**kw,generate=fake)
    assert captured[0]['canvasImageSettings']==settings
