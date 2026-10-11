
let liveLogProject=null,liveLogRows=[],liveLogStatus='';
const renderActionsBeforeProviders=renderActions;
renderActions=function(root){
 renderActionsBeforeProviders(root);
 for(const node of root.querySelectorAll('.action-record')){const idx=[...root.querySelectorAll('.action-record')].indexOf(node),action=S.actions[idx];if(!action)continue;node.append(el('p','muted',`关键词 / 对象：${actionKeyword(action)} · 执行方式：${action.execution_mode==='ai'?'AI 核对':action.execution_mode==='api'?'API':'UI 自动化'}`));if(action.failure_stage)node.append(el('p','muted','失败阶段：'+stageLabel(action.failure_stage)));if(action.diagnostic)node.append(el('p','notice',action.diagnostic));else if(action.status==='blocked')node.append(el('p','muted','旧记录未保存详细原因'));if(action.result?.evidence_kind==='json')node.append(link('查看接口证据',location.origin+'/workbench/api/projects/'+S.project.id+'/actions/'+action.id+'/provider-evidence'));}
 const panel=box('实时日志','实时推送执行阶段和失败原因；连接中断时自动恢复查询。'),status=el('p','muted'),lines=el('pre','live-log-lines');panel.classList.add('live-log-panel');status.dataset.liveLogStatus='true';lines.dataset.liveLogLines='true';panel.append(status,lines);root.append(panel);
};
function drawLiveLogs(){const status=document.querySelector('[data-live-log-status]');if(status)status.textContent=liveLogProject===S.project?.id?(liveLogStatus||'正在连接实时日志…'):'正在连接实时日志…';const lines=document.querySelector('[data-live-log-lines]');if(!lines)return;lines.textContent=liveLogProject===S.project?.id&&liveLogRows.length?liveLogRows.map(r=>`${time(r.created_at)} ${actionKeyword(r)} · ${r.execution_mode==='ai'?'AI 核对':r.execution_mode==='api'?'API':'UI 自动化'} [${r.action_id.slice(0,8)} / ${r.attempt}] ${stageLabel(r.stage)} · ${r.message}`).join('\n'):'暂无执行日志。';lines.scrollTop=lines.scrollHeight;}
const liveLogSession=createLogSession({
 openStream:typeof EventSource==='undefined'?null:(id,cursor)=>new EventSource('/workbench/api/projects/'+id+'/log-stream?after='+cursor),
 query:(id,cursor)=>api('/projects/'+id+'/live-logs?after='+cursor),
 onRows:rows=>{liveLogRows=[...liveLogRows,...rows].slice(-500);drawLiveLogs();},
 onStatus:message=>{liveLogStatus=message;const status=document.querySelector('[data-live-log-status]');if(status)status.textContent=message;},
});
async function pollLiveLogs(){
 const id=S.project&&document.querySelector('[data-live-log-lines]')?S.project.id:null;
 if(liveLogProject!==id){liveLogProject=id;liveLogRows=[];liveLogStatus='';}
 await liveLogSession.tick(id);
}
const renderBeforeLogSession=render;
render=function(){renderBeforeLogSession();if(!document.querySelector('[data-live-log-lines]')){liveLogSession.stop();liveLogProject=null;liveLogRows=[];liveLogStatus='';}else{drawLiveLogs();void pollLiveLogs();}};
window.addEventListener('pagehide',()=>liveLogSession.stop());
setInterval(pollLiveLogs,2000);
