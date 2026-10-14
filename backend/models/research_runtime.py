"""Explicit paths and lifecycle result for the dormant research subsystem."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class RuntimePaths:
    database: Path
    evidence_root: Path
    keys_root: Path
    browser_root: Path
    lock_root: Path


@dataclass(frozen=True)
class ResearchRuntime:
    engine: Any
    store: Any
    evidence_store: Any
    settings: Any
    paths: RuntimePaths
    diagnostics: tuple[str, ...] = ()
    settings_store: Any = None
    non_ai_integrations: Any = None
    workbench_services: dict[str, Any] = field(default_factory=dict)
    business_settings: Any = None
    ai_adapter: Any = None
    worker_readiness: tuple[str, ...] = ()
    commands_enabled: bool = False
