"""First-run controls only for independently initialized customer workspaces."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse
from models.research_ai import ResearchBusinessSettings
from services.research_security import require_research_session
from services.customer_distribution import customer_install, write_json, _private

# Visible examples requiring explicit confirmation, never silently written.
RULE_TEMPLATE = {
    'market': {'code': 'US', 'currency': 'USD', 'min_aov': 40, 'max_aov': 150,
               'payment_percent': 3, 'payment_fixed': 0.3, 'loss_reserve_percent': 5},
    'admission': {'daily_candidates': 10, 'daily_keywords': 10, 'daily_scans': 2,
                  'daily_ai_calls': 10, 'daily_cost_usd': '1',
                  'estimated_call_cost_usd': '0.02', 'estimated_research_scan_cost_usd': '0.20'},
    'trend_thresholds': {'coverage': 0.8, 'rising': 0.2, 'declining': 0.2,
                         'stable_median_ratio': 0.8, 'peak_ratio': 0.5,
                         'seasonal_ratio': 1.5, 'seasonal_years': 3, 'seasonal_tolerance_weeks': 2},
    'browser_concurrency': 1, 'poll_seconds': 60, 'public_dns': 'system',
}


def create_customer_setup_router(data=None):
    from routes.research_workbench import ResearchPrivateRoute
    router = APIRouter(prefix='/api/research/workbench/v1', route_class=ResearchPrivateRoute)

    def root():
        value = data if data is not None else os.environ.get('AI_ECOMMERCE_DATA_DIR')
        if not value: raise HTTPException(404, '此版本无需客户初始化')
        path = Path(value)
        if not (path / 'customer-install.json').is_file(): raise HTTPException(404, '此版本无需客户初始化')
        customer_install(path)
        return path

    @contextmanager
    def locked(path):
        target = path / '.customer-setup.lock'; _private(target)
        with os.fdopen(os.open(target, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def status(path, restart=False):
        marker = customer_install(path)
        config_path = path / 'research.json'; _private(config_path)
        config = json.loads(config_path.read_text())
        business = None
        target = path / 'research-business.json'
        if target.exists():
            _private(target)
            business = ResearchBusinessSettings.model_validate_json(target.read_text()).model_dump(mode='json')
        return {'version': marker['version'], 'setup_complete': marker['setup_complete'],
                'business': business, 'template': RULE_TEMPLATE,
                'worker_enabled': config.get('worker_mode') == 'active',
                'observe_feishu': config.get('feishu_polling_enabled') is True,
                'restart_required': restart}

    @router.get('/customer-setup')
    def read(request: Request):
        require_research_session(request, False)
        try: return JSONResponse(status(root()), headers={'Cache-Control': 'no-store'})
        except (ValueError, OSError, KeyError, TypeError):
            raise HTTPException(503, '客户运行配置无法核对，请保留数据并联系维护者。') from None

    @router.post('/customer-setup')
    async def update(request: Request):
        require_research_session(request, True)
        try:
            raw = await request.body()
            if len(raw) > 32768: raise ValueError()
            body = json.loads(raw)
            if not isinstance(body, dict): raise ValueError()
            action = body.get('action')
            fields = {'rules': {'action', 'business', 'confirmed'},
                      'background': {'action', 'enabled', 'confirm_costs', 'observe_feishu'},
                      'complete': {'action'}}
            if action not in fields or set(body) - fields[action]: raise ValueError()
            path = root()
            with locked(path):
                config_path = path / 'research.json'; _private(config_path)
                config = json.loads(config_path.read_text())
                if action == 'rules':
                    if body.get('confirmed') is not True: raise ValueError()
                    business = ResearchBusinessSettings.model_validate(body.get('business'))
                    write_json(path / 'research-business.json', business.model_dump(mode='json'))
                    config['business_settings_path'] = str(path / 'research-business.json')
                    write_json(config_path, config)
                elif action == 'background':
                    enabled = body.get('enabled'); observe = body.get('observe_feishu', False)
                    if type(enabled) is not bool or type(observe) is not bool: raise ValueError()
                    if enabled:
                        if body.get('confirm_costs') is not True: raise ValueError()
                        _private(path / 'research-business.json')
                        ResearchBusinessSettings.model_validate_json((path / 'research-business.json').read_text())
                    config.update(worker_mode='active' if enabled else 'paused',
                                  feishu_polling_enabled=enabled and observe,
                                  feishu_polling_policy={'mode': 'observe'})
                    write_json(config_path, config)
                else:
                    marker = customer_install(path); marker['setup_complete'] = True
                    write_json(path / 'customer-install.json', marker)
                return JSONResponse(status(path, action != 'complete'), headers={'Cache-Control': 'no-store'})
        except (ValueError, OSError, KeyError, TypeError):
            raise HTTPException(422, '请核对研究规则；启用后台前需保存规则并确认可能产生的服务费用。') from None

    return router


router = create_customer_setup_router()
