"""Local backend-only secrets, shared by API and worker through a private volume."""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
from pathlib import Path
from typing import Any


class ProviderSecrets:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or Path(os.environ.get(
            "RABBIT_HOLE_PROVIDER_SECRETS_PATH",
            str(Path.home() / ".local/share/rabbit-hole/providers/keys.json"),
        ))

    def _read(self) -> dict[str, str]:
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}
        if not isinstance(data, dict):
            raise TypeError("密钥文件格式无效")
        return {k: v for k, v in data.items() if k in {"apify", "serpapi", "firecrawl"} and isinstance(v, str)}

    def get(self, provider: str) -> str:
        return self._read().get(provider, "")

    def status(self) -> dict[str, bool]:
        data = self._read()
        return {key: bool(data.get(key)) for key in ("apify", "serpapi", "firecrawl")}

    def update(self, changes: dict[str, Any]) -> dict[str, bool]:
        if not changes or set(changes) - {"apify", "serpapi", "firecrawl"}:
            raise ValueError("仅支持 Apify、SerpApi 和 Firecrawl 密钥")
        for value in changes.values():
            if value is not None and (not isinstance(value, str) or not 1 <= len(value) <= 512 or any(c.isspace() for c in value)):
                raise ValueError("密钥不能为空、含空格或超过512字符")
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            data = self._read()
            for key, value in changes.items():
                if value is None:
                    data.pop(key, None)
                else:
                    data[key] = value
            fd, name = tempfile.mkstemp(dir=self.path.parent)
            try:
                with os.fdopen(fd, "w") as stream:
                    json.dump(data, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(name, self.path)
            finally:
                if os.path.exists(name):
                    os.unlink(name)
        finally:
            os.close(lock)
        return self.status()
