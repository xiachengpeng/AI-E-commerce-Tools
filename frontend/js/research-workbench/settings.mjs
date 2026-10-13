import { exportDrafts, importDrafts } from './drafts.mjs';
import { el, button, panel, notify } from './components/elements.mjs';
import { createActionLogs } from './components/live-logs.mjs';
export const integrationFields = Object.freeze({apify:['api_key','daily_limit'],serpapi:['api_key','daily_limit'],firecrawl:['api_key','daily_limit'],aliyun:['access_key_id','access_key_secret'],feishu:['app_id','app_secret','base_app_token']});
const names={apify:'Apify',serpapi:'SerpApi',firecrawl:'Firecrawl',aliyun:'阿里翻译（原中文阅读辅助）',feishu:'飞书 Base（原同步）'};
export async function loadResearchSettings(context) {
 const settled=await Promise.allSettled([context.api.request('/ai-settings',{signal:context.life.signal}),context.api.request('/sources',{signal:context.life.signal}),...Object.keys(integrationFields).map(p=>context.api.integration(p,'research',{signal:context.life.signal}))]);
 return {ai:settled[0].status==='fulfilled'?settled[0].value:{configured:false,message:'主 AI 绑定暂不可读'},sources:settled[1].status==='fulfilled'?settled[1].value.sources:[],integrations:settled.slice(2).map((r,i)=>r.status==='fulfilled'?r.value:{provider:Object.keys(integrationFields)[i],purpose:'research',configured:false,unavailable:true,fields:{}})};
}
export async function saveIntegration(context,provider,purpose,changes) {
 if(purpose!=='research'||!integrationFields[provider]||!changes||Object.keys(changes).some(k=>!integrationFields[provider].includes(k))||Object.values(changes).some(v=>v==='••••••••'||v===null))throw Error('集成配置参数无效');
 return context.api.integration(provider,purpose,{method:'PATCH',body:changes,signal:context.life.signal});
}
export function resetResearchDrafts(context) {
 // Submitted identities are reconciliation receipts, not disposable form drafts.
 const storage=context.context.storage||context.root.ownerDocument.defaultView?.sessionStorage;
 const drafts={...(context.state.drafts||{})};let partial=false;
 try{for(let i=0;i<(storage?.length||0);i++){const key=storage.key(i);if(key?.startsWith('rabbit-hole:draft:')&&!Object.hasOwn(drafts,key)){try{const value=JSON.parse(storage.getItem(key));if(value&&typeof value==='object'&&!Array.isArray(value))drafts[key]=value;}catch{partial=true;}}}}catch{partial=true;}
 let pending=0;
 for(const [key,draft] of Object.entries(drafts)){
  if(draft.submitting||draft.uncertain||draft.submittedHash){pending++;continue;}
  try{storage?.removeItem(key);}catch{partial=true;}delete context.state.drafts[key];
 }
 pending+=Object.values(context.state.commands||{}).filter(d=>d.submitting||d.uncertain||d.submittedHash).length;
 if(context.state.form&&!context.state.writeBusy)context.state.form=null;
 notify(context,'已重置未提交的本地表单草稿；保留待核对提交 '+pending+' 项。服务器记录保留。'+(partial?'部分浏览器草稿存储不可读，请人工核对。':''));
}
export function renderSettings(context) {
 const host=el(context,'section','rw-settings'),heading=el(context,'h1','','研究与集成');heading.tabIndex=-1;host.append(heading);
 const binding=panel(context,'主 AI text 绑定','研究使用主 AI 设置的 text 绑定。当前模型不支持操作时请更换主绑定；不会建立独立研究 AI 配置。');
 binding.append(button(context,'打开主 AI 设置',()=>context.context.openMainSettings?.('ai')));host.append(binding);
 const body=el(context,'div','rw-integration-grid');host.append(body);
 host.append(button(context,'重置本地表单草稿',()=>resetResearchDrafts(context)),renderDraftControls(context));
 const logPanel=panel(context,'研究持久任务日志','按项目和任务筛选；本入口只拥有一个推送连接，关闭页面即释放。主进程日志仍在主设置页。');
 const projects=el(context,'select'),actions=el(context,'select'),logBody=el(context,'div');projects.setAttribute('aria-label','日志项目');actions.setAttribute('aria-label','日志任务');
 const placeholder=el(context,'option','','选择研究项目');placeholder.value='';projects.append(placeholder);
 for(const project of context.state.projects||[]){const option=el(context,'option','',project.title||'研究项目');option.value=project.id;projects.append(option);}
 projects.value=context.state.project?.id||'';
 let logs=null,logGeneration=0;
 async function selectLogProject(){const id=++logGeneration;logs?.closeActionLogs();logs=null;logBody.replaceChildren();actions.replaceChildren();const all=el(context,'option','','全部任务');all.value='';actions.append(all);if(!projects.value)return;
  const projectId=projects.value;
  try {const data=await context.api.request('/projects/'+encodeURIComponent(projectId)+'/actions?limit=50',{signal:context.life.signal});if(!context.life.active||id!==logGeneration)return;
   for(const action of data.actions||[]){const option=el(context,'option','',(action.kind||'任务')+' · '+action.id);option.value=action.id;actions.append(option);}
   logs=createActionLogs({...context,state:{...context.state,project:{id:projectId}}});logBody.append(logs.host);
  }catch{if(context.life.active&&id===logGeneration)notify(context,'任务筛选暂不可读，请重新选择项目。');}
 }
 context.life.listen(projects,'change',selectLogProject);context.life.listen(actions,'change',()=>{if(logs)void logs.openActionLogs(actions.value||undefined);});
 logPanel.append(projects,actions,button(context,'读取持久日志',()=>logs?.openActionLogs(actions.value||undefined)),logBody);host.append(logPanel);void selectLogProject();
 void loadResearchSettings(context).then(data=>{
  if(!context.life.active)return;binding.append(el(context,'p','rw-muted',data.ai.message||'研究使用主 text 绑定'),el(context,'p','rw-muted','当前模型：'+(data.ai.model||'未配置')));
  for(const config of data.integrations){
   const card=panel(context,names[config.provider],config.unavailable?'配置尚未就绪；需显式准备数据库。':config.configured?'已保存凭据（未测试连接）':'未配置');card.dataset.integration=config.provider;
   const fields={};for(const name of integrationFields[config.provider]){
    const label=el(context,'label','rw-field',name),input=el(context,'input');input.name=name;input.type=name==='daily_limit'?'number':name==='app_id'?'text':'password';input.autocomplete='off';input.maxLength=512;
    input.value=input.type==='password'?'':String(config.fields?.[name]??'');input.placeholder=config.fields?.[name]?'已保存，留空保留':'未配置';if(name==='daily_limit'){input.min='1';input.max='1000000';}fields[name]=input;label.append(input);card.append(label);
   }
   const status=el(context,'p','rw-muted');card.append(button(context,'保存研究用途配置',async()=>{
    const changes={};for(const [name,input] of Object.entries(fields)){if(name==='daily_limit'){if(input.value.trim())changes[name]=Number(input.value);}else changes[name]=input.value.trim();}
    const saved=await saveIntegration(context,config.provider,'research',changes);if(!context.life.active)return;
    for(const input of Object.values(fields))if(input.type==='password'){input.value='';input.placeholder='已保存，留空保留';}
    status.textContent='已保存版本 '+saved.version+'；下次操作读取新配置。';
   }),status);body.append(card);
  }
  const sourcePanel=panel(context,'来源状态','配置存在不代表来源已授权或健康。');for(const source of data.sources||[])sourcePanel.append(el(context,'p','rw-muted',(source.name||source.id||'来源')+' · '+(source.integration_message||source.status||'未知')));body.append(sourcePanel);
 }).catch(()=>{if(context.life.active)notify(context,'研究设置暂不可读；请稍后重试。');});return host;
}

/** Explicit local-file handoff; imported source DTOs never become live form input. */
export function renderDraftControls(context) {
 const host=panel(context,'旧来源草稿导入 / 导出','用户主动导出旧标签页草稿包，再在此选择文件核对。未导出的旧标签页草稿未迁移。只读保留原提交身份，不自动保存、采集或重发。');
 const storage=context.context.storage||context.root.ownerDocument.defaultView?.sessionStorage;
 const file=el(context,'input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','选择 version 1 研究草稿包');
 const status=el(context,'p','rw-muted'),preview=el(context,'div');status.setAttribute('role','status');let generation=0;
 function paint(){preview.replaceChildren();for(const entry of context.state.importedDrafts||[]){const row=panel(context,entry.mode==='receipt_only'?'已提交 · 仅保留回执':'只读草稿 · 需人工核对',entry.reason?'待核对：'+entry.reason:'核对完成；仍不自动提交');const raw=el(context,'pre','',JSON.stringify(entry.receipt||entry.draft,null,2));raw.setAttribute('style','white-space:pre-wrap;overflow-wrap:anywhere');row.append(el(context,'p','rw-muted','来源：'+entry.source_origin),raw);preview.append(row);}}
 const exportButton=button(context,'导出本标签页研究草稿',()=>{
  try{const win=context.root.ownerDocument.defaultView,bundle=exportDrafts(storage,{sourceOrigin:win.location.origin});const url=win.URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}));const release=context.life.track(()=>win.URL.revokeObjectURL(url));const link=el(context,'a');link.href=url;link.download='research-drafts-v1.json';host.append(link);try{link.click();}finally{link.remove();release();}status.textContent='已主动导出 '+bundle.drafts.length+' 项；其他未导出状态未迁移。';}catch{status.textContent='草稿导出未完成：存在未知、超限或不安全字段；请在旧标签页人工核对。';}
 });
 const importButton=button(context,'读取并核对草稿包',async()=>{
  const selected=file.files?.[0];if(!selected){status.textContent='请先主动选择草稿包。';return;}
  if(selected.size>1048576){status.textContent='草稿包超过 1 MiB 上限，已拒绝。';return;}
  const current=++generation;importButton.disabled=true;
  const isCurrent=()=>context.life.active&&current===generation;
  try{const raw=await selected.text();if(!isCurrent())return;
   const result=await importDrafts(raw,{state:context.state,storage,signal:context.life.signal,isCurrent,
    readReceipt:(id,command,signal)=>context.api.request('/projects/'+encodeURIComponent(id)+'/commands/'+encodeURIComponent(command),{signal}),
    readProject:(id,signal)=>context.api.request('/projects/'+encodeURIComponent(id),{signal})});
   if(!isCurrent())return;status.textContent='只读接收 '+result.accepted.length+' 项，待核对 '+result.needs_review.length+' 项，拒绝 '+result.rejected.length+' 项。未重发任何命令。';paint();
  }catch{if(isCurrent())status.textContent='草稿包读取未完成，已有内容保留；请人工核对。';}
  finally{if(isCurrent())importButton.disabled=false;}
 });
 paint();host.append(exportButton,file,importButton,status,preview);return host;
}
