from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import uuid4

import boto3
import pytest

from rabbit_hole.persistence.evidence_store import EvidenceStore
from rabbit_hole.persistence.local_objects import ObjectError
from botocore.exceptions import ClientError


def test_distinct_microsecond_observations_have_distinct_immutable_keys(minio_store):
    client, bucket = minio_store
    store = EvidenceStore(client, bucket=bucket, collector_version="test-v1")
    collected = datetime(2026, 9, 4, microsecond=1, tzinfo=UTC)
    kwargs = {
        "market": "US",
        "record_id": "precision",
        "raw": b"same screenshot",
        "source_url": "https://shop.example/a",
        "content_type": "image/png",
    }
    first = store.put(collected_at=collected, **kwargs)
    second = store.put(collected_at=collected + timedelta(microseconds=1), **kwargs)
    assert first.object_id != second.object_id
    assert (
        store.structured_evidence(first.object_id)["collected_at"]
        == collected.isoformat()
    )
    assert (
        store.structured_evidence(second.object_id)["collected_at"]
        == (collected + timedelta(microseconds=1)).isoformat()
    )


@pytest.fixture
def minio_store(tmp_path):
    if os.getenv('RABBIT_HOLE_TEST_FILES') == '1':
        from rabbit_hole.persistence.local_objects import LocalObjectClient
        yield LocalObjectClient(tmp_path / 'evidence'), 'private'
        return
    endpoint = os.getenv("RABBIT_HOLE_TEST_MINIO_ENDPOINT")
    if endpoint is None:
        pytest.fail(
            "set RABBIT_HOLE_TEST_MINIO_ENDPOINT to run real MinIO integration tests"
        )
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["RABBIT_HOLE_TEST_MINIO_ACCESS_KEY"],
        aws_secret_access_key=os.environ["RABBIT_HOLE_TEST_MINIO_SECRET_KEY"],
        region_name="us-east-1",
    )
    bucket = f"rabbit-hole-task7-{uuid4().hex}"
    client.create_bucket(Bucket=bucket)
    client.put_bucket_versioning(
        Bucket=bucket, VersioningConfiguration={"Status": "Enabled"}
    )
    assert client.get_bucket_versioning(Bucket=bucket)["Status"] == "Enabled"
    try:
        yield client, bucket
    finally:
        while True:
            listed = client.list_object_versions(Bucket=bucket)
            objects = [
                {"Key": item["Key"], "VersionId": item["VersionId"]}
                for section in ("Versions", "DeleteMarkers")
                for item in listed.get(section, [])
            ]
            if not objects:
                break
            client.delete_objects(Bucket=bucket, Delete={"Objects": objects})
        client.delete_bucket(Bucket=bucket)


def test_minio_put_restart_purge_pagination_and_partial_delete(minio_store) -> None:
    client, bucket = minio_store
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    store = EvidenceStore(
        client, bucket=bucket, collector_version="landing-v1", list_page_size=1
    )
    old = store.put(
        market="US",
        record_id="old",
        collected_at=collected,
        raw=b"old",
        source_url="https://shop.example/old",
        content_type="text/html",
    )
    active = store.put(
        market="US",
        record_id="active",
        collected_at=collected + timedelta(days=2),
        raw=b"active",
        source_url="https://shop.example/active",
        content_type="text/html",
    )
    head = client.head_object(Bucket=bucket, Key=old.object_id)
    assert head["Metadata"]["sha256"] == old.sha256
    assert head["Metadata"]["retention-date"] == "2026-06-30T00:00:00+00:00"
    assert (
        head["Metadata"]["operation-token"]
        == store.structured_evidence(old.object_id)["operation_token"]
    )
    signed = EvidenceStore(
        client, bucket=bucket, collector_version="landing-v1"
    ).signed_read_link(active.object_id)
    if os.getenv("RABBIT_HOLE_TEST_FILES") == "1":
        from urllib.parse import parse_qs, urlsplit
        assert client.read_signed(parse_qs(urlsplit(signed).query)["token"][0])[0] == b"active"
    else:
        assert "Signature=" in signed and "Expires=" in signed
    restarted = EvidenceStore(
        client, bucket=bucket, collector_version="landing-v1", list_page_size=1
    )
    assert restarted.purge_expired(collected + timedelta(days=179), dry_run=False) == []
    assert restarted.purge_expired(collected + timedelta(days=181), dry_run=True) == [
        old.object_id
    ]

    class FailOnce:
        def __init__(self) -> None:
            self.failed = False

        def __getattr__(self, name: str):
            return getattr(client, name)

        def delete_object(self, **kwargs):
            if not self.failed:
                self.failed = True
                raise OSError("temporary delete failure")
            return client.delete_object(**kwargs)

    flaky = EvidenceStore(
        FailOnce(), bucket=bucket, collector_version="landing-v1", list_page_size=1
    )
    assert flaky.purge_expired(collected + timedelta(days=181), dry_run=False) == []
    assert restarted.purge_expired(collected + timedelta(days=181), dry_run=False) == [
        old.object_id
    ]
    assert restarted.structured_evidence(old.object_id)["raw_deleted"] is True


def test_minio_restart_repairs_stale_raw_after_commit_manifest_failure(
    minio_store, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, bucket = minio_store
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    monkeypatch.setattr(EvidenceStore, "pending_lease", timedelta(seconds=-1))

    class FailCommitManifest:
        def __init__(self) -> None:
            self.manifest_writes = 0

        def __getattr__(self, name: str):
            return getattr(client, name)

        def put_object(self, **kwargs):
            if str(kwargs["Key"]).startswith(EvidenceStore.manifest_prefix):
                self.manifest_writes += 1
                if self.manifest_writes == 2:
                    raise OSError("commit manifest failed")
            return client.put_object(**kwargs)

    broken = EvidenceStore(
        FailCommitManifest(), bucket=bucket, collector_version="landing-v1"
    )
    with pytest.raises(OSError, match="commit manifest failed"):
        broken.put(
            market="US",
            record_id="orphan",
            collected_at=collected,
            raw=b"orphan raw",
            source_url="https://shop.example/orphan",
            content_type="text/html",
        )

    page = client.list_objects_v2(Bucket=bucket, Prefix="evidence/US/")
    raw_key = page["Contents"][0]["Key"]
    restarted = EvidenceStore(client, bucket=bucket, collector_version="landing-v1")
    assert restarted.repair_pending() == [raw_key]
    with pytest.raises((ClientError, ObjectError)) as missing:
        client.head_object(Bucket=bucket, Key=raw_key)
    assert missing.value.response["ResponseMetadata"]["HTTPStatusCode"] == 404
    record = restarted.structured_evidence(raw_key)
    assert record["state"] == "aborted"
    assert record["raw_deleted"] is True
    assert record["sha256"] == raw_key.rsplit("/", 1)[-1]


def test_minio_repair_losing_if_match_race_preserves_committed_raw(
    minio_store, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, bucket = minio_store
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    monkeypatch.setattr(EvidenceStore, "pending_lease", timedelta(seconds=-1))

    class FailWriterCommit:
        def __init__(self) -> None:
            self.manifest_writes = 0

        def __getattr__(self, name: str):
            return getattr(client, name)

        def put_object(self, **kwargs):
            if str(kwargs["Key"]).startswith(EvidenceStore.manifest_prefix):
                self.manifest_writes += 1
                if self.manifest_writes == 2:
                    raise OSError("leave pending for repair race")
            return client.put_object(**kwargs)

    interrupted = EvidenceStore(
        FailWriterCommit(), bucket=bucket, collector_version="landing-v1"
    )
    with pytest.raises(OSError, match="leave pending"):
        interrupted.put(
            market="US",
            record_id="repair-cas-race",
            collected_at=collected,
            raw=b"committable raw",
            source_url="https://shop.example/repair-cas-race",
            content_type="text/html",
        )

    raw_key = client.list_objects_v2(Bucket=bucket, Prefix="evidence/US/")["Contents"][
        0
    ]["Key"]
    manifest_key = EvidenceStore.manifest_key(raw_key)
    pending_response = client.get_object(Bucket=bucket, Key=manifest_key)
    pending = json.loads(pending_response["Body"].read())

    class WriterWinsRepairCas:
        triggered = False

        def __getattr__(self, name: str):
            return getattr(client, name)

        def put_object(self, **kwargs):
            if (
                not self.triggered
                and kwargs["Key"] == manifest_key
                and "IfMatch" in kwargs
            ):
                self.triggered = True
                committed = {**pending, "state": "committed"}
                client.put_object(
                    Bucket=bucket,
                    Key=manifest_key,
                    Body=json.dumps(
                        committed, sort_keys=True, separators=(",", ":")
                    ).encode(),
                    ContentType="application/json",
                    ACL="private",
                    Metadata={
                        "sha256": committed["sha256"],
                        "raw-object-id": raw_key,
                    },
                    IfMatch=kwargs["IfMatch"],
                )
            return client.put_object(**kwargs)

    racing_client = WriterWinsRepairCas()
    restarted = EvidenceStore(
        racing_client, bucket=bucket, collector_version="landing-v1"
    )

    assert restarted.repair_pending() == []
    assert racing_client.triggered is True
    assert restarted.structured_evidence(raw_key)["state"] == "committed"
    assert client.head_object(Bucket=bucket, Key=raw_key)["ContentLength"] == len(
        b"committable raw"
    )


def test_minio_retry_is_idempotent_and_forged_manifest_cannot_delete_unrelated_key(
    minio_store,
) -> None:
    client, bucket = minio_store
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    store = EvidenceStore(client, bucket=bucket, collector_version="landing-v1")
    saved = store.put(
        market="US",
        record_id="same",
        collected_at=collected,
        raw=b"same raw",
        source_url="https://shop.example/same",
        content_type="text/html",
    )
    assert (
        store.put(
            market="US",
            record_id="same",
            collected_at=collected,
            raw=b"same raw",
            source_url="https://shop.example/same",
            content_type="text/html",
        )
        == saved
    )

    unrelated_key = "unrelated/private-object"
    client.put_object(Bucket=bucket, Key=unrelated_key, Body=b"keep")
    client.put_object(
        Bucket=bucket,
        Key=EvidenceStore.manifest_key(unrelated_key),
        Body=json.dumps(
            {
                "object_id": unrelated_key,
                "sha256": "0" * 64,
                "state": "pending",
                "raw_deleted": False,
                "retention_date": "2026-01-01T00:00:00+00:00",
            }
        ).encode(),
    )
    restarted = EvidenceStore(client, bucket=bucket, collector_version="landing-v1")
    assert restarted.repair_pending() == []
    assert (
        restarted.purge_expired(datetime(2026, 1, 2, tzinfo=UTC), dry_run=False) == []
    )
    assert client.get_object(Bucket=bucket, Key=unrelated_key)["Body"].read() == b"keep"


def test_minio_versioned_repair_deletes_only_owned_same_body_version(
    minio_store,
) -> None:
    client, bucket = minio_store
    collected = datetime(2026, 1, 1, tzinfo=UTC)
    store = EvidenceStore(client, bucket=bucket, collector_version="landing-v1")
    saved = store.put(
        market="US",
        record_id="same-body-replacement",
        collected_at=collected,
        raw=b"same body",
        source_url="https://shop.example/same-body-replacement",
        content_type="text/html",
    )
    manifest_key = EvidenceStore.manifest_key(saved.object_id)
    manifest_head = client.head_object(Bucket=bucket, Key=manifest_key)
    manifest = store.structured_evidence(saved.object_id)
    owned_version = manifest["raw_version_id"]
    aborted = {
        **manifest,
        "state": "aborted",
        "raw_deleted": False,
        "needs_cleanup": True,
    }
    client.put_object(
        Bucket=bucket,
        Key=manifest_key,
        Body=json.dumps(aborted, sort_keys=True, separators=(",", ":")).encode(),
        ContentType="application/json",
        ACL="private",
        Metadata={"sha256": saved.sha256, "raw-object-id": saved.object_id},
        IfMatch=manifest_head["ETag"],
    )
    replacement_token = "f" * 32
    replacement = client.put_object(
        Bucket=bucket,
        Key=saved.object_id,
        Body=b"same body",
        ContentType="text/html",
        ACL="private",
        Metadata={
            "sha256": saved.sha256,
            "operation-token": replacement_token,
        },
    )

    assert store.repair_pending() == [saved.object_id]
    current = client.head_object(Bucket=bucket, Key=saved.object_id)
    assert current["VersionId"] == replacement["VersionId"]
    assert current["Metadata"]["operation-token"] == replacement_token
    with pytest.raises((ClientError, ObjectError)) as missing:
        client.head_object(Bucket=bucket, Key=saved.object_id, VersionId=owned_version)
    assert missing.value.response["ResponseMetadata"]["HTTPStatusCode"] == 404


def test_minio_aborted_manifest_eventually_removes_late_raw_version(
    minio_store, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, bucket = minio_store
    monkeypatch.setattr(EvidenceStore, "pending_lease", timedelta(seconds=-1))
    collected = datetime.now(UTC).replace(microsecond=0)
    raw = b"late versioned raw"
    digest = sha256(raw).hexdigest()
    object_id = f"evidence/US/late-version/{collected:%Y%m%dT%H%M%SZ}/{digest}"
    operation_token = "a" * 32
    pending = {
        "object_id": object_id,
        "sha256": digest,
        "source_url": "https://shop.example/late-version",
        "content_type": "text/html",
        "collected_at": collected.isoformat(),
        "retention_date": (collected + timedelta(days=180)).isoformat(),
        "collector_version": "landing-v1",
        "trust": "verified",
        "raw_deleted": False,
        "state": "pending",
        "operation_token": operation_token,
        "created_at": collected.isoformat(),
        "lease_until": (collected + EvidenceStore.pending_lease).isoformat(),
    }
    manifest_key = EvidenceStore.manifest_key(object_id)
    client.put_object(
        Bucket=bucket,
        Key=manifest_key,
        Body=json.dumps(pending).encode(),
        ContentType="application/json",
        ACL="private",
        Metadata={"sha256": digest, "raw-object-id": object_id},
    )
    store = EvidenceStore(client, bucket=bucket, collector_version="landing-v1")
    assert store.repair_pending() == [object_id]
    assert store.structured_evidence(object_id)["raw_deleted"] is True

    late = client.put_object(
        Bucket=bucket,
        Key=object_id,
        Body=raw,
        ContentType="text/html",
        ACL="private",
        Metadata={
            "sha256": digest,
            "operation-token": operation_token,
        },
    )
    assert store.repair_pending() == [object_id]
    with pytest.raises((ClientError, ObjectError)) as missing:
        client.head_object(Bucket=bucket, Key=object_id, VersionId=late["VersionId"])
    assert missing.value.response["ResponseMetadata"]["HTTPStatusCode"] == 404
    repaired = store.structured_evidence(object_id)
    assert repaired["state"] == "aborted"
    assert repaired["raw_deleted"] is True
