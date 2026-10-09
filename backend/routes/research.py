"""Research-only session and routes; old business endpoints remain unchanged."""
import secrets
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from models.research import ConfirmFactRequest, LogisticsRequest, PreviewRequest, ScenarioRequest
from modules.research_math.logistics import logistics_weights
from modules.research_math.estimates import scenario_rows
from modules.research_math.markets import MARKETS
from services.research_client import ResearchClient, ResearchError, load_research_config
from services.research_mapper import build_marketing_preview

router = APIRouter(prefix='/api/research/v1', tags=['research'])
_session_token = secrets.token_urlsafe(32)
_origins = {'http://127.0.0.1:9502', 'http://localhost:9502', 'http://127.0.0.1:9503', 'http://localhost:9503'}


def guard_origin(request: Request):
    if request.url.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise HTTPException(403, '研究入口只允许本机访问')
    if request.headers.get('sec-fetch-site') == 'cross-site' and request.headers.get('origin') not in _origins:
        raise HTTPException(403, '拒绝跨站研究请求')
    if request.headers.get('origin') and request.headers['origin'] not in _origins:
        raise HTTPException(403, '拒绝跨站研究请求')


def require_session(request: Request):
    guard_origin(request)
    if not secrets.compare_digest(request.headers.get('x-research-token', '').encode(), _session_token.encode()):
        raise HTTPException(401, '研究会话已过期，请刷新研究入口')


@router.get('/session')
def session(request: Request):
    guard_origin(request)
    config = load_research_config()
    return JSONResponse({'csrf_token': _session_token, 'enabled': config.get('enabled') is True,
                         'workbench_url': config.get('workbench_url') if config.get('enabled') is True else None},
                        headers={'Cache-Control': 'no-store'})


def client():
    config = load_research_config()
    if config.get('enabled') is not True:
        raise HTTPException(503, '研究连接尚未启用，独立计算工具仍可使用')
    try:
        return ResearchClient(config)
    except ResearchError as e:
        raise HTTPException(e.status, {'code': e.code, 'message': str(e)}) from None


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
async def projects(cursor: UUID | None = None, limit: int = Query(20, ge=1, le=50)):
    return await invoke(client().list_projects(cursor, limit))


@router.get('/projects/{project_id}', dependencies=[Depends(require_session)])
async def project(project_id: UUID):
    return await invoke(client().get_project(project_id))


@router.get('/projects/{project_id}/report', dependencies=[Depends(require_session)])
async def report(project_id: UUID):
    from models.research import ResearchReport
    return await validated_projection(project_id, '/report', ResearchReport)


async def validated_projection(project_id, suffix, model):
    data = await invoke(client().request('GET', '/projects/' + str(project_id) + suffix))
    try:
        parsed = model.model_validate(data).model_dump(mode='json')
        if parsed['project_id'] != str(project_id):
            raise ValueError
        return parsed
    except (ValidationError, ValueError):
        raise HTTPException(503, '研究响应身份或格式不匹配') from None


@router.get('/projects/{project_id}/confirmations/{command_id}', dependencies=[Depends(require_session)])
async def confirmation_status(project_id: UUID, command_id: UUID):
    from models.research import ConfirmationStatus
    result = await validated_projection(project_id, '/confirmations/' + str(command_id), ConfirmationStatus)
    if result['command_id'] != str(command_id):
        raise HTTPException(503, '研究操作响应不匹配')
    return result


@router.post('/projects/{project_id}/products/{product_id}/preview', dependencies=[Depends(require_session)])
async def preview(project_id: UUID, product_id: UUID, payload: PreviewRequest):
    snapshot = await invoke(client().get_product(project_id, product_id))
    ref = snapshot['source_ref']
    if (ref['source_version'] != payload.expected_source_version or ref['identity_revision'] != payload.expected_identity_revision
            or snapshot['market'] != payload.expected_market):
        raise HTTPException(409, '研究资料或商品身份已更新，请刷新后重新预览')
    return build_marketing_preview(snapshot, payload.existing)


@router.post('/projects/{project_id}/products/{product_id}/confirm-fact', dependencies=[Depends(require_session)])
async def confirm_fact(project_id: UUID, product_id: UUID, body: ConfirmFactRequest):
    data = body.model_dump(mode='json')
    payload = {key: data[key] for key in ('identity_revision', 'market', 'key', 'value', 'source_url', 'own_product')}
    payload['product_id'] = str(product_id)
    result = await invoke(client().request('POST', '/projects/' + str(project_id) + '/confirm-fact',
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
