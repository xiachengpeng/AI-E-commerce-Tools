import os
import time
import pytest
from services.storage_cleanup_service import cleanup_expired_static_files, STATIC_DIR


def test_cleanup_expired_static_files():
    outputs_dir = os.path.join(STATIC_DIR, "outputs", "test_ttl")
    os.makedirs(outputs_dir, exist_ok=True)

    # 1. Old file (2 days old)
    old_file = os.path.join(outputs_dir, "old_bundle.zip")
    with open(old_file, "wb") as f:
        f.write(b"old zip contents" * 100)
    two_days_ago = time.time() - (86400 * 2)
    os.utime(old_file, (two_days_ago, two_days_ago))

    # 2. New file (just created)
    new_file = os.path.join(outputs_dir, "new_bundle.zip")
    with open(new_file, "wb") as f:
        f.write(b"new zip contents")

    try:
        deleted_count, freed_bytes = cleanup_expired_static_files(max_age_seconds=86400)

        assert deleted_count >= 1
        assert freed_bytes > 0
        assert not os.path.exists(old_file)
        assert os.path.exists(new_file)
    finally:
        # Cleanup test fixture
        if os.path.exists(old_file):
            os.remove(old_file)
        if os.path.exists(new_file):
            os.remove(new_file)
        if os.path.exists(outputs_dir):
            try:
                os.rmdir(outputs_dir)
            except OSError:
                pass
