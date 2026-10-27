import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def setup(tmp_path):
    from services.customer_distribution import prepare_customer_data
    from routes.customer_setup import create_customer_setup_router
    from routes.research import _session_token
    root = tmp_path / 'customer'
    prepare_customer_data(root, '0.2.0')
    app = FastAPI(); app.include_router(create_customer_setup_router(root))
    client = TestClient(app, client=('127.0.0.1', 42000), base_url='http://127.0.0.1:9503')
    headers = {'X-Research-Token': _session_token, 'Origin': 'http://127.0.0.1:9502'}
    return root, client, headers


BASE = '/api/research/workbench/v1/customer-setup'


def test_clean_status_is_paused_and_contains_no_credentials(setup):
    root, client, headers = setup
    response = client.get(BASE, headers=headers)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    data = response.json()
    assert data['setup_complete'] is False and data['worker_enabled'] is False
    assert data['business'] is None and data['version'] == '0.2.0'
    assert 'data_root' not in response.text and 'signature' not in response.text


def test_enable_requires_valid_explicit_rules_and_cost_confirmation(setup):
    root, client, headers = setup
    assert client.post(BASE, headers=headers, json={'action': 'background', 'enabled': True, 'confirm_costs': True}).status_code == 422
    from routes.customer_setup import RULE_TEMPLATE
    assert client.post(BASE, headers=headers, json={'action': 'rules', 'business': RULE_TEMPLATE, 'confirmed': False}).status_code == 422
    saved = client.post(BASE, headers=headers, json={'action': 'rules', 'business': RULE_TEMPLATE, 'confirmed': True})
    assert saved.status_code == 200
    assert saved.json()['worker_enabled'] is False
    assert client.post(BASE, headers=headers, json={'action': 'background', 'enabled': True}).status_code == 422
    enabled = client.post(BASE, headers=headers, json={'action': 'background', 'enabled': True, 'confirm_costs': True, 'observe_feishu': True})
    assert enabled.status_code == 200 and enabled.json()['restart_required'] is True
    config = json.loads((root / 'research.json').read_text())
    assert config['worker_mode'] == 'active' and config['feishu_polling_enabled'] is True
    assert config['feishu_polling_policy'] == {'mode': 'observe'}
    paused = client.post(BASE, headers=headers, json={'action': 'background', 'enabled': False})
    assert paused.status_code == 200
    assert json.loads((root / 'research.json').read_text())['worker_mode'] == 'paused'


def test_unknown_fields_invalid_rules_and_cross_site_leave_config_unchanged(setup):
    root, client, headers = setup
    before = (root / 'research.json').read_bytes()
    assert client.get(BASE).status_code == 401
    assert client.post(BASE, headers={**headers, 'Origin': 'https://evil.invalid'}, json={'action': 'complete'}).status_code == 403
    for body in [{'action': 'rules', 'business': {}, 'confirmed': True}, {'action': 'complete', 'data_root': '/tmp/no'}, {'action': 'background', 'enabled': 'false'}]:
        assert client.post(BASE, headers=headers, json=body).status_code == 422
    assert (root / 'research.json').read_bytes() == before


def test_setup_completion_does_not_start_background(setup):
    root, client, headers = setup
    result = client.post(BASE, headers=headers, json={'action': 'complete'})
    assert result.status_code == 200 and result.json()['setup_complete'] is True
    assert result.json()['worker_enabled'] is False
