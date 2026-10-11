"""Local screenshot delivery without exposing S3 credentials or signed URLs."""

from __future__ import annotations

import json
from hashlib import sha256
from typing import Any


def read_screenshot(client: Any, bucket: str, object_id: str) -> bytes:
    if not object_id.startswith("evidence/US/") or ".." in object_id:
        raise ValueError("invalid evidence reference")
    stream = client.get_object(
        Bucket=bucket, Key=f"evidence-manifests/{object_id}.json"
    )["Body"]
    try:
        manifest = json.loads(stream.read(100_001))
    finally:
        stream.close()
    if (
        not isinstance(manifest, dict)
        or manifest.get("object_id") != object_id
        or manifest.get("state") != "committed"
        or manifest.get("raw_deleted") is not False
        or manifest.get("content_type") != "image/png"
        or not manifest.get("raw_version_id")
    ):
        raise ValueError("evidence unavailable")
    stream = client.get_object(
        Bucket=bucket, Key=object_id, VersionId=manifest["raw_version_id"]
    )["Body"]
    try:
        raw = stream.read(5_000_001)
    finally:
        stream.close()
    if (
        not isinstance(raw, bytes)
        or len(raw) > 5_000_000
        or not raw.startswith(b"\x89PNG\r\n\x1a\n")
        or sha256(raw).hexdigest() != manifest["sha256"]
    ):
        raise ValueError("evidence integrity failure")
    return raw
