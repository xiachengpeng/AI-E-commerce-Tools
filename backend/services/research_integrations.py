"""Explicit non-AI factories. Construction never probes or creates a transport."""

from dataclasses import dataclass
from typing import Any

from services.integration_settings_service import IntegrationSettingsService


@dataclass(frozen=True)
class NonAIIntegrations:
    settings_store: IntegrationSettingsService
    providers: Any
    translator: Any
    translation_credentials: Any
    feishu: Any
    allow_external: bool

    def provider_limit(self, provider: str) -> int:
        from rabbit_hole.integrations.collectors.provider_api import ProviderError

        value = self.settings_store.resolve(provider, "research").get("daily_limit")
        if type(value) is not int or value < 1:
            raise ProviderError("not_configured", "采集接口调用预算未配置")
        return value

    def make_runner(self, store, explicit_settings, evidence_store):
        """Task10 injects AI at this seam; no market/admission/env defaults inferred."""
        from rabbit_hole.application.runner import WorkbenchRunner

        return WorkbenchRunner(
            store,
            explicit_settings,
            evidence_store,
            provider_secrets=self.providers,
            provider_budget_limits=self.provider_limit,
            allow_external=self.allow_external,
        )


def assemble_non_ai_integrations(
    store: IntegrationSettingsService, *, allow_external: bool, feishu_http_client=None
) -> NonAIIntegrations:
    from services.research_runtime import _research_imports

    _research_imports()
    from rabbit_hole.integrations.ad_translation import (
        TranslationCredentials,
        TranslationService,
    )
    from rabbit_hole.integrations.feishu import FeishuClient
    from rabbit_hole.integrations.provider_settings import ProviderSecrets

    if type(allow_external) is not bool:
        raise ValueError("explicit external authorization required")
    # Fail before providing operational services on a revision1/unprepared database.
    store.public("apify", "research")

    def translation_credentials():
        data = store.resolve("aliyun", "research")
        return TranslationCredentials(
            data.get("access_key_id", ""), data.get("access_key_secret", "")
        )

    return NonAIIntegrations(
        store,
        ProviderSecrets(unified_store=store, purpose="research"),
        TranslationService(
            credentials_resolver=translation_credentials,
            cache_store=store,
            allow_external=allow_external,
        ),
        translation_credentials,
        FeishuClient(
            credentials_resolver=lambda: store.resolve("feishu", "research"),
            allow_external=allow_external,
            http_client=feishu_http_client,
        ),
        allow_external,
    )


class ResearchSync:
    """Resolve a fresh Feishu target for each operation; closed before side effects."""

    def __init__(
        self,
        workbench_store,
        settings_store: IntegrationSettingsService,
        *,
        allow_external: bool,
    ) -> None:
        self.store, self.settings_store = workbench_store, settings_store
        self.allow_external = allow_external

    def _service(self, *, external: bool):
        from rabbit_hole.domain.project import WorkbenchError

        if external and not self.allow_external:
            raise WorkbenchError("integration_unconfigured", "飞书同步尚未授权", 503)
        config = self.settings_store.resolve("feishu", "research")
        if not all(config.get(k) for k in ("app_id", "app_secret", "base_app_token")):
            raise WorkbenchError("integration_unconfigured", "飞书同步尚未配置", 503)
        from rabbit_hole.application.sync import WorkbenchSync
        from rabbit_hole.integrations.feishu import FeishuClient

        # Snapshot credentials and target together; next operation resolves the next DB version.
        client = FeishuClient(
            config["app_id"],
            config["app_secret"],
            config["base_app_token"],
            allow_external=self.allow_external,
        )
        return WorkbenchSync(self.store, client), client

    async def _invoke(self, name, *args, external=True):
        service, client = self._service(external=external)
        try:
            return await getattr(service, name)(*args)
        finally:
            await client.aclose()

    async def status(self, project_id):
        return await self._invoke("status", project_id, external=False)

    async def preview(self, project_id, version):
        return await self._invoke("preview", project_id, version)

    async def enqueue(self, project_id, version, digest):
        return await self._invoke("enqueue", project_id, version, digest)

    async def retry(self, project_id, run_id):
        return await self._invoke("retry", project_id, run_id)

    async def run_once(self):
        return await self._invoke("run_once")

    async def loop(self):
        import asyncio

        # Activation belongs to Task19; do not silently retry authorization failures.
        self._service(external=True)
        while True:
            await self.run_once()
            await asyncio.sleep(3)
