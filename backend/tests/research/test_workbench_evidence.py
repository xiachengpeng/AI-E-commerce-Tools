import io
import json
from hashlib import sha256

import pytest


def test_screenshot_read_is_version_bound_and_hash_checked():
    from rabbit_hole.domain.evidence import read_screenshot

    raw = b"\x89PNG\r\n\x1a\nfixture"
    object_id = "evidence/US/action/date/" + sha256(raw).hexdigest()
    manifest = {
        "object_id": object_id,
        "state": "committed",
        "raw_deleted": False,
        "raw_version_id": "v1",
        "sha256": sha256(raw).hexdigest(),
        "content_type": "image/png",
    }

    class Client:
        def get_object(self, **kwargs):
            if kwargs["Key"].startswith("evidence-manifests/"):
                return {"Body": io.BytesIO(json.dumps(manifest).encode())}
            assert kwargs["VersionId"] == "v1"
            return {"Body": io.BytesIO(raw)}

    assert read_screenshot(Client(), "bucket", object_id) == raw
    manifest["sha256"] = "wrong"
    with pytest.raises(ValueError):
        read_screenshot(Client(), "bucket", object_id)
