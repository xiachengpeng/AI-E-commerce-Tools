import {createLifecycle} from '../lifecycle.mjs';
import {el,button} from './elements.mjs';
import {actionStatus} from '../services/actions.mjs';
import {createActionLogs,logStageLabel} from './live-logs.mjs';
let sequence=0;
export function createCollectionLogDialog(context,word,onClose){
 const life=createLifecycle(),dialog=el(context,'dialog','rw-action-dialog rw-collection-log-dialog'),trigger=context.root.ownerDocument.activeElement;
 const c={...context,root:dialog,life},initial=context.state.keywordActions?.[word.id],actionId=initial?.id;
 const matches=a=>a?.id===actionId&&!!actionId&&a.kind==='scan'&&a.keyword_id===word.id&&Number.isInteger(a.attempt)&&a.attempt>=0;
 dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
 const body=el(c,'section','rw-panel'),title=el(c,'h2','','采集日志');title.id='rw-collection-log-'+(++sequence);title.tabIndex=-1;dialog.setAttribute('aria-labelledby',title.id);
 const close=button(c,'关闭日志窗口',onClose,'rw-action-dialog-close');close.setAttribute('aria-label','关闭日志窗口');close.textContent='×';
 const overview=el(c,'section','rw-collection-log-overview');body.append(title,el(c,'p','rw-muted','搜索词：'+word.text),overview);
 const options={autoScroll:false,showClose:false,friendlyStages:true,friendlyTimes:true,title:'执行过程',note:'仅显示当前任务本次尝试的记录，时间按本机时区显示。'};let logs,lastAttempt=null,closed=false;
 function update(action){
  if(closed||!life.active)return;
  if(!matches(action)){if(lastAttempt===null)overview.textContent='未找到本次采集的任务记录，无法确认未完成原因；不会用其他搜索词的日志补充。';return;}
  overview.textContent='';overview.replaceChildren(el(c,'strong','',(action.display_status==='stopped'||action.status==='stopped'?'本次已停止':['blocked','failed'].includes(action.status)?'采集未完成':actionStatus(action))+(action.attempt?' · 第 '+action.attempt+' 次尝试':' · 等待开始执行')));
  if(action.failure_stage)overview.append(el(c,'p','','停在：'+logStageLabel(action.failure_stage)));
  for(const value of [...new Set([action.diagnostic,action.message].filter(Boolean))])overview.append(el(c,'p','',value));
  if(!action.diagnostic&&!action.message)overview.append(el(c,'p','',action.status==='complete'?'本次采集已完成，条数以已保存结果为准。':['ready','queued','running'].includes(action.status)?'采集正在排队或执行，请查看下方进度。':'尚未记录明确原因，请核对下方执行记录；未完成不代表零结果。'));
  const next=action.recovery_action==='manual'?'提交结果不确定：请先核对来源端任务状态，避免重复采集或收费。':action.recovery_action==='resume'?'可关闭此窗口，使用“继续查询结果”核对已有任务，无需重新创建采集。':['blocked','failed','stopped'].includes(action.status)?'先根据记录检查网络和来源页面状态，确认后再使用原页面的搜索恢复入口。':'这里只读取已保存的执行记录，不会开始新的采集。';
  overview.append(el(c,'p','rw-muted','下一步：'+next));
  if(!logs){logs=createActionLogs(c,options);body.append(logs.host);}
  if(lastAttempt!==action.attempt){lastAttempt=action.attempt;options.attempt=action.attempt;void logs.openActionLogs(action.id);}
 }
 dialog.append(close,body);
 const controller={keywordId:word.id,needsPaint:false,update,close({restoreFocus=true}={}){if(closed)return;closed=true;life.dispose();if(dialog.open&&dialog.close)dialog.close();dialog.remove();if(restoreFocus&&trigger?.isConnected!==false)trigger?.focus?.({preventScroll:true});}};
 life.listen(dialog,'cancel',event=>{event.preventDefault();onClose();});const detach=context.life.track(()=>controller.close({restoreFocus:false}));life.track(detach);
 update(initial);context.root.append(dialog);if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');title.focus({preventScroll:true});return controller;
}
