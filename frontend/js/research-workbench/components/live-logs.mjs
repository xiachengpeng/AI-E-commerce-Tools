import { createLifecycle } from '../lifecycle.mjs';
import { projectPath } from '../services/actions.mjs';
import { el, panel, button } from './elements.mjs';
export async function consumeEvents(stream,life,onEvent){
 const reader=stream.getReader(),decoder=new TextDecoder();let pending='';
 const release=life.track(()=>{void reader.cancel().catch(()=>{});});
 try{while(life.active){const {done,value}=await reader.read();if(done)break;pending=(pending+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');
  if(pending.length>1048576)throw Error('日志消息过大');
  let end;while((end=pending.indexOf('\n\n'))>=0){const event=pending.slice(0,end);pending=pending.slice(end+2);const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data&&life.active)onEvent(JSON.parse(data));}
 }}finally{release();reader.releaseLock();}
}
export const logStageLabel=stage=>({start:'开始执行',browser:'启动采集浏览器',filters:'打开来源并设置筛选',read:'读取广告内容',screenshot:'保存来源截图',queued:'加入任务队列',source_open:'打开来源',source_wait:'等待来源响应',complete:'完成记录',failed:'执行失败',stopped:'停止执行',cloud_abort:'停止云端任务'})[stage]||'执行记录';
export function formatLogTime(value){const date=typeof value==='string'?new Date(value):null;return date&&!Number.isNaN(date.getTime())?date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'时间未记录';}
export function createActionLogs(context,options={}){
 let session=null;
 const host=panel(context,options.title||(context.designDirectForms?'任务日志':'执行持久日志'),options.note??'与主设置页的本进程日志分开保存。'),status=el(context,'p','rw-muted'),lines=el(context,'pre','rw-log-lines');host.dataset.actionLogPanel='true';host.classList.add('rw-log-panel');host.hidden=true;host.tabIndex=-1;host.setAttribute('role','region');host.setAttribute('aria-label','任务执行日志');status.setAttribute('role','status');const table=el(context,'table','rw-action-log-table');if(context.designDirectForms){const raw=el(context,'details','rw-action-log-raw');raw.append(el(context,'summary','','查看原始执行记录'),lines);host.append(status,table,raw);}else host.append(status,lines);
 function closeActionLogs(){session?.dispose();session=null;host.hidden=true;}
 context.life.track(closeActionLogs);
 async function openActionLogs(action_id){
  closeActionLogs();host.hidden=false;host.focus?.({preventScroll:true});if(options.autoScroll!==false)host.scrollIntoView?.({block:'start',behavior:'auto'});const life=createLifecycle();session=life;const release=context.life.track(()=>life.dispose());life.track(release);
  let cursor=0,rows=[],querying=false;
  const path=projectPath(context.state.project.id),query=()=>'?after='+cursor+(action_id?'&action_id='+encodeURIComponent(action_id):'');
  function accept(data){if(!life.active)return;if(data.message&&!data.logs){status.textContent=data.message;return;}
   const incoming=(data.logs||[]).filter(r=>Number.isInteger(r.id)&&r.id>cursor&&(!action_id||r.action_id===action_id));
   rows=[...rows,...incoming.filter(r=>!Number.isInteger(options.attempt)||r.attempt===options.attempt)].slice(-500);cursor=Math.max(cursor,...incoming.map(r=>r.id));
   lines.textContent=rows.map(r=>`${r.created_at||''} [${r.action_id||''} / ${r.attempt??'未知'}] ${r.stage||''} · ${r.message||''}`).join('\n')||'暂无执行日志。';status.textContent='已读取持久执行记录';if(context.designDirectForms){const head=el(context,'tr');for(const title of ['业务动作','时间','记录内容'])head.append(el(context,'th','',title));table.replaceChildren(head);if(!rows.length){const empty=el(context,'td','','暂无执行日志。');empty.colSpan=3;const row=el(context,'tr');row.append(empty);table.append(row);}for(const record of rows){const row=el(context,'tr');row.append(el(context,'td','',options.friendlyStages?logStageLabel(record.stage):({queued:'加入任务队列',source_open:'打开来源',source_wait:'等待来源响应',complete:'完成记录',failed:'执行失败'})[record.stage]||record.stage||'执行记录'),el(context,'td','',options.friendlyTimes?formatLogTime(record.created_at):record.created_at||'时间未记录'),el(context,'td','',record.message||'未记录说明'));table.append(row);}}
  }
  async function poll(){if(querying||!life.active)return;querying=true;try{accept(await context.api.request(path+'/live-logs'+query(),{signal:life.signal}));}catch{if(life.active)status.textContent='日志暂不可读，已有记录保留。';}finally{querying=false;}}
  status.textContent='正在读取日志…';lines.textContent='';table.replaceChildren();await poll();if(!life.active)return;
  try{const stream=await context.api.stream(path+'/log-stream'+query(),{signal:life.signal});await consumeEvents(stream,life,accept);}catch{if(life.active)status.textContent='日志推送中断，改用持久查询。';}
  if(life.active){await poll();life.poll(poll,3000);}
 }
 if(options.showClose!==false)host.append(button(context,'关闭日志',closeActionLogs));return {host,openActionLogs,closeActionLogs};
}
