"""Explicit new observations retain old tasks and never replay an ambiguous run."""
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, update

from rabbit_hole.application.actions import actions, enqueue_action, get_action
from rabbit_hole.domain.project import WorkbenchError
from rabbit_hole.persistence.projects import WorkbenchStore


@pytest.fixture
async def completed_scan(db_engine):
    store = WorkbenchStore(db_engine)
    p = await store.create('isolated refresh', 'test', 'US', str(uuid4()))
    p = await store.command(p['id'], p['version'], str(uuid4()), 'add_keyword', {'text': 'wall repair kit', 'type': 'category'})
    word = p['keywords'][0]['id']
    p = await store.command(p['id'], p['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word, 'approved': True})
    old = await enqueue_action(store, p['id'], {'version': p['version'], 'kind': 'scan', 'keyword_id': word})
    async with db_engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(old['id'])).values(status='complete', result={'ads': 0}))
    p = await store.get(p['id'])
    await store.command(p['id'], p['version'], str(uuid4()), 'collection_result', {'keyword_id': word, 'status': 'complete', 'ads': []}, actor='automation')
    return store, p['id'], word, old['id']


async def refresh(case, **overrides):
    store, pid, word, old = case
    p = await store.get(pid)
    return await enqueue_action(store, pid, {'version': p['version'], 'kind': 'scan', 'keyword_id': word, 'rescan_of': old, **overrides})


async def test_explicit_completed_refresh_creates_one_new_task_and_preserves_original(completed_scan):
    store, pid, word, old = completed_scan
    fresh = await refresh(completed_scan)
    assert fresh['id'] != old
    repeated = await refresh(completed_scan)
    assert repeated['id'] == fresh['id']
    async with store.engine.connect() as c:
        rows = (await c.execute(select(actions).where(actions.c.project_id == UUID(pid)))).mappings().all()
    assert len(rows) == 2
    assert next(r for r in rows if str(r['id']) == old)['status'] == 'complete'
    new = next(r for r in rows if str(r['id']) == fresh['id'])
    assert new['payload']['rescan_of'] == old
    assert new['payload']['execution_mode'] == 'ui'
    assert 'apify_run' not in new['payload']


@pytest.mark.parametrize('status', ['ready', 'running', 'blocked'])
async def test_refresh_cannot_replay_unfinished_or_ambiguous_source(completed_scan, status):
    store, _, _, old = completed_scan
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(old)).values(status=status))
    with pytest.raises(WorkbenchError, match='完成'):
        await refresh(completed_scan)


async def test_refresh_reference_must_belong_to_current_keyword(completed_scan):
    with pytest.raises(WorkbenchError):
        await refresh(completed_scan, rescan_of=str(uuid4()))


async def test_refresh_obeys_daily_scan_budget(completed_scan):
    store, pid, _, _ = completed_scan
    p = await store.get(pid)
    await store.command(pid, p['version'], str(uuid4()), 'configure_rules', {'rules': {'scan_batch_limit': 1, 'daily_scan_budget': 1}, 'reason': 'isolated'})
    with pytest.raises(WorkbenchError, match='预算'):
        await refresh(completed_scan)


async def test_completed_refresh_can_be_explicitly_recovered_without_replaying_its_parent(completed_scan):
    store, pid, word, old = completed_scan
    fresh = await refresh(completed_scan)
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(fresh['id'])).values(status='blocked', error_code='source_error'))
    view = await get_action(store.engine, pid, fresh['id'])
    assert view['rescan_of'] == old
    retry = await refresh(completed_scan, retry_action_id=fresh['id'])
    assert retry['id'] == fresh['id']
    assert retry['status'] == 'ready'
    assert (await get_action(store.engine, pid, old))['status'] == 'complete'


async def test_completed_refresh_does_not_fork_after_collection_mode_change(completed_scan):
    store, pid, _, old = completed_scan
    fresh = await refresh(completed_scan)
    p = await store.get(pid)
    await store.command(pid, p['version'], str(uuid4()), 'configure_collection', {'meta': 'api', 'trends': 'ui'})
    assert (await refresh(completed_scan))['id'] == fresh['id']


async def test_batch_recovery_targets_failed_refresh_instead_of_its_completed_parent(completed_scan):
    store, pid, word, old = completed_scan
    fresh = await refresh(completed_scan)
    async with store.engine.begin() as c:
        await c.execute(update(actions).where(actions.c.id == UUID(fresh['id'])).values(status='blocked', error_code='source_error'))
    p = await store.get(pid)
    p = await store.command(pid, p['version'], str(uuid4()), 'keyword_state', {'keyword_id': word, 'status': 'blocked'}, actor='automation')
    result = await enqueue_action(store, pid, {'kind': 'scan_all', 'version': p['version']})
    assert result['queued'] == 1
    assert result['unchanged'] == 0
    assert (await get_action(store.engine, pid, fresh['id']))['status'] == 'ready'
    assert (await get_action(store.engine, pid, old))['status'] == 'complete'
