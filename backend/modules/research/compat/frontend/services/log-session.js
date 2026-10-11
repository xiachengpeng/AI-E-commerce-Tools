'use strict';
// Transport lifetime is separate from rendering: project changes close old streams.
function createLogSession({openStream,query,onRows,onStatus,now=()=>Date.now()}){
 let project=null,cursor=0,stream=null,busy=false,lastRetry=0,generation=0,connectAt=0,connected=false;
 function close(){if(stream)stream.close();stream=null;connected=false;}
 function select(id){if(id===project)return;close();project=id;cursor=0;generation++;lastRetry=0;busy=false;}
 function consume(data){
  if(!data||!Array.isArray(data.logs)||!Number.isSafeInteger(data.cursor)||data.cursor<cursor)throw Error('日志响应格式无效');
  const rows=data.logs.filter(row=>Number.isSafeInteger(row.id)&&row.id>cursor);
  cursor=data.cursor;onRows(rows);
 }
 function connect(){
  if(!project||stream||!openStream)return;
  const id=project,version=generation;
  try{
   const current=openStream(id,cursor);stream=current;connectAt=now();connected=false;
   current.onopen=()=>{if(generation===version&&stream===current){connected=true;onStatus('推送已连接 · 等待任务日志');}};
   current.addEventListener('logs',event=>{
    if(project!==id||generation!==version||stream!==current)return;
    try{connected=true;consume(JSON.parse(event.data));onStatus('推送已连接 · 日志实时更新');}
    catch{close();lastRetry=now();onStatus('推送数据异常，正在通过查询恢复');}
   });
   current.addEventListener('unavailable',()=>{if(generation===version&&stream===current){close();lastRetry=now();onStatus('推送暂不可用，正在通过查询恢复');}});
   current.onerror=()=>{if(generation===version&&stream===current){close();lastRetry=now();onStatus('推送连接中断，正在通过查询恢复');}};
  }catch{lastRetry=now();onStatus('推送暂不可用，正在通过查询恢复');}
 }
 async function tick(id){
  select(id);
  if(!project)return;
  if(stream&&!connected&&now()-connectAt>=10000){close();lastRetry=now();onStatus('推送连接超时，正在通过查询恢复');}
  if(!stream&&(!lastRetry||now()-lastRetry>=15000))connect();
  if(stream||busy)return;
  busy=true;const expected=project,version=generation;
  try{const data=await query(expected,cursor);if(project!==expected||generation!==version)return;consume(data);onStatus('查询已更新 · 自动恢复推送');}
  catch(error){if(generation===version)onStatus('日志连接中断，正在重试：'+error.message);}
  finally{if(generation===version)busy=false;}
 }
 function stop(){select(null);}
 return {tick,select,stop};
}
