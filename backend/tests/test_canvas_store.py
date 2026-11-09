import io

import pytest
from PIL import Image
from services.canvas_store import CanvasStore


def png_bytes():
    buffer=io.BytesIO();Image.new('RGBA',(3,2),(255,0,0,128)).save(buffer,format='PNG');return buffer.getvalue()


def test_project_and_asset_survive_reopen_and_are_project_bound(tmp_path):
    store=CanvasStore(tmp_path);project=store.create_project('素材');asset=store.put_asset(project['id'],png_bytes());saved=store.save_project(project['id'],project['revision'],{'images':[{'asset_id':asset['id'],'x':10}]})
    reopened=CanvasStore(tmp_path);assert reopened.get_project(project['id'])['document']==saved['document'];assert reopened.read_asset(project['id'],asset['id'])==png_bytes()
    other=reopened.create_project('其他')
    with pytest.raises(ValueError):reopened.read_asset(other['id'],asset['id'])
    with pytest.raises(ValueError):reopened.save_project(project['id'],project['revision'],{})


def test_duplicate_task_identity_and_unknown_outcome_survive_restart(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('画布');first=store.create_task(p['id'],'client-key',{'prompt':'test'});second=store.create_task(p['id'],'client-key',{'prompt':'test'})
    assert first['id']==second['id'];assert store.claim_task(first['id']);reopened=CanvasStore(tmp_path);assert reopened.recover_pending()==1
    assert reopened.get_task(first['id'])['status']=='unknown'
    with pytest.raises(ValueError):reopened.create_task(p['id'],'client-key',{'prompt':'different'})


def test_invalid_and_oversized_assets_fail_without_project_corruption(tmp_path):
    store=CanvasStore(tmp_path,max_asset_bytes=128);p=store.create_project('P')
    with pytest.raises(ValueError):store.put_asset(p['id'],b'not an image')
    with pytest.raises(ValueError):store.put_asset(p['id'],b'x'*129)
    assert store.get_project(p['id'])['document']=={}


def test_submission_claim_is_atomic_and_unknown_cannot_be_resubmitted(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('画布');task=store.create_task(p['id'],'operation',{})
    assert store.claim_task(task['id']) is True
    assert store.claim_task(task['id']) is False
    store.mark_task(task['id'],'unknown')
    assert store.claim_task(task['id']) is False


def test_rejects_missing_or_foreign_assets_in_saved_document(tmp_path):
    store=CanvasStore(tmp_path);a=store.create_project('A');b=store.create_project('B');asset=store.put_asset(b['id'],png_bytes())
    with pytest.raises(ValueError):store.save_project(a['id'],a['revision'],{'images':[{'asset_id':asset['id']}]})


def test_unknown_task_cannot_be_marked_failed_or_reset_for_retry(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P');t=store.create_task(p['id'],'key',{})
    assert store.claim_task(t['id'])
    store.mark_task(t['id'],'unknown')
    with pytest.raises(ValueError):store.mark_task(t['id'],'failed')
    with pytest.raises(ValueError):store.mark_task(t['id'],'submitted')
    assert store.get_task(t['id'])['status']=='unknown'


def test_task_transition_requires_prior_claim(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P');t=store.create_task(p['id'],'key',{})
    with pytest.raises(ValueError):store.mark_task(t['id'],'complete')


def test_completed_result_must_belong_to_original_project(tmp_path):
    store=CanvasStore(tmp_path);a=store.create_project('A');b=store.create_project('B');task=store.create_task(a['id'],'task',{});own=store.put_asset(a['id'],png_bytes());foreign=store.put_asset(b['id'],png_bytes());assert store.claim_task(task['id'])
    with pytest.raises(ValueError):store.complete_task(task['id'],foreign['id'])
    assert store.get_task(task['id'])['status']=='submitted'
    assert store.complete_task(task['id'],own['id'])['result_asset_id']==own['id']
    with pytest.raises(ValueError):store.complete_task(task['id'],own['id'])


def test_list_projects_and_asset_metadata(tmp_path):
    store=CanvasStore(tmp_path);first=store.create_project('第一');second=store.create_project('第二');asset=store.put_asset(first['id'],png_bytes())
    assert {p['id'] for p in store.list_projects()}=={first['id'],second['id']}
    assert store.asset_info(first['id'],asset['id'])['mime_type']=='image/png'
    with pytest.raises(ValueError):store.asset_info(second['id'],asset['id'])


def test_total_quota_rejects_new_asset_without_losing_old_one(tmp_path):
    data=png_bytes();store=CanvasStore(tmp_path,max_total_bytes=len(data));p=store.create_project('P');a=store.put_asset(p['id'],data)
    with pytest.raises(ValueError,match='空间'):store.put_asset(p['id'],data)
    assert store.read_asset(p['id'],a['id'])==data


def test_task_keeps_original_request_and_result_metadata_across_restart(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P');r={'prompt':'edit','reference_ids':['asset-x']};t=store.create_task(p['id'],'id',r);assert store.claim_task(t['id']);result=store.put_asset(p['id'],png_bytes());store.complete_task(t['id'],result['id'])
    recovered=CanvasStore(tmp_path).get_task(t['id']);assert recovered['request']==r and recovered['result_asset_id']==result['id']


def test_task_list_recovers_operation_keys_after_restart_and_is_project_scoped(tmp_path):
    s=CanvasStore(tmp_path);a=s.create_project('A');b=s.create_project('B');s.create_task(a['id'],'op-1',{'prompt':'saved'});s.create_task(b['id'],'op-2',{});
    tasks=CanvasStore(tmp_path).list_tasks(a['id']);assert len(tasks)==1;assert tasks[0]['operation_key']=='op-1';assert tasks[0]['request']['prompt']=='saved'


def test_manual_acknowledgement_keeps_unknown_outcome_but_persists_review(tmp_path):
    s=CanvasStore(tmp_path);p=s.create_project('P');t=s.create_task(p['id'],'op',{});assert s.claim_task(t['id']);s.mark_task(t['id'],'unknown');s.acknowledge_unknown(p['id'],'op');stored=CanvasStore(tmp_path).task_by_operation(p['id'],'op');assert stored['status']=='unknown' and stored['reviewed'] is True;assert not s.claim_task(t['id'])


def test_task_error_reason_survives_restart_and_is_returned_in_task_history(tmp_path):
    s=CanvasStore(tmp_path);p=s.create_project('P');t=s.create_task(p['id'],'op',{});assert s.claim_task(t['id'])
    s.mark_task(t['id'],'unknown',error_message='服务商响应超时；无法确认是否已完成或计费。')
    reopened=CanvasStore(tmp_path)
    assert reopened.get_task(t['id'])['error_message']=='服务商响应超时；无法确认是否已完成或计费。'
    assert reopened.list_tasks(p['id'])[0]['error_message']=='服务商响应超时；无法确认是否已完成或计费。'


def test_result_commit_atomically_attaches_asset_and_is_project_bound(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P');t=store.create_task(p['id'],'op',{});assert store.claim_task(t['id'])
    done=store.put_task_result(t['id'],p['id'],png_bytes())
    assert done['status']=='complete'
    assert CanvasStore(tmp_path).read_asset(p['id'],done['result_asset_id'])==png_bytes()
    with pytest.raises(ValueError):store.put_task_result(t['id'],p['id'],png_bytes())


def test_recovery_attaches_a_durable_result_written_before_database_commit(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P');t=store.create_task(p['id'],'op',{});assert store.claim_task(t['id'])
    (store.assets / ('result-'+t['id'])).write_bytes(png_bytes())
    CanvasStore(tmp_path).recover_pending()
    task=store.get_task(t['id']);assert task['status']=='complete'
    assert store.read_asset(p['id'],task['result_asset_id'])==png_bytes()


def test_recovery_does_not_interrupt_a_live_submission(tmp_path):
    first=CanvasStore(tmp_path);p=first.create_project('P');t=first.create_task(p['id'],'live',{})
    with first.task_lease(t['id']):
        assert first.claim_task(t['id'])
        assert CanvasStore(tmp_path).recover_pending()==0
        assert first.get_task(t['id'])['status']=='submitted'
    assert CanvasStore(tmp_path).recover_pending()==1
    assert first.get_task(t['id'])['status']=='unknown'
    assert '未收到服务商最终回执' in first.get_task(t['id'])['error_message']


def test_recovery_marks_never_submitted_reservations_as_retryable_failure(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P');t=store.create_task(p['id'],'prepared',{})
    assert store.recover_pending()==1
    recovered=store.get_task(t['id'])
    assert recovered['status']=='failed' and '尚未提交' in recovered['error_message']


def test_recovery_attaches_complete_temporary_result_after_crash(tmp_path):
    store=CanvasStore(tmp_path);p=store.create_project('P');t=store.create_task(p['id'],'op',{});assert store.claim_task(t['id'])
    (store.assets / ('result-'+t['id']+'.tmp')).write_bytes(png_bytes())
    CanvasStore(tmp_path).recover_pending()
    task=store.get_task(t['id']);assert task['status']=='complete'
    assert store.read_asset(p['id'],task['result_asset_id'])==png_bytes()
