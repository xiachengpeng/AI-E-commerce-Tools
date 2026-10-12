"""User-selected API collection with durable external run identity."""
from __future__ import annotations

import os
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy import select

from rabbit_hole.domain.markets import MARKETS
from rabbit_hole.integrations.collectors.provider_api import (
    ProviderError,
    parse_meta_items,
    parse_serpapi_series,
)
from rabbit_hole.integrations.provider_jobs import (
    ProviderPending,
    append_log,
    checkpoint,
)
from rabbit_hole.integrations.provider_settings import ProviderSecrets
from rabbit_hole.keyword_phrases import canonical_phrase
from rabbit_hole.persistence.sql import transaction_lock, write_transaction
from rabbit_hole.trends import classify_trend_window


async def abort_apify_run(engine: Any, project_id: str, action_id: str, attempt: int, run_id: str) -> None:
    """Best-effort cloud abort after the local action has already been fenced."""
    key = ProviderSecrets().get('apify')
    if not key or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', run_id):
        message = '本地已停止；无法确认 Apify 云端任务是否停止，请到 Apify 核对'
    else:
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                response = await client.post(
                    f'https://api.apify.com/v2/actor-runs/{run_id}/abort',
                    headers={'Authorization': 'Bearer ' + key},
                )
                response.raise_for_status()
            message = '已向 Apify 请求停止云端任务，请在 Apify 核对最终状态'
        except httpx.HTTPError:
            message = '本地已停止；Apify 云端停止请求未确认，请到 Apify 核对'
    await append_log(engine, project_id, action_id, attempt, 'cloud_abort', message)


async def reserve(runner: Any, action: dict[str, Any], provider: str, slot: str) -> None:
    """Serialize provider admission across projects; reservations survive failures."""
    from rabbit_hole.application.actions import actions
    day = datetime.now(UTC).date().isoformat()
    async with write_transaction(runner.store.engine) as c:
        await transaction_lock(c, "provider-budget:" + provider)
        row = (await c.execute(select(actions).where(actions.c.id == action['id']).with_for_update())).mappings().one()
        if row['status'] != 'running' or row['attempt'] != action['attempt'] or row['lease_until'] is None or row['lease_until'] <= datetime.now(UTC):
            raise ProviderError('input_changed', '任务租约已变化')
        payload = dict(row['payload'])
        reservations = dict(payload.get('provider_reservations', {}))
        if slot in reservations:
            return
        rows = (await c.execute(select(actions.c.payload))).scalars()
        count = sum(1 for p in rows for r in p.get('provider_reservations', {}).values() if r == {'provider': provider, 'day': day})
        budget_env, default_limit = {
            "apify": ("RABBIT_HOLE_APIFY_DAILY_RUNS", "8"),
            "serpapi": ("RABBIT_HOLE_SERPAPI_DAILY_REQUESTS", "40"),
            "firecrawl": ("RABBIT_HOLE_FIRECRAWL_DAILY_REQUESTS", "20"),
        }[provider]
        limits = getattr(runner, 'provider_budget_limits', None)
        limit = limits(provider) if limits is not None else int(os.environ.get(budget_env, default_limit))
        if count >= limit:
            raise ProviderError('budget', '该接口今日调用预算已用完')
        reservations[slot] = {'provider': provider, 'day': day}
        payload['provider_reservations'] = reservations
        from sqlalchemy import update
        await c.execute(update(actions).where(actions.c.id == action['id']).values(payload=payload))
        action['payload'] = payload


async def request_json(client: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> Any:
    response = await client.request(method, url, **kwargs)
    response.raise_for_status()
    try:
        return response.json()
    except ValueError:
        raise ProviderError('schema_drift', '接口未返回有效JSON') from None


async def execute_provider(runner: Any, action: dict[str, Any], project: dict[str, Any]) -> dict[str, Any]:
    provider = 'apify' if action['kind'] == 'scan' else 'serpapi'
    if getattr(runner, 'allow_external', True) is not True:
        raise PermissionError('research_external_not_authorized')
    providers = getattr(runner, 'provider_secrets', None)
    key = providers.get(provider) if providers is not None else ProviderSecrets().get(provider)
    if not key:
        raise ProviderError('not_configured', f'{provider} API 密钥未配置，请到数据源与配置设置')
    async with httpx.AsyncClient(timeout=45, follow_redirects=False) as client:
        if provider == 'apify':
            return await meta(runner, action, project, client, key)
        return await trends(runner, action, project, client, key)


async def meta(runner: Any, action: dict[str, Any], project: dict[str, Any], client: httpx.AsyncClient, key: str) -> dict[str, Any]:
    word = next(w for w in project['keywords'] if w['id'] == action['keyword_id'])
    url = 'https://www.facebook.com/ads/library/?' + urlencode({'q': canonical_phrase(word['text']).quoted, 'country': project['market'], 'active_status': 'active', 'media_type': 'video', 'search_type': 'keyword_exact_phrase', 'ad_type': 'all'})
    headers = {'Authorization': 'Bearer ' + key}
    base = 'https://api.apify.com/v2/'
    state = dict(action['payload'].get('apify_run', {}))
    if not state:
        await reserve(runner, action, 'apify', 'apify-run')
        await checkpoint(runner, action, apify_run={'submission': 'uncertain', 'owner': {'action_id': str(action['id']), 'input_version': action['input_version'], 'fingerprint': action['payload'].get('fingerprint')}})
        await runner.log(action, 'submit', 'Apify API：提交任务，每次费用上限 $0.25，最多读取100条')
        run = (await request_json(client, 'POST', base + 'acts/XtaWFhbtfxyzqrFmd/runs', headers=headers,
            params={'build': '2.7.26', 'timeout': 180, 'memory': 512, 'maxTotalChargeUsd': 0.25},
            json={'urls': [{'url': url}], 'count': 100, 'limitPerSource': 100, 'scrapeAdDetails': False, 'runTag': str(action['id'])}))['data']
        state = {'owner': {'action_id': str(action['id']), 'input_version': action['input_version'], 'fingerprint': action['payload'].get('fingerprint')}, 'id': run['id'], 'dataset': run['defaultDatasetId'], 'started_at': run['startedAt'], 'build_id': run.get('buildId'), 'status': run.get('status', 'READY')}
        await checkpoint(runner, action, apify_run=state)
        await runner.log(action, 'submitted', '云端任务已创建：' + state['id'])
        raise ProviderPending()
    if not state.get('id'):
        raise ProviderError('submission_uncertain', '上次提交结果不确定；请在 Apify 按任务标签核对，未自动重复收费')
    await runner.log(action, 'poll', '正在查询 Apify 云端任务状态')
    run = (await request_json(client, 'GET', base + 'actor-runs/' + state['id'], headers=headers))['data']
    status = run['status']
    state['status'] = status
    await checkpoint(runner, action, apify_run=state)
    await runner.log(action, 'poll', 'Apify 状态：' + str(status))
    if status in {'READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'}:
        started = datetime.fromisoformat(state['started_at'])
        if (datetime.now(UTC) - started).total_seconds() > 240:
            state['restart_required'] = True
            await checkpoint(runner, action, apify_run=state)
            await runner.log(action, 'cloud_abort', '云端任务超过截止时间，正在请求停止')
            await request_json(client, 'POST', base + 'actor-runs/' + state['id'] + '/abort', headers=headers)
            raise ProviderError('timeout', '云端任务超过截止时间，已请求停止；重新搜索会创建新任务并计入预算')
        raise ProviderPending()
    if status != 'SUCCEEDED':
        raise ProviderError('source_error', '云端任务结束：' + str(status) + '；未导入为成功结果')
    await runner.log(action, 'download', '正在读取 Apify 接口结果')
    items = await request_json(client, 'GET', base + 'datasets/' + state['dataset'] + '/items', headers=headers, params={'format': 'json', 'limit': 101})
    ads = parse_meta_items(items)
    received = datetime.now(UTC).isoformat()
    # JSON summary retains useful source facts, not expiring signed media URLs.
    evidence = {'provider': 'apify', 'run_id': state['id'], 'build_id': state.get('build_id'), 'source_url': url, 'received_at': received, 'requested_filters': {'country': project['market'], 'active': True, 'media': 'video', 'query': canonical_phrase(word['text']).quoted}, 'verified_filters': {'active': bool(ads), 'video_present': bool(ads)}, 'ads': ads, 'empty': not ads, 'filter_verification': '需要人工核对精准短语及地域', 'usage_usd_reported': run.get('usageTotalUsd')}
    await checkpoint(runner, action, provider_evidence=evidence)
    await runner.save(action, 'collection_result', {'keyword_id': word['id'], 'ads': ads, 'status': 'complete', 'message': f'本次采集 {len(ads)} 条广告；地域与精准匹配待人工核对。' if ads else '本次采集 0 条（Apify 限定样本）；请核对精准短语、地域并尝试相关词，不能据此判断没有机会。'})
    await runner.log(action, 'received', f'已保存{len(ads)}条广告；接口证据可查看')
    return {'ads': len(ads), 'provider': 'apify', 'evidence_kind': 'json', 'received_at': received, 'run_id': state['id'], 'source_url': url, 'coverage': 'bounded_sample', 'empty': not ads}


async def trends(runner: Any, action: dict[str, Any], project: dict[str, Any], client: httpx.AsyncClient, key: str) -> dict[str, Any]:
    submissions = dict(action['payload'].get('trend_submissions', {}))
    if any(item.get('state') == 'uncertain' for item in submissions.values() if isinstance(item, dict)):
        raise ProviderError('submission_uncertain', '上次 SerpApi 读取结果尚未确认；请人工核对，未重复收费调用')
    query = action['payload']['query']
    market = project['market']
    saved = dict(action['payload'].get('trend_windows', {}))
    if any(v.get('market', 'US') != market for v in saved.values()):
        saved = {}
    if saved:
        oldest = min(datetime.fromisoformat(v['received_at']) for v in saved.values())
        if (datetime.now(UTC) - oldest).total_seconds() > 3600:
            saved = {}
    for window, date in [('12m', 'today 12-m'), ('5y', 'today 5-y')]:
        if window in saved:
            continue
        await reserve(runner, action, 'serpapi', f'{window}:{action["attempt"]}')
        await runner.log(action, 'trends_' + window, 'SerpApi API：读取' + MARKETS[market].name + ' ' + window + ' 趋势')
        submissions[window] = {'state': 'uncertain', 'query': query, 'market': market,
                               'date': date, 'attempt': action['attempt'],
                               'submitted_at': datetime.now(UTC).isoformat()}
        await checkpoint(runner, action, trend_submissions=submissions)
        data = await request_json(client, 'GET', 'https://serpapi.com/search.json', params={'engine': 'google_trends', 'q': query, 'date': date, 'geo': market, 'tz': 0, 'data_type': 'TIMESERIES', 'api_key': key})
        series = parse_serpapi_series(data, query, window, market=market)
        classification = classify_trend_window(series)
        metadata = data.get('search_metadata', {})
        created = metadata.get('created_at')
        if not isinstance(created, str):
            raise ProviderError('schema_drift', '接口未提供结果生成时间')
        try:
            observed = datetime.fromisoformat(created.replace(' UTC', '+00:00'))
            if observed.tzinfo is None:
                raise ValueError()
        except ValueError:
            raise ProviderError('schema_drift', '接口结果时间格式不兼容') from None
        saved[window] = {'window': window, 'market': market, 'conclusion': classification.label.value, 'classification': classification.model_dump(mode='json'), 'points': series.model_dump(mode='json')['points'], 'source_url': 'https://trends.google.com/trends/explore?' + urlencode({'q': query, 'geo': market, 'date': date}), 'observed_at': observed.isoformat(), 'received_at': datetime.now(UTC).isoformat(), 'search_id': metadata.get('id'), 'raw_timeline': data.get('interest_over_time', {}).get('timeline_data', [])}
        submissions[window] = {**submissions[window], 'state': 'completed'}
        await checkpoint(runner, action, trend_windows=saved, trend_submissions=submissions)
        await runner.log(action, 'validated', f'{window} 已校验 {len(series.points)} 个完整周点')
    evidence = [{k: v for k, v in saved[w].items() if k not in {'raw_timeline', 'search_id', 'received_at'}} for w in ['12m', '5y']]
    await checkpoint(runner, action, provider_evidence={'provider': 'serpapi', 'query': query, 'geo': market, 'windows': saved})
    await runner.save(action, 'trends_result', {'product_id': action['product_id'], 'query': query, 'evidence': evidence, 'observed_at': datetime.now(UTC).isoformat()})
    return {'provider': 'serpapi', 'evidence_kind': 'json', 'note': '两个窗口已保存，请人工核对商品与查询词'}
