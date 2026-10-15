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


def test_archived_supervisor_exits_without_invoking_ssh(tmp_path):
    import json
    import os
    from pathlib import Path
    import subprocess
    import sys
    folder=tmp_path/'bin';folder.mkdir()
    marker=tmp_path/'ssh-invoked'
    fake=folder/'ssh'
    fake.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nexit 99\n')
    fake.chmod(0o700)
    config=tmp_path/'research.json'
    config.write_text(json.dumps({'enabled':True,'mode':'remote','base_url':'http://127.0.0.1:19503','ssh_target':'fixture@fixture'}))
    config.chmod(0o600)
    result=subprocess.run([sys.executable,'-B','-m','services.research_tunnel'],
        env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]),'RESEARCH_INTEGRATION_CONFIG':str(config),'PATH':str(folder)+os.pathsep+os.environ['PATH']},
        capture_output=True,timeout=5)
    assert result.returncode==0
    assert not marker.exists()
