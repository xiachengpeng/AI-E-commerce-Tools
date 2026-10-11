"""Latest product action lookup does not depend on history pagination."""
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import insert


async def test_product_landing_status_survives_newer_history(db_engine):
    from rabbit_hole.application.actions import (
        actions,
        enqueue_action,
        list_actions,
        stop_action,
    )
    from rabbit_hole.persistence.projects import WorkbenchStore
    store = WorkbenchStore(db_engine)
    p = await store.create("Progress", "test", "US", str(uuid4()))
    p = await store.command(p["id"], p["version"], str(uuid4()), "add_product",
                            {"name": "Cart", "url": "https://example.com/products/cart"})
    pid = p["products"][0]["id"]
    queued = await enqueue_action(store, p["id"], {"kind": "landing", "version": p["version"], "product_id": pid})
    now = datetime.now(UTC)
    async with db_engine.begin() as c:
        for i in range(25):
            await c.execute(insert(actions).values(id=uuid4(), project_id=UUID(p["id"]), dedupe_key=str(uuid4()),
                kind="keywords", status="complete", input_version=1, payload={}, attempt=1,
                created_at=now+timedelta(seconds=i), updated_at=now))
    page = await list_actions(db_engine, p["id"], limit=20)
    assert queued["id"] not in {a["id"] for a in page["actions"]}
    assert page["product_actions"][pid]["id"] == queued["id"]
    assert page["product_actions"][pid]["kind"] == "landing"
    await stop_action(store, p["id"], queued["id"], 0)
