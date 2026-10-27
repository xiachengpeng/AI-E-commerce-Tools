"""Restore a verified snapshot into a NEW private drill directory, never install it."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import sys

if __name__ == '__main__':
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from scripts.full_merge.verify import verify_snapshot


def canonical(path: Path) -> Path:
    path=Path(path).absolute()
    if path.is_symlink():
        raise ValueError('recovery_symlink_path')
    # Resolve the macOS /var alias, then reject user-created nested aliases.
    if any(p.is_symlink() for p in path.parents if str(p) != '/var'):
        raise ValueError('recovery_symlink_parent')
    return path.resolve()


def verify_recovery(snapshot: Path, destination: Path, *, expected_digest: str) -> dict:
    """The caller must supply the manifest anchor kept outside the snapshot."""
    source,target=map(canonical,(snapshot,destination))
    if source==target or source in target.parents or target in source.parents:
        raise ValueError('recovery_paths_overlap')
    if target.exists():
        raise FileExistsError('recovery_destination_exists')
    if not target.parent.is_dir():
        raise ValueError('recovery_parent_missing')
    if (not isinstance(expected_digest,str) or len(expected_digest)!=64
            or any(c not in '0123456789abcdef' for c in expected_digest)):
        raise ValueError('recovery_anchor_invalid')
    # Reject all symlinks, even inside the snapshot, before copying key material.
    if any(p.is_symlink() for p in source.rglob('*')):
        raise ValueError('recovery_snapshot_symlink')
    result=verify_snapshot(source,expected_digest=expected_digest)
    if not result['verified'] or not result['completeness_verified']:
        raise ValueError('recovery_snapshot_unverified')
    manifest=json.loads((source/'manifest.json').read_text())
    target.mkdir(mode=0o700,exist_ok=False)
    # Failures retain the clearly unverified partial drill for diagnosis; never
    # delete, overwrite, or try to activate the destination on a later attempt.
    for category in ('databases','objects','keys'):
        for entry in manifest[category]:
            relative=Path(entry['path']);original=source/relative
            copied=target/relative
            copied.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with original.open('rb') as src:
                fd=os.open(copied,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
                with os.fdopen(fd,'wb') as dst:
                    shutil.copyfileobj(src,dst)
                    dst.flush();os.fsync(dst.fileno())
    fd=os.open(target/'manifest.json',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as handle:
        handle.write((source/'manifest.json').read_bytes());handle.flush();os.fsync(handle.fileno())
    copied_result=verify_snapshot(target,expected_digest=expected_digest)
    source_result=verify_snapshot(source,expected_digest=expected_digest)
    if not copied_result['verified'] or not source_result['verified']:
        raise ValueError('recovery_copy_unverified')
    report={'schema_version':1,'verified':True,'execution_allowed':False,
        'manifest_sha256':expected_digest,'databases':copied_result['databases'],
        'objects':copied_result['objects'],'keys':copied_result['keys'],
        'signature_material':'preserved_bytes_not_reactivated',
        'installation_performed':False}
    with (target/'recovery-report.json').open('x') as handle:
        os.chmod(target/'recovery-report.json',0o600)
        json.dump(report,handle,indent=2)
    return report


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--destination',type=Path,required=True)
    parser.add_argument('--expected-digest',required=True)
    args=parser.parse_args()
    try:
        report=verify_recovery(args.snapshot,args.destination,expected_digest=args.expected_digest)
        print(json.dumps(report));return 0
    except (ValueError,OSError):
        print('恢复演练未通过：请核对外部清单摘要、快照与全新目标目录。没有覆盖或激活现有数据。',file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
