"""Customer content audit; print file identities only, never detected secret values."""
from pathlib import Path
import argparse
import json
import re
import subprocess
import sys

SECRET = re.compile(rb'(?:sk-[A-Za-z0-9_-]{24,}|AIza[0-9A-Za-z_-]{30,}|apify_api_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{60,})')
PRIVATE_PATH = re.compile(rb'(?:/Users/[^/\s"\x27]+/|xcp@192\.168\.)')
TEXT = {'.py', '.js', '.mjs', '.cjs', '.html', '.css', '.json', '.yaml', '.yml', '.txt'}


def audit_content(root: Path) -> list[str]:
    problems = []
    for path in root.rglob('*'):
        if not path.is_file() or path.suffix not in TEXT or path.stat().st_size > 8 * 1024 * 1024:
            continue
        value = path.read_bytes()
        relative = path.relative_to(root).as_posix()
        if SECRET.search(value): problems.append('embedded-secret:' + relative)
        if PRIVATE_PATH.search(value): problems.append('developer-path:' + relative)
    return problems


def audit_python_archive(resources: Path) -> list[str]:
    """Inspect first-party frozen code constants as well as loose resources."""
    from PyInstaller.archive.readers import CArchiveReader
    import types
    problems = []
    archive = CArchiveReader(str(resources / 'backend/ai-ecommerce-backend'))
    pyz = archive.open_embedded_archive('PYZ.pyz')
    def inspect(code, name):
        if isinstance(code, types.CodeType):
            for value in code.co_consts: inspect(value, name)
        elif isinstance(code, str):
            value=code.encode()
            if SECRET.search(value): problems.append('embedded-secret:python:' + name)
            if PRIVATE_PATH.search(value): problems.append('developer-path:python:' + name)
    for name in pyz.toc:
        if name in {'main', 'db', 'run', 'frontend_server'} or name.startswith(('services.', 'routes.', 'models.', 'rabbit_hole.')):
            inspect(pyz.extract(name), name)
    # desktop_entry is the top-level executable script, not an import in PYZ.
    import marshal
    inspect(marshal.loads(archive.extract('desktop_entry')), 'desktop_entry')
    return sorted(set(problems))


def verify(resources, *, official=False):
    from verify_bundle import validate
    issues = validate(resources) + audit_content(resources / 'frontend')
    release = json.loads((resources / 'release.json').read_text())
    if release.get('channel') != 'customer' or release.get('schema') != 1:
        issues.append('invalid-release-metadata')
    issues += audit_python_archive(resources)
    app = resources.parent.parent
    sign = subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], capture_output=True)
    if sign.returncode: issues.append('signature-invalid')
    if official:
        identity = subprocess.run(['codesign', '-dv', '--verbose=4', str(app)], capture_output=True, text=True)
        if 'Authority=Developer ID Application:' not in identity.stderr: issues.append('official-signature-missing')
        notarized = subprocess.run(['xcrun', 'stapler', 'validate', str(app)], capture_output=True)
        if notarized.returncode: issues.append('notarization-missing')
        accepted = subprocess.run(['spctl', '-a', '-t', 'exec', str(app)], capture_output=True)
        if accepted.returncode: issues.append('gatekeeper-not-accepted')
    return issues


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('resources',type=Path);parser.add_argument('--official',action='store_true')
    args=parser.parse_args()
    issues=verify(args.resources,official=args.official)
    print(json.dumps({'passed':not issues,'official_gate':args.official,'issues':issues},ensure_ascii=False))
    raise SystemExit(bool(issues))
