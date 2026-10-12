"""Research-only session and routes; old business endpoints remain unchanged."""
import secrets
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from models.research import (
    ConfirmFactRequest,
    LogisticsRequest,
    PreviewRequest,
    ScenarioRequest,
)
from modules.research_math.estimates import scenario_rows
from modules.research_math.logistics import logistics_weights
from modules.research_math.markets import MARKETS
from pydantic import ValidationError
from services.research_client import ResearchClient, ResearchError, load_research_config
from services.research_mapper import build_marketing_preview

router = APIRouter(prefix='/api/research/v1', tags=['research'])
_session_token = secrets.token_urlsafe(32)
_origins = {'http://127.0.0.1:9502', 'http://localhost:9502', 'http://127.0.0.1:9503', 'http://localhost:9503'}


def guard_origin(request: Request):
    from services.research_security import require_research_session
    require_research_session(request, write=False, bootstrap=True)


def require_session(request: Request):
    from services.research_security import require_research_session
    require_research_session(request, write=request.method not in {'GET', 'HEAD', 'OPTIONS'})


@router.get('/session')
def session(request: Request):
    guard_origin(request)
    config = load_research_config()
    endpoint = config.get('base_url', '')
    try:
        parsed = urlsplit(endpoint) if isinstance(endpoint, str) else None
        if parsed:
            _ = parsed.port
    except ValueError:
        parsed = None
    embed_url = (endpoint.rstrip('/') + '/marketing-workbench'
                 if parsed and parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost'}
                 and not parsed.username and not parsed.password and not parsed.query and parsed.path in {'', '/'} else None)
    return JSONResponse({'csrf_token': _session_token, 'enabled': config.get('enabled') is True,
                         'embed_url': embed_url if config.get('enabled') is True and config.get('mode', 'remote') == 'remote' else None,
                         'workbench_url': config.get('workbench_url') if config.get('enabled') is True and config.get('mode', 'remote') == 'remote' else None},
                        headers={'Cache-Control': 'no-store'})


def client(*, runtime=None, config=None):
    config = load_research_config() if config is None else config
    if config.get('enabled') is not True:
        raise HTTPException(503, '研究连接尚未启用，独立计算工具仍可使用')
    try:
        mode = config.get('mode', 'remote')
        if mode == 'local':
            from services.research_facade import ResearchFacade
            return ResearchFacade(runtime)
        if mode != 'remote':
            raise ResearchError('invalid_mode', '研究模式必须明确选择 local 或 remote')
        return ResearchClient(config)
    except ResearchError as e:
        raise HTTPException(e.status, {'code': e.code, 'message': str(e)}) from None


def routed_client(request):
    # Existing default and legacy test adapters retain the zero-argument factory.
    config = load_research_config()
    if config.get('mode', 'remote') == 'local':
        return client(runtime=getattr(request.app.state, 'research_runtime', None), config=config)
    return client()


async def invoke(call):
    try:
        return await call
    except ResearchError as e:
        raise HTTPException(e.status, {'code': e.code, 'message': str(e)}) from None


@router.get('/markets', dependencies=[Depends(require_session)])
def markets():
    return {code: {'name': item.name, 'language': item.language} for code, item in MARKETS.items()}


@router.post('/math/logistics', dependencies=[Depends(require_session)])
def logistics(payload: LogisticsRequest):
    try:
        return logistics_weights(**payload.model_dump())
    except (TypeError, ValueError):
        raise HTTPException(422, '重量、尺寸及计费除数必须为正数；未知项请留空') from None


@router.post('/math/scenarios', dependencies=[Depends(require_session)])
def scenarios(payload: ScenarioRequest):
    try:
        return scenario_rows(**payload.model_dump())
    except (TypeError, ValueError):
        raise HTTPException(422, '请核对流量、客单价及低中高转化率；转化率须有序且在0–100之间') from None


@router.get('/projects', dependencies=[Depends(require_session)])
async def projects(request: Request, cursor: UUID | None = None, limit: int = Query(20, ge=1, le=50)):
    return await invoke(routed_client(request).list_projects(cursor, limit))


@router.get('/projects/{project_id}', dependencies=[Depends(require_session)])
async def project(request: Request, project_id: UUID):
    return await invoke(routed_client(request).get_project(project_id))


@router.get('/projects/{project_id}/report', dependencies=[Depends(require_session)])
async def report(request: Request, project_id: UUID):
    from models.research import ResearchReport
    return await validated_projection(request, project_id, '/report', ResearchReport)


async def validated_projection(request, project_id, suffix, model):
    data = await invoke(routed_client(request).request('GET', '/projects/' + str(project_id) + suffix))
    try:
        parsed = model.model_validate(data).model_dump(mode='json')
        if parsed['project_id'] != str(project_id):
            raise ValueError
        return parsed
    except (ValidationError, ValueError):
        raise HTTPException(503, '研究响应身份或格式不匹配') from None


@router.get('/projects/{project_id}/confirmations/{command_id}', dependencies=[Depends(require_session)])
async def confirmation_status(request: Request, project_id: UUID, command_id: UUID):
    from models.research import ConfirmationStatus
    result = await validated_projection(request, project_id, '/confirmations/' + str(command_id), ConfirmationStatus)
    if result['command_id'] != str(command_id):
        raise HTTPException(503, '研究操作响应不匹配')
    return result


@router.post('/projects/{project_id}/products/{product_id}/preview', dependencies=[Depends(require_session)])
async def preview(request: Request, project_id: UUID, product_id: UUID, payload: PreviewRequest):
    snapshot = await invoke(routed_client(request).get_product(project_id, product_id))
    ref = snapshot['source_ref']
    if (ref['source_version'] != payload.expected_source_version or ref['identity_revision'] != payload.expected_identity_revision
            or snapshot['market'] != payload.expected_market):
        raise HTTPException(409, '研究资料或商品身份已更新，请刷新后重新预览')
    return build_marketing_preview(snapshot, payload.existing)


@router.post('/projects/{project_id}/products/{product_id}/confirm-fact', dependencies=[Depends(require_session)])
async def confirm_fact(request: Request, project_id: UUID, product_id: UUID, body: ConfirmFactRequest):
    data = body.model_dump(mode='json')
    payload = {key: data[key] for key in ('identity_revision', 'market', 'key', 'value', 'source_url', 'own_product')}
    payload['product_id'] = str(product_id)
    result = await invoke(routed_client(request).request('POST', '/projects/' + str(project_id) + '/confirm-fact',
                         {'command_id': str(body.command_id), 'expected_version': body.expected_version, 'payload': payload}))
    from models.research import ProjectSnapshot
    from pydantic import ValidationError
    try:
        parsed = ProjectSnapshot.model_validate(result).model_dump(mode='json')
        if parsed['id'] != str(project_id):
            raise ValueError
        return parsed
    except (ValidationError, ValueError):
        raise HTTPException(503, '确认结果尚未核实，请刷新研究状态，勿更换操作编号重复提交') from None


def repository():
    from db import DB_PATH
    from services.research_repository import ResearchRepository
    return ResearchRepository(DB_PATH)


def local_call(callback):
    from services.research_repository import RepositoryError
    try:
        return callback()
    except RepositoryError as exc:
        raise HTTPException(exc.status, str(exc)) from None


@router.get('/imports', dependencies=[Depends(require_session)])
def list_imports(cursor: UUID | None = None, limit: int = Query(20, ge=1, le=50)):
    return local_call(lambda: repository().list(limit, str(cursor) if cursor else None))


@router.get('/imports/{import_id}', dependencies=[Depends(require_session)])
def import_status(import_id: UUID):
    result = local_call(lambda: repository().lookup(import_id))
    if not result:
        raise HTTPException(404, '尚未查到此导入记录')
    return result


from models.research import AttachResearchArtifact, SaveResearchImport


@router.post('/projects/{project_id}/products/{product_id}/imports', dependencies=[Depends(require_session)])
async def save_import(request: Request, project_id: UUID, product_id: UUID, payload: SaveResearchImport):
    from services.research_unit_of_work import confirm_and_import, import_request_digest
    if not payload.name.strip():
        raise HTTPException(422, '档案名称不能为空')
    data = {'project_id': str(project_id), 'product_id': str(product_id), **payload.model_dump(mode='json')}
    request_digest = import_request_digest(data)
    config = load_research_config()
    runtime = getattr(request.app.state, 'research_runtime', None)
    if (config.get('enabled') is True and config.get('mode', 'remote') == 'local'
            and runtime is not None and runtime.engine is not None and runtime.store is not None
            and runtime.evidence_store is not None and not runtime.diagnostics):
        owner = client(runtime=runtime, config=config)
        from services.research_repository import RepositoryError
        try:
            return await invoke(confirm_and_import(owner.runtime, data, payload.import_id))
        except RepositoryError as exc:
            raise HTTPException(exc.status, str(exc)) from None
    # Preserve reconciliation of committed remote receipts with research offline.
    previous = local_call(lambda: repository().lookup(payload.import_id, request_digest))
    if previous:
        return previous
    if payload.confirmation is not None and config.get('mode', 'remote') != 'local':
        raise HTTPException(422, '确认并导入仅支持本地研究运行时')
    owner = routed_client(request)
    if config.get('mode', 'remote') == 'local':
        from services.research_repository import RepositoryError
        try:
            return await invoke(confirm_and_import(owner.runtime, data, payload.import_id))
        except RepositoryError as exc:
            raise HTTPException(exc.status, str(exc)) from None
    snapshot = await invoke(owner.get_product(project_id, product_id))
    ref = snapshot['source_ref']
    if (ref['source_version'] != payload.expected_source_version or ref['identity_revision'] != payload.expected_identity_revision
            or snapshot['market'] != payload.expected_market):
        raise HTTPException(409, '研究资料或商品身份已更新，请重新预览')
    accepted = set(payload.selected_fields)
    preview = build_marketing_preview(snapshot, {})
    if not accepted.issubset({field['key'] for field in preview['fields']}):
        raise HTTPException(409, '所选事实未核实或已失效，请重新核对')
    saved = {**snapshot, 'facts': [fact for fact in snapshot['facts'] if fact['key'] in accepted]}
    return local_call(lambda: repository().save(payload.import_id, request_digest, payload.name.strip(), saved))


@router.post('/imports/{import_id}/artifacts', dependencies=[Depends(require_session)])
def attach_artifact(import_id: UUID, payload: AttachResearchArtifact):
    return local_call(lambda: repository().attach(import_id, payload.expected_revision, payload.module, payload.history_id,payload.expected_history_timestamp))


@router.get('/artifact-choices', dependencies=[Depends(require_session)])
def artifact_choices(module: Literal['analysis', 'listing', 'ads', 'details'],
                     cursor: int | None = Query(None, ge=1), limit: int = Query(20, ge=1, le=50)):
    from db import (
        AdsHistory,
        AnalysisHistory,
        ListingHistory,
        RenderHistory,
        SessionLocal,
    )
    models = {'analysis': (AnalysisHistory, AnalysisHistory.query_url), 'listing': (ListingHistory, ListingHistory.product_name),
              'ads': (AdsHistory, AdsHistory.product_name), 'details': (RenderHistory, RenderHistory.task_name)}
    model, label = models[module]
    with SessionLocal() as database:
        query = database.query(model.id, model.timestamp, label).order_by(model.id.desc())
        if cursor:
            query = query.filter(model.id < cursor)
        rows = query.limit(limit + 1).all()
        # URLs and raw payloads are deliberately excluded from the chooser.
        return {'items': [{'id':row[0], 'created_at':row[1].isoformat() if row[1] else None,
                           'label': '竞品分析' if module == 'analysis' else str(row[2] or module)[:200]} for row in rows[:limit]],
                'next_cursor':rows[limit-1][0] if len(rows) > limit else None}


from models.research import ResearchUserCommand


@router.post('/projects/{project_id}/commands', dependencies=[Depends(require_session)])
async def research_command(request: Request, project_id: UUID, payload: ResearchUserCommand):
    import json

    from models.research import ProjectSnapshot
    try:
        size = len(json.dumps(payload.payload, allow_nan=False).encode())
    except ValueError:
        raise HTTPException(422, '不允许非有限数值') from None
    if size > 64000:
        raise HTTPException(413, '研究命令输入过大')
    result = await invoke(routed_client(request).request('POST', '/projects/' + str(project_id) + '/commands',payload.model_dump(mode='json')))
    try:
        parsed = ProjectSnapshot.model_validate(result)
        if parsed.id != project_id or parsed.market != payload.market:
            raise ValueError
        return parsed.model_dump(mode='json')
    except (ValidationError, ValueError):
        raise HTTPException(503, '命令结果尚未核实，请查询原操作编号，勿重复提交') from None


@router.get('/projects/{project_id}/commands/{command_id}', dependencies=[Depends(require_session)])
async def research_command_status(request: Request, project_id: UUID, command_id: UUID):
    from models.research import ConfirmationStatus
    result = await validated_projection(request, project_id,'/commands/' + str(command_id),ConfirmationStatus)
    if result['command_id'] != str(command_id):
        raise HTTPException(503, '操作回执编号不匹配')
    return result


@router.get('/projects/{project_id}/actions', dependencies=[Depends(require_session)])
async def research_actions(request: Request, project_id: UUID, cursor: UUID | None = None, limit: int = Query(20, ge=1, le=50)):
    from models.research import ResearchActionPage
    data = await invoke(routed_client(request).request('GET','/projects/' + str(project_id) + '/actions',params={'limit':limit,**({'cursor':str(cursor)} if cursor else {})}))
    try:
        page = ResearchActionPage.model_validate(data)
        if page.project_id != project_id:
            raise ValueError
        return page.model_dump(mode='json')
    except (ValidationError, ValueError):
        raise HTTPException(503, '任务响应格式不兼容') from None
