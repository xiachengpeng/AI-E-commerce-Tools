"""Restore externally anchored backups into a private, disposable candidate only.

A sibling <snapshot>.anchor is an independently saved SHA256, not a value taken
from the mutable manifest. <research-snapshot>.plan.json is a private operator
mapping: unknown configuration aliases/purposes must be resolved explicitly.
No source discovery, process handling, activation, or network operations exist.
"""
import asyncio
import hashlib
import json
import os
import tempfile
from pathlib import Path

from scripts.full_merge.backup import backup_sqlite, database_stats
from scripts.full_merge.copy_objects import copy_objects, inventory_objects
from scripts.full_merge.import_data import _digest, _safe, candidate_directory, import_research
from scripts.full_merge.verify import verify_snapshot


def _private_file(path):
    path = _safe(path)
    if not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ValueError('private operator file required')
    return path


def _snapshot_file(root, relative):
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError('backup path escape')
    path = _safe(root / relative)
    if not path.is_file():
        raise ValueError('backup file missing')
    return path


def _verified_snapshot(root):
    root = _safe(root)
    anchor = _private_file(root.with_suffix('.anchor')).read_text().strip()
    if len(anchor) != 64 or any(c not in '0123456789abcdef' for c in anchor):
        raise ValueError('independent backup anchor required')
    # Reject symlinks before the older verifier's resolve() behavior can hide them.
    for path in root.rglob('*'):
        _safe(path)
    result = verify_snapshot(root, expected_digest=anchor)
    if any(result.get(k) is not True for k in ('verified','integrity_verified','completeness_verified')):
        raise ValueError('backup verification failed')
    manifest = json.loads((root / 'manifest.json').read_bytes())
    # Restore and examine real SQLite copies, independently of report assertions.
    with tempfile.TemporaryDirectory(prefix='full-merge-restore-') as temporary:
        for index, entry in enumerate(manifest['databases']):
            restored = Path(temporary).resolve() / (str(index) + '.db')
            checked = backup_sqlite(_snapshot_file(root,entry['path']),restored)
            if checked['verified'] is not True or database_stats(restored) != entry['stats']:
                raise ValueError('backup restored copy mismatch')
    return manifest, anchor


def _write_private(path, raw):
    path = _safe(path)
    if path.exists():
        if not path.is_file() or path.read_bytes() != raw or path.stat().st_mode & 0o077:
            raise ValueError('candidate private material conflict')
        return
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with os.fdopen(os.open(path,os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,0o600),'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def resolve_original_evidence_path(original: Path, data_root: Path) -> Path:
    """Read-only mapping; signed history/event content remains byte-for-byte old."""
    data_root = _safe(data_root)
    mapping = json.loads(_private_file(data_root/'keys/path-map.json').read_bytes())
    source = Path(mapping['original_evidence_root'])
    original = Path(original)
    if mapping.get('version') != 1 or not source.is_absolute() or '..' in original.parts or not original.is_absolute() or not original.is_relative_to(source):
        raise ValueError('historical evidence path outside namespace')
    target = _safe(data_root/'evidence'/original.relative_to(source))
    if not target.is_file():
        raise ValueError('historical evidence missing')
    return target


async def _runtime_read_check(database, data_root):
    from services.research_runtime import open_research_runtime, resolve_runtime_paths
    from sqlalchemy import text
    before = _digest(database)
    async with open_research_runtime(resolve_runtime_paths(database,data_root),allow_commands=False,allow_external=False) as runtime:
        if runtime.diagnostics:
            raise ValueError('candidate read-only runtime unprepared')
        async with runtime.engine.connect() as connection:
            await connection.execute(text('SELECT COUNT(*) FROM workbench_projects'))
            await connection.execute(text('SELECT COUNT(*) FROM workbench_events'))
    if _digest(database) != before:
        raise ValueError('read-only runtime changed database')
    return True


def rehearse(snapshot: Path, main_snapshot: Path, destination: Path) -> dict:
    snapshot,main_snapshot,destination = _safe(snapshot),_safe(main_snapshot),_safe(destination)
    source_manifest,source_anchor = _verified_snapshot(snapshot)
    main_manifest,main_anchor = _verified_snapshot(main_snapshot)
    plan_bytes = _private_file(snapshot.with_suffix('.plan.json')).read_bytes()
    plan = json.loads(plan_bytes)
    required = {'version','source_database','main_database','evidence_root','namespace_file','business_settings_file','original_evidence_root','configuration'}
    if not isinstance(plan,dict) or not required.issubset(plan) or set(plan) - required - {'auxiliary_databases'} or plan['version'] != 1:
        raise ValueError('explicit complete migration plan required')
    for root,manifest,relative in ((snapshot,source_manifest,plan['source_database']),(main_snapshot,main_manifest,plan['main_database'])):
        if relative not in {e['path'] for e in manifest['databases']}:
            raise ValueError('planned database not in anchored backup')
    # No auxiliary database may silently disappear. Additional DBs need explicit mapping.
    auxiliary = []
    mapped = {plan['source_database']}
    for entry in plan.get('auxiliary_databases', []):
        if set(entry) != {'database','active_table_mapping'} or entry['database'] in mapped:
            raise ValueError('explicit auxiliary database mapping required')
        if entry['database'] not in {e['path'] for e in source_manifest['databases']}:
            raise ValueError('auxiliary database absent from anchored backup')
        mapped.add(entry['database'])
        path = _snapshot_file(snapshot,entry['database'])
        auxiliary.append({'path':str(path),'sha256':_digest(path),'stats':database_stats(path),'active_table_mapping':entry['active_table_mapping']})
    if mapped != {e['path'] for e in source_manifest['databases']} or len(main_manifest['databases']) != 1:
        raise ValueError('auxiliary database mapping required')
    evidence_relative = Path(plan['evidence_root'])
    if evidence_relative.is_absolute() or '..' in evidence_relative.parts or len(evidence_relative.parts) != 2 or evidence_relative.parts[0] != 'objects':
        raise ValueError('explicit backed-up evidence root required')
    evidence_source = _safe(snapshot/evidence_relative)
    if not evidence_source.is_dir() or not any(e['path'].startswith(evidence_relative.as_posix()+'/') for e in source_manifest['objects']):
        raise ValueError('evidence root absent from backup')
    for field in ('namespace_file','business_settings_file'):
        if plan[field] not in {e['path'] for e in source_manifest['keys']}:
            raise ValueError('source configuration absent from backup')
    namespace_bytes = _snapshot_file(snapshot,plan['namespace_file']).read_bytes()
    business_bytes = _snapshot_file(snapshot,plan['business_settings_file']).read_bytes()
    from models.research_ai import ResearchBusinessSettings
    from services.research_runtime import _namespace, resolve_runtime_paths
    from backend.migrations.full_merge_v1 import prepare_schema, verify_backup_report
    ResearchBusinessSettings.model_validate_json(business_bytes)
    namespace = json.loads(namespace_bytes)
    if set(namespace) != {'version','evidence_bucket','collector_version'}:
        raise ValueError('original namespace required')
    original_root = Path(plan['original_evidence_root'])
    if not original_root.is_absolute() or '..' in original_root.parts:
        raise ValueError('original evidence root mapping required')
    signing = _snapshot_file(evidence_source,'.signing-key').read_bytes()
    if len(signing) != 32:
        raise ValueError('original 32-byte signing material required')
    # destination creation is permitted only under disposable/private operator roots.
    roots = (Path(tempfile.gettempdir()).resolve(),Path.home()/'.local/share/ai-ecommerce-merge')
    if not any(destination.is_relative_to(root) and destination != root for root in roots) or destination.is_relative_to(snapshot) or destination.is_relative_to(main_snapshot):
        raise ValueError('disposable candidate destination required')
    identity = json.dumps({'source_anchor':source_anchor,'main_anchor':main_anchor,'plan_sha256':hashlib.sha256(plan_bytes).hexdigest()},sort_keys=True).encode()
    if destination.exists():
        candidate_directory(destination)
        if _private_file(destination/'candidate-inputs.json').read_bytes() != identity:
            raise ValueError('candidate snapshot identity mismatch')
    else:
        destination.mkdir(mode=0o700,parents=True)
        _write_private(destination/'.full-merge-candidate',b'1')
        _write_private(destination/'candidate-inputs.json',identity)
    candidate = destination/'history.db'
    if not candidate.exists():
        backup_sqlite(_snapshot_file(main_snapshot,plan['main_database']),candidate)
    if not (destination/'schema-prepared.json').exists():
        canonical = {'version':1,'snapshot_directory':str(main_snapshot),'manifest_sha256':main_anchor,'verified':True,'integrity_verified':True,'completeness_verified':True,'restore_verified':True}
        report_path = destination/'backup-report.json'
        _write_private(report_path,json.dumps(canonical,sort_keys=True).encode())
        # Exact canonical Task4 report and actual restored database comparison before DDL.
        # Prepare an independent restored copy first. A crash after candidate DDL
        # but before the receipt can resume only when the entire DB matches it.
        with tempfile.TemporaryDirectory(prefix='schema-',dir=destination) as temporary:
            reference = Path(temporary)/'history.db'
            backup_sqlite(_snapshot_file(main_snapshot,plan['main_database']),reference)
            verify_backup_report(reference,report_path)
            prepared = prepare_schema(reference,backup_verified=True,target_revision=3)
            current_stats = database_stats(candidate)
            if current_stats == database_stats(_snapshot_file(main_snapshot,plan['main_database'])):
                verify_backup_report(candidate,report_path)
                prepare_schema(candidate,backup_verified=True,target_revision=3)
            if database_stats(candidate) != database_stats(reference):
                raise ValueError('interrupted schema candidate mismatch')
        _write_private(destination/'schema-prepared.json',json.dumps(prepared,sort_keys=True).encode())
    research_root = destination/'research'
    research_root.mkdir(mode=0o700,exist_ok=True)
    for relative in ('keys','browser','locks'):
        (research_root/relative).mkdir(mode=0o700,parents=True,exist_ok=True)
    paths = resolve_runtime_paths(candidate,research_root)
    _write_private(paths.keys_root/'evidence-signing.key',signing)
    _write_private(paths.keys_root/'evidence-namespace.json',namespace_bytes)
    _write_private(paths.keys_root/'business-settings.json',business_bytes)
    mapping = {'version':1,'original_evidence_root':str(original_root)}
    _write_private(paths.keys_root/'path-map.json',json.dumps(mapping,sort_keys=True).encode())
    if _namespace(paths) is None:
        raise ValueError('original evidence namespace invalid')
    object_result = copy_objects(evidence_source,paths.evidence_root,inventory_objects(evidence_source))
    # Preserve all backup config files/other object roots privately, including legacy aliases.
    for role,root,manifest in (('research',snapshot,source_manifest),('main',main_snapshot,main_manifest)):
        for category in ('objects','keys'):
            for entry in manifest[category]:
                if role == 'research' and category == 'objects' and entry['path'].startswith(evidence_relative.as_posix()+'/'):
                    continue
                _write_private(destination/'provenance'/role/entry['path'],_snapshot_file(root,entry['path']).read_bytes())
    source_db = _snapshot_file(snapshot,plan['source_database'])
    manifest = {'backup_verified':True,'source_snapshot_id':source_anchor,'source_snapshot_sha256':source_anchor,'source_database_sha256':_digest(source_db),'source_stats':database_stats(source_db),'configuration':plan['configuration'],'auxiliary_databases':auxiliary}
    imported = import_research(source_db,candidate,manifest)
    runtime_verified = asyncio.run(_runtime_read_check(candidate,research_root))
    result = {'verified':imported['verified'] and object_result['verified'] and runtime_verified,'mismatches':[],'hash':imported['hash'],'tables':imported['tables'],'rows':imported['rows'],'objects':object_result['objects'],'versions':object_result['versions'],'runtime_readonly_verified':runtime_verified,'cutover_allowed':False,'source_freeze_attested':False}
    _write_private(destination/'rehearsal-report.json',json.dumps(result,sort_keys=True).encode())
    return result


async def authenticated_candidate_read(database: Path, data_root: Path) -> dict:
    """Use native session/GET routers with the original store on a read-only engine."""
    from dataclasses import replace
    import httpx
    from fastapi import FastAPI
    from services.research_runtime import open_research_runtime, resolve_runtime_paths
    from routes import research_workbench
    from rabbit_hole.persistence.projects import WorkbenchStore
    before = _digest(database)
    async with open_research_runtime(resolve_runtime_paths(database,data_root),allow_commands=False,allow_external=False) as runtime:
        if runtime.diagnostics:
            raise ValueError('candidate read-only runtime unprepared')
        app = FastAPI()
        app.state.research_runtime = replace(runtime,store=WorkbenchStore(runtime.engine))
        app.include_router(research_workbench.router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://localhost:9503') as client:
            prefix = '/api/research/workbench/v1'
            refused = await client.get(prefix+'/projects')
            session = await client.get(prefix+'/session')
            if refused.status_code != 401 or session.status_code != 200:
                raise ValueError('candidate session boundary failed')
            response = await client.get(prefix+'/projects',headers={'X-Research-Token':session.json()['csrf_token']})
            if response.status_code != 200 or response.headers.get('cache-control') != 'no-store':
                raise ValueError('candidate authenticated read failed')
            projects = len(response.json()['projects'])
    if _digest(database) != before:
        raise ValueError('authenticated read modified candidate')
    return {'authenticated':True,'unauthenticated_refused':True,'readonly':True,'projects':projects}


def benchmark_main_reads(main_db: Path, candidate_db: Path, *, samples: int = 200) -> dict:
    """Current /config handler in-process, readonly DBs, identical explicit constants.

    Extract only its three pure functions rather than import main.py (which owns
    init_db). Includes native FastAPI ASGI handling, binding/provider reads and
    serialization. No socket, lifespan, environment fallback, or external call.
    This small endpoint comparison does not attest whole-application performance.
    """
    import ast
    import math
    import time
    import httpx
    from fastapi import Depends, FastAPI
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from services.ai_config_service import ProviderSnapshot, get_snapshot
    if type(samples) is not int or samples < 20:
        raise ValueError('at least20 benchmark samples required')
    main_db,candidate_db = _safe(main_db),_safe(candidate_db)
    before = [_digest(p) for p in (main_db,candidate_db)]
    source = Path(__file__).resolve().parents[2]/'backend/main.py'
    names = {'serialize_public_snapshot','get_public_route','get_frontend_config'}
    functions = [n for n in ast.parse(source.read_text()).body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
    if {n.name for n in functions} != names:
        raise ValueError('main read endpoint contract missing')
    for function in functions:
        function.decorator_list = []
    module = ast.fix_missing_locations(ast.Module(body=functions,type_ignores=[]))
    globals_ = {'Session':Session,'ProviderSnapshot':ProviderSnapshot,'get_snapshot':get_snapshot,'Depends':Depends,'get_db':lambda:None,'FRONTEND_CONCURRENCY_LIMIT':1,'FRONTEND_STAGGER_DELAY':0}
    exec(compile(module,str(source),'exec'),globals_)
    apps,engines = [],[]
    for path in (main_db,candidate_db):
        engine = create_engine('sqlite://',creator=lambda path=path: __import__('sqlite3').connect(path.as_uri()+'?mode=ro',uri=True,check_same_thread=False))
        engines.append(engine)
        app = FastAPI()
        def make_dependency(bound_engine):
            def session_dependency():
                with Session(bound_engine) as session:
                    yield session
            return session_dependency
        session_dependency = make_dependency(engine)
        app.dependency_overrides[globals_['get_db']] = session_dependency
        app.get('/config')(globals_['get_frontend_config'])
        apps.append(app)
    async def measure():
        timings = [[],[]]
        hashes = [set(),set()]
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[0]),base_url='http://localhost:9503') as main, httpx.AsyncClient(transport=httpx.ASGITransport(app=apps[1]),base_url='http://localhost:9503') as candidate:
            clients = (main,candidate)
            for index in range(samples+20):
                # Alternating first client reduces ordering and temperature bias.
                for side in (index%2,1-index%2):
                    started = time.perf_counter()
                    response = await clients[side].get('/config')
                    elapsed = (time.perf_counter()-started)*1000
                    if response.status_code != 200:
                        raise ValueError('main read benchmark endpoint failed')
                    hashes[side].add(hashlib.sha256(response.content).hexdigest())
                    if index >= 20:
                        timings[side].append(elapsed)
        p95 = [sorted(values)[math.ceil(samples*0.95)-1] for values in timings]
        equal = hashes[0] == hashes[1] and len(hashes[0]) == 1
        return {'scope':'current /config ASGI readonly in-process; not whole-app SLA','samples':samples,'main_p95_ms':round(p95[0],4),'candidate_p95_ms':round(p95[1],4),'increase_percent':round((p95[1]/p95[0]-1)*100,4),'within_20_percent':p95[1] <= p95[0]*1.2,'response_hash_equal':equal,'readonly':True}
    try:
        result = asyncio.run(measure())
    finally:
        for engine in engines:
            engine.dispose()
    if [_digest(p) for p in (main_db,candidate_db)] != before:
        raise ValueError('read benchmark modified database')
    return result
