"""Complex optional JSON-LD must not discard the usable product page."""
from datetime import UTC, datetime
from uuid import uuid4

import pytest


def nested(levels):
    value = {"name": "Cart"}
    for _ in range(levels):
        value = {"item": value}
    return [value]


async def save_snapshot(db_engine, metadata):
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    p = await store.create("Complex page", "test", "US", str(uuid4()))
    p = await store.command(p["id"], p["version"], str(uuid4()), "add_product",
                            {"name": "Cart", "url": "https://example.com/products/cart"})
    p = await store.command(p["id"], p["version"], str(uuid4()), "landing_result", {
        "product_id": p["products"][0]["id"],
        "snapshot": {"title": "Cart", "body_text": "Usable original product description", "price": "79",
                     "json_ld": metadata, "http_status_code": 200, "final_url": "https://example.com/products/cart"},
        "source_url": "https://example.com/products/cart", "observed_at": datetime.now(UTC).isoformat(),
    }, actor="automation")
    return p["products"][0]["landing_snapshot"]


async def test_normal_deep_product_metadata_preserved(db_engine):
    metadata = nested(8)
    saved = await save_snapshot(db_engine, metadata)
    assert saved["json_ld"] == metadata
    assert saved["confirmed"] is False


@pytest.mark.parametrize("metadata", [nested(30), [{"description": "x" * 110000}]])
async def test_excess_optional_metadata_marked_without_losing_page(db_engine, metadata):
    saved = await save_snapshot(db_engine, metadata)
    assert saved["body_text"] == "Usable original product description"
    assert saved["title"] == "Cart" and saved["http_status_code"] == 200
    assert saved["json_ld"] == []
    assert saved["json_ld_status"] == "omitted_limit"
    assert saved["json_ld_warning"]
    assert saved["confirmed"] is False


def test_other_evidence_depth_limit_not_relaxed():
    from rabbit_hole.domain.project import WorkbenchError, _bounded
    with pytest.raises(WorkbenchError, match="nesting"):
        _bounded(nested(8))


def test_business_failure_reason_is_clear_without_raw_payload():
    from rabbit_hole.domain.project import WorkbenchError
    from rabbit_hole.integrations.provider_jobs import diagnostic
    message = diagnostic(WorkbenchError("limit_reached", "Evidence nesting is too deep"))
    assert "嵌套" in message and "保存" in message
    assert "TOP_SECRET" not in diagnostic(WorkbenchError("invalid_payload", "TOP_SECRET raw URL"))


def test_collector_failure_exports_status_but_never_raw_urls():
    from rabbit_hole.integrations.collectors.base import CollectorError
    from rabbit_hole.integrations.provider_jobs import landing_diagnostic
    assert "HTTP 403" in landing_diagnostic(CollectorError(code="http_status", detail="landing page returned HTTP 403"))
    assert "超时" in landing_diagnostic(CollectorError(code="timeout", detail="TOP_SECRET raw URL"))
    assert "TOP_SECRET" not in landing_diagnostic(CollectorError(code="parse_error", detail="TOP_SECRET raw URL"))
