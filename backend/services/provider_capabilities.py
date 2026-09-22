from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Dict, Optional


class IdempotencyMode(str, Enum):
    NONE = "NONE"
    HEADER = "HEADER"
    INPUT_FIELD = "INPUT_FIELD"
    GRAPHQL_DIRECTIVE = "GRAPHQL_DIRECTIVE"
    PROVIDER_SPECIFIC = "PROVIDER_SPECIFIC"


@dataclass(frozen=True)
class ProviderCapability:
    supports_idempotency: bool = False
    idempotency_mode: IdempotencyMode = IdempotencyMode.NONE
    header_name: Optional[str] = None
    supports_retry_after: bool = True
    sdk_retry_configurable: bool = False
    has_side_effect_on_read_timeout: bool = True
    operation_overrides: Dict[str, Any] = field(default_factory=dict)


# Default matrix for well-known providers and protocols
_PROVIDER_CAPABILITIES: Dict[str, ProviderCapability] = {
    # Official OpenAI: Client tracking via X-Client-Request-Id, responses carry X-Request-Id
    "openai": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.HEADER,
        header_name="X-Client-Request-Id",
        supports_retry_after=True,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=True,
    ),
    # Google Gemini: uses google-genai SDK, retry options configurable
    "gemini": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.NONE,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=True,
        has_side_effect_on_read_timeout=True,
    ),
    # Google Vertex AI: uses google-genai SDK
    "vertex": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.NONE,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=True,
        has_side_effect_on_read_timeout=True,
    ),
    # Shopify Admin GraphQL: Supports idempotency on certain mutations, but staged uploads or custom mutations differ
    "shopify": ProviderCapability(
        supports_idempotency=True,
        idempotency_mode=IdempotencyMode.INPUT_FIELD,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=True,
        operation_overrides={
            "stagedUploadsCreate": {
                "supports_idempotency": False,
                "has_side_effect_on_read_timeout": True,
            },
            "productCreate": {
                "supports_idempotency": True,
                "has_side_effect_on_read_timeout": True,
            },
        },
    ),
    # WordPress REST API: No native idempotency key; write timeouts may have persisted media
    "wordpress": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.NONE,
        header_name=None,
        supports_retry_after=False,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=True,
    ),
    # Cloudflare R2 / S3 Compatible: PutObject is naturally idempotent
    "cloudflare_r2": ProviderCapability(
        supports_idempotency=True,
        idempotency_mode=IdempotencyMode.PROVIDER_SPECIFIC,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=False,
    ),
}

# Protocol fallback defaults for generic or custom providers
_PROTOCOL_DEFAULTS: Dict[str, ProviderCapability] = {
    "openai_compatible": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.NONE,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=True,
    ),
    "gemini": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.NONE,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=True,
        has_side_effect_on_read_timeout=True,
    ),
    "vertex": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.NONE,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=True,
        has_side_effect_on_read_timeout=True,
    ),
    "shopify_graphql": ProviderCapability(
        supports_idempotency=True,
        idempotency_mode=IdempotencyMode.INPUT_FIELD,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=True,
        operation_overrides={
            "stagedUploadsCreate": {
                "supports_idempotency": False,
                "has_side_effect_on_read_timeout": True,
            },
        },
    ),
    "wordpress_rest": ProviderCapability(
        supports_idempotency=False,
        idempotency_mode=IdempotencyMode.NONE,
        header_name=None,
        supports_retry_after=False,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=True,
    ),
    "s3_compatible": ProviderCapability(
        supports_idempotency=True,
        idempotency_mode=IdempotencyMode.PROVIDER_SPECIFIC,
        header_name=None,
        supports_retry_after=True,
        sdk_retry_configurable=False,
        has_side_effect_on_read_timeout=False,
    ),
}


def get_provider_capability(
    provider_name: str,
    protocol: str,
    operation: Optional[str] = None,
) -> ProviderCapability:
    """Resolve capability matrix for a provider/protocol, with optional operation overrides."""
    norm_name = provider_name.strip().lower() if provider_name else ""
    norm_proto = protocol.strip().lower() if protocol else ""

    # 1. Match specific provider if registered
    base_cap = _PROVIDER_CAPABILITIES.get(norm_name)

    # 2. Fall back to protocol default
    if base_cap is None:
        base_cap = _PROTOCOL_DEFAULTS.get(
            norm_proto,
            ProviderCapability(
                supports_idempotency=False,
                idempotency_mode=IdempotencyMode.NONE,
                header_name=None,
                supports_retry_after=True,
                sdk_retry_configurable=False,
                has_side_effect_on_read_timeout=True,
            ),
        )

    # 3. Apply operation-level overrides if specified
    if operation and operation in base_cap.operation_overrides:
        override_data = base_cap.operation_overrides[operation]
        if isinstance(override_data, dict):
            return replace(base_cap, **override_data)
        elif isinstance(override_data, ProviderCapability):
            return override_data

    return base_cap
