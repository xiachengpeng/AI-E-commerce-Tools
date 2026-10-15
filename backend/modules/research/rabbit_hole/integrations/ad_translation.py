"""Alibaba translation is a reading aid; never rewrites research evidence."""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import sqlite3
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rabbit_hole.integrations.provider_settings import ProviderSecrets


class TranslationError(Exception):
    """Safe public error without SDK requests, credentials or raw messages."""


@dataclass(frozen=True)
class TranslationCredentials:
    access_key_id: str = field(repr=False)
    access_key_secret: str = field(repr=False)


class TranslationSettings:
    def __init__(self, path: Path | None = None) -> None:
        if path is None:
            provider_path = ProviderSecrets().path
            assert provider_path is not None
            path = provider_path.with_name("translation.json")
        self.path = path

    def resolve(self) -> TranslationCredentials:
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            data = {}
        if not isinstance(data, dict):
            raise ValueError("翻译配置格式无效")  # noqa: TRY004 -- safe configuration error
        return TranslationCredentials(str(data.get("access_key_id", "")), str(data.get("access_key_secret", "")))

    def public(self) -> dict[str, bool]:
        credentials = self.resolve()
        return {"configured": bool(credentials.access_key_id and credentials.access_key_secret)}

    def update(self, data: dict[str, Any]) -> dict[str, bool]:
        if set(data) != {"access_key_id", "access_key_secret"} or any(
            not isinstance(value, str) or not value or len(value) > 512 or any(c.isspace() for c in value)
            for value in data.values()
        ):
            raise ValueError("请同时填写有效的阿里云 AccessKey ID 和 Secret")
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
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
        return self.public()


class TranslationService:
    def __init__(self, path: Path | None = None, *, credentials_resolver: Any = None,
                 cache_store: Any = None, allow_external: bool = True) -> None:
        if cache_store is not None:
            self.path = cache_store.database
        else:
            if path is None:
                provider_path = ProviderSecrets().path
                assert provider_path is not None
                path = provider_path.with_name("translation-cache.sqlite3")
            self.path = path
        self._credentials_resolver = credentials_resolver
        self._cache_store = cache_store
        self._allow_external = allow_external
        self._lock = asyncio.Lock()

    def _cache(self, key: str, value: dict[str, Any] | None = None) -> dict[str, Any] | None:
        if self._cache_store is not None:
            with self._cache_store.connection() as db:
                if value is not None:
                    db.execute("INSERT OR REPLACE INTO research_translation_cache VALUES (?, ?, ?)", (key, json.dumps(value), time.time()))
                    db.execute("DELETE FROM research_translation_cache WHERE key IN (SELECT key FROM research_translation_cache ORDER BY created DESC LIMIT -1 OFFSET 2000)")
                    db.commit()
                    return value
                row = db.execute("SELECT value FROM research_translation_cache WHERE key = ?", (key,)).fetchone()
                return json.loads(row[0]) if row else None
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.path, 0o600)
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, value TEXT NOT NULL, created REAL NOT NULL)")
            if value is not None:
                db.execute("INSERT OR REPLACE INTO translations VALUES (?, ?, ?)", (key, json.dumps(value), time.time()))
                db.execute("DELETE FROM translations WHERE key IN (SELECT key FROM translations ORDER BY created DESC LIMIT -1 OFFSET 2000)")
                return value
            row = db.execute("SELECT value FROM translations WHERE key = ?", (key,)).fetchone()
            return json.loads(row[0]) if row else None

    async def translate(self, text: str) -> dict[str, Any]:
        if not text.strip() or len(text) > 10000:
            raise TranslationError("广告文案为空或超过一万字符，无法翻译")
        try:
            async with self._lock:
                chunks = [text[index:index + 5000] for index in range(0, len(text), 5000)]
                translated = []
                detected = []
                all_cached = True
                for chunk in chunks:
                    key = hashlib.sha256(("aliyun-general-v1:zh:" + chunk).encode()).hexdigest()
                    value = await asyncio.to_thread(self._cache, key)
                    if value is None:
                        value = await self._request(chunk)
                        await asyncio.to_thread(self._cache, key, value)
                        all_cached = False
                    translated.append(value["translated"])
                    detected.append(value.get("detected_language", ""))
                return {"translated": "".join(translated), "detected_language": detected[0],
                        "cached": all_cached, "source_hash": hashlib.sha256(text.encode()).hexdigest(),
                        "provider": "aliyun", "target_language": "zh"}
        except (OSError, ValueError, sqlite3.Error):
            raise TranslationError("翻译缓存暂不可用，请检查后端存储后重试") from None

    async def _request(self, text: str) -> dict[str, Any]:
        if not self._allow_external:
            raise TranslationError("阿里云翻译尚未授权；原文已保留")
        credentials = self._credentials_resolver() if self._credentials_resolver is not None else TranslationSettings().resolve()
        if not credentials.access_key_id or not credentials.access_key_secret:
            raise TranslationError("尚未配置阿里云机器翻译密钥")
        from alibabacloud_alimt20181012.client import Client  # type: ignore[import-untyped]  # noqa: I001
        from alibabacloud_alimt20181012.models import TranslateGeneralRequest  # type: ignore[import-untyped]
        from alibabacloud_tea_openapi.models import Config  # type: ignore[import-untyped]
        from alibabacloud_tea_util.models import RuntimeOptions  # type: ignore[import-untyped]

        client = Client(Config(access_key_id=credentials.access_key_id,
                               access_key_secret=credentials.access_key_secret,
                               endpoint="mt.cn-hangzhou.aliyuncs.com", region_id="cn-hangzhou"))
        request = TranslateGeneralRequest(format_type="text", scene="general", source_language="auto",
                                          target_language="zh", source_text=text)
        try:
            response = await client.translate_general_with_options_async(
                request, RuntimeOptions(connect_timeout=4000, read_timeout=7000, autoretry=False))
        except Exception as exc:  # noqa: BLE001 -- never expose signed SDK requests
            inner = getattr(exc, "inner_exception", None)
            # Inspect only the wrapped transport error; never stringify the SDK request.
            if inner is not None and "ssl" in str(inner).lower():
                raise TranslationError("阿里云 HTTPS 连接失败，请检查备用机代理或网络后重试；原文已保留") from None
            raise TranslationError("阿里云翻译请求失败，请检查密钥、权限与网络后重试；原文已保留") from None
        result = response.body
        errors = {
            10001: "阿里云翻译超时，请重试",
            10005: "阿里云暂不支持该语言",
            10006: "阿里云无法识别原文语言，请核对文案",
            10008: "广告文案超过阿里云单次翻译长度",
            10009: "阿里云密钥缺少机器翻译权限",
            10010: "请先在阿里云开通机器翻译通用版",
            10011: "请核对阿里云子账号机器翻译权限",
            10013: "阿里云机器翻译未开通或账户欠费",
        }
        code = str(result.code) if result else ""
        if code != "200":
            raise TranslationError({str(key): message for key, message in errors.items()}.get(code, "阿里云翻译未成功，请核对服务状态后重试"))
        if not result.data or not isinstance(result.data.translated, str) or not result.data.translated.strip():
            raise TranslationError("阿里云未返回可用译文，请重试；原文已保留")
        return {"translated": result.data.translated, "detected_language": result.data.detected_language or ""}
