"""Safe static file garbage collection and history cascade deletion service."""

import logging
import os
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

STATIC_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
)
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
        if os.path.isfile(abs_path):
            os.remove(abs_path)
            logger.info("已安全清理磁盘静态文件: %s", abs_path)
            return True
    except OSError as exc:
        logger.error("删除静态文件失败 %s: %s", abs_path, exc)

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


def cleanup_history_associated_files(module: str, items: Iterable[Any]) -> int:
    """
    Extract and safely delete all static disk assets associated with given history records.
    Returns the total count of deleted files.
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

    deleted_count = 0
    for url in urls_to_delete:
        if safe_delete_static_file(url):
            deleted_count += 1

    return deleted_count
