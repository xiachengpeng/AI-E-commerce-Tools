import { createLifecycle } from '../lifecycle.mjs';
import { el,button,panel,notify } from '../components/elements.mjs';
import { createActionService,actionStatus,retryEligible,trendsQuery,projectPath } from '../services/actions.mjs';
import { createActionLogs } from '../components/live-logs.mjs';
import { renderEvents } from '../components/events.mjs';
import { renderAds,mediaControl } from '../components/ad-copy.mjs';
export function renderActions(context){
 const host=el(context,'section'),heading=el(context,'h1','','动作队列');heading.tabIndex=-1;host.append(heading,button(context,'返回探索',()=>context.navigate('project')));
 const service=createActionService(context),logs=createActionLogs(context),records=panel(context,'自动处理记录','执行状态不代表产品已通过筛选；没有可确认结果时保留未知。'),sources=panel(context,'来源可用性','仅显示配置状态；不探测或自动采集。');
 async function refresh(older=false){try{await service.load(older);if(context.life.active)draw();}catch(error){if(context.life.active)notify(context,error.message+'。已保存记录保持显示。');}}
 const selection=context.state.queueSelection,kinds={keywords:'AI 建议初始词',scan:'搜索这个词',scan_all:'扫描全部已审核词',expand:'提取下一层建议',landing:'读取商品页面',verify:'核对商品',trends:'采集 Trends'};
 if(selection?.kind&&kinds[selection.kind])host.append(panel(context,'已选择操作',kinds[selection.kind]),button(context,'确认提交：'+kinds[selection.kind],async()=>{const {action_id,...request}=selection;const outcome=await service.enqueue(request);if(!context.life.active)return;notify(context,outcome.disposition==='unchanged'?'已有任务，未重复入队。':'已保存执行请求；尚未确认取得结果。');await refresh();},'rw-primary'));
 let recordLife=null,lastRecords='';context.life.track(()=>recordLife?.dispose());
 function draw(){const signature=JSON.stringify([context.state.actions,context.state.actionCursor]);if(signature===lastRecords)return;lastRecords=signature;recordLife?.dispose();recordLife=createLifecycle();const rowContext={...context,life:recordLife};
 records.replaceChildren(el(context,'h2','','自动处理记录'));
  for(const action of context.state.actions||[]){const row=panel(rowContext,action.label||action.kind,actionStatus(action));row.dataset.rwAction=action.id;
   row.append(el(context,'p','rw-muted',`${action.keyword_text||action.keyword_id||action.product_id||'对象未记录'} · 尝试 ${action.attempt??'未知'} · ${action.execution_mode||'执行方式未知'} · ${action.observed_at?'实际观察 '+action.observed_at:'旧记录时间 '+(action.updated_at||'未知')}`));
   for(const value of [action.message,action.failure_stage&&'失败阶段：'+action.failure_stage,action.diagnostic])if(value)row.append(el(context,'p','rw-notice',value));
   if(action.status==='complete')row.append(el(context,'p','rw-muted',Number.isInteger(action.result?.ads)?'本次采集 '+action.result.ads+' 条（限定样本）':'本次条数未记录；不推断为零。'));
   row.append(button(rowContext,'查看任务日志',()=>{void logs.openActionLogs(action.id);}));
   if(['ready','queued','running'].includes(action.status)&&Number.isInteger(action.attempt))row.append(button(rowContext,'停止本次尝试',async()=>{await service.stop(action);if(context.life.active)await refresh();}));
   if(retryEligible(action)){
    let queryInput;
    if(action.kind==='trends'){
     const queryKey=action.id+':'+action.attempt;context.state.actionQueries||={};
     const label=el(rowContext,'label','','当地常用产品搜索词');queryInput=el(rowContext,'input');queryInput.type='text';queryInput.name='trends_query';queryInput.required=true;queryInput.maxLength=200;queryInput.setAttribute('aria-label','当地常用产品搜索词');
     queryInput.value=context.state.actionQueries[queryKey]??trendsQuery(action);rowContext.life.listen(queryInput,'input',()=>{context.state.actionQueries[queryKey]=queryInput.value;});label.append(queryInput);row.append(label,el(rowContext,'p','rw-muted','按目标市场输入真实查询词；不自动从商品名推断。'));
    }
    row.append(button(rowContext,action.recovery_action==='resume'?'继续查询结果':'显式重试失败任务',async()=>{await service.retry(action,queryInput?{query:queryInput.value}:{});if(context.life.active)await refresh();}));
   }
   if(action.result?.evidence_id)row.append(mediaControl(rowContext,projectPath(context.state.project.id)+'/actions/'+encodeURIComponent(action.id)+'/screenshot','读取采集截图'));
   if(action.result?.evidence_kind==='json')row.append(button(rowContext,'查看接口证据',async()=>{const proof=await context.api.request(projectPath(context.state.project.id)+'/actions/'+encodeURIComponent(action.id)+'/provider-evidence',{signal:context.life.signal});if(context.life.active)row.append(el(context,'pre','rw-log-lines',JSON.stringify(proof,null,2)));}));
   records.append(row);
  }
  records.append(button(context,'刷新任务状态',()=>refresh()));if(context.state.actionCursor)records.append(button(context,'加载更早记录',()=>refresh(true)));
 }
 host.append(sources,records,logs.host,renderAds(context),renderEvents(context));draw();
 void context.api.request('/sources',{signal:context.life.signal}).then(data=>{if(!context.life.active)return;for(const source of data.sources||[])sources.append(el(context,'p','rw-muted',`${source.name} · ${source.status|| (source.available===true?'可用':'未配置 / 未验证')} · ${source.integration_message||source.note||''}`));}).catch(error=>{if(context.life.active)sources.append(el(context,'p','rw-notice',error.message));});
 let polling=false;context.life.poll(async()=>{if(polling)return;polling=true;try{await refresh();}finally{polling=false;}},3000);void refresh();return host;
}
