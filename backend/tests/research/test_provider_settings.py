import json
import stat

import pytest


def test_keys_are_private_and_status_never_returns_secret(tmp_path):
    from rabbit_hole.integrations.provider_settings import ProviderSecrets

    vault = ProviderSecrets(tmp_path / 'keys.json')
    vault.update({'apify': 'test-apify-secret', 'serpapi': 'test-serp-secret'})
    assert vault.get('apify') == 'test-apify-secret'
    assert vault.status() == {'apify': True, 'serpapi': True, 'firecrawl': False}
    assert stat.S_IMODE(vault.path.stat().st_mode) == 0o600
    vault.update({'apify': None})
    assert not vault.status()['apify']
    assert vault.get('serpapi') == 'test-serp-secret'
    with pytest.raises(ValueError):
        vault.update({'unknown': 'secret'})
    assert 'test-serp-secret' not in json.dumps(vault.status())


async def test_settings_api_guards_write_and_never_echoes(tmp_path, monkeypatch):
    import httpx

    from rabbit_hole.runtime.server import create_app

    monkeypatch.setenv('RABBIT_HOLE_PROVIDER_SECRETS_PATH', str(tmp_path / 'keys.json'))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(checks={})), base_url='http://localhost:8000') as client:
        endpoint = '/workbench/api/provider-settings'
        assert (await client.post(endpoint, json={'apify': 'secret'})).status_code == 403
        token = (await client.get('/workbench/api/session')).json()['csrf_token']
        result = await client.post(endpoint, headers={'X-Workbench-Token': token}, json={'apify': 'private-value'})
        assert result.status_code == 200
        assert result.json()['configured']['apify'] is True
        assert 'private-value' not in (await client.get(endpoint)).text
