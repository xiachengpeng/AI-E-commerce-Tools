import {el,button} from './elements.mjs';
const states={paused:'后台已暂停',starting:'后台正在启动，尚未确认就绪',running:'后台正在运行',not_running:'后台未运行',degraded:'后台需要检查',unknown:'暂时无法确认后台状态'};
const polling={scope_expired:'执行授权已到期，当前仅查看触发记录',disabled:'飞书轮询未启用',waiting:'等待后台就绪',observing:'正在查看新触发，不自动加入任务队列',running:'按批准范围检查触发记录',failed:'最近一次检查失败',stale:'检查记录已过期',unknown:'轮询状态未知'};
const reasons={budget_worker_restart_required:'后台尚未载入本次调用上限，已阻止继续发送请求；请正常退出并重新打开客户端。',budget_restart_required:'本次调用上限尚未载入当前服务，请正常退出并重新打开客户端后再执行。',owner_missing:'未检测到后台进程，请正常退出后重新打开客户端。',heartbeat_pending:'已检测到进程，正在等待首次运行记录。',heartbeat_stale:'后台运行记录已过期，请先核对任务结果，避免重复提交。',owner_still_present:'已配置暂停，但进程仍在结束中。',polling_stale:'飞书检查记录已过期，请查看任务日志。',polling_failed:'最近一次飞书检查失败，请核对连接与任务日志。',configuration_unknown:'无法确认当前运行配置。',polling_policy_invalid:'后台执行范围配置无法确认，未扩大执行范围。',execution_scope_expired:'本次批准的执行窗口已结束。',budget_unavailable:'本次调用授权暂不可核对，未扩大授权范围。',status_unavailable:'本机状态暂不可读取，已有任务和数据保持不变。'};
const time=value=>{const stamp=new Date(value);return value&&Number.isFinite(stamp.getTime())?stamp.toLocaleString():'尚无记录';};
const count=value=>Number.isSafeInteger(value)&&value>=0?String(value):'未知';
export function renderWorkerStatus(context){
 const host=el(context,'section','rw-worker-status rw-worker-status-inline');host.dataset.workerStatus='';host.setAttribute('role','region');host.setAttribute('aria-label','后台任务状态');
 const title=el(context,'span','rw-worker-caption','后台任务'),status=el(context,'p','','正在读取后台状态…'),queue=el(context,'p'),poll=el(context,'p'),observed=el(context,'p','text-sm text-slate-500'),note=el(context,'p','text-sm text-slate-500');
 const budget=el(context,'p','text-sm text-slate-500');
 status.dataset.workerState='';status.setAttribute('role','status');queue.dataset.workerQueue='';
 const summary=el(context,'div','rw-worker-summary'),details=el(context,'details','rw-worker-details'),alert=el(context,'p','rw-worker-alert');alert.dataset.workerAlert='';alert.hidden=true;alert.setAttribute('role','status');
 summary.append(title,status,queue);details.append(el(context,'summary','','后台详情'),poll,budget,observed,note);host.append(summary,alert,details);let loading=false;
 async function refresh(){
  if(loading||!context.life.active)return;loading=true;
  try{
   const data=await context.api.request('/runtime-status',{method:'GET',signal:context.life.signal});
   if(!context.life.active)return;
   if(data?.contract_version!==1)throw Error('invalid status');
   status.textContent=states[data.worker_state]||states.unknown;status.dataset.state=data.worker_state||'unknown';
   queue.textContent='等待处理 '+count(data.queues?.queued)+' · 正在处理 '+count(data.queues?.running)+' · 需要查看 '+count(data.queues?.needs_attention);
   poll.textContent=polling[data.polling?.state]||polling.unknown;
   const budgetNames={apify:'广告采集',serpapi:'趋势研究',firecrawl:'商品读取',text_ai:'AI文字'};
   const budgetState={available:'已启用',exhausted:'次数已用完',expired:'已到期',unavailable:'暂不可确认'};
   budget.textContent=data.budget?'后台调用授权：'+(data.budget.bound_to_api===false?'等待重新打开客户端':budgetState[data.budget.state]||'未知')+'；'+Object.entries(data.budget.providers||{}).filter(([key])=>budgetNames[key]).map(([key,value])=>budgetNames[key]+' 已用'+count(value.used)+'/'+count(value.limit)).join(' · '):'后台调用授权：未启用额外会话';
   observed.textContent='本次观测：'+time(data.observed_at)+'；后台最近活动：'+time(data.heartbeat_at)+'；最近飞书检查：'+time(data.polling?.last_observed_at)+(data.polling?.next_expected_at?'；预计下次检查：'+time(data.polling.next_expected_at):'');
   const reason=(Array.isArray(data.reason_codes)?data.reason_codes:[]).map(code=>reasons[code]).filter(Boolean).join(' ');alert.textContent=reason;alert.hidden=!reason;note.textContent='状态约每15秒更新；查看或刷新不会启动采集，也不会修改飞书记录。';
  }catch{
   if(context.life.active){status.textContent=states.unknown;status.dataset.state='unknown';alert.hidden=false;alert.textContent='本次状态读取失败；如有数量或详情，为上次观测记录，请先核对任务结果。';}
  }finally{loading=false;}
 }
 summary.append(button(context,'刷新后台状态',refresh,'settings-log-button rw-worker-refresh'));
 void refresh();context.life.poll(refresh,15000);
 return host;
}
