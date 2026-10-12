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
export function createActionLogs(context){
 let session=null;
 const host=panel(context,'执行持久日志','与主设置页的本进程日志分开保存。'),status=el(context,'p','rw-muted'),lines=el(context,'pre','rw-log-lines');host.append(status,lines);
 function closeActionLogs(){session?.dispose();session=null;}
 context.life.track(closeActionLogs);
 async function openActionLogs(action_id){
  closeActionLogs();const life=createLifecycle();session=life;const release=context.life.track(()=>life.dispose());life.track(release);
  let cursor=0,rows=[],querying=false;
  const path=projectPath(context.state.project.id),query=()=>'?after='+cursor+(action_id?'&action_id='+encodeURIComponent(action_id):'');
  function accept(data){if(!life.active)return;if(data.message&&!data.logs){status.textContent=data.message;return;}
   const incoming=(data.logs||[]).filter(r=>Number.isInteger(r.id)&&r.id>cursor&&(!action_id||r.action_id===action_id));
   rows=[...rows,...incoming].slice(-500);cursor=Math.max(cursor,...incoming.map(r=>r.id));
   lines.textContent=rows.map(r=>`${r.created_at||''} [${r.action_id||''} / ${r.attempt??'未知'}] ${r.stage||''} · ${r.message||''}`).join('\n')||'暂无执行日志。';status.textContent='已读取持久执行记录';
  }
  async function poll(){if(querying||!life.active)return;querying=true;try{accept(await context.api.request(path+'/live-logs'+query(),{signal:life.signal}));}catch{if(life.active)status.textContent='日志暂不可读，已有记录保留。';}finally{querying=false;}}
  status.textContent='正在读取日志…';lines.textContent='';await poll();if(!life.active)return;
  try{const stream=await context.api.stream(path+'/log-stream'+query(),{signal:life.signal});await consumeEvents(stream,life,accept);}catch{if(life.active)status.textContent='日志推送中断，改用持久查询。';}
  if(life.active){await poll();life.poll(poll,3000);}
 }
 host.append(button(context,'关闭日志',closeActionLogs));return {host,openActionLogs,closeActionLogs};
}
