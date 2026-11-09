"""Project-bound, single-submission canvas text tasks."""
import base64
from services.canvas_ai_service import confirm_canvas_snapshot, _validate_node_project
from services.image_validation import validate_image_payload


def identity(snapshot,prompt,reference_ids,node_context):
    return {'operation':'text','prompt':prompt,'reference_ids':reference_ids,
            'provider':{'id':snapshot.id,'incarnation_id':snapshot.incarnation_id,'config_version':snapshot.config_version},'node_context':node_context}


def validate(store,project_id,prompt,reference_ids,snapshot,expected_provider,node_context):
    if snapshot.capability!='text': raise ValueError('文本渠道无效')
    if not isinstance(node_context,dict): raise ValueError('节点任务资料无效')
    confirm_canvas_snapshot(snapshot,expected_provider)
    if node_context.get('selected_provider_id',snapshot.id)!=snapshot.id or node_context.get('selected_model',snapshot.model)!=snapshot.model: raise ValueError('文本渠道或模型已变更')
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>10000 or not isinstance(reference_ids,list) or len(reference_ids)>16 or any(not isinstance(x,str) for x in reference_ids): raise ValueError('文本请求无效')
    effort=node_context.get('reasoning_effort','auto')
    if effort not in {'auto','low','medium','high','xhigh'}: raise ValueError('推理参数无效')
    if effort!='auto' and snapshot.protocol!='openai_compatible': raise ValueError('当前文本渠道暂不支持指定推理强度，请选择自动')
    return [validate_image_payload(store.read_asset(project_id,ref),strict_mime=False) for ref in reference_ids]


def reserve_text_task(*,store,project_id,operation_key,prompt,reference_ids,snapshot,expected_provider,node_context):
    validate(store,project_id,prompt,reference_ids,snapshot,expected_provider,node_context)
    _validate_node_project(store,project_id,node_context)
    return store.create_task(project_id,operation_key,identity(snapshot,prompt,reference_ids,node_context),expected_revision=node_context['project_revision'])


async def run_text_task(*,store,project_id,operation_key,prompt,reference_ids,snapshot,expected_provider,node_context,generate):
    images=validate(store,project_id,prompt,reference_ids,snapshot,expected_provider,node_context)
    existing=store.task_by_operation(project_id,operation_key)
    if existing['request']!=identity(snapshot,prompt,reference_ids,node_context): raise ValueError('操作编号已用于其他请求')
    parts=[{'text':prompt}]+[{'inlineData':{'mimeType':image.mime_type,'data':base64.b64encode(image.data).decode('ascii')}} for image in images]
    payload={'contents':[{'role':'user','parts':parts}],'client_operation_key':operation_key}
    if node_context.get('reasoning_effort','auto')!='auto':payload['canvasReasoningEffort']=node_context['reasoning_effort']
    with store.task_lease(existing['id']) as acquired:
        if not acquired or not store.claim_task(existing['id']): return store.get_task(existing['id'])
        try:
            response=await generate(payload,snapshot)
            text=''.join(part.get('text','') for candidate in response.get('candidates',[]) for part in candidate.get('content',{}).get('parts',[]) if isinstance(part.get('text'),str))
            return store.complete_text_task(existing['id'],text)
        except BaseException as exc:
            if store.get_task(existing['id'])['status']=='submitted':
                from services.canvas_task_errors import canvas_task_failure
                failure=canvas_task_failure(exc)
                store.mark_task(existing['id'],failure['status'],error_message=failure['message'])
            if not isinstance(exc,Exception): raise
            return store.get_task(existing['id'])
