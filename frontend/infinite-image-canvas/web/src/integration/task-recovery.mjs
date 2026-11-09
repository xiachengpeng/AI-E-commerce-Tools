export function taskRecoveryAction(task, represented) {
  if(task.status==='complete' && (task.result_asset_id || task.result_text)) return represented.has(task.id)?'already-added':'restore';
  if(task.status==='unknown' && !task.reviewed) return 'review';
  if(task.status==='unknown' && task.reviewed) return 'retry';
  if(task.status==='failed') return 'retry';
  if(task.status==='prepared') return 'cancel';
  if(task.status==='submitted') return 'wait';
  return 'none';
}
