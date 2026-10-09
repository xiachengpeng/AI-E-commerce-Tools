"""Fixed-destination, bounded research transport, never retries mutations."""
import json
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import ValidationError
from models.research import ProductSnapshot, ProjectPage, ProjectSnapshot


class ResearchError(Exception):
    def __init__(self, code, message, status=503):
        super().__init__(message)
        self.code, self.status = code, status


def load_research_config():
    path = Path(os.environ.get('RESEARCH_INTEGRATION_CONFIG', str(Path.home() / '.local/share/ai-ecommerce-merge/research.json')))
    try:
        if any(p.is_symlink() for p in (path, *path.parents)):
            return {}
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'r') as f:
            info = os.fstat(f.fileno())
            if info.st_uid != os.getuid() or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
                return {}
            raw = f.read(8193)
            if len(raw) > 8192:
                return {}
            data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


class ResearchClient:
    def __init__(self, config=None, *, transport=None):
        config = load_research_config() if config is None else config
        self.token = config.get('token')
        self.base_url = config.get('base_url', '')
        try:
            if not isinstance(self.token, str) or not isinstance(self.base_url, str):
                raise ValueError
            p = urlsplit(self.base_url)
            valid = (p.scheme == 'https' or (p.scheme == 'http' and p.hostname in {'127.0.0.1', 'localhost', '::1'}))
            if not valid or not p.hostname or p.username or p.password or p.path not in {'', '/'} or p.query or p.fragment or not self.token:
                raise ValueError
            _ = p.port
        except (ValueError, TypeError):
            raise ResearchError('unconfigured', '研究连接配置不可用；请检查本机安全连接') from None
        self.transport = transport

    async def request(self, method, path, payload=None, *, params=None):
        if not path.startswith('/') or '?' in path or '#' in path or '..' in path or '//' in path:
            raise ResearchError('invalid_path', '研究请求路径无效', 422)
        try:
            async with httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False,
                                         timeout=httpx.Timeout(10, connect=3)) as client:
                async with client.stream(method, self.base_url.rstrip('/') + '/internal/integration/v1' + path,
                                         headers={'Authorization': 'Bearer ' + self.token}, json=payload, params=params) as response:
                    if response.status_code != 200:
                        codes = {401: ('authentication_failed', '研究连接认证失败'),
                                 403: ('forbidden', '研究操作未获授权'),
                                 404: ('not_found', '研究项目或商品不存在'),
                                 422: ('invalid_input', '人工事实确认参数无效，请核对商品、国家及来源'),
                                 409: ('version_conflict', '研究资料已更新，请刷新后重新确认')}
                        code, message = codes.get(response.status_code, ('unavailable', '研究服务暂不可用'))
                        raise ResearchError(code, message, response.status_code if response.status_code in codes else 503)
                    body = bytearray()
                    async for block in response.aiter_bytes():
                        body.extend(block)
                        if len(body) > 2_000_000:
                            raise ResearchError('response_too_large', '研究响应超过安全大小限制')
            result = json.loads(body)
            if not isinstance(result, dict) or result.get('contract_version') != 1 or result.get('status') == 'error':
                raise ResearchError('invalid_contract', '研究服务响应版本或格式不兼容')
            return result
        except httpx.TimeoutException:
            code = 'outcome_unknown' if method != 'GET' else 'timeout'
            message = '提交结果尚未确认，请查询研究状态后再操作' if method != 'GET' else '研究读取超时，请稍后重试'
            raise ResearchError(code, message) from None
        except httpx.HTTPError:
            raise ResearchError('unavailable', '研究连接中断，请检查安全连接') from None
        except (ValueError, UnicodeError):
            raise ResearchError('invalid_contract', '研究服务返回了无效数据') from None

    async def _validated(self, path, model, *, params=None):
        result = await self.request('GET', path, params=params)
        try:
            return model.model_validate(result).model_dump(mode='json')
        except ValidationError:
            raise ResearchError('invalid_contract', '研究数据格式不兼容') from None

    async def list_projects(self, cursor=None, limit=20):
        params = {'limit': min(50, max(1, int(limit)))}
        if cursor:
            params['cursor'] = str(UUID(str(cursor)))
        return await self._validated('/projects', ProjectPage, params=params)

    async def get_project(self, project_id):
        project_id = str(UUID(str(project_id)))
        result = await self._validated('/projects/' + project_id, ProjectSnapshot)
        if result['id'] != project_id:
            raise ResearchError('identity_mismatch', '研究项目响应不匹配')
        return result

    async def get_product(self, project_id, product_id):
        project_id, product_id = str(UUID(str(project_id))), str(UUID(str(product_id)))
        result = await self._validated('/projects/' + project_id + '/products/' + product_id, ProductSnapshot)
        if result['source_ref']['project_id'] != project_id or result['source_ref']['product_id'] != product_id:
            raise ResearchError('identity_mismatch', '研究商品响应不匹配')
        return result
