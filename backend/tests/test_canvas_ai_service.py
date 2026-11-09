from dataclasses import replace

import pytest
from services.ai_config_service import ProviderSnapshot
from services.canvas_ai_service import inspect_canvas_operation, confirm_canvas_snapshot


def snapshot(mode='text_to_image'):
    return ProviderSnapshot(id=1, incarnation_id='incarnation', capability='image', name='Example', protocol='openai_compatible', base_url='https://example.invalid', api_key='secret', vertex_project_id=None, vertex_location=None, vertex_key_path=None, model='image-model', timeout_seconds=60, max_retries=0, config_version=4, image_generation_mode=mode)


def test_incompatible_reference_never_silently_discarded():
    assert inspect_canvas_operation(snapshot(), 'generate', 0, False).supported
    assert not inspect_canvas_operation(snapshot(), 'generate', 1, False).supported
    assert not inspect_canvas_operation(snapshot('image_to_image'), 'generate', 0, False).supported
    assert inspect_canvas_operation(snapshot('image_to_image'), 'generate', 1, False).supported


def test_mask_needs_single_reference_and_compatible_mode():
    assert inspect_canvas_operation(snapshot('image_to_image'), 'edit', 1, True).supported
    assert not inspect_canvas_operation(snapshot('image_to_image'), 'edit', 2, True).supported
    assert not inspect_canvas_operation(snapshot(), 'edit', 1, True).supported


def test_changing_provider_snapshot_is_rejected_without_secret_disclosure():
    public=confirm_canvas_snapshot(snapshot())
    assert 'secret' not in repr(public)
    assert confirm_canvas_snapshot(snapshot(), public) == public
    with pytest.raises(ValueError, match='变更'):
        confirm_canvas_snapshot(replace(snapshot(),config_version=5), public)
    with pytest.raises(ValueError, match='变更'):
        confirm_canvas_snapshot(replace(snapshot(),incarnation_id='another'), public)


def test_invalid_and_unverified_shapes_fail_closed():
    assert not inspect_canvas_operation(snapshot(), 'edit', 0, False).supported
    assert not inspect_canvas_operation(snapshot(), 'generate', True, False).supported
    assert not inspect_canvas_operation(replace(snapshot(), protocol='unknown'), 'generate', 0, False).supported
    assert not inspect_canvas_operation(replace(snapshot(), protocol='gemini'), 'edit', 1, True).supported


def test_preflight_endpoint_reports_masked_configuration_and_compatibility(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import canvas
    monkeypatch.setattr(canvas, 'resolve_image_snapshot', lambda: snapshot())
    app = FastAPI()
    app.include_router(canvas.router)
    client = TestClient(app)
    response = client.post('/api/canvas/preflight', json={'operation':'generate','reference_count':1,'has_mask':False})
    assert response.status_code == 200
    assert response.json()['supported'] is True
    assert response.json()['provider']['image_generation_mode'] == 'image_to_image'
    assert response.json()['provider']['name'] == 'Example'
    assert 'secret' not in response.text


@pytest.mark.asyncio
async def test_mock_generation_is_dispatched_once_and_saved_to_original_project(tmp_path):
    import base64,io
    from PIL import Image
    from services.canvas_ai_service import run_canvas_task
    from services.canvas_store import CanvasStore
    buffer=io.BytesIO();Image.new('RGB',(2,2),'red').save(buffer,format='PNG');encoded=base64.b64encode(buffer.getvalue()).decode()
    store=CanvasStore(tmp_path);p=store.create_project('P');snap=snapshot();calls=[]
    async def generate(payload,selected):
        calls.append((payload,selected));return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':encoded}}]}}]}
    kw={'store':store,'project_id':p['id'],'operation_key':'one','operation':'generate','prompt':'draw','reference_ids':[],'mask_id':None,'snapshot':snap,'expected_provider':confirm_canvas_snapshot(snap),'generate':generate}
    first=await run_canvas_task(**kw);second=await run_canvas_task(**kw)
    assert first['status']=='complete';assert second['id']==first['id'];assert len(calls)==1
    assert store.read_asset(p['id'],first['result_asset_id'])==buffer.getvalue()


@pytest.mark.asyncio
async def test_ambiguous_provider_error_cannot_trigger_duplicate_call(tmp_path):
    from services.canvas_ai_service import run_canvas_task
    from services.canvas_store import CanvasStore
    store=CanvasStore(tmp_path);p=store.create_project('P');snap=snapshot();calls=[]
    async def generate(payload,selected):calls.append(1);raise TimeoutError('timeout')
    kw={'store':store,'project_id':p['id'],'operation_key':'one','operation':'generate','prompt':'draw','reference_ids':[],'mask_id':None,'snapshot':snap,'expected_provider':confirm_canvas_snapshot(snap),'generate':generate}
    assert (await run_canvas_task(**kw))['status']=='unknown';assert (await run_canvas_task(**kw))['status']=='unknown';assert len(calls)==1


def test_canvas_task_failure_explains_timeout_without_claiming_whether_it_was_charged():
    from services.canvas_task_errors import canvas_task_failure
    result=canvas_task_failure(TimeoutError('socket timed out'))
    assert result['status']=='unknown'
    assert '超时' in result['message'] and '无法确认' in result['message'] and '核对服务商任务记录' in result['message']


def test_canvas_task_failure_exposes_safe_provider_rejection_details():
    from types import SimpleNamespace
    from services.canvas_task_errors import canvas_task_failure
    error=SimpleNamespace(category='authentication',diagnostic=SimpleNamespace(http_status=401,provider_code='UNAUTHENTICATED',request_id='req-123'))
    result=canvas_task_failure(error)
    assert result['status']=='failed'
    assert '认证失败' in result['message'] and 'HTTP 401' in result['message'] and 'req-123' in result['message']


@pytest.mark.asyncio
async def test_masked_edit_keeps_pixels_outside_user_mask(tmp_path):
    import base64,io
    from PIL import Image
    from services.canvas_ai_service import run_canvas_task
    from services.canvas_store import CanvasStore
    def png(im):
        buf=io.BytesIO();im.save(buf,format='PNG');return buf.getvalue()
    original=Image.new('RGBA',(2,1),(10,20,30,100));mask=Image.new('RGBA',(2,1),(0,0,0,255));mask.putpixel((1,0),(255,255,255,255));output=Image.new('RGBA',(2,1),(200,100,50,255))
    store=CanvasStore(tmp_path);p=store.create_project('P');src=store.put_asset(p['id'],png(original));sel=store.put_asset(p['id'],png(mask));snap=snapshot('image_to_image');calls=[]
    async def generate(payload, selected):
        calls.append(payload);return {'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':base64.b64encode(png(output)).decode()}}]}}]}
    result=await run_canvas_task(store=store,project_id=p['id'],operation_key='mask',operation='edit',prompt='replace',reference_ids=[src['id']],mask_id=sel['id'],snapshot=snap,expected_provider=confirm_canvas_snapshot(snap),generate=generate)
    with Image.open(io.BytesIO(store.read_asset(p['id'],result['result_asset_id']))) as image:
        assert image.getpixel((0,0))==(10,20,30,100);assert image.getpixel((1,0))==(200,100,50,255)
    assert calls[0]['imageEdit']=={'maskIndex':1}
    from services.ai_adapters import extract_openai_edit_images, _openai_edit_mask_bytes
    inputs, sent_mask = extract_openai_edit_images(calls[0])
    with Image.open(io.BytesIO(_openai_edit_mask_bytes(sent_mask, inputs[0]))) as native:
        assert native.getpixel((0,0))[3] == 255
        assert native.getpixel((1,0))[3] == 0
