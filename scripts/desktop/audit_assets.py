"""Read-only desktop asset inventory. Never downloads, restores, or cleans files."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from services.asset_reference_service import collect_asset_references


def checked_root(path: Path) -> Path:
    path = Path(path).absolute()
    if path.is_symlink():
        raise ValueError('audit_symlink_root')
    path = path.resolve()
    if not path.is_dir():
        raise ValueError('audit_root_unavailable')
    return path


def plain_file(path: Path) -> bool:
    return path.is_file() and not any(p.is_symlink() for p in (path, *path.parents))


def image_valid(path: Path) -> bool:
    from PIL import Image
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except (OSError, ValueError, Image.DecompressionBombError):
        return False


def audit_assets(data_dir: Path, *, backup_roots=()) -> dict:
    root = checked_root(data_dir)
    static = checked_root(root / 'static')
    database = root / 'history.db'
    if not plain_file(database):
        raise ValueError('audit_database_unavailable')
    backups = [checked_root(p) for p in backup_roots]
    index = collect_asset_references(database, asset_root=static)
    rows = []
    for path in sorted(index.protected_paths):
        relative = path.relative_to(static)
        exists = plain_file(path)
        candidates = []
        if not exists:
            for number, backup in enumerate(backups):
                candidate = backup / relative
                if not plain_file(candidate):
                    continue
                candidates.append({'backup_index': number,
                    'sha256': hashlib.sha256(candidate.read_bytes()).hexdigest(),
                    'bytes': candidate.stat().st_size, 'media_valid': image_valid(candidate)})
        rows.append({'path': relative.as_posix(), 'status': 'present' if exists else 'missing',
            'recovered': False, 'candidates': candidates,
            'candidate_conflict': len({c['sha256'] for c in candidates}) > 1})
    return {'schema_version': 1, 'read_only': True,
        'index_complete': index.complete, 'diagnostic_codes': list(index.unresolved),
        'referenced_count': len(rows), 'missing_count': sum(r['status']=='missing' for r in rows),
        'backup_roots_checked': len(backups), 'assets': rows,
        'protected_directory_count': len(index.protected_directories),
        'recovery_requires_verified_identity': True}


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--backup-root', type=Path, action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    args=parser.parse_args()
    try:
        output=args.output.absolute()
        # Inventory paths are private diagnostics, never public static content.
        parent=checked_root(output.parent)
        data=checked_root(args.data_dir)
        if parent == data/'static' or (data/'static') in parent.parents or parent.stat().st_mode & 0o077:
            raise ValueError('audit_output_not_private')
        report=audit_assets(data, backup_roots=args.backup_root)
        fd=os.open(output, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd,'w') as handle:
            json.dump(report,handle,ensure_ascii=False,indent=2)
        print(json.dumps({key:report[key] for key in ['read_only','index_complete','referenced_count','missing_count']}))
        return 0
    except (OSError, ValueError):
        print('未生成报告：请核对数据根、私有输出目录及文件是否已存在。未恢复或清理任何素材。',file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
