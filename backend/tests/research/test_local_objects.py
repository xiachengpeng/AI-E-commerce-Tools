"""Local versioned evidence must preserve the existing immutable contract."""
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

def client(tmp_path):
    from rabbit_hole.persistence.local_objects import LocalObjectClient
    return LocalObjectClient(tmp_path / "evidence")

def test_local_versions_and_conditions(tmp_path):
    c = client(tmp_path)
    first = c.put_object(Bucket="private",Key="evidence/test",Body=b"old",Metadata={"sha256":sha256(b"old").hexdigest()})
    second = c.put_object(Bucket="private",Key="evidence/test",Body=b"new",IfMatch=first["ETag"])
    assert first["VersionId"] != second["VersionId"]
    assert c.get_object(Bucket="private",Key="evidence/test",VersionId=first["VersionId"])["Body"].read() == b"old"
    with pytest.raises(Exception) as exc:
        c.put_object(Bucket="private",Key="evidence/test",Body=b"bad",IfMatch=first["ETag"])
    assert exc.value.response["ResponseMetadata"]["HTTPStatusCode"] == 412
    c.delete_object(Bucket="private",Key="evidence/test")
    with pytest.raises(Exception):
        c.get_object(Bucket="private",Key="evidence/test")
    assert c.get_object(Bucket="private",Key="evidence/test",VersionId=second["VersionId"])["Body"].read() == b"new"

def test_local_evidence_contract_restart_and_signed_download(tmp_path):
    from rabbit_hole.persistence.evidence_store import EvidenceStore, EvidenceConflict
    c = client(tmp_path)
    store = EvidenceStore(c,bucket="private",collector_version="test")
    args = dict(market="US",record_id="test",collected_at=datetime.now(UTC),raw=b"body",source_url="https://example.com",content_type="text/plain")
    result = store.put(**args)
    other = EvidenceStore(client(tmp_path),bucket="private",collector_version="test")
    assert other.put(**args).object_id == result.object_id
    with pytest.raises(EvidenceConflict):
        other.put(**{**args,"source_url":"https://example.org"})
    link = store.signed_read_link(result.object_id)
    token = parse_qs(urlsplit(link).query)["token"][0]
    assert c.read_signed(token)[0] == b"body"
    with pytest.raises(ValueError):
        c.read_signed(token+"x")

@pytest.mark.parametrize("key",["../secret","evidence/../../secret","/absolute","a\\b","a//b"])
def test_local_rejects_unsafe_paths(tmp_path,key):
    c = client(tmp_path)
    with pytest.raises(ValueError):
        c.put_object(Bucket="private",Key=key,Body=b"bad")

def test_local_rejects_symlink_root(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "evidence").symlink_to(outside)
    with pytest.raises(ValueError):
        client(tmp_path)

def test_local_detects_tampered_body(tmp_path):
    c = client(tmp_path)
    c.put_object(Bucket="private",Key="evidence/test",Body=b"good")
    body = next((tmp_path / "evidence").rglob("body"))
    body.write_bytes(b"bad")
    with pytest.raises(ValueError,match="integrity"):
        c.get_object(Bucket="private",Key="evidence/test")

def test_local_listing_pagination_and_delete_exact_version(tmp_path):
    c = client(tmp_path)
    for key in ["a","b","c"]:
        c.put_object(Bucket="private",Key=key,Body=b"one")
    p = c.list_objects_v2(Bucket="private",Prefix="",MaxKeys=2)
    assert p["IsTruncated"]
    assert len(p["Contents"]) == 2
    p2=c.list_objects_v2(Bucket="private",ContinuationToken=p["NextContinuationToken"])
    assert len(p2["Contents"]) == 1
    v=c.put_object(Bucket="private",Key="a",Body=b"two")["VersionId"]
    c.delete_object(Bucket="private",Key="a",VersionId=v)
    assert c.get_object(Bucket="private",Key="a")["Body"].read() == b"one"

async def test_local_signed_http_gateway_and_expiry(tmp_path, monkeypatch):
    import httpx
    from rabbit_hole.runtime.server import create_app
    from rabbit_hole.persistence import local_objects
    c = client(tmp_path)
    version = c.put_object(Bucket="private", Key="evidence/test", Body=b"private", ContentType="text/plain")["VersionId"]
    app = create_app(checks={})
    app.state.workbench_storage_client = c
    link = c.generate_presigned_url("get_object", Params={"Bucket":"private", "Key":"evidence/test", "VersionId":version}, ExpiresIn=60)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as http:
        response = await http.get(link)
        assert response.status_code == 200 and response.content == b"private"
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert (await http.get(link+"tampered")).status_code == 404
        monkeypatch.setattr(local_objects.time, "time", lambda: 999999999999)
        assert (await http.get(link)).status_code == 404
        assert (await http.get("/workbench/api/evidence-file?token=../../private")).status_code == 404
