async function api(path,options={}){
 const ctx=S.form?.submitting&&$('dialog').open?S.form:null;
 if(ctx&&options.method==='POST'&&options.body&& !path.includes('/sync')){
  const body=JSON.parse(options.body);if('version' in body)body.version=ctx.version;body.command_id=ctx.command_id;
  const content={...body};delete content.version;delete content.command_id;
  const hash=await submissionFingerprint(content);
  if(ctx.submittedHash&&ctx.submittedHash!==hash){
   if(ctx.uncertain&&!ctx.projectId)throw Error('此前新建项目的保存状态未确认，请恢复原输入重试，再修改已创建的项目，避免重复创建。');
   if(ctx.uncertain&&ctx.projectId){const p=await api('/projects/'+ctx.projectId);if(!p.events?.some(e=>e.command_id===ctx.command_id))throw Error('此前保存状态未确认，请先保持原输入重试或刷新核对，避免重复提交。');S.project=p;ctx.version=p.version;body.version=p.version;}
   ctx.command_id=newCommandId();body.command_id=ctx.command_id;
  }
  ctx.submittedHash=hash;ctx.uncertain=true;saveDraft(ctx);options={...options,body:JSON.stringify(body)};
 }
 const headers={'Content-Type':'application/json',...(options.method?{'X-Workbench-Token':S.token}:{})};
 const r=await fetch('/workbench/api'+path,{...options,headers,signal:AbortSignal.timeout(25000)});let d;
 try{d=await r.json();}catch{throw Error('服务未返回有效数据；保存状态可能未确认，请核对后重试。');}
 if(!r.ok){if(ctx&&r.status<500){ctx.uncertain=false;saveDraft(ctx);}const err=Error(typeof d.detail==='string'?d.detail:'输入校验失败，请检查字段');err.status=r.status;throw err;}
 if(ctx&&options.method==='POST'){ctx.uncertain=false;saveDraft(ctx);}return d;
}
function mergeActionRows(current,incoming){const byId=new Map(current.map(item=>[item.id,item]));for(const item of incoming)byId.set(item.id,item);return [...byId.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));}
async function load(){const id=S.project?.id;const projects=(await api('/projects')).projects;let project=S.project,actions=S.actions,keywordActions=S.keywordActions,productActions=S.productActions,verificationActions=S.verificationActions,syncRuns=S.syncRuns;if(id){project=await api('/projects/'+id);const page=await api('/projects/'+id+'/actions?limit=20');keywordActions=page.keyword_actions||{};verificationActions=page.verification_actions||{};productActions=page.product_actions||{};const hadActions=actions.length>0;actions=mergeActionRows(actions,page.actions);if(!hadActions)S.actionCursor=page.next_cursor||null;try{syncRuns=(await api('/projects/'+id+'/sync')).runs;}catch{syncRuns=[];}}if(id!==S.project?.id)return;S.projects=projects;S.project=project&&S.project&&project.version<S.project.version?S.project:project;S.actions=actions;S.keywordActions=keywordActions;S.productActions=productActions;S.verificationActions=verificationActions;S.syncRuns=syncRuns;const all=S.projects.flatMap(p=>p.todos||[]);$('todo-count').textContent=all.length;$('connection').textContent='已同步 '+new Date().toLocaleTimeString('zh-CN',{hour12:false});}
async function afterSave(message='已保存。'){const queued=S.nextFeedback;S.nextFeedback=null;const savedMessage=queued?.message||message;if(S.project){const index=S.projects.findIndex(p=>p.id===S.project.id);if(index>=0)S.projects[index]=S.project;else S.projects.push(S.project);}render();warn(savedMessage,undefined,queued?.action);try{await load();render();}catch(e){warn(savedMessage+' 后续列表刷新未完成，请稍后刷新核对。当前页面保留服务器返回的保存版本。','alert');$('connection').textContent='刷新未完成';}}
async function refresh(){if(S.busy||$('dialog').open||S.form?.submitting)return;S.busy=true;const before=JSON.stringify([S.projects,S.project,S.actions,S.keywordActions,S.productActions,S.verificationActions]);try{await load();if(before!==JSON.stringify([S.projects,S.project,S.actions,S.keywordActions,S.productActions,S.verificationActions])&&!$('dialog').open)render();}catch(e){warn((S.feedback.startsWith('已保存')?'已保存。':'')+'连接或同步未完成：'+e.message+'。当前内容可能已过期。','alert');$('connection').textContent='连接中断';}finally{S.busy=false;}}
async function openProject(id){try{S.project=await api('/projects/'+id);const page=await api('/projects/'+id+'/actions?limit=20');S.actions=page.actions;S.keywordActions=page.keyword_actions||{};S.verificationActions=page.verification_actions||{};S.productActions=page.product_actions||{};S.actionCursor=page.next_cursor||null;S.actionsError='';S.product=null;S.view='project';S.secondaryResearchOpen=false;localStorage.removeItem('rabbit-hole:research-review');sessionStorage.setItem('rabbit-hole:active-project',id);render();}catch(e){warn(e.message);}}
async function loadMoreActions(){if(!S.actionCursor||S.actionsLoading)return;S.actionsLoading=true;S.actionsError='';render();try{const page=await api('/projects/'+S.project.id+'/actions?limit=20&cursor='+encodeURIComponent(S.actionCursor));S.actions=mergeActionRows(S.actions,page.actions);S.actionCursor=page.next_cursor||null;}catch(e){S.actionsError='较早记录加载失败：'+e.message;}finally{S.actionsLoading=false;render();}}
