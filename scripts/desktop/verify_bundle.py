"""Fail packaging if known private/build-only state or symlink escapes leaked."""
from pathlib import Path
import argparse
import json
import os


def validate(root: Path) -> list[str]:
    problems = []
    forbidden = {'.env', '.env.local', 'history.db', 'research.json', 'activation.key',
                 'evidence-signing.key', 'activation.json', 'service-account.json'}
    for p in root.rglob('*'):
        if p.name in forbidden or p.suffix in {'.db', '.sqlite', '.sqlite3'} or p.name.endswith(('.db-wal', '.db-shm')):
            problems.append('private-state:' + p.relative_to(root).as_posix())
        if p.is_symlink() and not p.resolve().is_relative_to(root.resolve()):
            problems.append('escaping-symlink:' + p.relative_to(root).as_posix())
    inventory = root / 'browser-inventory.json'
    try:
        entries = json.loads(inventory.read_text())
        if set(entries) != {'chromium', 'chromium-headless-shell', 'ffmpeg'}:
            raise ValueError('incomplete browser inventory')
        for name, relative in entries.items():
            executable = root / relative
            if not executable.resolve().is_relative_to(root.resolve()) or not executable.is_file() or not os.access(executable, os.X_OK):
                problems.append('missing-browser:' + name)
    except (OSError, ValueError, TypeError):
        problems.append('missing-browser:inventory')
    for name in ['backend/ai-ecommerce-backend', 'frontend/index.html', 'frontend/dist/output.css',
                 'frontend/js/research-workbench/index.mjs', 'frontend/assets/phosphor/regular/style.css']:
        if not (root / name).is_file():
            problems.append('missing-resource:' + name)
    return problems


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('resources', type=Path)
    args = parser.parse_args()
    issues = validate(args.resources)
    for issue in issues:
        print(issue)
    raise SystemExit(1 if issues else 0)
