import importlib
import json
import os
from pathlib import Path
import subprocess
import sys


def test_desktop_environment_never_uses_developer_credentials(monkeypatch, tmp_path):
    entry = importlib.import_module('desktop_entry')
    data = tmp_path / '用户 数据'
    resources = tmp_path / 'Read Only App'
    monkeypatch.setenv('SQLITE_DB_PATH', '/production.db')
    monkeypatch.setenv('RESEARCH_INTEGRATION_CONFIG', '/private/live.json')
    monkeypatch.setenv('AI_ECOMMERCE_ENV_FILE', '/developer/.env')
    entry.configure_environment(data, resources)
    assert os.environ['SQLITE_DB_PATH'] == str(data / 'history.db')
    assert os.environ['AI_ECOMMERCE_ENV_FILE'] == str(data / '.env')
    assert os.environ['RESEARCH_INTEGRATION_CONFIG'] == str(data / 'research.json')
    assert os.environ['AI_ECOMMERCE_DATA_DIR'] == str(data)
    assert not (data / 'history.db').exists()
    assert not resources.exists()
    assert data.stat().st_mode & 0o077 == 0


def test_data_directory_cannot_alias_resources(tmp_path):
    import pytest
    entry = importlib.import_module('desktop_entry')
    with pytest.raises(ValueError):
        entry.configure_environment(tmp_path, tmp_path)


def test_diagnostics_does_not_import_live_backend_or_create_database(tmp_path):
    env = dict(os.environ)
    result = subprocess.run([sys.executable, 'backend/desktop_entry.py', '--mode', 'diagnose', '--data-dir', str(tmp_path / 'data'), '--resources-dir', str(tmp_path / 'app')], capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report['database_exists'] is False
    assert report['worker_enabled'] is False
    assert not (tmp_path / 'data/history.db').exists()


def test_frozen_verification_mode_checks_real_imports_without_starting_services(tmp_path):
    result = subprocess.run([sys.executable, 'backend/desktop_entry.py', '--mode', 'verify', '--data-dir', str(tmp_path / 'data'), '--resources-dir', str(tmp_path / 'app')], capture_output=True, text=True, env={**os.environ, 'FIRECRAWL_API_KEY': '', 'GEMINI_API_KEY': ''})
    assert result.returncode == 0, result.stderr
    report=json.loads(result.stdout)
    assert report['backend_imports'] is True
    assert report['config_status'] == 200
    assert report['worker_started'] is False


def test_research_inspection_uses_disposable_copy_and_redacts_errors(tmp_path):
    import sqlite3
    from contextlib import closing
    import pytest
    entry=importlib.import_module('desktop_entry')
    root=tmp_path/'data';root.mkdir()
    with closing(sqlite3.connect(root/'history.db')) as c:
        c.execute('create table sample(value text)');c.commit()
    (root/'research.json').write_text('{}')
    before=(root/'history.db').read_bytes()
    def probe(database,config):
        assert database!=root/'history.db'
        with closing(sqlite3.connect(database)) as c:c.execute("insert into sample values('temporary')");c.commit()
        raise RuntimeError('fixture secret must never escape')
    report=entry.inspect_research(root,inspector=probe)
    assert report['research_ready'] is False
    assert report['error_type']=='RuntimeError'
    assert 'fixture secret' not in json.dumps(report)
    assert (root/'history.db').read_bytes()==before


def test_polling_probe_runs_only_on_disposable_copy_and_proves_owner(tmp_path):
    from backend.tests.test_full_merge_ownership import fixture_activation
    from scripts.full_merge.backup import database_stats
    entry = importlib.import_module('desktop_entry')
    paths, _ = fixture_activation(tmp_path)
    before = database_stats(paths.database)
    report = entry.inspect_polling(paths.database.parent)
    assert report == {'polling_probe_ready': True, 'synthetic_poll_calls': 2,
                      'synthetic_failures': 1, 'duplicate_owner_rejected': True,
                      'external_calls': 0, 'production_worker_started': False, 'finite_policy_probe_ready': True}
    assert database_stats(paths.database) == before
