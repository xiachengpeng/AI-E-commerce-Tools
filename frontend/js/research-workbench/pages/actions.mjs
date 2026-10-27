import {icon} from '../components/presentation.mjs';
import {renderActionConfirmation,trackedActionFeedback} from '../components/action-confirmation.mjs';
import { createLifecycle } from '../lifecycle.mjs';
import { el,button,panel,notify } from '../components/elements.mjs';
import { createActionService,actionResultSummary,actionStatus,actionProgress,retryEligible,trendsQuery,projectPath } from '../services/actions.mjs';
import { createActionLogs } from '../components/live-logs.mjs';
import { renderEvents } from '../components/events.mjs';
import { renderAds,mediaControl } from '../components/ad-copy.mjs';
export function renderActions(context){
 const host=el(context,'section'),heading=el(context,'h1','','研究任务');heading.tabIndex=-1;host.append(heading,el(context,'p','rw-task-description','系统按步骤处理研究任务；需要核对、重试或补充资料时会在这里提示。'),button(context,'返回探索',()=>context.navigate('project')));
 const service=createActionService(context),logs=createActionLogs(context),records=panel(context,'自动处理记录','执行状态不代表产品已通过筛选；没有可确认结果时保留未知。'),sources=panel(context,'来源可用性','仅显示配置状态；不探测或自动采集。');
 async function refresh(older=false){try{await service.load(older);if(!older)await context.refreshProject?.(false);if(context.life.active)draw();}catch(error){if(context.life.active)notify(context,error.message+'。已保存记录保持显示。');}}
 const selection=context.state.queueSelection;
 if(selection?.kind){const choice=renderActionConfirmation(context,selection,async()=>{context.state.queueSelection=null;await refresh();});if(choice)host.append(choice);}
 const taskList=el(context,'section','rw-task-list'),taskDetail=el(context,'section','rw-task-detail');let recordLife=null,lastRecords='',adsLife=null,lastAds='';const adsHost=el(context,'div');context.life.track(()=>{recordLife?.dispose();adsLife?.dispose();});
 function draw(){
  const feedback=trackedActionFeedback(context.state);if(feedback&&feedback!==context.state.lastResearchFeedback){context.state.lastResearchFeedback=feedback;notify(context,feedback);}
  const adSignature=JSON.stringify(context.state.project.keywords||[]);
  if(adSignature!==lastAds){lastAds=adSignature;adsLife?.dispose();adsLife=createLifecycle();adsHost.replaceChildren(renderAds({...context,life:adsLife}));}
  const signature=JSON.stringify([context.state.actions,context.state.actionCursor,context.state.selectedResearchAction,context.state.researchTaskFilter]);if(signature===lastRecords)return;lastRecords=signature;recordLife?.dispose();recordLife=createLifecycle();const rowContext={...context,life:recordLife};
 const actions=context.state.actions||[],matches=(action,filter)=>filter==='running'?['ready','queued','running'].includes(action.status):filter==='attention'?['blocked','failed'].includes(action.status):true,filter=context.state.researchTaskFilter||'all',visible=actions.filter(a=>matches(a,filter)),selected=visible.find(a=>a.id===context.state.selectedResearchAction)||visible[0];taskList.replaceChildren(el(context,'h2','','研究任务（'+actions.length+'）'));const filters=el(context,'nav','rw-task-filters');filters.setAttribute('aria-label','任务状态筛选');for(const [value,label] of [['all','全部'],['running','进行中'],['attention','需处理']]){const choice=button(rowContext,label+'（'+actions.filter(a=>matches(a,value)).length+'）',()=>{context.state.researchTaskFilter=value;logs.closeActionLogs();draw();});choice.setAttribute('aria-pressed',String(filter===value));filters.append(choice);}taskList.append(filters);records.replaceChildren(el(context,'h2','','任务详情'));if(!visible.length)taskList.append(el(context,'p','rw-muted',actions.length?'当前分类暂无任务。':'暂时没有研究任务。'));
  for(const action of context.state.actions||[]){const row=panel(rowContext,action.label||action.kind,actionStatus(action));row.dataset.rwAction=action.id;row.hidden=selected?.id!==action.id;const progress=el(rowContext,'nav','rw-task-progress');progress.setAttribute('aria-label','任务进度');for(const step of actionProgress(action)){const item=el(rowContext,'span');item.dataset.state=step.state;item.append(icon(rowContext,step.state==='done'?'check-circle':step.state==='blocked'?'warning-circle':step.state==='current'?'circle-notch':'circle'),el(rowContext,'span','',step.label));progress.append(item);}row.append(progress);const select=button(rowContext,'',()=>{context.state.selectedResearchAction=action.id;draw();void logs.openActionLogs(action.id);},'rw-task-select'),copy=el(rowContext,'span');copy.append(el(rowContext,'strong','',action.label||action.kind),el(rowContext,'small','',action.keyword_text||action.product_name||'当前研究'),el(rowContext,'span','rw-tag',actionStatus(action)));select.setAttribute('aria-pressed',String(selected?.id===action.id));select.hidden=!matches(action,filter);select.append(icon(rowContext,({scan:'megaphone',meta:'megaphone',landing:'browser',trends:'chart-bar',keywords:'magnifying-glass',verify:'check-square'})[action.kind]||'file-text'),copy);taskList.append(select);
   row.append(el(context,'p','rw-muted',`${action.keyword_text||context.state.project.keywords?.find(k=>k.id===action.keyword_id)?.text||context.state.project.products?.find(p=>p.id===action.product_id)?.name||'当前研究'} · 尝试 ${action.attempt??'未知'} · ${(['keywords','expand','verify'].includes(action.kind)?'AI':action.kind==='landing'?'页面读取':({ui:'本机浏览器',api:'API'})[action.execution_mode]||'执行方式未知')} · ${action.observed_at?'实际观察 '+new Date(action.observed_at).toLocaleString('zh-CN'):'任务更新 '+(action.updated_at?new Date(action.updated_at).toLocaleString('zh-CN'):'未知')}`));
   for(const value of [action.message,action.failure_stage&&'失败阶段：'+action.failure_stage,action.diagnostic])if(value)row.append(el(context,'p','rw-notice',value));
   if(action.status==='complete')row.append(el(context,'p','rw-muted',actionResultSummary(action)));
   row.append(button(rowContext,'查看任务日志',()=>{void logs.openActionLogs(action.id);},'rw-task-open-logs'));
   if(['ready','queued','running'].includes(action.status)&&Number.isInteger(action.attempt))row.append(button(rowContext,'停止本次尝试',async()=>{await service.stop(action);if(context.life.active)await refresh();}));
   if(retryEligible(action)){
    let queryInput;
    if(action.kind==='trends'){
     const queryKey=action.id+':'+action.attempt;context.state.actionQueries||={};
     const label=el(rowContext,'label','','当地常用产品搜索词');queryInput=el(rowContext,'input');queryInput.type='text';queryInput.name='trends_query';queryInput.required=true;queryInput.maxLength=200;queryInput.setAttribute('aria-label','当地常用产品搜索词');
     queryInput.value=context.state.actionQueries[queryKey]??trendsQuery(action);rowContext.life.listen(queryInput,'input',()=>{context.state.actionQueries[queryKey]=queryInput.value;});label.append(queryInput);row.append(label,el(rowContext,'p','rw-muted','按目标市场输入真实查询词；不自动从商品名推断。'));
    }
    row.append(button(rowContext,action.recovery_action==='resume'?'继续查询结果':'显式重试失败任务',async()=>{await service.retry(action,queryInput?{query:queryInput.value}:{});if(context.life.active)await refresh();},'rw-primary rw-task-retry'));
   }
   if(action.result?.evidence_id)row.append(mediaControl(rowContext,projectPath(context.state.project.id)+'/actions/'+encodeURIComponent(action.id)+'/screenshot','读取采集截图'));
   if(action.result?.evidence_kind==='json')row.append(button(rowContext,'查看接口证据',async()=>{const proof=await context.api.request(projectPath(context.state.project.id)+'/actions/'+encodeURIComponent(action.id)+'/provider-evidence',{signal:context.life.signal});if(context.life.active)row.append(el(context,'pre','rw-log-lines',JSON.stringify(proof,null,2)));}));
   records.append(row);
  }
  records.append(button(context,'刷新任务状态',()=>refresh()));if(context.state.actionCursor)records.append(button(context,'加载更早记录',()=>refresh(true)));
 }
 const sourceDetails=el(context,'details','rw-task-sources');sourceDetails.append(el(context,'summary','','来源可用性'),sources);
 const workspace=el(context,'div','rw-task-workspace');taskDetail.append(records,logs.host);workspace.append(taskList,taskDetail);
 const adsDetails=el(context,'details','rw-task-related');adsDetails.append(el(context,'summary','','查看已保存广告与媒体'),adsHost);
 const eventDetails=el(context,'details','rw-task-related');eventDetails.append(el(context,'summary','','查看研究事件'),renderEvents(context));
 host.append(workspace,sourceDetails,adsDetails,eventDetails);draw();
 void context.api.request('/sources',{signal:context.life.signal}).then(data=>{if(!context.life.active)return;for(const source of data.sources||[]){const mode=context.state.project.collection_modes?.[source.key]||(['meta','trends'].includes(source.key)?'ui':null),ui=mode==='ui';sources.append(el(context,'p','rw-muted',`${source.name} · ${ui?'本机浏览器模式':({healthy:'已连接',configured:'已配置，待验证',unconfigured:'接口未配置'})[source.status]||(source.available===true?'可手动记录（未连接自动采集）':'待验证')} · ${ui?'不依赖采集API密钥；本次来源是否可访问以任务结果为准。':source.integration_message||source.note||''}`));}}).catch(error=>{if(context.life.active)sources.append(el(context,'p','rw-notice',error.message));});
 let polling=false;context.life.poll(async()=>{if(polling)return;polling=true;try{await refresh();}finally{polling=false;}},3000);void refresh();return host;
}
