"""Tests for storage_cleanup_service safe deletion and cascade cleanup."""

import os
from unittest.mock import MagicMock
import pytest

from services.storage_cleanup_service import (
    STATIC_DIR,
    cleanup_history_associated_files,
    safe_delete_static_file,
)


def test_safe_delete_static_file_success(tmp_path):
    # Create test output file in backend/static/outputs
    test_dir = os.path.join(STATIC_DIR, "outputs", "test_gc")
    os.makedirs(test_dir, exist_ok=True)
    test_file = os.path.join(test_dir, "sample.jpg")
    with open(test_file, "wb") as f:
        f.write(b"fake image data")

    assert os.path.isfile(test_file)
    static_url = "/static/outputs/test_gc/sample.jpg"

    # Execute safe delete
    res = safe_delete_static_file(static_url)
    assert res is True
    assert not os.path.exists(test_file)


def test_safe_delete_rejects_path_traversal():
    # Attempt directory traversal outside STATIC_DIR
    assert safe_delete_static_file("/static/../../README.md") is False
    assert safe_delete_static_file("../backend/config.py") is False


def test_safe_delete_rejects_unauthorized_subdirs():
    # Only outputs and uploads can be cleaned up
    assert safe_delete_static_file("/static/css/style.css") is False
    assert safe_delete_static_file("/static/js/app.js") is False


def test_safe_delete_ignores_base64_and_invalid():
    assert safe_delete_static_file(None) is False
    assert safe_delete_static_file("") is False
    assert safe_delete_static_file("data:image/png;base64,1234") is False


def test_cleanup_history_associated_files_render():
    test_dir = os.path.join(STATIC_DIR, "outputs", "test_gc_render")
    os.makedirs(test_dir, exist_ok=True)
    file1 = os.path.join(test_dir, "img1.jpg")
    file2 = os.path.join(test_dir, "img2.jpg")
    with open(file1, "wb") as f:
        f.write(b"f1")
    with open(file2, "wb") as f:
        f.write(b"f2")

    mock_record = MagicMock()
    mock_record.image_base64 = "/static/outputs/test_gc_render/img1.jpg"
    mock_record.metadata_info = {
        "finalImage": "/static/outputs/test_gc_render/img2.jpg",
        "modules": [{"imageSrc": "data:image/png;base64,..."}],
    }

    deleted = cleanup_history_associated_files("render", [mock_record])
    assert deleted == 2
    assert not os.path.exists(file1)
    assert not os.path.exists(file2)
