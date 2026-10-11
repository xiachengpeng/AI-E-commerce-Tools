"""Private, dynamically resolved OpenAI-compatible relay settings."""
from __future__ import annotations

import fcntl
import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from rabbit_hole.integrations.provider_settings import ProviderSecrets


@dataclass(frozen=True)
class AIConnection:
    api_key: str = field(repr=False)
    base_url: str
    model: str


def validate_base_url(value: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(value)
    if len(value) > 2048 or any(c.isspace() for c in value) or parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("接口地址需为 HTTP/HTTPS 地址，不能包含凭据、查询参数或片段")
    try:
        _ = parsed.port
    except ValueError:
        raise ValueError("接口地址端口无效") from None
    return value.rstrip("/")


class AISettings:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or ProviderSecrets().path.with_name("ai.json")

    def _read(self) -> dict[str, str]:
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}
        if not isinstance(data, dict):
            raise TypeError("AI 配置格式无效")
        return {k: v for k, v in data.items() if k in {"api_key", "base_url", "model"} and isinstance(v, str)}

    def resolve(self, settings: Any = None) -> AIConnection:
        data = self._read()
        def value(key: str) -> str:
            fallback = getattr(settings, "openai_" + key, os.environ.get("RABBIT_HOLE_OPENAI_" + key.upper(), ""))
            return data.get(key, fallback or "")
        return AIConnection(value("api_key"), value("base_url"), value("model"))

    def public(self, settings: Any = None) -> dict[str, Any]:
        effective = self.resolve(settings)
        try:
            public_url = validate_base_url(effective.base_url)
        except ValueError:
            public_url = ""
        return {"configured": bool(effective.api_key and effective.model), "key_configured": bool(effective.api_key), "base_url": public_url, "model": effective.model, "source": "saved" if self._read() else "environment"}

    def _write(self, data: dict[str, str]) -> None:
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

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        if not changes or set(changes) - {"api_key", "base_url", "model"}:
            raise ValueError("请填写接口地址、模型名称和密钥")
        clean: dict[str, str] = {}
        for key, value in changes.items():
            if not isinstance(value, str):
                raise ValueError("配置项必须是文字")  # noqa: TRY004 -- public validation error
            if key == "api_key":
                if value and (len(value) > 512 or any(c.isspace() for c in value)):
                    raise ValueError("密钥不能含空格或超过512字符")
                if value:
                    clean[key] = value
            elif key == "base_url":
                clean[key] = validate_base_url(value.strip())
            else:
                if not value or len(value) > 200 or any(c.isspace() for c in value):
                    raise ValueError("请填写中转站支持的模型名称，不含空格，最多200字符")
                clean[key] = value
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            data = {**self._read(), **clean}
            effective = self.resolve()
            if not data.get("api_key", effective.api_key) or not data.get("model", effective.model):
                raise ValueError("首次配置需要密钥与模型名称")
            self._write(data)
        finally:
            os.close(lock)
        return self.public()

    def reset(self) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self._write({})
        finally:
            os.close(lock)
        return self.public()
