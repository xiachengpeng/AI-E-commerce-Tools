"""Private, atomic, versioned files implementing the collector object protocol."""
from __future__ import annotations

import base64
import fcntl
import hmac
import io
import json
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from email.utils import format_datetime
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4


class ObjectError(RuntimeError):
    def __init__(self, status: int):
        super().__init__("private_object_unavailable")
        self.response = {"ResponseMetadata":{"HTTPStatusCode":status}, "Error":{"Code":"NoSuchKey" if status == 404 else "PreconditionFailed"}}


class LocalObjectClient:
    """No public mount or S3 process; stable keys and immutable version records."""
    def __init__(self, root: Path | str):
        self.root = Path(root).absolute()
        self._directory(self.root)
        with self._lock():
            secret = self.root / ".signing-key"
            if not secret.exists():
                self._atomic(secret, os.urandom(32))
            self._secret = self._read(secret)

    def _check(self, path: Path) -> None:
        # Check every existing ancestor, not only the final resolved path.
        for item in (path, *path.parents):
            if item.is_symlink():
                raise ValueError("symlink storage paths are forbidden")

    def _directory(self, path: Path) -> None:
        self._check(path)
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        if not path.is_dir():
            raise ValueError("invalid storage directory")
        os.chmod(path,0o700)

    def _read(self, path: Path) -> bytes:
        self._check(path)
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as file:
            return file.read()

    def _atomic(self, path: Path, body: bytes) -> None:
        self._directory(path.parent)
        self._check(path)
        tmp = path.parent / ("."+uuid4().hex+".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,0o600)
        try:
            with os.fdopen(fd,"wb") as file:
                file.write(body)
                file.flush()
                os.fsync(file.fileno())
            os.replace(tmp,path)
            parent = os.open(path.parent,os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            tmp.unlink(missing_ok=True)

    @contextmanager
    def _lock(self) -> Iterator[None]:
        self._check(self.root)
        fd = os.open(self.root / ".store.lock",os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd,fcntl.LOCK_UN)
            os.close(fd)

    @staticmethod
    def _valid(value: str) -> None:
        if not isinstance(value,str) or not value or "\\" in value or any(s in {"",".",".."} for s in value.split("/")):
            raise ValueError("invalid object key")

    def _object_dir(self,bucket: str,key: str) -> Path:
        self._valid(bucket)
        if "/" in bucket:
            raise ValueError("invalid bucket")
        self._valid(key)
        return self.root / bucket / sha256(key.encode()).hexdigest()

    def _index(self,bucket: str,key: str) -> tuple[Path,dict[str,Any]]:
        directory = self._object_dir(bucket,key)
        index_path = directory / "index.json"
        if not index_path.exists():
            self._check(index_path)
            return directory, {"Key":key,"versions":[]}
        index = json.loads(self._read(index_path))
        if index.get("Key") != key:
            raise ValueError("object key integrity failure")
        return directory,index

    def _save(self,directory: Path,index: dict[str,Any]) -> None:
        self._atomic(directory / "index.json",json.dumps(index,sort_keys=True).encode())

    @staticmethod
    def _headers() -> dict[str,Any]:
        return {"HTTPStatusCode":200,"HTTPHeaders":{"date":format_datetime(datetime.now(UTC),usegmt=True)}}

    def put_object(self, **request: Any) -> dict[str,Any]:
        bucket,key = request["Bucket"],request["Key"]
        raw = request["Body"]
        if hasattr(raw,"read"):
            raw=raw.read()
        if not isinstance(raw,bytes):
            raise TypeError("object body must be bytes")
        digest = sha256(raw).hexdigest()
        with self._lock():
            directory,index=self._index(bucket,key)
            current=index["versions"][0] if index["versions"] else None
            if request.get("IfNoneMatch") == "*" and current and not current["DeleteMarker"]:
                raise ObjectError(412)
            if request.get("IfMatch") is not None and (not current or current["DeleteMarker"] or current["ETag"] != request["IfMatch"]):
                raise ObjectError(412)
            version=uuid4().hex
            item={"VersionId":version,"DeleteMarker":False,"ETag":'"'+digest+'"',"sha256":digest,
                  "LastModified":datetime.now(UTC).isoformat(),"Metadata":dict(request.get("Metadata",{})),
                  "ContentType":request.get("ContentType","application/octet-stream"),"Size":len(raw)}
            self._atomic(directory / sha256(version.encode()).hexdigest() / "body",raw)
            index["versions"].insert(0,item)
            self._save(directory,index)
            return {"VersionId":version,"ETag":item["ETag"],"ResponseMetadata":self._headers()}

    def _version(self,request: dict[str,Any]) -> tuple[Path,dict[str,Any]]:
        directory,index=self._index(request["Bucket"],request["Key"])
        vid=request.get("VersionId")
        versions=index["versions"]
        version=next((v for v in versions if v["VersionId"] == vid),None) if vid else (versions[0] if versions else None)
        if version is None or version["DeleteMarker"]:
            raise ObjectError(404)
        return directory,version

    def get_object(self, **request: Any) -> dict[str,Any]:
        with self._lock():
            directory,version=self._version(request)
            raw=self._read(directory / sha256(version["VersionId"].encode()).hexdigest() / "body")
            if sha256(raw).hexdigest() != version["sha256"]:
                raise ValueError("object integrity failure")
            return {**version,"LastModified":datetime.fromisoformat(version["LastModified"]),
                    "Body":io.BytesIO(raw),"ContentLength":len(raw),"ResponseMetadata":self._headers()}

    def head_object(self, **request: Any) -> dict[str,Any]:
        response=self.get_object(**request)
        response.pop("Body").close()
        return response

    def delete_object(self, **request: Any) -> dict[str,Any]:
        with self._lock():
            directory,index=self._index(request["Bucket"],request["Key"])
            vid=request.get("VersionId")
            if vid is not None:
                matches=[v for v in index["versions"] if v["VersionId"] == vid]
                index["versions"]=[v for v in index["versions"] if v["VersionId"] != vid]
                self._save(directory,index)
                if matches and not matches[0]["DeleteMarker"]:
                    body=directory / sha256(vid.encode()).hexdigest() / "body"
                    self._check(body)
                    body.unlink(missing_ok=True)
                return {"VersionId":vid}
            marker={"VersionId":uuid4().hex,"DeleteMarker":True,"LastModified":datetime.now(UTC).isoformat()}
            index["versions"].insert(0,marker)
            self._save(directory,index)
            return marker

    def list_objects_v2(self, **request: Any) -> dict[str,Any]:
        self._valid(request["Bucket"])
        with self._lock():
            directory=self.root / request["Bucket"]
            self._check(directory)
            items=[]
            for file in directory.glob("*/index.json"):
                index=json.loads(self._read(file))
                versions=index["versions"]
                if versions and not versions[0]["DeleteMarker"] and index["Key"].startswith(request.get("Prefix","")):
                    items.append({"Key":index["Key"],"Size":versions[0]["Size"]})
            items.sort(key=lambda x:x["Key"])
            start=int(request.get("ContinuationToken",0))
            limit=int(request.get("MaxKeys",1000))
            if start < 0 or limit < 1:
                raise ValueError("invalid pagination")
            page=items[start:start+limit]
            more=start+limit<len(items)
            return {"Contents":page,"IsTruncated":more,**({"NextContinuationToken":str(start+limit)} if more else {})}

    def get_bucket_versioning(self, *, Bucket: str) -> dict[str,Any]:
        self._valid(Bucket)
        return {"Status":"Enabled"}

    def head_bucket(self, *, Bucket: str) -> dict[str,Any]:
        self._valid(Bucket)
        self._check(self.root)
        if self.root.stat().st_mode & 0o077:
            raise ValueError("storage must be private")
        return {}

    def get_bucket_acl(self, **_: Any) -> dict[str,Any]:
        return {"Grants":[{"Grantee":{"Type":"CanonicalUser"}}]}

    def get_bucket_policy(self, **_: Any) -> dict[str,Any]:
        return {"Policy":'{"Statement":[]}'}

    def generate_presigned_url(self, operation: str, *, Params: dict[str,str], ExpiresIn: int) -> str:
        if operation != "get_object" or not 1 <= ExpiresIn <= 86400:
            raise ValueError("invalid read operation")
        payload={**Params,"expires":int(time.time())+ExpiresIn}
        encoded=base64.urlsafe_b64encode(json.dumps(payload,sort_keys=True).encode()).decode().rstrip("=")
        signature=hmac.new(self._secret,encoded.encode(),"sha256").hexdigest()
        return "/workbench/api/evidence-file?"+urlencode({"token":encoded+"."+signature})

    def read_signed(self, token: str) -> tuple[bytes,str]:
        try:
            encoded,signature=token.split(".")
            expected=hmac.new(self._secret,encoded.encode(),"sha256").hexdigest()
            if not hmac.compare_digest(signature,expected):
                raise ValueError("invalid evidence link")
            payload=json.loads(base64.urlsafe_b64decode(encoded+"="*((-len(encoded))%4)))
            if payload.pop("expires") < time.time():
                raise ValueError("expired evidence link")
            if not payload["Key"].startswith("evidence/"):
                raise ValueError("invalid evidence reference")
            response=self.get_object(**payload)
            return response["Body"].read(),response["ContentType"]
        except (KeyError,TypeError,UnicodeError,json.JSONDecodeError) as exc:
            raise ValueError("invalid evidence link") from exc

    def list_object_versions(self, **request: Any) -> dict[str,Any]:
        self._valid(request["Bucket"])
        with self._lock():
            directory=self.root / request["Bucket"]
            self._check(directory)
            versions: list[dict[str,Any]] = []
            markers: list[dict[str,Any]] = []
            for file in sorted(directory.glob("*/index.json")):
                index=json.loads(self._read(file))
                if not index["Key"].startswith(request.get("Prefix","")):
                    continue
                for position,item in enumerate(index["versions"]):
                    record={**item,"Key":index["Key"],"IsLatest":position == 0,
                            "LastModified":datetime.fromisoformat(item["LastModified"])}
                    (markers if item["DeleteMarker"] else versions).append(record)
            return {"Versions":versions,"DeleteMarkers":markers,"IsTruncated":False}

    def import_version(self, bucket: str, key: str, item: dict[str,Any], raw: bytes | None) -> None:
        """Migration-only: preserve original identity, metadata and timestamp."""
        with self._lock():
            directory,index=self._index(bucket,key)
            if any(v["VersionId"] == item["VersionId"] for v in index["versions"]):
                raise ValueError("duplicate imported version")
            record={k:v for k,v in item.items() if k not in {"Key","IsLatest","ResponseMetadata","Body"}}
            stamp=record["LastModified"]
            record["LastModified"]=stamp.astimezone(UTC).isoformat() if isinstance(stamp,datetime) else stamp
            if not record["DeleteMarker"]:
                if raw is None:
                    raise ValueError("raw version required")
                record["sha256"]=sha256(raw).hexdigest()
                record["Size"]=len(raw)
                self._atomic(directory / sha256(record["VersionId"].encode()).hexdigest() / "body",raw)
            index["versions"].insert(0,record)
            self._save(directory,index)

    def close(self) -> None:
        pass
