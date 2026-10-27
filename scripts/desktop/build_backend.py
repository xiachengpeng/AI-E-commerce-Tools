"""Build only runtime code/assets; never copy a developer database or secrets."""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def copy_runtime(source: Path, target: Path) -> None:
    shutil.copytree(source, target, symlinks=True)


def stage_frontend(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=False)
    source = ROOT / 'frontend'
    for folder in ('css', 'js', 'assets'):
        shutil.copytree(source / folder, target / folder)
    (target / 'dist').mkdir()
    shutil.copy2(source / 'dist/output.css', target / 'dist/output.css')
    icons = ROOT / 'desktop/node_modules/@phosphor-icons/web/src'
    shutil.copytree(icons, target / 'assets/phosphor')
    shutil.copy2(icons.parent / 'LICENSE', target / 'assets/phosphor/LICENSE')
    html = (source / 'index.html').read_text()
    html = html.replace('https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/', 'assets/phosphor/')
    (target / 'index.html').write_text(html)


def build() -> None:
    resources = ROOT / 'desktop/resources'
    if resources.exists():
        raise SystemExit('Resources already exist; choose a new build workspace instead of overwriting them')
    resources.mkdir()
    stage_frontend(resources / 'frontend')
    work = ROOT / 'desktop/.build'
    work.mkdir(exist_ok=True)
    backend = ROOT / 'backend'
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'ai-ecommerce-backend',
               '--distpath', str(work / 'dist'), '--workpath', str(work / 'work'), '--specpath', str(work),
               '--paths', str(backend), '--paths', str(ROOT), '--paths', str(backend / 'modules/research'),
               '--hidden-import', 'main', '--hidden-import', 'run', '--hidden-import', 'frontend_server',
               '--hidden-import', 'aiosqlite',
               '--collect-submodules', 'services', '--collect-submodules', 'routes', '--collect-submodules', 'models',
               '--collect-submodules', 'rabbit_hole', '--collect-all', 'playwright',
               '--collect-submodules', 'uvicorn', '--collect-submodules', 'sqlalchemy.dialects.sqlite',
               '--collect-data', 'certifi', '--exclude-module', 'pytest', '--exclude-module', 'tkinter',
               '--add-data', str(backend / 'modules/research/rabbit_hole/data') + ':rabbit_hole/data',
               str(backend / 'desktop_entry.py')]
    subprocess.run(command, check=True, cwd=ROOT)
    copy_runtime(work / 'dist/ai-ecommerce-backend', resources / 'backend')
    import playwright
    inventory = json.loads((Path(playwright.__file__).parent / 'driver/package/browsers.json').read_text())
    cache = Path.home() / 'Library/Caches/ms-playwright'
    browsers = resources / 'browsers'
    browsers.mkdir()
    browser_files = {}
    for entry in inventory['browsers']:
        if entry['name'] not in {'chromium', 'chromium-headless-shell', 'ffmpeg'}:
            continue
        folder = entry['name'].replace('-', '_') + '-' + entry['revision']
        source = cache / folder
        if not source.is_dir():
            raise SystemExit(f'Missing matching build browser: {folder}')
        shutil.copytree(source, browsers / folder, symlinks=True)
        suffix = {
            'chromium': 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            'chromium-headless-shell': 'chrome-headless-shell-mac-arm64/chrome-headless-shell',
            'ffmpeg': 'ffmpeg-mac',
        }[entry['name']]
        browser_files[entry['name']] = 'browsers/' + folder + '/' + suffix
    (resources / 'browser-inventory.json').write_text(json.dumps(browser_files, indent=2))
    print('Backend and frontend staged; run verify_bundle.py before packaging')


if __name__ == '__main__':
    build()
