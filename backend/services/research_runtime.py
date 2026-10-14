"""No startup, migrations, credentials, or network clients are implicit here."""
import json
import os
import re
import stat
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib import import_module
from pathlib import Path
from types import ModuleType

from models.research_runtime import ResearchRuntime, RuntimePaths
from sqlalchemy.engine import URL
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine


def _validate_path(path: Path, *, private: bool = False) -> None:
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('runtime paths must be absolute without traversal')
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError('symlink runtime paths are forbidden')
    if path.exists() and private:
        info = path.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError('private runtime path permissions are invalid')


def resolve_runtime_paths(database: Path, data_root: Path) -> RuntimePaths:
    database, data_root = Path(database), Path(data_root)
    _validate_path(database)
    _validate_path(data_root, private=True)
    if 'static' in data_root.parts or database == data_root or data_root in database.parents:
        raise ValueError('research storage must be separate from database and public assets')
    paths = RuntimePaths(database, data_root / 'evidence', data_root / 'keys',
                         data_root / 'browser', data_root / 'locks')
    for path in (paths.evidence_root, paths.keys_root, paths.browser_root, paths.lock_root):
        _validate_path(path, private=True)
    return paths


def _namespace(paths: RuntimePaths) -> dict[str, str] | None:
    path = paths.keys_root / 'evidence-namespace.json'
    _validate_path(path, private=True)
    if not path.is_file():
        return None
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'r') as stream:
        raw = stream.read(4097)
    if len(raw) > 4096:
        return None
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'version', 'evidence_bucket', 'collector_version'}:
            raise ValueError
        if type(value['version']) is not int or value['version'] != 1:
            raise ValueError
        for field in ('evidence_bucket', 'collector_version'):
            if not isinstance(value[field], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', value[field]):
                raise ValueError
        return {field: value[field] for field in ('evidence_bucket', 'collector_version')}
    except (ValueError, TypeError, KeyError):
        return None


def _research_imports() -> ModuleType:
    # Single project environment; migration namespace deliberately has no top-level package.
    source = str(Path(__file__).resolve().parents[1] / 'modules' / 'research')
    if source not in sys.path:
        sys.path.insert(0, source)
    return import_module('rabbit_hole.persistence.sql')


async def _prepared(engine: AsyncEngine) -> bool:
    for name in ('application.actions', 'application.sync', 'monitoring',
                 'integrations.provider_jobs', 'persistence.projects'):
        import_module('rabbit_hole.' + name)
    metadata = import_module('rabbit_hole.persistence.database').metadata
    async with engine.connect() as connection:
        from models.full_merge import validate_prepared_schema
        try:
            revision = await connection.run_sync(lambda sync: validate_prepared_schema(sync, metadata))
            if revision >= 2:
                from models.integration_settings import metadata as integrations
                await connection.run_sync(lambda sync: validate_prepared_schema(sync, metadata, additional_metadata=integrations))
            if revision >= 3:
                from models.research_ai_usage import metadata as usage
                await connection.run_sync(lambda sync: validate_prepared_schema(sync, metadata, additional_metadata=usage))
        except (SQLAlchemyError, ValueError):
            return False
        return True


@asynccontextmanager
async def open_research_runtime(paths: RuntimePaths, *, allow_commands: bool = False,
                                allow_external: bool = False, business_settings=None, offline_commands: bool = False) -> AsyncIterator[ResearchRuntime]:
    if business_settings is not None:
        from models.research_ai import ResearchBusinessSettings
        if not isinstance(business_settings, ResearchBusinessSettings):
            raise ValueError("explicit typed business settings required")
    expected = resolve_runtime_paths(paths.database, paths.evidence_root.parent)
    if paths != expected:
        raise ValueError('runtime paths must use the common private root')
    config = import_module('rabbit_hole.config') if 'rabbit_hole.config' in sys.modules else None
    sql = _research_imports()
    config = config or import_module('rabbit_hole.config')
    settings = config.OfflineRuntimeSettings(database=paths.database, evidence_root=paths.evidence_root,
                                            browser_root=paths.browser_root, lock_root=paths.lock_root)
    if offline_commands and allow_external:
        raise PermissionError('offline commands cannot enable external capabilities')
    if allow_external:
        from services.research_activation import validate_activation
        if not allow_commands or not validate_activation(paths):
            raise ValueError('external execution requires validated activation')
    if allow_commands and not allow_external:
        import tempfile
        from services.research_activation import validate_activation
        if offline_commands:
            if not all(path.is_relative_to(Path(tempfile.gettempdir()).resolve()) for path in (paths.database, paths.evidence_root.parent)):
                raise PermissionError('offline commands require disposable temporary database')
        elif not validate_activation(paths):
            raise PermissionError('research_activation_denied')
    if not paths.database.is_file():
        if allow_commands:
            raise ValueError('research database is not prepared')
        yield ResearchRuntime(None, None, None, settings, paths, ('database_missing',))
        return
    engine = sql.create_engine(str(URL.create('sqlite+aiosqlite', database='file:' + str(paths.database),
                                             query={'mode': 'ro', 'uri': 'true'})), readonly=True,
                               lock_root=paths.lock_root)
    try:
        prepared = await _prepared(engine)
        namespace = _namespace(paths) if prepared else None
        if namespace is not None:
            settings = settings.model_copy(update=namespace)
        if not allow_commands:
            readonly_store = import_module('rabbit_hole.persistence.projects').WorkbenchStore(engine) if prepared else None
            yield ResearchRuntime(engine, readonly_store, None, settings, paths,
                                  (('evidence_namespace_missing',) if namespace is None else ()) if prepared else ('schema_unprepared',))
            return
        if not prepared:
            raise ValueError('research database is not prepared')
        if namespace is None:
            raise ValueError('existing evidence namespace configuration is required')
    finally:
        await engine.dispose()
    for directory in (paths.evidence_root, paths.keys_root, paths.browser_root, paths.lock_root):
        if not directory.is_dir():
            raise ValueError('private runtime directories must be prepared explicitly')
    key = paths.keys_root / 'evidence-signing.key'
    _validate_path(key, private=True)
    if not key.is_file() or key.stat().st_size != 32:
        raise ValueError('existing evidence signing material is required')
    if allow_commands and not offline_commands:
        from services.research_activation import claim_activation
        claim_activation(paths)
    client = import_module('rabbit_hole.persistence.local_objects').LocalObjectClient(
        paths.evidence_root, initialize=False, signing_key_path=key)
    engine = sql.create_engine(str(URL.create('sqlite+aiosqlite', database=str(paths.database))),
                               initialize_file=False, lock_root=paths.lock_root)
    engine.update_execution_options(research_ownership_paths=paths, research_offline_commands=offline_commands)
    ai = None
    try:
        store = import_module('rabbit_hole.persistence.projects').WorkbenchStore(engine)
        evidence = import_module('rabbit_hole.persistence.evidence_store').EvidenceStore(
            client, bucket=namespace['evidence_bucket'], collector_version=namespace['collector_version'])
        async with engine.connect() as connection:
            revision = (await connection.exec_driver_sql('SELECT revision FROM full_merge_schema WHERE id=1')).scalar_one()
        integrations = None
        services = {}
        settings_store = None
        if revision >= 2:
            from services.integration_settings_service import IntegrationSettingsService
            from services.research_integrations import (
                ResearchSync,
                assemble_non_ai_integrations,
            )
            settings_store = IntegrationSettingsService(paths.database)
            integrations = assemble_non_ai_integrations(settings_store, allow_external=allow_external)
            services = {'provider_settings': integrations.providers,
                        'translator': integrations.translator,
                        'sync': ResearchSync(store, settings_store, allow_external=allow_external)}
            from rabbit_hole.integrations.project_direction import generate_direction
            from sqlalchemy import create_engine
            from sqlalchemy.orm import sessionmaker

            from services.research_ai_adapter import (
                ResearchAIAdapter,
                ResearchAISettings,
            )
            ai_engine = create_engine(URL.create('sqlite', database='file:' + str(paths.database),
                                                 query={'mode':'ro','uri':'true'}))
            ai_sessions = sessionmaker(bind=ai_engine)
            from types import SimpleNamespace
            usage_runtime = SimpleNamespace(engine=engine, store=store) if revision >= 3 else None
            ai = ResearchAIAdapter(session_factory=ai_sessions, allow_external=allow_external, usage_runtime=usage_runtime)
            async def direction(title, market):
                return await generate_direction(title, market, ai_adapter=ai)
            services.update(ai_settings=ResearchAISettings(ai_sessions), generate_direction=direction)
        if allow_external:
            from services.research_activation import external_services
            services.update(external_services(paths, integrations, business_settings))
        yield ResearchRuntime(engine, store, evidence, settings, paths,
                              settings_store=settings_store, non_ai_integrations=integrations, commands_enabled=True,
                              workbench_services=services, business_settings=business_settings, ai_adapter=ai,
                              worker_readiness=(("business_settings_missing",) if business_settings is None else ())
                              + (("integration_schema_unprepared",) if revision < 2 else ())
                              + (("ai_usage_schema_unprepared",) if revision < 3 else ()))
    finally:
        if ai is not None:
            ai_engine.dispose()
        await engine.dispose()
