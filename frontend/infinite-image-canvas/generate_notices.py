"""Generate notices for actual Rollup modules. Pass CANVAS_AUDIT_MODULES output."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
fallback = {
    '@ant-design/icons-svg': 'ant-design-icons-svg.txt',
    'is-mobile': 'is-mobile.txt',
    'react-remove-scroll-bar': 'react-remove-scroll-bar.txt',
}
packages = {}
for module in json.loads(Path(sys.argv[1]).read_text()):
    if '/node_modules/' not in module or '\0' in module:
        continue
    for directory in Path(module.split('?')[0]).resolve().parents:
        metadata = directory / 'package.json'
        if metadata.is_file():
            info = json.loads(metadata.read_text())
            if info.get('name') and info.get('version'):
                packages[(info['name'], info['version'])] = (directory, info)
                break

sections = ['Third-party notices for the bundled image canvas.\nPackage licenses are copied from the installed dependencies; the three exceptions are preserved from their upstream repositories in ../licenses/.\n']
for (name, version), (directory, info) in sorted(packages.items()):
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.name.lower().startswith(('license', 'licence', 'copying', 'notice')))
    if not files and name in fallback:
        files = [root / 'licenses' / fallback[name]]
    if not files:
        raise SystemExit(f'Missing license text: {name}@{version}')
    sections.append(f'\n===== {name}@{version} ({info.get("license", "see text")}) =====\n')
    for file in files:
        sections.append(f'\n--- {file.name} ---\n{file.read_text(errors="replace")}\n')
output = root / 'web/public/THIRD_PARTY_NOTICES.txt'
output.write_text(''.join(sections))
print(f'{len(packages)} bundled packages; notices written to {output}')
