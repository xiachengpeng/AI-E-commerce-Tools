"""Copy every local immutable version and original signing bytes, never re-key."""
import hashlib
import json
import os
import shutil
from pathlib import Path

from scripts.full_merge.import_data import _digest, _safe


def _file(root, relative):
    raw = Path(relative)
    if raw.is_absolute() or '..' in raw.parts or not raw.parts:
        raise ValueError('object path escape')
    path = _safe(root / raw)
    if not path.is_file():
        raise ValueError('missing object')
    return path


def inventory_objects(source: Path) -> dict:
    source = _safe(source)
    files = []
    versions = 0
    indexed_bodies = set()
    for path in sorted(source.rglob('*')):
        _safe(path)
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('nonregular object')
        relative = path.relative_to(source).as_posix()
        files.append({'path':relative, 'sha256':_digest(path), 'bytes':path.stat().st_size})
        if path.name != 'index.json':
            continue
        index = json.loads(path.read_bytes())
        key = index['Key']
        if not isinstance(key,str) or not key or path.parent.name != hashlib.sha256(key.encode()).hexdigest():
            raise ValueError('object key mismatch')
        seen = set()
        for version in index['versions']:
            vid = version['VersionId']
            if not isinstance(vid,str) or not vid or vid in seen or type(version['DeleteMarker']) is not bool:
                raise ValueError('invalid object version')
            seen.add(vid)
            versions += 1
            if version['DeleteMarker']:
                continue
            body = path.parent / hashlib.sha256(vid.encode()).hexdigest() / 'body'
            _file(source, body.relative_to(source))
            if _digest(body) != version['sha256'] or body.stat().st_size != version['Size']:
                raise ValueError('object version hash mismatch')
            indexed_bodies.add(body)
    if {p for p in source.rglob('body')} != indexed_bodies:
        raise ValueError('unindexed object version')
    return {'files':files, 'versions':versions, 'hash':hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()}


def copy_objects(source: Path, staging: Path, manifest: dict) -> dict:
    source, staging = _safe(source), _safe(staging)
    if source == staging or staging.is_relative_to(source) or source.is_relative_to(staging):
        raise ValueError('separate object staging required')
    # Full validation and capacity precede destination creation, including manifest traversal.
    seen = set()
    for entry in manifest['files']:
        path = _file(source, entry['path'])
        if path in seen or _digest(path) != entry['sha256'] or path.stat().st_size != entry['bytes']:
            raise ValueError('object manifest mismatch')
        seen.add(path)
    actual = inventory_objects(source)
    if actual != manifest:
        raise ValueError('object roster mismatch')
    ancestor = staging.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    needed = sum(e['bytes'] for e in actual['files'] if not (staging / e['path']).exists())
    if shutil.disk_usage(ancestor).free < needed + 4096:
        raise OSError('insufficient object staging space')
    if staging.exists():
        if not staging.is_dir() or staging.stat().st_mode & 0o077:
            raise ValueError('private object staging required')
        for entry in actual['files']:
            target = _safe(staging / entry['path'])
            if target.exists() and (not target.is_file() or _digest(target) != entry['sha256']):
                raise ValueError('staging object conflict')
        allowed = {e['path'] for e in actual['files']}
        if any(p.is_file() and p.relative_to(staging).as_posix() not in allowed for p in staging.rglob('*')):
            raise ValueError('staging roster conflict')
    staging.mkdir(parents=True, exist_ok=True, mode=0o700)
    for entry in actual['files']:
        target = _safe(staging / entry['path'])
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream, _file(source, entry['path']).open('rb') as original:
            try:
                shutil.copyfileobj(original, stream)
                stream.flush()
                os.fsync(stream.fileno())
            except BaseException:
                target.unlink(missing_ok=True)
                raise
        if _digest(target) != entry['sha256']:
            target.unlink()
            raise ValueError('copied object hash mismatch')
    if inventory_objects(staging) != actual:
        raise ValueError('object staging verification failed')
    return {'verified':True, 'mismatches':[], 'objects':len(actual['files']), 'versions':actual['versions'], 'hash':actual['hash']}
