from typing import Optional
import pytest

from backend.services.provider_capabilities import (
    IdempotencyMode,
    ProviderCapability,
    get_provider_capability,
)


def test_official_openai_capability():
    cap = get_provider_capability("openai", "openai_compatible")
    assert cap.supports_idempotency is False
    assert cap.idempotency_mode == IdempotencyMode.HEADER
    assert cap.header_name == "X-Client-Request-Id"
    assert cap.supports_retry_after is True


def test_third_party_openai_compatible_defaults():
    cap = get_provider_capability("deepseek", "openai_compatible")
    assert cap.supports_idempotency is False
    assert cap.idempotency_mode == IdempotencyMode.NONE
    assert cap.header_name is None
    assert cap.supports_retry_after is True
    assert cap.has_side_effect_on_read_timeout is True

    # Unknown custom provider also defaults safely
    cap_unknown = get_provider_capability("my-custom-proxy", "openai_compatible")
    assert cap_unknown.supports_idempotency is False
    assert cap_unknown.idempotency_mode == IdempotencyMode.NONE
    assert cap_unknown.header_name is None


def test_google_gemini_and_vertex_capabilities():
    gemini_cap = get_provider_capability("gemini", "gemini")
    assert gemini_cap.sdk_retry_configurable is True
    assert gemini_cap.supports_retry_after is True
    assert gemini_cap.idempotency_mode == IdempotencyMode.NONE

    vertex_cap = get_provider_capability("vertex", "vertex")
    assert vertex_cap.sdk_retry_configurable is True
    assert vertex_cap.supports_retry_after is True


def test_shopify_mutation_level_override():
    # Base Shopify capability
    base_cap = get_provider_capability("shopify", "shopify_graphql")
    assert base_cap.supports_idempotency is True
    assert base_cap.supports_retry_after is True

    # stagedUploadsCreate mutation is non-idempotent or has side effect
    upload_cap = get_provider_capability(
        "shopify", "shopify_graphql", operation="stagedUploadsCreate"
    )
    assert upload_cap.supports_idempotency is False
    assert upload_cap.has_side_effect_on_read_timeout is True

    # productCreate or other mutations might support idempotency via input fields
    product_cap = get_provider_capability(
        "shopify", "shopify_graphql", operation="productCreate"
    )
    assert product_cap.supports_idempotency is True


def test_wordpress_capabilities():
    wp_cap = get_provider_capability("wordpress", "wordpress_rest")
    assert wp_cap.supports_idempotency is False
    assert wp_cap.idempotency_mode == IdempotencyMode.NONE
    assert wp_cap.has_side_effect_on_read_timeout is True


def test_cloudflare_r2_capabilities():
    r2_cap = get_provider_capability("cloudflare_r2", "s3_compatible")
    assert r2_cap.supports_idempotency is True
    assert r2_cap.idempotency_mode == IdempotencyMode.PROVIDER_SPECIFIC
    assert r2_cap.has_side_effect_on_read_timeout is False
