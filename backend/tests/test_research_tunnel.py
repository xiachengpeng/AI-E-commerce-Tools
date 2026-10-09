import pytest


def test_tunnel_requires_fixed_loopback_destination_and_no_user_ssh_options():
    from services.research_tunnel import ssh_command
    config = {'enabled': True, 'base_url': 'http://127.0.0.1:19503', 'ssh_target': 'xcp@192.168.31.112'}
    command = ssh_command(config)
    assert 'StrictHostKeyChecking=yes' in command
    assert 'BatchMode=yes' in command
    assert '127.0.0.1:19503:127.0.0.1:8000' in command
    assert command[-1] == 'xcp@192.168.31.112'
    assert ssh_command({}) is None
    for changes in [{'ssh_target': '-oProxyCommand=evil'}, {'ssh_target': 'user@host;evil'}, {'base_url': 'http://example.com:19503'}]:
        with pytest.raises(ValueError):
            ssh_command({**config, **changes})


def test_supervisor_shutdown_closes_only_its_owned_transport(tmp_path):
    import json
    import os
    from pathlib import Path
    import shlex
    import socket
    import subprocess
    import sys
    import time
    def listening():
        with socket.socket() as probe:
            probe.settimeout(0.1)
            return probe.connect_ex(('127.0.0.1', 19503)) == 0
    if listening(): pytest.skip('integration transport already owns the fixed port')
    folder = tmp_path / 'bin'; folder.mkdir()
    fake = folder / 'ssh'
    code = 'import socket,time;s=socket.socket();s.bind(("127.0.0.1",19503));s.listen();time.sleep(30)'
    fake.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' -c ' + shlex.quote(code) + '\n')
    fake.chmod(0o700)
    config = tmp_path / 'research.json'
    config.write_text(json.dumps({'enabled': True, 'base_url': 'http://127.0.0.1:19503', 'ssh_target': 'fixture@fixture'}))
    config.chmod(0o600)
    process = subprocess.Popen([sys.executable, '-B', '-m', 'services.research_tunnel'],
        env={**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1]), 'RESEARCH_INTEGRATION_CONFIG': str(config), 'PATH': str(folder) + os.pathsep + os.environ['PATH']},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while not listening() and process.poll() is None and time.monotonic() < deadline: time.sleep(0.05)
        assert listening(), 'owned fake SSH transport did not start'
        process.terminate(); process.wait(timeout=7)
        assert not listening(), 'owned transport leaked after supervisor exit'
    finally:
        if process.poll() is None: process.kill(); process.wait()
