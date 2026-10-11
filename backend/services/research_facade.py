"""Explicit local research owner; no transport, startup or schema initialization."""
import json
from uuid import UUID

from models.research import ProjectPage
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from services.research_client import ResearchError


class ResearchFacade:
    def __init__(self, runtime):
        self.runtime = runtime
        if runtime is None or runtime.engine is None or runtime.diagnostics:
            raise ResearchError('unprepared', '本地研究运行时尚未就绪')
        # Namespace bootstrapping belongs exclusively to open_research_runtime.
        from rabbit_hole.persistence.projects import WorkbenchStore
        self.store = runtime.store or WorkbenchStore(runtime.engine)

    @staticmethod
    def _id(value):
        try:
            return str(UUID(str(value)))
        except (ValueError, TypeError, AttributeError):
            raise ResearchError('invalid_input', '研究标识无效', 422) from None

    @staticmethod
    def _dto(value, model):
        try:
            return model.model_validate(value).model_dump(mode='json')
        except ValidationError:
            raise ResearchError('invalid_contract', '研究数据格式不兼容') from None

    async def _raw(self, project_id):
        from rabbit_hole.domain.project import WorkbenchError
        try:
            return await self.store.get(self._id(project_id))
        except (WorkbenchError, SQLAlchemyError) as exc:
            raise self._error(exc) from None

    @staticmethod
    def _error(exc):
        code = getattr(exc, 'code', '')
        status = 404 if code == 'not_found' else 409 if code in {'version_conflict', 'idempotency_conflict'} else 422 if code else 503
        return ResearchError(code or 'unavailable', '研究操作未完成，请核对输入、资料版本和操作状态', status)

    async def list_projects(self, cursor=None, limit=20):
        from rabbit_hole.persistence.projects import workbench_projects as table
        try:
            limit = min(50, max(1, int(limit)))
        except (ValueError, TypeError):
            raise ResearchError('invalid_input', '研究分页参数无效', 422) from None
        query = select(table.c.id, table.c.title, table.c.market, table.c.version, table.c.updated_at).order_by(table.c.id).limit(limit + 1)
        if cursor:
            query = query.where(table.c.id > self._id(cursor))
        try:
            async with self.runtime.engine.connect() as connection:
                rows = (await connection.execute(query)).mappings().all()
        except SQLAlchemyError as exc:
            raise self._error(exc) from None
        return self._dto({'contract_version': 1, 'projects': [
            {'id': row['id'], 'title': row['title'], 'market': row['market'], 'source_version': row['version'], 'updated_at': row['updated_at']}
            for row in rows[:limit]], 'next_cursor': rows[limit - 1]['id'] if len(rows) > limit else None}, ProjectPage)

    async def get_project(self, project_id):
        from services.research_mapper import map_project_snapshot
        return map_project_snapshot(await self._raw(project_id))

    async def get_product(self, project_id, product_id):
        from services.research_mapper import map_product_snapshot
        raw = await self._raw(project_id)
        item = next((p for p in raw.get('products', []) if p['id'] == self._id(product_id)), None)
        if item is None:
            raise ResearchError('not_found', '研究商品不存在', 404)
        return map_product_snapshot(raw, item)

    async def command(self, project_id, version, command_id, action, payload):
        from rabbit_hole.api.workbench import USER_ACTIONS
        if not isinstance(action, str) or action not in USER_ACTIONS:
            raise ResearchError('invalid_input', '不支持的研究操作', 422)
        return await self._command(project_id, version, command_id, action, payload)

    async def _command(self, project_id, version, command_id, action, payload):
        if self.runtime.store is None or self.runtime.evidence_store is None:
            raise ResearchError('readonly', '本地研究运行时仅允许读取')
        try:
            if not isinstance(payload, dict) or len(json.dumps(payload, allow_nan=False).encode()) > 64000:
                raise ValueError
        except (ValueError, TypeError):
            raise ResearchError('invalid_input', '研究命令输入无效或过大', 422) from None
        from rabbit_hole.domain.project import WorkbenchError

        from services.research_mapper import map_project_snapshot
        try:
            raw = await self.runtime.store.command(self._id(project_id), version, self._id(command_id), action, payload)
        except (WorkbenchError, SQLAlchemyError) as exc:
            raise self._error(exc) from None
        return map_project_snapshot(raw)

    async def request(self, method, path, payload=None, *, params=None):
        from rabbit_hole.domain.project import WorkbenchError
        try:
            return await self._request(method, path, payload, params=params)
        except (SQLAlchemyError, WorkbenchError) as exc:
            raise self._error(exc) from None
        except (ValueError, TypeError):
            raise ResearchError('invalid_input', '研究请求参数无效', 422) from None

    async def _request(self, method, path, payload=None, *, params=None):
        """Legacy v1 adapter dispatches locally; unsupported paths fail explicitly."""
        if not isinstance(path, str) or not path.startswith('/') or any(part in path for part in ('?', '#', '..', '//')):
            raise ResearchError('invalid_path', '研究请求路径无效', 422)
        parts = path.strip('/').split('/')
        params = params or {}
        if method == 'GET' and parts == ['projects']:
            return await self.list_projects(params.get('cursor'), params.get('limit', 20))
        if len(parts) < 2 or parts[0] != 'projects':
            raise ResearchError('unsupported_local_path', '此本地研究接口尚未提供', 422)
        project_id = self._id(parts[1])
        if method == 'GET' and len(parts) == 2:
            return await self.get_project(project_id)
        if method == 'GET' and len(parts) == 4 and parts[2] == 'products':
            return await self.get_product(project_id, parts[3])
        if method == 'POST' and len(parts) == 3 and parts[2] in {'commands', 'confirm-fact'}:
            try:
                from models.research import ResearchUserCommand
                from rabbit_hole.api.integration import ConfirmationCommand
                body = (ResearchUserCommand if parts[2] == 'commands' else ConfirmationCommand).model_validate(payload)
            except ValidationError:
                raise ResearchError('invalid_input', '研究命令格式无效', 422) from None
            if parts[2] == 'commands':
                current = await self._raw(project_id)
                if current['market'] != body.market:
                    raise ResearchError('version_conflict', '研究国家已更新', 409)
                return await self.command(project_id, body.expected_version, body.command_id, body.action, body.payload)
            return await self._command(project_id, body.expected_version, body.command_id, 'confirm_marketing_fact', body.payload)
        if method == 'GET' and len(parts) == 3 and parts[2] == 'report':
            p = await self.get_project(project_id)
            return {'contract_version': 1, 'project_id': p['id'], 'source_version': p['source_version'], 'market': p['market'], 'title': p['title'], 'product_count': len(p['products']), 'keyword_count': p['keyword_count'], 'confirmed_fact_count': sum(f['state'] == 'confirmed' for item in p['products'] for f in item['facts']), 'truncated': len(p['products']) == 200}
        if method == 'GET' and len(parts) == 4 and parts[2] in {'confirmations', 'commands'}:
            from rabbit_hole.persistence.projects import workbench_events as table
            await self._raw(project_id)
            command_id = self._id(parts[3])
            query = select(table.c.id).where(table.c.project_id == project_id, table.c.command_id == command_id)
            if parts[2] == 'confirmations':
                query = query.where(table.c.action == 'confirm_marketing_fact')
            async with self.runtime.engine.connect() as connection:
                found = await connection.scalar(query)
            return {'contract_version': 1, 'project_id': project_id, 'command_id': command_id, 'state': 'committed' if found else 'not_observed'}
        if method == 'GET' and len(parts) == 3 and parts[2] == 'actions':
            from rabbit_hole.application.actions import actions
            await self._raw(project_id)
            limit = min(50, max(1, int(params.get('limit', 20))))
            fields = ('id', 'kind', 'status', 'attempt', 'created_at', 'updated_at')
            query = select(*(actions.c[key] for key in fields)).where(actions.c.project_id == UUID(project_id)).order_by(actions.c.id).limit(limit + 1)
            if params.get('cursor'):
                query = query.where(actions.c.id > UUID(self._id(params['cursor'])))
            async with self.runtime.engine.connect() as connection:
                rows = (await connection.execute(query)).mappings().all()
            return {'contract_version': 1, 'project_id': project_id, 'actions': [{**dict(row), 'id': str(row['id']), 'created_at': row['created_at'].isoformat(), 'updated_at': row['updated_at'].isoformat()} for row in rows[:limit]], 'next_cursor': str(rows[limit - 1]['id']) if len(rows) > limit else None}
        raise ResearchError('unsupported_local_path', '此本地研究接口尚未提供', 422)
