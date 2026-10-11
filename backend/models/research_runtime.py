"""Explicit paths and lifecycle result for the dormant research subsystem."""
from dataclasses import dataclass
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
