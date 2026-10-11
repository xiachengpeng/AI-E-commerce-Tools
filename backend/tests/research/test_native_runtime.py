"""Native startup must preserve private configuration and isolate service roles."""
from __future__ import annotations
import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path
import pytest
from test_sqlite_storage import sqlite_engine

def config(tmp_path):
    value={
        "RABBIT_HOLE_DATABASE_URL":"sqlite+aiosqlite:///"+str(tmp_path/"workbench.db"),
        "RABBIT_HOLE_STORAGE_BACKEND":"files",
        "RABBIT_HOLE_STORAGE_PATH":str(tmp_path/"evidence"),
        "RABBIT_HOLE_PROVIDER_SECRETS_PATH":str(tmp_path/"providers/keys.json"),
        "RABBIT_HOLE_LAN_IP":"192.168.31.112",
        "PLAYWRIGHT_BROWSERS_PATH":str(tmp_path/"browsers"),
        "RABBIT_HOLE_OPENAI_API_KEY":"SECRET_SENTINEL_$literal",
    }
    path=tmp_path/"runtime.json"
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    return path,value

def test_native_load_preserves_host_paths_and_literal_secrets(tmp_path):
    from rabbit_hole.runtime.native import load_environment
    path,value=config(tmp_path)
    assert load_environment(path)==value

@pytest.mark.parametrize("changes",[
    {"RABBIT_HOLE_DATABASE_URL":"postgresql://private:SECRET_SENTINEL@db/rabbit"},
    {"RABBIT_HOLE_DATABASE_URL":"sqlite+aiosqlite:////app/data/workbench.db"},
    {"RABBIT_HOLE_DATABASE_URL":"SECRET_SENTINEL-invalid-url"},
    {"RABBIT_HOLE_STORAGE_PATH":"/app/data/evidence"},
    {"RABBIT_HOLE_PROVIDER_SECRETS_PATH":"relative/keys.json"},
    {"LD_PRELOAD":"SECRET_SENTINEL"},
    {"RABBIT_HOLE_STORAGE_BACKEND":"s3"},
    {"RABBIT_HOLE_LAN_IP":False},
])
def test_native_rejects_container_or_unsafe_config_without_secret_echo(tmp_path,changes):
    from rabbit_hole.runtime.native import load_environment
    path,value=config(tmp_path)
    path.write_text(json.dumps({**value,**changes}))
    with pytest.raises(ValueError) as error:
        load_environment(path)
    assert "SECRET_SENTINEL" not in str(error.value)

def test_native_config_rejects_public_permissions_and_symlink(tmp_path):
    from rabbit_hole.runtime.native import load_environment
    path,_=config(tmp_path)
    path.chmod(0o644)
    with pytest.raises(ValueError): load_environment(path)
    path.chmod(0o600)
    link=tmp_path/"link.json"
    link.symlink_to(path)
    with pytest.raises(ValueError): load_environment(link)

def test_native_cli_bad_config_fails_without_starting_or_exposing_content(tmp_path):
    path,_=config(tmp_path)
    path.write_text('{"SECRET_SENTINEL":"broken"')
    result=subprocess.run([sys.executable,"-m","rabbit_hole.runtime.native","--config",str(path),"api"],
        env={**os.environ,"PYTHONPATH":str(Path(__file__).resolve().parents[1]/"src")},
        capture_output=True,text=True,timeout=10)
    assert result.returncode==2
    assert "SECRET_SENTINEL" not in result.stdout+result.stderr
    assert "configuration" in result.stderr.lower()

@pytest.mark.parametrize("component",["api","worker"])
def test_launchagent_targets_native_role_and_private_config(tmp_path,component):
    from rabbit_hole.runtime.native_services import service_plist
    project=tmp_path/"project"; data=tmp_path/"private-data"
    value=plistlib.loads(plistlib.dumps(service_plist(component,project,data)))
    assert value["ProgramArguments"]==[
        str(project/".venv-macos/bin/python"),"-m","rabbit_hole.runtime.native",
        "--config",str(data/"runtime.json"),component]
    assert value["WorkingDirectory"]==str(project)
    assert value["EnvironmentVariables"]["PYTHONPATH"]==str(project/"src")
    assert value["RunAtLoad"] is True and value["KeepAlive"] is True
    assert value["Umask"]==0o077
    assert not any(k.startswith("RABBIT_HOLE_") for k in value["EnvironmentVariables"])

def test_launchagent_rejects_unknown_component(tmp_path):
    from rabbit_hole.runtime.native_services import service_plist
    with pytest.raises(ValueError): service_plist("legacy",tmp_path/"project",tmp_path/"data")

def test_native_start_refuses_existing_listener(tmp_path):
    import socket
    from rabbit_hole.runtime.native_services import ensure_can_start
    with socket.socket() as listener:
        listener.bind(("127.0.0.1",0))
        listener.listen()
        with pytest.raises(RuntimeError,match="port"):
            ensure_can_start(tmp_path/"project",tmp_path/"data",api_loaded=False,
                worker_loaded=True,port=listener.getsockname()[1])

async def test_native_start_refuses_foreign_live_worker(sqlite_engine,tmp_path):
    from datetime import UTC,datetime
    from rabbit_hole.runtime.native_services import ensure_can_start
    from rabbit_hole.monitoring import runtime_health
    from rabbit_hole.persistence.sql import write_transaction
    project=tmp_path/"project"
    (project/".venv-macos/bin").mkdir(parents=True)
    import shlex
    launcher=project/".venv-macos/bin/python"
    launcher.write_text("#!/bin/sh\nexec "+shlex.quote(sys.executable)+' "$@"\n')
    launcher.chmod(0o700)
    (project/"src").symlink_to(Path(__file__).resolve().parents[1]/"src",target_is_directory=True)
    path,values=config(tmp_path)
    values.update({
        "RABBIT_HOLE_DATABASE_URL":str(sqlite_engine.url),
        "RABBIT_HOLE_FEISHU_APP_ID":"isolated","RABBIT_HOLE_FEISHU_APP_SECRET":"isolated",
        "RABBIT_HOLE_FEISHU_BASE_APP_TOKEN":"isolated","RABBIT_HOLE_S3_ENDPOINT":"http://localhost:9999",
        "RABBIT_HOLE_S3_BUCKET":"isolated","RABBIT_HOLE_S3_ACCESS_KEY":"isolated",
        "RABBIT_HOLE_S3_SECRET_KEY":"isolated",
        "RABBIT_HOLE_MARKET__CODE":"US","RABBIT_HOLE_MARKET__CURRENCY":"USD",
        "RABBIT_HOLE_MARKET__MIN_AOV":"1","RABBIT_HOLE_MARKET__MAX_AOV":"100",
        "RABBIT_HOLE_MARKET__PAYMENT_PERCENT":"0.03","RABBIT_HOLE_MARKET__PAYMENT_FIXED":"0.3",
        "RABBIT_HOLE_MARKET__LOSS_RESERVE_PERCENT":"0.02"})
    path.write_text(json.dumps(values))
    async with write_transaction(sqlite_engine) as c:
        await c.execute(runtime_health.insert().values(component="workbench_worker",updated_at=datetime.now(UTC)))
    with pytest.raises(RuntimeError,match="worker"):
        await __import__("asyncio").to_thread(ensure_can_start,project,tmp_path,
            api_loaded=True,worker_loaded=False)

@pytest.mark.parametrize("role",["api","worker","worker-health"])
@pytest.mark.parametrize("changes",[{},{"RABBIT_HOLE_S3_ENDPOINT":"SECRET_SENTINEL-not-a-url"}])
def test_native_cli_invalid_application_settings_are_private(tmp_path,role,changes):
    path,value=config(tmp_path)
    path.write_text(json.dumps({**value,**changes}))
    env={k:v for k,v in os.environ.items() if not k.startswith("RABBIT_HOLE_")}
    env["PYTHONPATH"]=str(Path(__file__).resolve().parents[1]/"src")
    result=subprocess.run([sys.executable,"-m","rabbit_hole.runtime.native","--config",str(path),role],
        env=env,capture_output=True,text=True,timeout=10)
    assert result.returncode==2
    assert "SECRET_SENTINEL" not in result.stdout+result.stderr
    assert "configuration" in result.stderr.lower()

def test_native_stop_waits_for_real_process_exit():
    import threading
    import time
    from rabbit_hole.runtime.native_services import wait_for_exit
    process=subprocess.Popen([sys.executable,"-c","import time; print('ready',flush=True); time.sleep(.3)"],
        stdout=subprocess.PIPE,text=True)
    assert process.stdout.readline().strip()=="ready"
    reaper=threading.Thread(target=process.wait)
    reaper.start()
    started=time.monotonic()
    try:
        wait_for_exit([process.pid],timeout=2)
        assert time.monotonic()-started>=.2
        assert process.poll()==0
    finally:
        reaper.join(timeout=2)
        process.stdout.close()

def test_native_stop_timeout_does_not_allow_false_success():
    from rabbit_hole.runtime.native_services import wait_for_exit
    process=subprocess.Popen([sys.executable,"-c","import time; print('ready',flush=True); time.sleep(10)"],
        stdout=subprocess.PIPE,text=True)
    assert process.stdout.readline().strip()=="ready"
    try:
        with pytest.raises(TimeoutError,match="stop incomplete"):
            wait_for_exit([process.pid],timeout=.1)
        assert process.poll() is None
    finally:
        process.terminate()
        process.wait(timeout=2)
        process.stdout.close()
