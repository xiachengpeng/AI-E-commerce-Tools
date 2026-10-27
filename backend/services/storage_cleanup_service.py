"""Safe static file garbage collection and history cascade deletion service."""

import logging
import os
import time
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

from services.runtime_paths import static_root

STATIC_DIR = str(static_root())
ALLOWED_CLEANUP_SUBDIRS = ("outputs", "uploads")


def safe_delete_static_file(static_url_or_path: str | None) -> bool:
    """
    Safely delete a physical file under `backend/static/outputs` or `backend/static/uploads`.
    Prevents path traversal and never deletes outside authorized directories.
    """
    if not static_url_or_path or not isinstance(static_url_or_path, str):
        return False

    val = static_url_or_path.strip()
    if not val or val.startswith("data:image"):
        return False

    # Extract relative path if prefixed with /static/ or http(s)://.../static/
    if "/static/" in val:
        rel_path = val.split("/static/", 1)[1]
    elif val.startswith("static/"):
        rel_path = val.replace("static/", "", 1)
    elif not val.startswith("/") and not val.startswith("http"):
        rel_path = val
    else:
        return False

    # Normalize and verify absolute path
    norm_rel = os.path.normpath(rel_path).lstrip(os.sep)
    abs_path = os.path.abspath(os.path.join(STATIC_DIR, norm_rel))

    # Security check: must reside strictly within STATIC_DIR
    if not abs_path.startswith(STATIC_DIR + os.sep):
        logger.warning("拒绝删除静态目录外文件: %s", abs_path)
        return False

    # Security check: must reside within authorized subdirectories (outputs or uploads)
    is_in_allowed_subdir = any(
        abs_path.startswith(os.path.abspath(os.path.join(STATIC_DIR, subdir)) + os.sep)
        or abs_path == os.path.abspath(os.path.join(STATIC_DIR, subdir))
        for subdir in ALLOWED_CLEANUP_SUBDIRS
    )
    if not is_in_allowed_subdir:
        logger.warning("拒绝删除非 outputs/uploads 目录的静态文件: %s", abs_path)
        return False

    try:
        from services.asset_reference_service import asset_reference_lock, collect_asset_references, current_database
        path = Path(abs_path)
        if any(part.is_symlink() for part in (path, *path.parents)):
            return False
        database = current_database()
        with asset_reference_lock(database, exclusive=True):
            index = collect_asset_references(database, asset_root=Path(STATIC_DIR))
            if not index.complete or index.protects(path):
                return False
            if path.is_file():
                path.unlink()
                return True
    except (OSError, ValueError):
        logger.warning("asset_cleanup_skipped_unverified")

    return False


def _extract_static_urls_from_dict(data: Any, found_urls: set[str]) -> None:
    if not data:
        return
    if isinstance(data, str):
        if "/static/" in data and not data.startswith("data:"):
            found_urls.add(data)
        return
    if isinstance(data, list):
        for elem in data:
            _extract_static_urls_from_dict(elem, found_urls)
        return
    if isinstance(data, dict):
        for key, val in data.items():
            _extract_static_urls_from_dict(val, found_urls)


def history_asset_urls(module: str, items: Iterable[Any]) -> set[str]:
    """
    Extract candidate asset URLs before deleting records.
    Actual deletion runs only after commit and reference revalidation.
    """
    urls_to_delete: set[str] = set()

    for item in items:
        if not item:
            continue

        if module == "render":
            img = getattr(item, "image_base64", None)
            if img and "/static/" in str(img):
                urls_to_delete.add(str(img))
            metadata = getattr(item, "metadata_info", None)
            _extract_static_urls_from_dict(metadata, urls_to_delete)

        elif module == "square-redraw":
            result = getattr(item, "result", None)
            _extract_static_urls_from_dict(result, urls_to_delete)

        elif module == "translation":
            res = getattr(item, "result", None)
            _extract_static_urls_from_dict(res, urls_to_delete)

        elif module == "ads":
            img = getattr(item, "image_url", None)
            if img and "/static/" in str(img):
                urls_to_delete.add(str(img))

        elif module == "watermark-removal":
            res = getattr(item, "result", None)
            _extract_static_urls_from_dict(res, urls_to_delete)

    return urls_to_delete


def cleanup_history_associated_files(module: str, items: Iterable[Any]) -> int:
    return sum(safe_delete_static_file(url) for url in history_asset_urls(module, items))


def cleanup_expired_static_files(max_age_seconds: int = 86400) -> tuple[int, int]:
    """Remove only expired, verified-unreferenced files. Uncertainty retains data."""
    from services.asset_reference_service import asset_reference_lock, collect_asset_references, current_database
    now = time.time()
    removed = freed = 0
    root = Path(STATIC_DIR).absolute()
    database = current_database()
    try:
        with asset_reference_lock(database, exclusive=True):
            index = collect_asset_references(database, asset_root=root)
            if not index.complete:
                logger.warning('asset_ttl_skipped_reference_index_incomplete')
                return 0, 0
            for subdir in ALLOWED_CLEANUP_SUBDIRS:
                folder = root / subdir
                if folder.is_symlink() or not folder.is_dir(): continue
                for parent, directories, files in os.walk(folder, followlinks=False):
                    directories[:] = [d for d in directories if not (Path(parent)/d).is_symlink()]
                    for name in files:
                        candidate = Path(parent)/name
                        if any(p.is_symlink() for p in (candidate,*candidate.parents)) or not candidate.is_relative_to(root): continue
                        try:
                            info = candidate.stat()
                            if now-info.st_mtime <= max_age_seconds or index.protects(candidate): continue
                            # Recheck committed refs immediately before removing a
                            # candidate; compliant app writers share this lock.
                            latest = collect_asset_references(database, asset_root=root)
                            if not latest.complete: return removed, freed
                            if latest.protects(candidate): continue
                            candidate.unlink();removed += 1;freed += info.st_size
                        except OSError:
                            logger.warning('asset_ttl_file_skipped')
    except (OSError, ValueError):
        logger.warning('asset_ttl_skipped_unverified')
    return removed, freed
