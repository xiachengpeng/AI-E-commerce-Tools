"""Frozen/dev desktop runtime. No backend imports or state writes on import."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys


def _inspect_database(database: Path, config: dict) -> dict:
    import asyncio
    from services.research_runtime import resolve_runtime_paths, open_research_runtime
    from services.research_ai_adapter import read_business_settings
    async def inspect():
        business=read_business_settings(config['business_settings_path']) if config.get('business_settings_path') else None
        root=Path(config.get('data_root') or Path.home()/'.local/share/ai-ecommerce-tools/research')
        async with open_research_runtime(resolve_runtime_paths(database,root),allow_commands=True,
                allow_external=True,business_settings=business) as runtime:
            from sqlalchemy import text
            async with runtime.engine.connect() as c:
                count=(await c.execute(text('SELECT COUNT(*) FROM workbench_projects'))).scalar_one()
            return {'research_ready':not runtime.diagnostics,'projects':count,'worker_started':False}
    return asyncio.run(inspect())


def inspect_research(data: Path, *, inspector=_inspect_database) -> dict:
    """Assemble services against a disposable DB; never execute handlers or queues."""
    from contextlib import closing
    import sqlite3
    import tempfile
    import traceback
    import re
    before={key:os.environ.get(key) for key in ('SQLITE_DB_PATH','AI_ECOMMERCE_DATA_DIR')}
    try:
        with tempfile.TemporaryDirectory(prefix='desktop-research-inspect-') as temporary:
            root=Path(temporary).resolve();database=root/'history.db'
            with closing(sqlite3.connect((data/'history.db').as_uri()+'?mode=ro',uri=True)) as source,closing(sqlite3.connect(database)) as target:
                source.backup(target)
            os.environ['SQLITE_DB_PATH']=str(database)
            os.environ['AI_ECOMMERCE_DATA_DIR']=str(root)
            return inspector(database,json.loads((data/'research.json').read_text()))
    except Exception as exc:
        # No messages, locals or full paths: imported exceptions may carry keys.
        report={'research_ready':False,'worker_started':False,'error_type':type(exc).__name__,
                'frames':[(Path(f.filename).name,f.lineno) for f in traceback.extract_tb(exc.__traceback__)]}
        if isinstance(exc,ModuleNotFoundError) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]*',exc.name or ''):
            report['missing_module']=exc.name
        return report
    finally:
        for key,value in before.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value


def configure_environment(data: Path, resources: Path) -> None:
    if not data.is_absolute() or not resources.is_absolute():
        raise ValueError('Desktop paths must be absolute')
    data, resources = data.resolve(), resources.resolve()
    if data == resources or resources in data.parents:
        raise ValueError('User data cannot live inside application resources')
    os.umask(0o077)
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = data.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Desktop data directory must be private')
    os.environ.update({
        'AI_ECOMMERCE_DATA_DIR': str(data),
        'SQLITE_DB_PATH': str(data / 'history.db'),
        'AI_ECOMMERCE_ENV_FILE': str(data / '.env'),
        'RESEARCH_INTEGRATION_CONFIG': str(data / 'research.json'),
    })
    browsers = resources / 'browsers'
    if browsers.is_dir():
        os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(browsers)


def inspect_polling(data: Path) -> dict:
    """Exercise frozen polling/owner/cancellation using only a disposable copy.

    The fake operator never constructs a provider client or queue repository.
    Offline ownership is restricted by the existing guard to the temp root.
    """
    import asyncio
    from contextlib import closing
    import sqlite3
    import tempfile
    from services.research_runtime import _research_imports, resolve_runtime_paths
    sql = _research_imports()
    from services.research_worker import FeishuPollingLoop
    from rabbit_hole.runtime.workbench_worker import LOCK_KEY, serve_workbench

    async def probe(database, root):
        paths = resolve_runtime_paths(database, root)
        engine = sql.create_engine('sqlite+aiosqlite:///' + str(database), initialize_file=False, lock_root=paths.lock_root)
        engine.update_execution_options(research_ownership_paths=paths, research_offline_commands=True)
        stop = asyncio.Event()
        observed = {'calls': 0, 'failures': 0, 'duplicate': False}
        class Operator:
            async def poll_once(self):
                observed['calls'] += 1
                if observed['calls'] == 1:
                    observed['failures'] += 1
                    raise OSError('synthetic offline failure')
                return 0
        async def wait(_seconds):
            if observed['calls'] >= 2:
                stop.set()
                await asyncio.Event().wait()
            await asyncio.sleep(0)
        class Idle:
            async def loop(self):
                async with sql.session_lock(engine, LOCK_KEY) as owned:
                    observed['duplicate'] = not owned
                await asyncio.Event().wait()
        try:
            async with asyncio.timeout(10):
                await serve_workbench(engine, FeishuPollingLoop(Operator(), engine, 60, wait=wait), Idle(), stop=stop)
            async with engine.connect() as connection:
                state = (await connection.exec_driver_sql("SELECT component FROM runtime_health WHERE component IN ('feishu_poll_ok','feishu_poll_failed','workbench_worker')")).scalars().all()
            from datetime import UTC, datetime, timedelta
            from types import SimpleNamespace
            from uuid import uuid4
            from services.research_polling_policy import PollingPolicy, SessionBudgetStore, poll_with_policy
            class Source:
                async def list_trigger_records(self): return []
            class NoJobs:
                async def enqueue_with_receipt(self, payload): raise AssertionError('observation enqueued work')
            outcome = await poll_with_policy(SimpleNamespace(feishu=Source(), jobs=NoJobs()), PollingPolicy())
            sessions = root / 'closeout-sessions'
            sessions.mkdir(mode=0o700)
            budget = SessionBudgetStore.create(sessions, str(uuid4()), scope_ids=['probe'], limits={'text_ai':1}, expires_at=datetime.now(UTC)+timedelta(minutes=1))
            first = budget.reserve('probe','probe','text_ai',1)
            replay = SessionBudgetStore(sessions,budget.session_id,expected_policy_digest=budget.policy_digest).reserve('probe','probe','text_ai',1)
            finite_ready = first.permit_network and not replay.permit_network and outcome.enqueued == 0
            ready = observed['calls'] == 2 and observed['failures'] == 1 and observed['duplicate'] and state == ['feishu_poll_ok'] and finite_ready
            return {'polling_probe_ready': ready, 'synthetic_poll_calls': observed['calls'],
                    'synthetic_failures': observed['failures'], 'duplicate_owner_rejected': observed['duplicate'],
                    'external_calls': 0, 'production_worker_started': False, 'finite_policy_probe_ready': finite_ready}
        finally:
            await engine.dispose()
    with tempfile.TemporaryDirectory(prefix='desktop-polling-probe-') as temporary:
        root = Path(temporary).resolve()
        database = root / 'history.db'
        with closing(sqlite3.connect((data / 'history.db').as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(database)) as target:
            source.backup(target)
        private = root / 'research'
        private.mkdir(mode=0o700)
        return asyncio.run(probe(database, private))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('api', 'frontend', 'worker', 'diagnose', 'verify', 'inspect-research', 'verify-polling'), required=True)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--resources-dir', type=Path, required=True)
    args = parser.parse_args(argv)
    if not getattr(sys, 'frozen', False):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    try:
        # Customer bootstrap is explicit in the signed app resources, before any
        # main imports or legacy DB initialization. Diagnostics remain read-only.
        release_path = args.resources_dir / 'release.json'
        if args.mode == 'api' and release_path.is_file():
            release = json.loads(release_path.read_text())
            if release.get('channel') == 'customer':
                from services.customer_distribution import prepare_customer_data
                prepare_customer_data(args.data_dir, release['version'])
        configure_environment(args.data_dir, args.resources_dir)
        if args.mode == 'verify-polling':
            result = inspect_polling(args.data_dir)
            print(json.dumps(result))
            return 0 if result['polling_probe_ready'] else 1
        if args.mode == 'inspect-research':
            result=inspect_research(args.data_dir)
            print(json.dumps(result))
            return 0 if result['research_ready'] else 1
        if args.mode == 'diagnose':
            print(json.dumps({'database_exists': (args.data_dir / 'history.db').is_file(),
                              'worker_enabled': False, 'research_config_exists': (args.data_dir / 'research.json').is_file(),
                              'architecture': __import__('platform').machine()}))
            return 0
        if args.mode == 'verify':
            # Build verification is restricted to a fresh disposable root.
            if any((args.data_dir / name).exists() for name in ('history.db', '.env', 'research.json')):
                raise ValueError('Verification requires an empty data root')
            import asyncio
            import httpx
            import main as backend_app
            async def verify():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=backend_app.app), base_url='http://127.0.0.1:9503') as client:
                    response = await client.get('/config')
                    return response.status_code
            status = asyncio.run(verify())
            print(json.dumps({'backend_imports': True, 'config_status': status, 'worker_started': False}))
            return 0 if status == 200 else 1
        # A desktop instance owns only these files/processes. Research keeps its
        # separate dataset/worker fencing, activation and uncertain-outcome gates.
        import fcntl
        with open(args.data_dir / (args.mode + '.lock'), 'a') as owned:
            fcntl.flock(owned, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.mode == 'api':
                from services.research_client import load_research_config
                from services.research_runtime import check_cutover_startup
                check_cutover_startup(load_research_config(), os.environ['SQLITE_DB_PATH'])
                import uvicorn
                uvicorn.run('main:app', host='127.0.0.1', port=9503, workers=1,
                            timeout_graceful_shutdown=5, log_level='warning')
            elif args.mode == 'frontend':
                import http.server
                from frontend_server import make_handler
                frontend = args.resources_dir / 'frontend'
                if not (frontend / 'index.html').is_file() or not (frontend / 'dist/output.css').is_file():
                    raise ValueError('Desktop frontend resources are incomplete')
                with http.server.ThreadingHTTPServer(('127.0.0.1', 9502), make_handler(str(frontend))) as server:
                    server.serve_forever()
            else:
                from run import local_worker_command
                from services.research_client import load_research_config
                config = load_research_config()
                if not local_worker_command(config, os.environ['SQLITE_DB_PATH']):
                    return 0
                import asyncio
                from services.research_worker import _run
                root = Path(config.get('data_root') or Path.home() / '.local/share/ai-ecommerce-tools/research')
                business = Path(config['business_settings_path']) if config.get('business_settings_path') else None
                asyncio.run(_run(Path(os.environ['SQLITE_DB_PATH']), root, 'active', business,
                                 poll_feishu=config.get('feishu_polling_enabled') is True))
        return 0
    except Exception:
        # Imported provider/DB exceptions can contain secrets; never print them.
        print('desktop_runtime_failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    if getattr(sys, 'frozen', False):
        import multiprocessing
        multiprocessing.freeze_support()
    sys.exit(main())
