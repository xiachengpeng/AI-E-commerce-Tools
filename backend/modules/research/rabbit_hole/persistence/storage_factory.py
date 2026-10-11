"""Choose one explicit storage backend; never fall back after a failure."""
from __future__ import annotations

from typing import Any

import boto3  # type: ignore[import-untyped]
from botocore.config import Config  # type: ignore[import-untyped]


def create_storage_client(settings: Any) -> Any:
    if getattr(settings,"storage_backend","s3") == "files":
        from rabbit_hole.persistence.local_objects import LocalObjectClient
        return LocalObjectClient(settings.storage_path)
    return boto3.client("s3",endpoint_url=str(settings.s3_endpoint).rstrip("/"),
        aws_access_key_id=settings.s3_access_key, aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1", config=Config(connect_timeout=2,read_timeout=5,retries={"max_attempts":0}))
