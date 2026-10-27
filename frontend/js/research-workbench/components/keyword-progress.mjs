import {el,button} from './elements.mjs';
import {actionStatus,actionResultSummary} from '../services/actions.mjs';

/** Read the existing page snapshot only; no extra polling, writes or AI requests. */
export function createKeywordProgress(context,{onBusy=()=>{}}={}){
 const projectId=context.state.project.id,host=el(context,'section','rw-keyword-progress');host.dataset.keywordProgress='';host.setAttribute('aria-label','AI 初始词任务状态');
 const header=el(context,'div','rw-keyword-progress-heading'),mark=el(context,'i','ph ph-circle-notch'),title=el(context,'strong','','AI 初始词建议'),badge=el(context,'span','rw-tag'),summary=el(context,'p','rw-keyword-progress-summary'),reason=el(context,'p','rw-keyword-progress-reason');mark.setAttribute('aria-hidden','true');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
 let currentAction=null;
 const details=button(context,'查看任务详情',()=>{if(!currentAction?.id)return;context.state.selectedResearchAction=currentAction.id;context.navigate('actions');},'rw-keyword-progress-details');
 header.append(mark,title,badge,details);host.append(header,summary,reason);
 function update(){
  if(!context.life.active)return;
  const state=context.state,tracked=state.lastResearchAction;
  if(state.project?.id!==projectId){host.hidden=true;onBusy(false);return;}
  const candidates=(state.actions||[]).filter(a=>a.kind==='keywords'&&(!a.project_id||a.project_id===projectId));
  const trackedHere=tracked?.projectId===projectId;
  currentAction=candidates.find(a=>trackedHere&&a.id===tracked.id)||
   (trackedHere&&tracked.kind==='keywords'?{id:tracked.id,kind:'keywords',status:'awaiting_status'}:candidates[0]);
  host.hidden=!currentAction;if(!currentAction){onBusy(false);return;}
  const status=currentAction.status,pending=['ready','queued','running','awaiting_status'].includes(status);onBusy(pending);host.dataset.state=status;
  mark.className='ph '+(pending?'ph-circle-notch rw-keyword-spinner':status==='complete'?'ph-check-circle':'ph-warning-circle');badge.textContent=status==='awaiting_status'?'正在核对状态':actionStatus(currentAction);
  summary.textContent=status==='awaiting_status'?'请求已保存，正在核对执行状态；请勿重复提交。':status==='running'?'正在根据研究方向准备搜索词，可留在本页等待结果。':['ready','queued'].includes(status)?'请求已排队，将根据研究方向准备搜索词；无需重复点击。':status==='complete'?actionResultSummary(currentAction)+'，请在下方逐项审核后再搜索。':'初始词准备尚未完成，已有研究资料保留。请核对下面的原因与任务记录。';
  const messages=[currentAction.message,currentAction.failure_stage&&'失败环节：'+currentAction.failure_stage,currentAction.diagnostic].filter(v=>typeof v==='string'&&v.trim());reason.textContent=[...new Set(messages)].join(' ');reason.hidden=!reason.textContent;
  details.hidden=!currentAction.id;
 }
 update();return {host,update};
}
