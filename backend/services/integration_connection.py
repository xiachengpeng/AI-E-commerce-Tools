"""User-triggered account/permission probes; no collection, translation or writes.

Fixed endpoints only; no redirects/retries or raw upstream diagnostics returned.
"""
from datetime import datetime, timezone
from urllib.parse import quote
import httpx
import logging
from services.integration_settings_service import FIELDS


class _ProbeLogFilter(logging.Filter):
    def filter(self, record):
        # httpx logs full query URLs at INFO. Never log account keys or Base tokens.
        message = record.getMessage()
        if 'serpapi.com/account.json' in message or 'open.feishu.cn/open-apis/bitable/v1/apps/' in message:
            record.msg = 'External service account probe response (URL redacted)'
            record.args = ()
        return True


logging.getLogger('httpx').addFilter(_ProbeLogFilter())


def result(success, message):
    return {'success': success, 'message': message, 'tested_at': datetime.now(timezone.utc).isoformat()}


async def test_connection(provider, credentials, *, transport=None):
    if provider not in FIELDS:
        raise ValueError('invalid provider')
    if not all(credentials.get(k) for k in FIELDS[provider] - {'daily_limit'}):
        return result(False, '请先填写并保存完整凭据，再测试连接。')
    if provider == 'aliyun':
        return await _aliyun(credentials)
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False, transport=transport) as client:
            if provider == 'apify':
                response = await client.get('https://api.apify.com/v2/users/me', headers={'Authorization': 'Bearer ' + credentials['api_key']})
            elif provider == 'serpapi':
                response = await client.get('https://serpapi.com/account.json', params={'api_key': credentials['api_key']})
            elif provider == 'firecrawl':
                response = await client.get('https://api.firecrawl.dev/v2/team/credit-usage', headers={'Authorization': 'Bearer ' + credentials['api_key']})
            else:
                response = await client.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', json={'app_id': credentials['app_id'], 'app_secret': credentials['app_secret']})
                response.raise_for_status()
                data = response.json()
                token = data.get('tenant_access_token')
                if data.get('code') != 0 or not isinstance(token, str) or not token:
                    return result(False, '飞书应用认证未通过，请检查 App ID、Secret 与应用状态。')
                response = await client.get('https://open.feishu.cn/open-apis/bitable/v1/apps/' + quote(credentials['base_app_token'], safe='') + '/tables', params={'page_size': 1}, headers={'Authorization': 'Bearer ' + token})
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict) or data.get('error') or data.get('success') is False or (provider == 'feishu' and data.get('code') != 0):
                return result(False, '服务认证或读取权限未通过，请核对凭据、服务开通状态和访问权限。')
            # Do not present arbitrary successful HTML/JSON as authenticated success.
            if provider in {'apify','firecrawl'} and not isinstance(data.get('data'), dict):
                return result(False, '服务返回格式无法确认，请稍后重试。')
            if provider == 'serpapi' and not any(k in data for k in ('account_id','searches_left','total_searches_left')):
                return result(False, '账户返回格式无法确认，请稍后重试。')
            return result(True, '连接与账户读取通过。' if provider != 'feishu' else '应用认证与多维表格读取通过；未写入记录，写权限需实际同步时验证。')
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        message = {401:'凭据未通过，请检查密钥是否有效。',403:'访问被拒绝，请检查服务权限与访问限制。',402:'账户额度不足或服务未开通，请到服务控制台核对。',429:'服务请求过于频繁，请稍后再试。'}.get(status, '服务暂不可用或返回异常，请稍后再试。')
        return result(False, message)
    except httpx.TimeoutException:
        return result(False, '连接超时，请检查网络或代理；未自动重试。')
    except Exception:
        return result(False, '连接未完成，请检查网络、代理与服务状态。')


async def _aliyun(credentials):
    try:
        from alibabacloud_alimt20181012.client import Client
        from alibabacloud_alimt20181012.models import GetTranslateReportRequest
        from alibabacloud_tea_openapi.models import Config
        from alibabacloud_tea_util.models import RuntimeOptions
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        client = Client(Config(access_key_id=credentials['access_key_id'], access_key_secret=credentials['access_key_secret'], endpoint='mt.cn-hangzhou.aliyuncs.com', region_id='cn-hangzhou'))
        response = await client.get_translate_report_with_options_async(GetTranslateReportRequest(api_name='translate_standard', begin_time=today+' 00:00:00', end_time=today+' 23:59:59', group='day'), RuntimeOptions(connect_timeout=4000, read_timeout=7000, autoretry=False))
        if response.body and str(response.body.code) == '200':
            return result(True, '连接与翻译报表读取通过；未执行翻译，翻译调用权限需实际使用时验证。')
        return result(False, '翻译报表读取未通过，请检查机器翻译服务及 GetTranslateReport 权限。')
    except Exception:
        return result(False, '报表连接未通过，请核对网络、密钥与 GetTranslateReport 权限；未执行翻译。')
