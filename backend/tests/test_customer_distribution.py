"""Customer lifecycle uses real private SQLite files, never the developer DB."""
from contextlib import closing
import fcntl
import importlib
import json
from pathlib import Path
import sqlite3

import pytest


def lifecycle():
    return importlib.import_module('services.customer_distribution')


def test_fresh_install_is_independently_owned_and_paused(tmp_path):
    module = lifecycle()
    roots = [tmp_path / 'client-a', tmp_path / 'client-b']
    for root in roots:
        info = module.prepare_customer_data(root, '0.2.0')
        assert info['version'] == '0.2.0'
        config = json.loads((root / 'research.json').read_text())
        assert config['enabled'] is True
        assert config['worker_mode'] == 'paused'
        assert config['feishu_polling_enabled'] is False
        from services.research_runtime import resolve_runtime_paths
        from services.research_activation import validate_activation, load_activation
        paths = resolve_runtime_paths(root / 'history.db', root / 'research')
        assert validate_activation(paths)
        assert load_activation(paths)['kind'] == 'fresh_install'
        with closing(sqlite3.connect(root / 'history.db')) as c:
            assert c.execute('select count(*) from workbench_projects').fetchone()[0] == 0
            assert c.execute('select count(*) from integration_settings').fetchone()[0] == 0
            assert c.execute('select cutover_state from full_merge_ledger').fetchone()[0] == 'activated'
        assert (root / 'research/keys/activation.key').stat().st_mode & 0o077 == 0
        assert not (root / '.env').exists()
    assert (roots[0] / 'research/keys/activation.key').read_bytes() != (roots[1] / 'research/keys/activation.key').read_bytes()
    assert (roots[0] / 'research/keys/evidence-signing.key').read_bytes() != (roots[1] / 'research/keys/evidence-signing.key').read_bytes()


def test_restart_preserves_records_keys_and_settings(tmp_path):
    module = lifecycle(); root = tmp_path / 'customer'
    module.prepare_customer_data(root, '0.2.0')
    with closing(sqlite3.connect(root / 'history.db')) as c:
        c.execute('create table customer_note(value text)')
        c.execute("insert into customer_note values ('keep me')"); c.commit()
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()}
    module.prepare_customer_data(root, '0.2.0')
    after = {p.relative_to(root): p.read_bytes() for p in root.rglob('*') if p.is_file()}
    assert before == after


def test_unknown_existing_data_is_never_overwritten(tmp_path):
    root = tmp_path / 'customer'; root.mkdir(mode=0o700)
    (root / 'history.db').write_bytes(b'unknown user data')
    with pytest.raises(ValueError): lifecycle().prepare_customer_data(root, '0.2.0')
    assert (root / 'history.db').read_bytes() == b'unknown user data'


def test_upgrade_backs_up_complete_workspace_and_rejects_downgrade(tmp_path):
    module = lifecycle(); root = tmp_path / 'customer'
    module.prepare_customer_data(root, '0.2.0')
    (root / 'research/evidence/keep.bin').write_bytes(b'evidence')
    (root / '.env').write_text('CUSTOMER_FIXTURE=yes')
    (root / '.env').chmod(0o600)
    report = module.prepare_customer_data(root, '0.2.1')
    backup = Path(report['backup'])
    assert (backup / '.env').read_text() == 'CUSTOMER_FIXTURE=yes'
    assert (backup / 'research/evidence/keep.bin').read_bytes() == b'evidence'
    assert (backup / 'research/keys/activation.key').read_bytes() == (root / 'research/keys/activation.key').read_bytes()
    with closing(sqlite3.connect(backup / 'history.db')) as c:
        assert c.execute('pragma integrity_check').fetchone() == ('ok',)
    with pytest.raises(ValueError): module.prepare_customer_data(root, '0.2.0')
    assert json.loads((root / 'customer-install.json').read_text())['version'] == '0.2.1'


def test_tampered_owner_and_busy_process_reject_upgrade(tmp_path):
    module = lifecycle(); root = tmp_path / 'customer'
    module.prepare_customer_data(root, '0.2.0')
    with (root / 'worker.lock').open('a') as lock:
        (root / 'worker.lock').chmod(0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError): module.prepare_customer_data(root, '0.2.1')
    key = root / 'research/keys/activation.key'
    key.write_bytes(b'x' * 32)
    with pytest.raises(ValueError): module.prepare_customer_data(root, '0.2.1')
    assert json.loads((root / 'customer-install.json').read_text())['version'] == '0.2.0'


def test_failed_initialization_never_publishes_partial_data(tmp_path, monkeypatch):
    module = lifecycle(); root = tmp_path / 'customer'
    def fail(*args): raise RuntimeError('synthetic interruption')
    monkeypatch.setattr(module, '_initialize', fail)
    with pytest.raises(RuntimeError): module.prepare_customer_data(root, '0.2.0')
    assert not root.exists()
    monkeypatch.undo()
    module.prepare_customer_data(root, '0.2.0')
    assert (root / 'customer-install.json').exists()


def test_symlink_data_rejected(tmp_path):
    real = tmp_path / 'real'; real.mkdir()
    alias = tmp_path / 'alias'; alias.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError): lifecycle().prepare_customer_data(alias, '0.2.0')
