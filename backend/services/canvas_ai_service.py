"""Fail-closed capability checks for the image canvas.

A successful check means the existing adapter can encode the request; it is not
proof that a particular third-party model accepts the request or preserves pixels.
"""
from dataclasses import dataclass

from services.ai_config_service import ProviderSnapshot


@dataclass(frozen=True)
class CanvasCapability:
    supported: bool
    reason: str = ''


def inspect_canvas_operation(snapshot: ProviderSnapshot, operation: str, reference_count: int, has_mask: bool) -> CanvasCapability:
    if snapshot.capability != 'image' or operation not in {'generate', 'edit'}:
        return CanvasCapability(False, '当前操作或图片服务无效。')
    if not isinstance(reference_count, int) or isinstance(reference_count, bool) or reference_count < 0:
        return CanvasCapability(False, '参考图片数量无效。')
    if operation == 'edit' and reference_count == 0:
        return CanvasCapability(False, '图片编辑需要选择原图。')
    if has_mask and (operation != 'edit' or reference_count != 1):
        return CanvasCapability(False, '局部编辑需要一张原图和一张遮罩。')
    if snapshot.protocol == 'openai_compatible':
        if snapshot.image_generation_mode == 'text_to_image':
            if reference_count or has_mask:
                return CanvasCapability(False, '当前图片服务设置为文生图，无法发送参考图；请在设置中选择支持图生图的配置。')
        elif snapshot.image_generation_mode == 'image_to_image':
            if reference_count == 0:
                return CanvasCapability(False, '当前图片服务设置为图生图，需要参考图；请在设置中选择支持文生图的配置。')
        else:
            return CanvasCapability(False, '当前图片服务模式不支持此操作。')
    elif snapshot.protocol in {'gemini', 'vertex'}:
        if has_mask:
            return CanvasCapability(False, '该服务的遮罩编辑尚未验证，请使用已验证的图片编辑配置。')
    else:
        return CanvasCapability(False, '当前图片服务协议不支持画布操作。')
    return CanvasCapability(True)


def confirm_canvas_snapshot(snapshot: ProviderSnapshot, expected: dict | None = None) -> dict:
    public = {'id': snapshot.id, 'incarnation_id': snapshot.incarnation_id,
              'config_version': snapshot.config_version, 'name': snapshot.name,
              'protocol': snapshot.protocol, 'model': snapshot.model,
              'image_generation_mode': snapshot.image_generation_mode}
    if expected is not None and any(expected.get(key) != public[key] for key in ('id', 'incarnation_id', 'config_version', 'model', 'image_generation_mode')):
        raise ValueError('图片服务配置已变更，请重新确认。')
    return public


def _node_identity(operation, prompt, reference_ids, mask_id, snapshot, node_context):
    return {'operation':operation,'prompt':prompt,'reference_ids':reference_ids,'mask_id':mask_id,
            'provider':{'id':snapshot.id,'incarnation_id':snapshot.incarnation_id,'config_version':snapshot.config_version},
            'node_context':node_context}


def _validate_node_project(store, project_id, node_context):
    if not isinstance(node_context,dict) or not isinstance(node_context.get('node_id'),str) or not node_context['node_id'] or not isinstance(node_context.get('project_revision'),int) or isinstance(node_context['project_revision'],bool) or not isinstance(node_context.get('node_revision'),str) or not isinstance(node_context.get('connections'),list):
        raise ValueError('节点任务资料无效')
    project=store.get_project(project_id)
    if project['format']!='node-v1' or project['archived'] or project['revision']!=node_context['project_revision']:
        raise ValueError('画布已更改，请保存并重新确认')
    if not any(isinstance(node,dict) and node.get('id')==node_context['node_id'] for node in project['document'].get('nodes',[])):
        raise ValueError('画布节点不存在')


def _image_settings(snapshot, node_context):
    import re
    settings=(node_context or {}).get('image_settings')
    if settings is None: return None
    if not isinstance(settings,dict) or set(settings)!={'size','quality','background'}:
        raise ValueError('图片参数无效')
    size,quality,background=settings['size'],settings['quality'],settings['background']
    if not isinstance(size,str) or len(size)>32 or not re.fullmatch(r'(?:auto|[1-9][0-9]{0,3}(?:x|:)[1-9][0-9]{0,3})',size): raise ValueError('图片尺寸无效')
    if size!='auto':
        separator='x' if 'x' in size else ':'
        width,height=map(int,size.split(separator))
        if max(width,height)/min(width,height)>3: raise ValueError('图片宽高比例不能超过 3:1')
        if separator=='x' and (width%16 or height%16 or max(width,height)>3840 or not 655360<=width*height<=8294400): raise ValueError('图片尺寸不符合原版范围或步长')
    if quality not in {'auto','low','medium','high','xhigh','max'} or background not in {'','transparent'}: raise ValueError('图片质量或背景参数无效')
    if snapshot.protocol in {'gemini','vertex'} and (quality!='auto' or background): raise ValueError('当前渠道不支持所选质量或透明背景参数')
    return dict(settings)


def _confirm_node_selection(snapshot, node_context):
    if node_context is not None and ('selected_provider_id' in node_context or 'selected_model' in node_context):
        if node_context.get('selected_provider_id') != snapshot.id or node_context.get('selected_model') != snapshot.model:
            raise ValueError('已确认的图片渠道或模型发生变化，请重新确认。')


def reserve_node_task(*, store, project_id, operation_key, operation, prompt, reference_ids, mask_id,
                      snapshot, expected_provider, node_context):
    from services.image_validation import validate_image_payload
    confirm_canvas_snapshot(snapshot,expected_provider)
    _confirm_node_selection(snapshot,node_context)
    _image_settings(snapshot,node_context)
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>10000 or not isinstance(reference_ids,list) or len(reference_ids)>16 or any(not isinstance(value,str) for value in reference_ids):
        raise ValueError('图片请求无效')
    capability=inspect_canvas_operation(snapshot,operation,len(reference_ids),mask_id is not None)
    if not capability.supported: raise ValueError(capability.reason)
    images=[validate_image_payload(store.read_asset(project_id,value),strict_mime=False) for value in reference_ids]
    mask=validate_image_payload(store.read_asset(project_id,mask_id),strict_mime=False) if mask_id else None
    if mask and (mask.width,mask.height)!=(images[0].width,images[0].height): raise ValueError('遮罩尺寸必须与原图一致')
    _validate_node_project(store,project_id,node_context)
    identity=_node_identity(operation,prompt,reference_ids,mask_id,snapshot,node_context)
    return store.create_task(project_id,operation_key,identity,expected_revision=node_context['project_revision'])


async def run_canvas_task(*, store, project_id, operation_key, operation, prompt, reference_ids, mask_id,
                          snapshot, expected_provider, generate, node_context=None):
    """Claim once, send one frozen request and save a project-bound result.

    `generate(payload, snapshot)` is an injected async adapter; provider snapshot
    is captured by the caller and cannot be silently rebound during the request.
    """
    import base64
    from io import BytesIO
    from PIL import Image
    from services.image_validation import validate_image_payload

    confirm_canvas_snapshot(snapshot, expected_provider)
    _confirm_node_selection(snapshot,node_context)
    image_settings=_image_settings(snapshot,node_context)
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt)>10000:
        raise ValueError('请输入有效的生成要求')
    if not isinstance(reference_ids,list) or any(not isinstance(x,str) for x in reference_ids):
        raise ValueError('参考图无效')
    status=inspect_canvas_operation(snapshot,operation,len(reference_ids),mask_id is not None)
    if not status.supported: raise ValueError(status.reason)
    source_data=[store.read_asset(project_id, asset_id) for asset_id in reference_ids]
    mask_data=store.read_asset(project_id,mask_id) if mask_id else None
    source=[validate_image_payload(x,strict_mime=False) for x in source_data]
    mask=validate_image_payload(mask_data,strict_mime=False) if mask_data else None
    if mask and (mask.width,mask.height)!=(source[0].width,source[0].height):
        raise ValueError('遮罩尺寸必须与原图一致')
    reserved=False
    if node_context is not None:
        identity=_node_identity(operation,prompt,reference_ids,mask_id,snapshot,node_context)
        try:
            existing=store.task_by_operation(project_id,operation_key)
        except ValueError:
            existing=None
        if existing is not None:
            if existing['request']!=identity: raise ValueError('操作编号已用于其他请求')
            reserved=True
        else:
            _validate_node_project(store,project_id,node_context)
    parts=[{'text':prompt}]
    # Browser canvas PNGs have an opaque alpha channel. Normalize the
    # white-edit mask to grayscale so the adapter can invert it to native alpha.
    if mask:
        with Image.open(BytesIO(mask.data)) as decoded:
            buffer=BytesIO();decoded.convert('L').save(buffer,format='PNG')
            mask=validate_image_payload(buffer.getvalue(),strict_mime=False)
    for item in [*source,*([mask] if mask else [])]:
        parts.append({'inlineData':{'mimeType':item.mime_type,'data':base64.b64encode(item.data).decode('ascii')}})
    payload={'contents':[{'role':'user','parts':parts}],'client_operation_key':operation_key,
             'generationConfig':{'responseModalities':['IMAGE']}}
    if mask: payload['imageEdit']={'maskIndex':len(parts)-2}
    if image_settings is not None:
        payload['canvasImageSettings']=image_settings
        size=image_settings['size']
        if snapshot.protocol in {'gemini','vertex'} and size!='auto':
            separator='x' if 'x' in size else ':'
            width,height=map(int,size.split(separator));target=width/height
            ratios=['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9']
            def distance(value):
                w,h=map(int,value.split(':'));return abs(w/h-target)
            image_config={'aspectRatio':min(ratios,key=distance)}
            if separator=='x':
                edge=max(width,height);image_config['imageSize']='512' if edge<=768 else '1K' if edge<=1536 else '2K' if edge<=3072 else '4K'
            payload['generationConfig']['imageConfig']=image_config
    request_identity={'operation':operation,'prompt':prompt,'reference_ids':reference_ids,'mask_id':mask_id,
                      'provider':{'id':snapshot.id,'incarnation_id':snapshot.incarnation_id,'config_version':snapshot.config_version}}
    if node_context is not None: request_identity['node_context']=node_context
    task=store.create_task(project_id,operation_key,request_identity)
    with store.task_lease(task['id']) as acquired:
        if not acquired: return store.get_task(task['id'])
        if not store.claim_task(task['id'],expected_revision=node_context['project_revision'] if node_context is not None and not reserved else None):
            current=store.get_task(task['id'])
            if current['status']=='failed' and node_context is not None: raise ValueError('画布已更改，请保存并重新确认')
            return current
        try:
            response=await generate(payload,snapshot)
            result=None
            for candidate in response.get('candidates',[]):
                for part in candidate.get('content',{}).get('parts',[]):
                    item=part.get('inlineData') or part.get('inline_data')
                    if item:
                        result=validate_image_payload(item.get('data'),item.get('mimeType') or item.get('mime_type'));break
                if result:break
            if not result: raise ValueError('服务未返回图片')
            result_data=result.data
            if mask:
                if (result.width,result.height)!=(source[0].width,source[0].height):
                    raise ValueError('生成图尺寸与原图不一致，无法安全合成')
                with Image.open(BytesIO(source[0].data)) as original, Image.open(BytesIO(result.data)) as output, Image.open(BytesIO(mask.data)) as selection:
                    merged=Image.composite(output.convert('RGBA'),original.convert('RGBA'),selection.convert('L'))
                    buffer=BytesIO();merged.save(buffer,format='PNG');result_data=buffer.getvalue()
            return store.put_task_result(task['id'],project_id,result_data)
        except BaseException as exc:
            # Provider may have received or completed the request, even after an error.
            if store.get_task(task['id'])['status']=='submitted':
                from services.canvas_task_errors import canvas_task_failure
                failure=canvas_task_failure(exc)
                store.mark_task(task['id'],failure['status'],error_message=failure['message'])
            if not isinstance(exc,Exception): raise
            return store.get_task(task['id'])
