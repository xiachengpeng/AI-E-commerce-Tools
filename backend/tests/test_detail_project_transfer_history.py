"""Portable detail snapshots use the existing history path, never task execution."""
import base64
import io
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

import main


def test_imported_detail_copy_persists_media_and_provenance_independently(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STATIC_DIR", str(tmp_path))
    image = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(image, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
    facts = {"material": {"value": "glass", "source": "ai", "verified": False}}
    metadata = {
        "kind": "detail-page-project", "version": 2,
        "transferProjectId": "a-copy-id", "channel": "shopify", "layoutStyle": "bento",
        "typography": {"fontFamily": "inter", "titleSize": "28px"},
        "verifiedFacts": facts, "rawProductFacts": "source text",
        "uploadedImages": [{"id": "asset_safe", "base64": data_url}],
        "modules": [{"id": "section_safe", "moduleId": "m10", "imageSrc": data_url,
                     "includeText": False, "status": "success", "dtcCopy": None,
                     "seo": {"titleTarget": "Cup"}}],
        "longImageOrder": ["section_safe"], "config": {"language": "English"},
    }
    client = TestClient(main.app)
    first = client.post("/api/history/render", json={"name": "imported copy", "metadata": metadata, "image": data_url})
    second = client.post("/api/history/render", json={"name": "another copy", "metadata": metadata, "image": data_url})
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] != second.json()["id"]
    # A new client/request gets a fresh DB session, with no in-memory editor state.
    restored = TestClient(main.app).get(f'/api/history/render/{first.json()["id"]}')
    assert restored.status_code == 200
    row = restored.json()
    saved = row["metadata_info"]
    assert saved["verifiedFacts"] == facts
    assert saved["modules"][0]["includeText"] is False
    assert saved["modules"][0]["moduleId"] == "m10"
    assert saved["typography"] == metadata["typography"]
    assert saved["longImageOrder"] == ["section_safe"]
    for url in (row["image_base64"], saved["uploadedImages"][0]["base64"], saved["modules"][0]["imageSrc"]):
        assert url.startswith("/static/outputs/")
        candidate = tmp_path / url.removeprefix("/static/")
        assert candidate.is_file()
        with Image.open(candidate) as decoded:
            decoded.load()
            assert decoded.size == (2, 2)
    # Second import cannot replace files referenced by the first snapshot.
    assert client.get(f'/api/history/render/{second.json()["id"]}').status_code == 200
