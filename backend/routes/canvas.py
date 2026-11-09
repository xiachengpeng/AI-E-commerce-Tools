"""Canvas preflight endpoints; never send credentials to the browser."""
from typing import Literal
from dataclasses import replace

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from db import DB_PATH, SessionLocal, AIProviderConfig, AICapabilityBinding
from services.ai_config_service import get_snapshot, get_snapshot_for_provider
from services.canvas_ai_service import confirm_canvas_snapshot, inspect_canvas_operation

router = APIRouter(prefix='/api/canvas', tags=['canvas'])


class CanvasPreflight(BaseModel):
    operation: Literal['generate', 'edit']
    reference_count: int = Field(ge=0, le=16, strict=True)
    has_mask: bool = Field(strict=True)
    provider_id: int | None = Field(default=None, ge=1, strict=True)
    model: str | None = Field(default=None, min_length=1, max_length=160, pattern=r'^[A-Za-z0-9][A-Za-z0-9._:/-]*$')


def resolve_image_snapshot():
    with SessionLocal() as db:
        return get_snapshot(db, 'image')


@router.get('/providers')
def canvas_providers():
    with SessionLocal() as db:
        binding=db.get(AICapabilityBinding, 'image')
        rows=db.query(AIProviderConfig).filter_by(enabled=1,supports_image=1).order_by(AIProviderConfig.name).all()
        return {'providers':[{'id':row.id,'name':row.name,'model':row.image_model,'models':list(dict.fromkeys([row.image_model,*get_canvas_store().provider_models(row.incarnation_id)])),'is_default':bool(binding and binding.provider_config_id==row.id)} for row in rows if row.image_model and row.image_model.strip()]}


@router.get('/text-providers')
def canvas_text_providers():
    with SessionLocal() as db:
        binding=db.get(AICapabilityBinding, 'text')
        rows=db.query(AIProviderConfig).filter_by(enabled=1,supports_text=1).order_by(AIProviderConfig.name).all()
        return {'providers':[{'id':row.id,'name':row.name,'model':row.text_model,'models':list(dict.fromkeys([row.text_model,*get_canvas_store().text_provider_models(row.incarnation_id)])),'is_default':bool(binding and binding.provider_config_id==row.id)} for row in rows if row.text_model and row.text_model.strip()]}


class CanvasModelWrite(BaseModel):
    model: str = Field(min_length=1, max_length=160, pattern=r'^[A-Za-z0-9][A-Za-z0-9._:/-]*$')


@router.post('/text-providers/{provider_id}/models')
def add_canvas_text_model(provider_id: int, body: CanvasModelWrite):
    try:
        with SessionLocal() as db: snapshot=get_snapshot_for_provider(db,'text',provider_id)
        get_canvas_store().add_text_provider_model(snapshot.incarnation_id,body.model)
        return {'models':get_canvas_store().text_provider_models(snapshot.incarnation_id)}
    except ValueError as exc: raise HTTPException(status_code=400,detail=str(exc)) from exc


@router.delete('/text-providers/{provider_id}/models/{model:path}')
def remove_canvas_text_model(provider_id: int, model: str):
    try:
        with SessionLocal() as db: snapshot=get_snapshot_for_provider(db,'text',provider_id)
        get_canvas_store().delete_text_provider_model(snapshot.incarnation_id,model)
        return {'models':get_canvas_store().text_provider_models(snapshot.incarnation_id)}
    except ValueError as exc: raise HTTPException(status_code=400,detail=str(exc)) from exc


@router.post('/providers/{provider_id}/models')
def add_canvas_provider_model(provider_id: int, body: CanvasModelWrite):
    try:
        with SessionLocal() as db: snapshot=get_snapshot_for_provider(db,'image',provider_id)
        get_canvas_store().add_provider_model(snapshot.incarnation_id,body.model)
        return {'models':get_canvas_store().provider_models(snapshot.incarnation_id)}
    except ValueError as exc: raise HTTPException(status_code=400,detail=str(exc)) from exc


@router.delete('/providers/{provider_id}/models/{model:path}')
def remove_canvas_provider_model(provider_id: int, model: str):
    try:
        with SessionLocal() as db: snapshot=get_snapshot_for_provider(db,'image',provider_id)
        get_canvas_store().delete_provider_model(snapshot.incarnation_id,model)
        return {'models':get_canvas_store().provider_models(snapshot.incarnation_id)}
    except ValueError as exc: raise HTTPException(status_code=400,detail=str(exc)) from exc


def resolve_canvas_snapshot(provider_id, model, reference_count):
    if provider_id is None:
        if model is not None: raise ValueError('请先选择图片渠道')
        snapshot=resolve_image_snapshot()
    else:
        with SessionLocal() as db: snapshot=get_snapshot_for_provider(db,'image',provider_id)
        if model is not None: snapshot=replace(snapshot,model=model)
    if snapshot.protocol=='openai_compatible':
        snapshot=replace(snapshot,image_generation_mode='image_to_image' if reference_count else 'text_to_image')
    return snapshot


@router.post('/preflight')
def preflight(request: CanvasPreflight):
    try:
        snapshot = resolve_canvas_snapshot(request.provider_id, request.model, request.reference_count)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    result = inspect_canvas_operation(snapshot, request.operation, request.reference_count, request.has_mask)
    return {'supported': result.supported, 'reason': result.reason, 'provider': confirm_canvas_snapshot(snapshot)}

# The store is opened only when a canvas is used. It lives beside the active
# user database, not in the packaged app or publicly served static tree.
from functools import lru_cache
from pathlib import Path
import os
from fastapi import Response
from services.canvas_store import CanvasStore
from services.image_validation import validate_image_payload


class CanvasCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    format: Literal['invoke-v1','node-v1'] = 'invoke-v1'
    project_id: str | None = Field(default=None, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')


class CanvasDocumentSave(BaseModel):
    revision: int = Field(ge=0, strict=True)
    document: dict


class CanvasAssetUpload(BaseModel):
    data: str = Field(max_length=35_000_000)
    mime_type: Literal['image/png','image/jpeg','image/webp']


@lru_cache(maxsize=1)
def get_canvas_store():
    root = os.environ.get('AI_ECOMMERCE_DATA_DIR') or str(Path(DB_PATH).resolve().parent)
    store = CanvasStore(Path(root) / 'canvas-workspaces')
    store.recover_pending()
    return store


def canvas_error(exc):
    return HTTPException(status_code=400, detail=str(exc))


@router.get('/projects')
def list_canvas_projects(format: Literal['invoke-v1','node-v1']='invoke-v1', archived: bool=False):
    return {'projects':get_canvas_store().list_projects(format=format,archived=archived)}


@router.post('/projects')
def create_canvas_project(body: CanvasCreate):
    try:return get_canvas_store().create_project(body.title,format=body.format,project_id=body.project_id)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.get('/projects/{project_id}')
def get_canvas_project(project_id: str):
    try:return get_canvas_store().get_project(project_id)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/archive')
def archive_canvas_project(project_id: str):
    try:return get_canvas_store().archive_project(project_id)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/restore')
def restore_canvas_project(project_id: str):
    try:return get_canvas_store().restore_project(project_id)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.put('/projects/{project_id}')
def save_canvas_project(project_id: str, body: CanvasDocumentSave):
    try:return get_canvas_store().save_project(project_id,body.revision,body.document)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/assets')
def upload_canvas_asset(project_id: str, body: CanvasAssetUpload):
    try:
        image=validate_image_payload(body.data,body.mime_type)
        store=get_canvas_store();asset=store.put_asset(project_id,image.data)
        return store.asset_info(project_id,asset['id'])
    except ValueError as exc:raise canvas_error(exc) from exc


@router.get('/projects/{project_id}/assets/{asset_id}')
def get_canvas_asset(project_id: str, asset_id: str):
    try:
        store=get_canvas_store();info=store.asset_info(project_id,asset_id)
        return Response(content=store.read_asset(project_id,asset_id),media_type=info['mime_type'],headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
    except ValueError as exc:raise canvas_error(exc) from exc


class CanvasTaskRequest(BaseModel):
    operation_key: str = Field(min_length=1,max_length=200,pattern=r'^[A-Za-z0-9_-]+$')
    operation: Literal['generate','edit']
    prompt: str = Field(min_length=1,max_length=10000)
    reference_ids: list[str] = Field(max_length=16)
    mask_id: str | None = None
    expected_provider: dict
    node_context: dict | None = None
    provider_id: int | None = Field(default=None, ge=1, strict=True)
    model: str | None = Field(default=None, min_length=1, max_length=160, pattern=r'^[A-Za-z0-9][A-Za-z0-9._:/-]*$')


class CanvasTextTaskRequest(BaseModel):
    operation_key: str = Field(min_length=1,max_length=200,pattern=r'^[A-Za-z0-9_-]+$')
    prompt: str = Field(min_length=1,max_length=10000)
    reference_ids: list[str] = Field(max_length=16)
    expected_provider: dict
    node_context: dict
    provider_id: int = Field(ge=1,strict=True)
    model: str | None = Field(default=None, min_length=1,max_length=160,pattern=r'^[A-Za-z0-9][A-Za-z0-9._:/-]*$')


def resolve_text_snapshot(provider_id,model=None):
    with SessionLocal() as db: snapshot=get_snapshot_for_provider(db,'text',provider_id)
    if model and model!=snapshot.model:
        if model not in get_canvas_store().text_provider_models(snapshot.incarnation_id): raise ValueError('文本模型不在该渠道列表中')
        snapshot=replace(snapshot,model=model)
    return snapshot


class CanvasTextPreflight(BaseModel):
    model: str | None = Field(default=None,min_length=1,max_length=160,pattern=r'^[A-Za-z0-9][A-Za-z0-9._:/-]*$')


@router.post('/text-preflight/{provider_id}')
def text_preflight(provider_id: int, body: CanvasTextPreflight):
    try:return {'provider':confirm_canvas_snapshot(resolve_text_snapshot(provider_id,body.model))}
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/text-reservations')
def reserve_canvas_text(project_id: str, body: CanvasTextTaskRequest):
    from services.canvas_text_service import reserve_text_task
    try:return reserve_text_task(store=get_canvas_store(),project_id=project_id,operation_key=body.operation_key,prompt=body.prompt,reference_ids=body.reference_ids,snapshot=resolve_text_snapshot(body.provider_id,body.model),expected_provider=body.expected_provider,node_context=body.node_context)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/text-tasks')
async def submit_canvas_text(project_id: str, body: CanvasTextTaskRequest):
    from services.canvas_text_service import run_text_task
    from services.ai_service import ai_router
    async def generate(payload,snapshot):
        return await ai_router.generate('text',payload,snapshot=replace(snapshot,max_retries=0))
    try:return await run_text_task(store=get_canvas_store(),project_id=project_id,operation_key=body.operation_key,prompt=body.prompt,reference_ids=body.reference_ids,snapshot=resolve_text_snapshot(body.provider_id,body.model),expected_provider=body.expected_provider,node_context=body.node_context,generate=generate)
    except ValueError as exc:raise canvas_error(exc) from exc


async def generate_canvas_image(payload, snapshot):
    from dataclasses import replace
    from services.ai_service import ai_router
    payload = {**payload, 'disable_image_format_fallback': True}
    return await ai_router.generate('image',payload,snapshot=replace(snapshot,max_retries=0))


@router.post('/projects/{project_id}/task-reservations')
def reserve_canvas_task(project_id: str, body: CanvasTaskRequest):
    from services.canvas_ai_service import reserve_node_task
    try:
        if body.node_context is None: raise ValueError('节点任务资料无效')
        return reserve_node_task(store=get_canvas_store(),project_id=project_id,
            operation_key=body.operation_key,operation=body.operation,prompt=body.prompt,
            reference_ids=body.reference_ids,mask_id=body.mask_id,snapshot=resolve_canvas_snapshot(body.provider_id,body.model,len(body.reference_ids)),
            expected_provider=body.expected_provider,node_context=body.node_context)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/task-reservations/{operation_key}/cancel')
def cancel_canvas_task_reservation(project_id: str, operation_key: str):
    try:return get_canvas_store().cancel_reservation(project_id,operation_key)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/tasks')
async def submit_canvas_task(project_id: str, body: CanvasTaskRequest):
    from services.canvas_ai_service import run_canvas_task
    try:
        snapshot=resolve_canvas_snapshot(body.provider_id,body.model,len(body.reference_ids))
        return await run_canvas_task(store=get_canvas_store(),project_id=project_id,
            operation_key=body.operation_key,operation=body.operation,prompt=body.prompt,
            reference_ids=body.reference_ids,mask_id=body.mask_id,snapshot=snapshot,
            expected_provider=body.expected_provider,generate=generate_canvas_image,node_context=body.node_context)
    except ValueError as exc:raise canvas_error(exc) from exc


@router.get('/projects/{project_id}/tasks/by-operation/{operation_key}')
def canvas_task_by_operation(project_id: str,operation_key: str):
    try:return get_canvas_store().task_by_operation(project_id,operation_key)
    except ValueError as exc:raise HTTPException(status_code=404,detail=str(exc)) from exc


@router.get('/projects/{project_id}/tasks')
def list_canvas_tasks(project_id: str, limit: int=50, offset: int=0):
    try:return {'tasks':get_canvas_store().list_tasks(project_id,limit=limit,offset=offset)}
    except ValueError as exc:raise canvas_error(exc) from exc


@router.post('/projects/{project_id}/tasks/by-operation/{operation_key}/acknowledge')
def acknowledge_canvas_task(project_id: str,operation_key: str):
    try:return get_canvas_store().acknowledge_unknown(project_id,operation_key)
    except ValueError as exc:raise canvas_error(exc) from exc
