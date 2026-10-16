"""Behavioral checks for source-only, independently collected test sandboxes."""

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def runner():
    path = ROOT / "scripts/full_merge/run_tests.py"
    assert path.is_file(), "isolated suite runner is missing"
    spec = importlib.util.spec_from_file_location("full_merge_runner", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_research_package_imports_without_database_creation(tmp_path):
    package = ROOT / "backend/modules/research/rabbit_hole"
    assert package.is_dir(), "approved research package has not been consolidated"
    result = subprocess.run(
        [sys.executable, "-c", "import rabbit_hole; import rabbit_hole.domain.project"],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(package.parent)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert list(tmp_path.iterdir()) == []


def test_suite_copies_have_separate_databases_and_no_live_assets(tmp_path):
    module = runner()
    main = module.prepare_sandbox("main", tmp_path / "main")
    research = module.prepare_sandbox("research", tmp_path / "research")
    assert main != research
    for sandbox in (main, research):
        assert not list(sandbox.rglob("*.db"))
        assert not list(sandbox.rglob(".env"))
        assert not (sandbox / "backend/static").exists()
    assert not (main / "backend/tests/research/conftest.py").exists()
    assert not (research / "backend/tests/conftest.py").exists()
    assert (research / "tests/conftest.py").exists()


def test_guard_blocks_external_socket_and_paid_subprocess(tmp_path):
    module = runner()
    sandbox = module.prepare_sandbox("main", tmp_path)
    env = module.sandbox_environment(sandbox, "main")
    code = "import socket; s=socket.socket(); s.connect(('8.8.8.8',443))"
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=sandbox,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "isolated test network" in result.stderr
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import subprocess; subprocess.run(['curl','https://example.com'])",
        ],
        cwd=sandbox,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "isolated test subprocess" in result.stderr


def test_guard_allows_loopback_fixture(tmp_path):
    module = runner()
    sandbox = module.prepare_sandbox("research", tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); c=socket.socket(); c.connect(s.getsockname()); s.accept(); print('ok')",
        ],
        cwd=sandbox,
        env=module.sandbox_environment(sandbox, "research"),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_research_collection_cannot_load_main_conftest(tmp_path):
    module = runner()
    sandbox = module.prepare_sandbox("research", tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "pytest_asyncio.plugin",
            "-c",
            "pyproject.toml",
            "--collect-only",
            "-q",
            "tests",
        ],
        cwd=sandbox,
        env=module.sandbox_environment(sandbox, "research"),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "test_workbench_domain.py" in result.stdout
    assert "test_full_merge_isolation.py" not in result.stdout
    assert not (sandbox / "backend/tests/conftest.py").exists()


def test_environment_drops_inherited_credentials_and_database(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-do-not-inherit")
    monkeypatch.setenv(
        "RABBIT_HOLE_TEST_POSTGRES_URL", "synthetic-external-do-not-inherit"
    )
    monkeypatch.setenv("SQLITE_DB_PATH", "synthetic-live-db-do-not-inherit")
    module = runner()
    main = module.prepare_sandbox("main", tmp_path / "main")
    research = module.prepare_sandbox("research", tmp_path / "research")
    main_env = module.sandbox_environment(main, "main")
    research_env = module.sandbox_environment(research, "research")
    for env in (main_env, research_env):
        assert "OPENAI_API_KEY" not in env
        assert "RABBIT_HOLE_TEST_POSTGRES_URL" not in env
        assert "synthetic-live-db-do-not-inherit" != env["SQLITE_DB_PATH"]
    assert main_env["HOME"] != research_env["HOME"]
    assert main_env["SQLITE_DB_PATH"] != research_env["SQLITE_DB_PATH"]


def test_browser_guard_allows_source_file_fixture_and_blocks_external(tmp_path):
    module = runner()
    sandbox = module.prepare_sandbox("research", tmp_path)
    fixture = sandbox / "fixture.html"
    fixture.write_text("<h1>Isolated fixture</h1>")
    code = """import asyncio
from playwright.async_api import async_playwright
async def check():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto(FIXTURE)
        assert await page.locator('h1').inner_text() == 'Isolated fixture'
        try:
            await page.goto('https://8.8.8.8', timeout=2000)
        except Exception as exc:
            assert 'ERR_BLOCKED_BY_CLIENT' in str(exc), str(exc)
        else:
            raise AssertionError('external browser request escaped isolation')
        await browser.close()
asyncio.run(check())
""".replace("FIXTURE", repr(fixture.as_uri()))
    env = module.sandbox_environment(sandbox, "research")
    env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ.get(
        "PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".venv/playwright-browsers")
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=sandbox,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_source_copy_excludes_sqlite_sidecars_and_environment_variants(tmp_path):
    module = runner()
    source = tmp_path / "live"
    source.mkdir()
    for name in (
        "history.db",
        "history.db-wal",
        "history.db-shm",
        "history.db-journal",
        ".env",
        ".env.secret",
        ".venv-macos",
    ):
        (source / name).write_text("synthetic private state")
    (source / "module.py").write_text("value = 1")
    target = tmp_path / "copied"
    module.copy_source(source, target)
    assert sorted(path.name for path in target.iterdir()) == ["module.py"]


def test_signal_terminated_components_cannot_be_success(monkeypatch, tmp_path):
    module = runner()
    # Terminate only synthetic child processes; never run real suites or network calls.
    # Main now includes the independently reported native workflow component.
    returns = iter((-9, 0, 0, 0, 0, -15, 0))
    monkeypatch.setattr(
        module,
        "prepare_sandbox",
        lambda suite, output: output.mkdir(parents=True) or output,
    )
    monkeypatch.setattr(module, "sandbox_environment", lambda *args: {})
    monkeypatch.setattr(module, "build_research_frontend", lambda *args: None)
    original_run = subprocess.run

    def synthetic_component(*args, **kwargs):
        status = next(returns)
        code = f"import os; os.kill(os.getpid(), {-status})" if status < 0 else "pass"
        return original_run([sys.executable, "-c", code], **kwargs)

    monkeypatch.setattr(module.subprocess, "run", synthetic_component)
    assert module.run_isolated_suite("all", tmp_path) > 0
    import json

    results = json.loads((tmp_path / "result.json").read_text())
    assert results["main"] > 0
    assert results["research"] > 0
    raw = json.loads((tmp_path / "component-results.json").read_text())
    assert raw["main"]["pytest"] == -9
    assert raw["research"]["ruff"] == -15


def test_python_options_wrappers_and_forced_executable_cannot_drop_guard(tmp_path):
    module = runner()
    sandbox = module.prepare_sandbox("research", tmp_path)
    code = """import subprocess,sys,pathlib,shlex
wrapper=pathlib.Path('python');wrapper.write_text('#!/bin/sh\\nexec '+shlex.quote(sys.executable)+' "$@"\\n');wrapper.chmod(0o700)
probe='import socket; assert socket.socket.connect.__module__ == "sitecustomize"'
for executable in (sys.executable,str(wrapper.resolve())):
    subprocess.run([executable,'-Bs','-c',probe],env={},check=True)
    for flag in ('-Es','-IS','-sE','-Ssu'):
        try: subprocess.run([executable,flag,'-c','pass'],check=True)
        except RuntimeError as exc: assert 'isolated test subprocess' in str(exc)
        else: raise AssertionError('combined option escaped guard: '+flag)
    try: subprocess.run([executable,'-c','pass'],executable='/usr/bin/true',check=True)
    except RuntimeError as exc: assert 'isolated test subprocess' in str(exc)
    else: raise AssertionError('forced executable escaped guard')
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=sandbox,
        env=module.sandbox_environment(sandbox, "research"),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_node_child_process_apis_reject_unguarded_children(tmp_path):
    module = runner()
    sandbox = module.prepare_sandbox("main", tmp_path)
    fixture = sandbox / "frontend/tests/isolation_child_probe.test.cjs"
    fixture.write_text("""const assert=require('node:assert/strict');const cp=require('node:child_process');
const calls=[()=>cp.spawn('/usr/bin/true'),()=>cp.spawnSync('/usr/bin/true'),()=>cp.exec('true',()=>{}),()=>cp.execSync('true'),()=>cp.execFile('/usr/bin/true',[],()=>{}),()=>cp.execFileSync('/usr/bin/true'),()=>cp.fork('/does-not-exist.js'),()=>new cp.ChildProcess().spawn({file:'/usr/bin/true',args:['true'],envPairs:[]})];
for(const call of calls) assert.throws(call,/isolated test subprocess/);
""")
    result = subprocess.run(
        ["node", "--test", "--test-isolation=none", str(fixture)],
        cwd=sandbox,
        env=module.sandbox_environment(sandbox, "main"),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_source_copy_rejects_all_supported_database_sidecars(tmp_path):
    module = runner()
    source = tmp_path / "source"
    source.mkdir()
    for ext in (".db", ".sqlite", ".sqlite3"):
        for suffix in ("", "-wal", "-shm", "-journal"):
            (source / ("private" + ext + suffix)).write_text(
                "synthetic private database rows"
            )
    (source / "keep.py").write_text("value=1")
    target = tmp_path / "copied"
    module.copy_source(source, target)
    assert sorted(path.name for path in target.iterdir()) == ["keep.py"]


def test_guard_allows_only_sandbox_file_handle_inventory(tmp_path):
    module=runner()
    sandbox=module.prepare_sandbox('main',tmp_path)
    code='''import subprocess,pathlib,sqlite3,os
p=pathlib.Path('fixture.db').resolve()
c=sqlite3.connect(p);c.execute('CREATE TABLE marker(value TEXT)')
r=subprocess.run(['lsof','-t','--',str(p)],capture_output=True,text=True)
assert str(os.getpid()) in r.stdout
for args in (['lsof','-t'],['lsof','-t','--','/etc/passwd'],['lsof','-p',str(os.getpid())]):
 try:subprocess.run(args,capture_output=True)
 except RuntimeError as e:assert 'isolated test subprocess' in str(e)
 else:raise AssertionError('unbounded lsof escaped')
c.close()
'''
    result=subprocess.run([sys.executable,'-c',code],cwd=sandbox,env=module.sandbox_environment(sandbox,'main'),capture_output=True,text=True)
    assert result.returncode==0,result.stderr


def test_research_sandbox_imports_unified_modules_from_source_only_copy(tmp_path):
    module = runner()
    sandbox = module.prepare_sandbox('research', tmp_path)
    code = """from pathlib import Path
import models.research_ai_usage, services.research_ai_adapter, migrations.full_merge_v1, db, config
root=Path.cwd().resolve()
for module in (models.research_ai_usage, services.research_ai_adapter, migrations.full_merge_v1, db, config):
    assert Path(module.__file__).resolve().is_relative_to(root), module.__file__
"""
    result = subprocess.run([sys.executable, '-c', code], cwd=sandbox,
        env=module.sandbox_environment(sandbox, 'research'), capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert not list(sandbox.rglob('history.db'))
    assert not list(sandbox.rglob('.env*'))
    assert not list(sandbox.rglob('*.pem'))
