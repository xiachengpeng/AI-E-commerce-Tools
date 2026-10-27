"""Collection receipts and bounded local page jobs commit together, without AI."""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

from sqlalchemy import delete, select, update

from rabbit_hole.application.actions import actions, enqueue_action, stop_action
from rabbit_hole.application.runner import WorkbenchRunner
from rabbit_hole.persistence.projects import WorkbenchStore


async def fixture(engine):
    store = WorkbenchStore(engine)
    p = await store.create('sync', 'home repair', 'US', str(uuid4()))
    p = await store.command(p['id'], p['version'], str(uuid4()), 'add_keyword', {'text': 'repair', 'type': 'category'})
    k = p['keywords'][0]['id']
    p = await store.command(p['id'], p['version'], str(uuid4()), 'approve_keyword', {'keyword_id': k, 'approved': True})
    q = await enqueue_action(store, p['id'], {'kind': 'scan', 'version': p['version'], 'keyword_id': k})
    async with engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(q['id'])).values(status='running', attempt=1, lease_until=datetime.now(UTC)+timedelta(minutes=5)))
        row = (await c.execute(select(actions).where(actions.c.id == UUID(q['id'])))).mappings().one()
    return store, p, k, dict(row)


def ad(i, url=None):
    return {'id': str(i), 'advertiser': 'Store', 'active': True, 'landing_url': url or f'https://shop.example/products/{i}', 'primary_text': 'repair item', 'media': []}


async def children(engine):
    async with engine.connect() as c:
        return (await c.execute(select(actions).where(actions.c.kind == 'landing'))).mappings().all()


async def test_scan_receipt_schedules_only_current_bound_products_locally_and_once(db_engine):
    store, p, k, action = await fixture(db_engine)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    payload = {'keyword_id': k, 'ads': [ad(1), ad(2), ad(3, 'https://shop.example/products/1')], 'status': 'complete'}
    saved = await runner.save(action, 'collection_result', payload)
    rows = await children(db_engine)
    assert len(rows) == 2
    assert all(r['payload']['landing_mode'] == 'local' and r['status'] == 'ready' for r in rows)
    assert {r['product_id'] for r in rows} == {p['id'] for p in saved['products']}
    assert all(r['payload']['collection_action_id'] == str(action['id']) for r in rows)
    await runner.save(action, 'collection_result', payload)
    assert len(await children(db_engine)) == 2


async def test_existing_failed_reads_are_not_silently_retried_or_switched_to_paid(db_engine):
    store, p, k, action = await fixture(db_engine)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    payload = {'keyword_id': k, 'ads': [ad(1)], 'status': 'complete'}
    await runner.save(action, 'collection_result', payload)
    rows = await children(db_engine)
    assert len(rows) == 1
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == rows[0]['id']).values(status='blocked', error_code='source_error'))
    await runner.save(action, 'collection_result', payload)
    rows = await children(db_engine)
    assert len(rows) == 1 and rows[0]['status'] == 'blocked'


async def test_page_job_limit(db_engine):
    store, p, k, action = await fixture(db_engine)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    await runner.save(action, 'collection_result', {'keyword_id': k, 'ads': [ad(i) for i in range(25)], 'status': 'complete'})
    assert len(await children(db_engine)) == 20


async def test_existing_paid_read_and_saved_page_are_reused_without_new_jobs(db_engine):
    from rabbit_hole.application.collection_pages import schedule_collection_pages
    store, p, k, action = await fixture(db_engine)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    payload = {'keyword_id': k, 'ads': [ad(1), ad(2)], 'status': 'complete'}
    saved = await runner.save(action, 'collection_result', payload)
    rows = await children(db_engine)
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == rows[0]['id']).values(payload={**rows[0]['payload'], 'landing_mode':'firecrawl'}))
        # A saved page is reused even if it contains no extractable pictures.
        await c.execute(delete(actions).where(actions.c.id == rows[1]['id']))
        saved['products'][1]['landing_snapshot'] = {'images': [], 'body_text': 'Saved page'}
        await schedule_collection_pages(c, saved, action, payload)
    final = await children(db_engine)
    assert len(final) == 1
    assert next(r for r in final if r['id'] == rows[0]['id'])['payload']['landing_mode'] == 'firecrawl'


async def test_stopped_parent_cannot_create_ads_or_page_jobs(db_engine):
    import pytest
    from rabbit_hole.application.actions import SourceFailure
    store, p, k, action = await fixture(db_engine)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    await stop_action(store, p['id'], str(action['id']), 1)
    with pytest.raises(SourceFailure):
        await runner.save(action, 'collection_result', {'keyword_id': k, 'ads': [ad(99)], 'status': 'complete'}, suffix='late')
    assert not await children(db_engine)
    assert not (await store.get(p['id']))['products']


async def test_page_admission_and_ads_roll_back_together(db_engine, monkeypatch):
    import pytest
    from rabbit_hole.application import collection_pages
    store, p, k, action = await fixture(db_engine)
    runner = WorkbenchRunner(store, SimpleNamespace(), None)
    async def fail(*args):
        raise RuntimeError('synthetic transaction failure')
    monkeypatch.setattr(collection_pages, 'schedule_collection_pages', fail)
    with pytest.raises(RuntimeError):
        await runner.save(action, 'collection_result', {'keyword_id': k, 'ads': [ad(1)], 'status': 'complete'})
    assert not (await store.get(p['id']))['products']
    assert not await children(db_engine)
