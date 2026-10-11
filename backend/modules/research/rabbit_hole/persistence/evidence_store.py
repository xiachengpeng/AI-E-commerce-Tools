"""Private immutable storage for raw collector evidence."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from hashlib import sha256
from typing import Any, Protocol
from uuid import uuid4

from rabbit_hole.domain.legacy import EvidenceTrust

logger = logging.getLogger(__name__)
_OBJECT_TIMESTAMP = re.compile(r"^\d{8}T\d{6}(?:\.\d{6})?Z$", re.ASCII)


def _utc_now() -> datetime:
    """Return the current UTC time (private seam for deterministic tests)."""
    return datetime.now(UTC)


class EvidenceConflict(RuntimeError):
    """A deterministic evidence key is already owned by different state/data."""


class S3Client(Protocol):
    def put_object(self, **kwargs: Any) -> Any: ...
    def delete_object(self, **kwargs: Any) -> Any: ...
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def get_bucket_versioning(self, *, Bucket: str) -> dict[str, Any]: ...
    def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]: ...
    def generate_presigned_url(
        self, operation: str, *, Params: dict[str, str], ExpiresIn: int
    ) -> str: ...


@dataclass(frozen=True, slots=True)
class StoredEvidence:
    object_id: str
    sha256: str
    collected_at: datetime
    retention_date: datetime
    trust: EvidenceTrust = EvidenceTrust.VERIFIED


@dataclass(frozen=True, slots=True)
class _ManifestSnapshot:
    record: dict[str, Any]
    etag: str


class EvidenceStore:
    """Private raw storage backed by durable S3 manifest objects."""

    retention_days = 180
    manifest_prefix = "evidence-manifests/"
    pending_lease = timedelta(minutes=5)
    legacy_pending_grace = timedelta(hours=24)

    def __init__(
        self,
        client: S3Client,
        *,
        bucket: str,
        collector_version: str,
        list_page_size: int | None = None,
    ) -> None:
        self._client = client
        self._bucket = bucket
        self._collector_version = collector_version
        self._list_page_size = list_page_size
        self._require_enabled_versioning()

    @classmethod
    def manifest_key(cls, object_id: str) -> str:
        return f"{cls.manifest_prefix}{object_id}.json"

    def put(
        self,
        *,
        market: str,
        record_id: str,
        collected_at: datetime,
        raw: bytes,
        source_url: str,
        content_type: str,
        trust: EvidenceTrust = EvidenceTrust.VERIFIED,
    ) -> StoredEvidence:
        self._validate_path_segment(market, "market")
        self._validate_path_segment(record_id, "record_id")
        if collected_at.tzinfo is None or collected_at.utcoffset() is None:
            raise ValueError("collected_at must be timezone-aware")
        collected_at = collected_at.astimezone(UTC)
        digest = sha256(raw).hexdigest()
        object_id = (
            f"evidence/{market}/{record_id}/{collected_at:%Y%m%dT%H%M%S.%fZ}/{digest}"
        )
        retention_date = collected_at + timedelta(days=self.retention_days)
        operation_token = uuid4().hex
        metadata = {
            "source-url": source_url,
            "content-type": content_type,
            "sha256": digest,
            "collector-version": self._collector_version,
            "retention-date": retention_date.isoformat(),
            "operation-token": operation_token,
        }
        stable_manifest = {
            "object_id": object_id,
            "sha256": digest,
            "source_url": source_url,
            "content_type": content_type,
            "collected_at": collected_at.isoformat(),
            "retention_date": retention_date.isoformat(),
            "collector_version": self._collector_version,
            "trust": trust.value,
        }
        expected_committed = {
            **stable_manifest,
            "raw_deleted": False,
            "state": "committed",
        }
        manifest_key = self.manifest_key(object_id)
        existing = self._try_read_manifest_snapshot(manifest_key)
        if existing is not None:
            if not self._matches_committed_request(
                manifest_key, existing.record, expected_committed
            ):
                raise EvidenceConflict(
                    "evidence manifest conflict: deterministic key has different metadata or state"
                )
            if not self._object_matches(
                object_id,
                digest,
                self._recorded_version_id(existing.record),
            ):
                raise EvidenceConflict(
                    "evidence manifest conflict: committed raw object is missing or has a different hash"
                )
            return StoredEvidence(
                object_id, digest, collected_at, retention_date, trust
            )
        created_at = _utc_now().astimezone(UTC)
        manifest = {
            **stable_manifest,
            "raw_deleted": False,
            "state": "pending",
            "operation_token": operation_token,
            "created_at": created_at.isoformat(),
            "lease_until": (created_at + self.pending_lease).isoformat(),
        }
        # Persist intent before the raw object exists. If either following write
        # fails, a restarted worker can find the pending key and remove any raw
        # object that may have been accepted before the failure was observed.
        pending_etag = self._write_manifest(manifest, create_only=True)
        raw_response = self._client.put_object(
            Bucket=self._bucket,
            Key=object_id,
            Body=raw,
            ContentType=content_type,
            ACL="private",
            Metadata=metadata,
        )
        raw_version_id = self._required_version_id(raw_response)
        committed = {
            **manifest,
            "state": "committed",
            "raw_version_id": raw_version_id,
        }
        try:
            self._write_manifest(committed, if_match=pending_etag)
        except EvidenceConflict as exc:
            latest = self._try_read_manifest_snapshot(manifest_key)
            if (
                latest is not None
                and self._matches_committed_request(
                    manifest_key, latest.record, expected_committed
                )
                and self._object_matches(
                    object_id,
                    digest,
                    self._recorded_version_id(latest.record),
                )
            ):
                return StoredEvidence(
                    object_id, digest, collected_at, retention_date, trust
                )
            if latest is not None:
                self._compensate_failed_commit(latest, operation_token, raw_version_id)
            raise EvidenceConflict(
                "evidence manifest conflict: pending state changed before commit"
            ) from exc
        return StoredEvidence(object_id, digest, collected_at, retention_date, trust)

    def signed_read_link(self, object_id: str) -> str:
        if not object_id.startswith("evidence/"):
            raise ValueError("only raw evidence objects can be signed")
        record = self._read_manifest(self.manifest_key(object_id))
        if (
            not self._valid_manifest_binding(self.manifest_key(object_id), record)
            or record.get("raw_deleted") is not False
            or record.get("state") != "committed"
        ):
            raise ValueError("evidence raw object is unavailable")
        raw_version_id = self._recorded_version_id(record)
        head_request: dict[str, Any] = {
            "Bucket": self._bucket,
            "Key": object_id,
        }
        if raw_version_id is not None:
            head_request["VersionId"] = raw_version_id
        self._client.head_object(**head_request)
        params = {"Bucket": self._bucket, "Key": object_id}
        if raw_version_id is not None:
            params["VersionId"] = raw_version_id
        return self._client.generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=24 * 60 * 60,
        )

    def structured_evidence(self, object_id: str) -> dict[str, Any]:
        return self._read_manifest(self.manifest_key(object_id))

    def purge_expired(self, now: datetime, dry_run: bool) -> list[str]:
        now = now.astimezone(UTC)
        deleted: list[str] = []
        if not dry_run:
            deleted.extend(self.repair_pending())
        for manifest_key in self._manifest_keys():
            snapshot = self._read_deletable_manifest(manifest_key)
            if snapshot is None or snapshot.record.get("state") != "committed":
                continue
            record = snapshot.record
            retention_date = self._parse_aware_datetime(
                record["retention_date"]
            ).astimezone(UTC)
            if bool(record["raw_deleted"]) or retention_date > now:
                continue
            object_id = str(record["object_id"])
            if dry_run:
                deleted.append(object_id)
                continue
            raw_version_id = self._recorded_version_id(record)
            if raw_version_id is None or not self._delete_raw_version(
                object_id, raw_version_id
            ):
                continue
            record["raw_deleted"] = True
            try:
                self._write_manifest(record, if_match=snapshot.etag)
            except EvidenceConflict:
                self._read_deletable_manifest(manifest_key)
            deleted.append(object_id)
        return deleted

    def repair_pending(self) -> list[str]:
        """Remove possible raw objects left by an interrupted two-phase put."""
        repaired: list[str] = []
        for manifest_key in self._manifest_keys():
            snapshot = self._read_deletable_manifest(manifest_key)
            if snapshot is None:
                continue
            record = snapshot.record
            state = record.get("state")
            if state not in {"pending", "aborted"}:
                continue
            if state == "pending":
                minimum_age = (
                    self.pending_lease
                    if "lease_until" in record
                    else self.legacy_pending_grace
                )
                try:
                    stale = self._manifest_age_at_least(manifest_key, minimum_age)
                except Exception:  # noqa: BLE001,S112 -- transient HEAD stays retryable
                    continue
                if not stale:
                    continue
                aborted = {
                    **record,
                    "state": "aborted",
                    "raw_deleted": False,
                    "needs_cleanup": True,
                }
                try:
                    aborted_etag = self._write_manifest(aborted, if_match=snapshot.etag)
                except EvidenceConflict:
                    self._read_deletable_manifest(manifest_key)
                    continue
                snapshot = _ManifestSnapshot(aborted, aborted_etag)
            if self._reconcile_aborted(snapshot):
                repaired.append(str(snapshot.record["object_id"]))
        return repaired

    def _reconcile_aborted(
        self,
        snapshot: _ManifestSnapshot,
        *,
        preferred_version_id: str | None = None,
    ) -> bool:
        record = snapshot.record
        if record.get("state") != "aborted":
            return False
        object_id = str(record["object_id"])
        version_id = preferred_version_id
        if version_id is None and record.get("raw_deleted") is False:
            version_id = self._recorded_version_id(record)
        try:
            raw_head = self._try_head_object(object_id, version_id=version_id)
        except Exception:  # noqa: BLE001 -- leave the aborted manifest retryable
            return False
        if raw_head is None:
            if (
                record.get("raw_deleted") is True
                and record.get("needs_cleanup") is not True
            ):
                return False
            cleaned = {**record, "raw_deleted": True, "needs_cleanup": False}
            try:
                self._write_manifest(cleaned, if_match=snapshot.etag)
            except EvidenceConflict:
                self._read_deletable_manifest(self.manifest_key(object_id))
                return False
            return True
        if not self._raw_owned_by_manifest(record, raw_head):
            return False
        observed_version_id = raw_head.get("VersionId")
        if not isinstance(observed_version_id, str) or not observed_version_id:
            return False
        cleanup = {
            **record,
            "raw_version_id": observed_version_id,
            "raw_deleted": False,
            "needs_cleanup": True,
        }
        if cleanup != record:
            try:
                cleanup_etag = self._write_manifest(cleanup, if_match=snapshot.etag)
            except EvidenceConflict:
                self._read_deletable_manifest(self.manifest_key(object_id))
                return False
            snapshot = _ManifestSnapshot(cleanup, cleanup_etag)
            record = cleanup
        if not self._delete_raw_version(object_id, observed_version_id):
            return False
        cleaned = {**record, "raw_deleted": True, "needs_cleanup": False}
        try:
            self._write_manifest(cleaned, if_match=snapshot.etag)
        except EvidenceConflict:
            self._read_deletable_manifest(self.manifest_key(object_id))
            return False
        return True

    def _manifest_keys(self) -> list[str]:
        token: str | None = None
        keys: list[str] = []
        while True:
            request: dict[str, Any] = {
                "Bucket": self._bucket,
                "Prefix": self.manifest_prefix,
            }
            if self._list_page_size is not None:
                request["MaxKeys"] = self._list_page_size
            if token is not None:
                request["ContinuationToken"] = token
            page = self._client.list_objects_v2(**request)
            keys.extend(
                str(item["Key"]) for item in page.get("Contents", []) if "Key" in item
            )
            if not page.get("IsTruncated"):
                return keys
            token = page.get("NextContinuationToken")
            if not token:
                raise RuntimeError(
                    "S3 returned truncated manifest page without a continuation token"
                )

    def _read_manifest(self, key: str) -> dict[str, Any]:
        return self._read_manifest_snapshot(key).record

    def _read_manifest_snapshot(self, key: str) -> _ManifestSnapshot:
        response = self._client.get_object(Bucket=self._bucket, Key=key)
        body = response["Body"]
        raw = body.read()
        parsed = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
        if not isinstance(parsed, dict):
            raise TypeError("evidence manifest must be an object")
        etag = response.get("ETag")
        if not isinstance(etag, str) or not etag:
            raise TypeError("evidence manifest response must include an ETag")
        return _ManifestSnapshot(parsed, etag)

    def _try_read_manifest_snapshot(self, key: str) -> _ManifestSnapshot | None:
        try:
            return self._read_manifest_snapshot(key)
        except KeyError:
            return None
        except Exception as exc:
            if self._error_status(exc) == 404:
                return None
            raise

    @classmethod
    def _matches_committed_request(
        cls,
        manifest_key: str,
        record: dict[str, Any],
        expected: dict[str, Any],
    ) -> bool:
        lifecycle_keys = {"operation_token", "created_at", "lease_until"}
        allowed_keys = frozenset(expected) | lifecycle_keys | {"raw_version_id"}
        return (
            frozenset(record).issubset(allowed_keys)
            and all(record.get(key) == value for key, value in expected.items())
            and cls._valid_manifest_binding(manifest_key, record)
        )

    def _object_matches(
        self, key: str, digest: str, version_id: str | None = None
    ) -> bool:
        head = self._try_head_object(key, version_id=version_id)
        if head is None:
            return False
        metadata = head.get("Metadata")
        return isinstance(metadata, dict) and metadata.get("sha256") == digest

    def _try_head_object(
        self, key: str, *, version_id: str | None = None
    ) -> dict[str, Any] | None:
        request: dict[str, Any] = {"Bucket": self._bucket, "Key": key}
        if version_id is not None:
            request["VersionId"] = version_id
        try:
            return self._client.head_object(**request)
        except KeyError:
            return None
        except Exception as exc:
            if self._error_status(exc) == 404:
                return None
            raise

    def _manifest_age_at_least(self, key: str, minimum_age: timedelta) -> bool:
        head = self._try_head_object(key)
        if head is None:
            return False
        last_modified = head.get("LastModified")
        if (
            not isinstance(last_modified, datetime)
            or last_modified.tzinfo is None
            or last_modified.utcoffset() is None
        ):
            return False
        now = self._server_response_date(head)
        if now is None:
            return False
        try:
            stale_at = last_modified.astimezone(UTC) + minimum_age
        except OverflowError:
            return False
        return now >= stale_at

    @staticmethod
    def _raw_owned_by_manifest(record: dict[str, Any], head: dict[str, Any]) -> bool:
        metadata = head.get("Metadata")
        if not isinstance(metadata, dict) or metadata.get("sha256") != record.get(
            "sha256"
        ):
            return False
        operation_token = record.get("operation_token")
        return (
            not isinstance(operation_token, str)
            or metadata.get("operation-token") == operation_token
        )

    def _delete_raw_version(self, object_id: str, version_id: str) -> bool:
        request: dict[str, Any] = {
            "Bucket": self._bucket,
            "Key": object_id,
            "VersionId": version_id,
        }
        try:
            self._client.delete_object(**request)
        except Exception:  # noqa: BLE001 -- callers retain retryable manifest state
            return False
        return True

    def _compensate_failed_commit(
        self,
        snapshot: _ManifestSnapshot,
        operation_token: str,
        raw_version_id: str,
    ) -> None:
        record = snapshot.record
        object_id = record.get("object_id")
        manifest_key = self.manifest_key(str(object_id))
        if (
            not isinstance(object_id, str)
            or not self._valid_manifest_binding(manifest_key, record)
            or record.get("state") != "aborted"
            or record.get("operation_token") != operation_token
        ):
            return
        self._reconcile_aborted(snapshot, preferred_version_id=raw_version_id)

    def _require_enabled_versioning(self) -> None:
        try:
            response = self._client.get_bucket_versioning(Bucket=self._bucket)
        except Exception as exc:
            raise RuntimeError(
                "S3 bucket versioning check failed; versioning must be Enabled"
            ) from exc
        if not isinstance(response, dict) or response.get("Status") != "Enabled":
            raise RuntimeError("S3 bucket versioning must be Enabled")

    @staticmethod
    def _required_version_id(response: object) -> str:
        version_id = response.get("VersionId") if isinstance(response, dict) else None
        if not isinstance(version_id, str) or not version_id or version_id == "null":
            raise RuntimeError(
                "S3 raw put did not return VersionId with bucket versioning Enabled"
            )
        return version_id

    @staticmethod
    def _recorded_version_id(record: dict[str, Any]) -> str | None:
        version_id = record.get("raw_version_id")
        return version_id if isinstance(version_id, str) and version_id else None

    @staticmethod
    def _server_response_date(response: dict[str, Any]) -> datetime | None:
        metadata = response.get("ResponseMetadata")
        if not isinstance(metadata, dict):
            return None
        headers = metadata.get("HTTPHeaders")
        if not isinstance(headers, dict):
            return None
        raw_date = next(
            (
                value
                for name, value in headers.items()
                if isinstance(name, str) and name.lower() == "date"
            ),
            None,
        )
        if not isinstance(raw_date, str):
            return None
        try:
            parsed = parsedate_to_datetime(raw_date)
        except (IndexError, OverflowError, TypeError, ValueError):
            return None
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return None
        return parsed.astimezone(UTC)

    @staticmethod
    def _error_status(exc: Exception) -> int | None:
        response = getattr(exc, "response", None)
        if not isinstance(response, dict):
            return None
        metadata = response.get("ResponseMetadata")
        if not isinstance(metadata, dict):
            return None
        status = metadata.get("HTTPStatusCode")
        return status if isinstance(status, int) else None

    @staticmethod
    def _validate_path_segment(value: str, label: str) -> None:
        if not value or value in {".", ".."} or "/" in value or "\\" in value:
            raise ValueError(f"{label} must be one non-empty object-key segment")

    @staticmethod
    def _parse_aware_datetime(value: object) -> datetime:
        if not isinstance(value, str):
            raise TypeError("manifest timestamp must be a string")
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("manifest timestamp must be timezone-aware")
        parsed.astimezone(UTC)
        return parsed

    @classmethod
    def _valid_manifest_binding(cls, manifest_key: str, record: dict[str, Any]) -> bool:
        object_id = record.get("object_id")
        digest = record.get("sha256")
        if not isinstance(object_id, str) or not isinstance(digest, str):
            return False
        state = record.get("state")
        raw_deleted = record.get("raw_deleted")
        needs_cleanup = record.get("needs_cleanup")
        raw_version_id = record.get("raw_version_id")
        lifecycle_keys = {"operation_token", "created_at", "lease_until"}
        lifecycle_presence = {key in record for key in lifecycle_keys}
        if len(lifecycle_presence) != 1:
            return False
        has_lifecycle = True in lifecycle_presence
        parts = object_id.split("/")
        if len(parts) != 5 or parts[0] != "evidence":
            return False
        try:
            cls._validate_path_segment(parts[1], "market")
            cls._validate_path_segment(parts[2], "record_id")
            timestamp = parts[3]
            if _OBJECT_TIMESTAMP.fullmatch(timestamp) is None:
                return False
            time_format = "%Y%m%dT%H%M%S.%fZ" if "." in timestamp else "%Y%m%dT%H%M%SZ"
            key_collected_at = datetime.strptime(timestamp, time_format).replace(
                tzinfo=UTC
            )
            if key_collected_at.strftime(time_format) != timestamp:
                return False
            collected_at = cls._parse_aware_datetime(record["collected_at"])
            retention = cls._parse_aware_datetime(record["retention_date"])
            collected_utc = collected_at.astimezone(UTC)
            expected_retention = collected_at + timedelta(days=cls.retention_days)
            if has_lifecycle:
                created_at = cls._parse_aware_datetime(record["created_at"])
                lease_until = cls._parse_aware_datetime(record["lease_until"])
                expected_lease = created_at + cls.pending_lease
        except (KeyError, OverflowError, TypeError, ValueError):
            return False
        if (
            collected_utc.strftime(time_format) != timestamp
            or retention != expected_retention
            or (has_lifecycle and lease_until != expected_lease)
        ):
            return False
        return (
            re.fullmatch(r"[0-9a-f]{64}", digest) is not None
            and (
                not has_lifecycle
                or (
                    isinstance(record.get("operation_token"), str)
                    and re.fullmatch(r"[0-9a-f]{32}", record["operation_token"])
                    is not None
                )
            )
            and parts[4] == digest
            and manifest_key == cls.manifest_key(object_id)
            and state in {"pending", "committed", "aborted"}
            and isinstance(raw_deleted, bool)
            and (
                raw_version_id is None
                or (
                    isinstance(raw_version_id, str)
                    and bool(raw_version_id)
                    and raw_version_id != "null"
                )
            )
            and (needs_cleanup is None or isinstance(needs_cleanup, bool))
            and not (needs_cleanup is True and (state != "aborted" or raw_deleted))
        )

    def _read_deletable_manifest(self, key: str) -> _ManifestSnapshot | None:
        try:
            snapshot = self._read_manifest_snapshot(key)
        except (
            json.JSONDecodeError,
            UnicodeDecodeError,
            OverflowError,
            TypeError,
            KeyError,
            ValueError,
        ):
            logger.warning("skipping malformed evidence manifest %s", key)
            return None
        if not self._valid_manifest_binding(key, snapshot.record):
            logger.warning("skipping unbound evidence manifest %s", key)
            return None
        return snapshot

    def _write_manifest(
        self,
        record: dict[str, Any],
        *,
        create_only: bool = False,
        if_match: str | None = None,
    ) -> str:
        if create_only and if_match is not None:
            raise ValueError("manifest write cannot combine create-only and If-Match")
        object_id = str(record["object_id"])
        payload = json.dumps(record, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
        request: dict[str, Any] = {
            "Bucket": self._bucket,
            "Key": self.manifest_key(object_id),
            "Body": payload,
            "ContentType": "application/json",
            "ACL": "private",
            "Metadata": {
                "sha256": str(record["sha256"]),
                "raw-object-id": object_id,
            },
        }
        if create_only:
            request["IfNoneMatch"] = "*"
        if if_match is not None:
            request["IfMatch"] = if_match
        try:
            response = self._client.put_object(**request)
        except Exception as exc:
            if (create_only or if_match is not None) and self._error_status(exc) in {
                409,
                412,
            }:
                raise EvidenceConflict(
                    "evidence manifest conflict: conditional write failed"
                ) from exc
            raise
        etag = response.get("ETag") if isinstance(response, dict) else None
        if isinstance(etag, str) and etag:
            return etag
        snapshot = self._read_manifest_snapshot(self.manifest_key(object_id))
        if snapshot.record != record:
            raise EvidenceConflict(
                "evidence manifest conflict: state changed after conditional write"
            )
        return snapshot.etag
