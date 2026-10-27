"""Writable roots must be independent of read-only installation resources."""
import importlib
from pathlib import Path


def test_default_static_root_preserves_browser_runtime(monkeypatch):
    monkeypatch.delenv('AI_ECOMMERCE_DATA_DIR', raising=False)
    paths = importlib.import_module('services.runtime_paths')
    assert paths.static_root() == Path(paths.__file__).resolve().parents[1] / 'static'


def test_desktop_static_root_does_not_create_or_write_directories(monkeypatch, tmp_path):
    root = tmp_path / '用户 数据'
    monkeypatch.setenv('AI_ECOMMERCE_DATA_DIR', str(root))
    paths = importlib.import_module('services.runtime_paths')
    assert paths.static_root() == root / 'static'
    assert not root.exists()


def test_relative_writable_root_fails_closed(monkeypatch):
    import pytest
    monkeypatch.setenv('AI_ECOMMERCE_DATA_DIR', '../data')
    paths = importlib.import_module('services.runtime_paths')
    with pytest.raises(ValueError):
        paths.static_root()
