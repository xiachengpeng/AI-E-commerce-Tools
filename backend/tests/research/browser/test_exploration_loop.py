"""Exploration controls use the existing durable workflow, without auto collection."""

from uuid import uuid4

from playwright.async_api import expect

pytest_plugins = ("test_workbench_recovery",)


async def test_exploration_review_scan_stop_and_archive(recovery_page):
    page, store, project = recovery_page
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'pet road trip', 'type': 'scenario'})
    word = project['keywords'][0]['id']
    await page.reload()
    branch = page.locator('[data-exploration-keyword]').filter(has_text='pet road trip')
    await branch.get_by_role('button', name='审核这个词', exact=True).click()
    await expect(branch.get_by_role('button', name='搜索这个词', exact=True)).to_be_visible()
    assert (await store.get(project['id']))['keywords'][0]['status'] == 'ready'
    await branch.get_by_role('button', name='搜索这个词', exact=True).click()
    await branch.get_by_role('button', name='停止本次搜索', exact=True).click()
    await expect(branch.get_by_role('button', name='重试搜索', exact=True)).to_be_visible()
    await branch.get_by_role('button', name='暂停这个入口', exact=True).click()
    await expect(branch.get_by_role('button', name='恢复并重新审核', exact=True)).to_be_visible()
    assert (await store.get(project['id']))['keywords'][0]['status'] == 'archived'
    await page.reload()
    await branch.get_by_role('button', name='恢复并重新审核', exact=True).click()
    saved = await store.get(project['id'])
    assert saved['keywords'][0]['id'] == word
    assert saved['keywords'][0]['approved'] is False


async def test_empty_sample_offers_new_entry_without_overwriting_history(recovery_page):
    page, store, project = recovery_page
    for name, payload in [
        ('add_keyword', {'text': 'lightweight pet travel products', 'type': 'category'}),
    ]:
        project = await store.command(project['id'], project['version'], str(uuid4()), name, payload)
    word = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'approve_keyword', {'keyword_id': word, 'approved': True})
    await store.command(project['id'], project['version'], str(uuid4()), 'collection_result', {'keyword_id': word, 'ads': [], 'status': 'complete', 'message': '本次采集 0 条'}, actor='automation')
    await page.reload()
    branch = page.locator('[data-exploration-keyword]').filter(has_text='lightweight pet travel products')
    await branch.get_by_role('button', name='换一个搜索入口', exact=True).click()
    await page.locator('#editor [name=text]').fill('pet travel')
    await page.locator('#editor button[type=submit]').click()
    await expect(page.locator('#dialog')).not_to_be_visible()
    saved = await store.get(project['id'])
    assert len(saved['keywords']) == 2
    assert saved['keywords'][0]['status'] == 'complete'
    assert saved['keywords'][1]['approved'] is False
    assert saved['keywords'][1]['parent_id'] is None


async def test_source_product_is_reachable_from_search_branch(recovery_page):
    page, store, project = recovery_page
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_keyword', {'text': 'pet travel', 'type': 'scenario'})
    word = project['keywords'][0]['id']
    project = await store.command(project['id'], project['version'], str(uuid4()), 'add_product', {'name': '旅行杯', 'url': 'https://example.com/cup', 'source_keyword_ids': [word]})
    await page.reload()
    branch = page.locator('[data-exploration-keyword]').filter(has_text='pet travel')
    await branch.get_by_role('button', name='识别商品：旅行杯', exact=True).click()
    await expect(page.get_by_role('dialog')).to_be_visible()
    await expect(page.get_by_role('textbox', name='产品名称', exact=True)).to_have_value('旅行杯')
    await page.get_by_role('button', name='取消', exact=True).click()
    await expect(branch).to_be_visible()
