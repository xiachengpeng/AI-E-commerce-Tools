import {createIntegrationEditor} from './components/integration-editor.mjs';
import { exportDrafts, importDrafts, describeResearchDraftKey } from './drafts.mjs';
import { el, button, panel, notify } from './components/elements.mjs';
import { createActionLogs } from './components/live-logs.mjs';
import { actionNames } from './services/actions.mjs';
import {icon} from './components/presentation.mjs';
export const integrationFields = Object.freeze({apify:['api_key','daily_limit'],serpapi:['api_key','daily_limit'],firecrawl:['api_key','daily_limit'],aliyun:['access_key_id','access_key_secret'],feishu:['app_id','app_secret','base_app_token']});
const names={apify:'Apify 广告采集',serpapi:'SerpApi 趋势研究',firecrawl:'选品研究用途',aliyun:'阿里云翻译',feishu:'飞书多维表格'};
const fieldLabels={api_key:'API Key',daily_limit:'每日调用上限',access_key_id:'Access Key ID',access_key_secret:'Access Key Secret',app_id:'App ID',app_secret:'App Secret',base_app_token:'多维表格 App Token'};
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
/** Inspect safe local draft metadata; uncertain receipts are never replayed here. */
export function renderLocalDraftIndex(context){
 const host=el(context,'section','rw-local-drafts'),list=el(context,'div','rw-local-draft-list'),detail=el(context,'aside','rw-local-draft-detail');host.append(list,detail);list.append(el(context,'h2','','已有草稿'));
 const names={new_project:'新建研究',add_keyword:'搜索词',edit_keyword:'修改搜索词',confirm_product:'确认商品',confirm_creatives:'广告粗筛',funnel:'漏斗拆解',economics:'订单测算',decide:'人工决定',test_plan:'测试计划',test_result:'真实结果',review:'复盘',configure_rules:'项目规则',configure_collection:'采集方式',new_search_entry:'更换搜索入口',add_product:'添加商品',delete_project:'删除项目确认',merge_products:'合并商品档案',split_product_offer:'拆分同款商品',link_product_offers:'关联同款商品',triage_product:'线索判断',triage_retained:'保留线索',triage_observing:'观察线索',triage_rejected:'淘汰线索',restore_product:'恢复线索',add_creative_reference:'创意参考',record_funnel_investigation:'漏斗调查',logistics_profile:'物流规则',add_sales_estimate:'情景估算',revise_test_result:'修订测试结果',void_test_result:'作废测试结果',trends_import:'导入趋势数据'};
 const stored=new Map(),storage=context.context.storage||context.root.ownerDocument.defaultView?.sessionStorage;let unreadable=false;try{for(let n=0;n<(storage?.length||0);n++){const key=storage.key(n);if(!key?.startsWith('rabbit-hole:draft:'))continue;try{const raw=storage.getItem(key);if(typeof raw==='string'&&new TextEncoder().encode(raw).length<=65536){const value=JSON.parse(raw);if(value&&typeof value==='object'&&!Array.isArray(value))stored.set(key,value);}}catch{unreadable=true;}}}catch{unreadable=true;}for(const [key,value] of Object.entries(context.state.drafts||{}))stored.set(key,value);
 const records=[];for(const [key,draft] of stored){if(!key.startsWith('rabbit-hole:draft:'))continue;let identity;try{const spec=describeResearchDraftKey(key);identity=[spec.project,spec.product,spec.kind,''];}catch{continue;}if(!Object.values(draft.values||{}).some(v=>v!==''&&v!=null))continue;records.push({key,draft,identity});}
 const select=record=>{const [projectId,productId,type]=record.identity,project=context.state.projects?.find(p=>p.id===projectId),product=project?.products?.find(p=>p.id===productId);detail.replaceChildren(el(context,'h2','','草稿详情'),el(context,'h3','',names[type]||'研究表单草稿'),el(context,'p','rw-muted',project?.title||'原研究尚未载入'));if(product)detail.append(el(context,'p','',product.name));const pending=record.draft.uncertain||record.draft.submittedHash||record.draft.submitting;detail.append(el(context,'p','rw-notice',pending?'待核对提交':'本地未提交草稿'),el(context,'p','rw-muted',pending?'请先在原研究中核对保存状态；此处不会重发、换提交身份或覆盖内容。':'草稿留在本标签页；链接和文件需要重新填写。此处仅查看元信息，不自动保存或采集。'));if(project&&!pending)detail.append(button(context,'回到原研究继续',()=>context.openProject(projectId),'rw-primary'));};
 for(const record of records){const item=button(context,'',()=>select(record),'rw-local-draft-row');item.append(icon(context,'file-text'),el(context,'strong','',names[record.identity[2]]||'研究表单草稿'),el(context,'span','rw-tag',record.draft.uncertain||record.draft.submittedHash?'待核对提交':'本地草稿'));list.append(item);}if(records.length)select(records[0]);else{list.append(el(context,'p','rw-muted','当前标签页暂无已填写的本地草稿。'));detail.append(el(context,'h2','','草稿详情'),el(context,'p','rw-muted','选择左侧草稿后查看；不会自动恢复或提交。'));}if(unreadable)list.append(el(context,'p','rw-notice','部分浏览器草稿暂不可读，已有内容保留；请回到原表单核对。'));return host;
}

export function renderSettings(context) {
 const host=el(context,'section','rw-settings'),heading=el(context,'h1','','研究工具与日志');heading.tabIndex=-1;host.append(heading,el(context,'p','rw-tools-description','本地草稿与只读导入分开保留；不确定的提交先核对原记录。'));
 const entry=panel(context,'接口统一管理','AI、采集、翻译与飞书接口统一在系统设置中管理。');entry.append(button(context,'打开接口设置',()=>context.context.openMainSettings?.('integrations')));host.append(entry);const tabs=el(context,'nav','rw-tools-tabs');tabs.setAttribute('aria-label','研究工具分区');for(const [label,target] of [['本地草稿','rw-tools-drafts'],['持久任务日志','rw-tools-task-logs']]){const anchor=el(context,'a','',label);anchor.href='#'+target;tabs.append(anchor);}host.append(tabs);
 const draftIndex=renderLocalDraftIndex(context),draftWorkspace=el(context,'section','rw-tools-draft-workspace'),draftLeft=el(context,'div','rw-tools-draft-left'),[draftList,draftDetail]=Array.from(draftIndex.children);draftLeft.append(renderDraftControls(context),draftList);draftWorkspace.append(draftLeft,draftDetail);draftWorkspace.id='rw-tools-drafts';host.append(draftWorkspace);const reset=panel(context,'重置未提交草稿','只清理未提交表单；待核对提交和服务器记录保留。');reset.classList.add('rw-draft-reset');reset.append(button(context,'重置本地表单草稿',()=>resetResearchDrafts(context)));const bottom=el(context,'section','rw-tools-bottom');bottom.append(reset);host.append(bottom);
 const logPanel=panel(context,'研究任务日志','选择项目和任务查看执行过程、失败原因与已保留结果。应用运行日志可在系统设置中查看。');
 logPanel.classList.add('rw-tools-logs');logPanel.id='rw-tools-task-logs';
 const projects=el(context,'select'),actions=el(context,'select'),logBody=el(context,'div');projects.setAttribute('aria-label','日志项目');actions.setAttribute('aria-label','日志任务');
 const placeholder=el(context,'option','','选择研究项目');placeholder.value='';projects.append(placeholder);
 for(const project of context.state.projects||[]){const option=el(context,'option','',project.title||'研究项目');option.value=project.id;projects.append(option);}
 projects.value=context.state.project?.id||'';
 let logs=null,logGeneration=0;
 async function selectLogProject(){const id=++logGeneration;logs?.closeActionLogs();logs=null;logBody.replaceChildren();actions.replaceChildren();const all=el(context,'option','','全部任务');all.value='';actions.append(all);if(!projects.value)return;
  const projectId=projects.value;
  try {const data=await context.api.request('/projects/'+encodeURIComponent(projectId)+'/actions?limit=50',{signal:context.life.signal});if(!context.life.active||id!==logGeneration)return;
   for(const action of data.actions||[]){const option=el(context,'option','',(actionNames[action.kind]||'研究任务')+' · '+(action.keyword_text||context.state.projects.find(p=>p.id===projectId)?.products?.find(p=>p.id===action.product_id)?.name||'项目任务')+' · '+(action.updated_at?new Date(action.updated_at).toLocaleString('zh-CN'):'时间未记录'));option.value=action.id;actions.append(option);}
   logs=createActionLogs({...context,state:{...context.state,project:{id:projectId}}});logBody.append(logs.host);
  }catch{if(context.life.active&&id===logGeneration)notify(context,'任务筛选暂不可读，请重新选择项目。');}
 }
 context.life.listen(projects,'change',selectLogProject);context.life.listen(actions,'change',()=>{if(logs)void logs.openActionLogs(actions.value||undefined);});
 logPanel.append(projects,actions,button(context,'读取持久日志',()=>logs?.openActionLogs(actions.value||undefined)),logBody);bottom.append(logPanel);void selectLogProject();
 return host;
}

/** Explicit local-file handoff; imported source DTOs never become live form input. */
export function renderDraftControls(context) {
 const host=panel(context,'旧来源草稿导入 / 导出','用户主动导出旧标签页草稿包，再在此选择文件核对。未导出的旧标签页草稿未迁移。只读保留原提交身份，不自动保存、采集或重发。');
 host.classList.add('rw-draft-controls');
 const storage=context.context.storage||context.root.ownerDocument.defaultView?.sessionStorage;
 const file=el(context,'input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','选择 version 1 研究草稿包');
 const status=el(context,'p','rw-muted'),preview=el(context,'div');status.setAttribute('role','status');let generation=0;
 function paint(){preview.replaceChildren();for(const entry of context.state.importedDrafts||[]){const row=panel(context,entry.mode==='receipt_only'?'已提交 · 仅保留回执':'只读草稿 · 需人工核对',entry.reason?'待核对：'+entry.reason:'核对完成；仍不自动提交');const raw=el(context,'pre','',JSON.stringify(entry.receipt||entry.draft,null,2));raw.setAttribute('style','white-space:pre-wrap;overflow-wrap:anywhere');const detail=el(context,'details');detail.append(el(context,'summary','','查看原提交身份与只读字段'),raw);row.append(el(context,'p','rw-muted','来源：'+entry.source_origin),detail);preview.append(row);}}
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
 exportButton.classList.add('rw-primary');paint();host.append(exportButton,file,importButton,status,preview);return host;
}

/** Credential editors are mounted only by the main Settings / External services pane. */
export function renderIntegrationSettings(context,{firecrawlHost}={}) {
 const host=el(context,'section','rw-settings rw-external-services rw-accounts-layout'),title=el(context,'h2','rw-external-title','外部服务配置');
 const binding=panel(context,'全局 AI 模型','选品研究与其他工具共用文字模型。当前模型不支持操作时，请到 AI 线路中调整。');binding.classList.add('rw-binding-summary');
 binding.append(button(context,'管理 AI 线路',()=>context.context.openMainSettings?.('ai')));const bindingDetails=el(context,'details','rw-integration-ai-note');bindingDetails.open=false;bindingDetails.append(el(context,'summary','','相关设置 · 共用 AI 模型'),binding);context.life.track(()=>bindingDetails.remove());
 const body=el(context,'div','rw-integration-grid rw-service-workspace'),services=el(context,'nav','rw-service-list');services.setAttribute('aria-label','外部服务');services.append(title,el(context,'p','rw-service-description','配置后，研究与其他模块共用以下服务。'));body.append(services);host.append(body,bindingDetails);const design=context.root.ownerDocument.body?.classList.contains('research-design-mode');
 void loadResearchSettings(context).then(data=>{
  if(!context.life.active)return;const model=el(context,'p','rw-muted','当前模型：'+(data.ai.model||'未配置')),message=el(context,'p','rw-muted',data.ai.message||'研究使用主 text 绑定');if(design){const limits=el(context,'details','rw-ai-capability-limits');limits.append(el(context,'summary','','查看模型能力与输入限制'),message);binding.append(model,limits);}else binding.append(message,model);
  const secretEditors=new Map(),cards=new Map(),serviceButtons=new Map();let activeProvider=context.state.settingsService||data.integrations.find(c=>c.provider!=='firecrawl')?.provider;
  const selectService=provider=>{for(const editor of secretEditors.values())editor.hideSecrets();activeProvider=provider;context.state.settingsService=provider;for(const [key,card] of cards)card.hidden=key!==provider;for(const [key,b] of serviceButtons)b.setAttribute('aria-pressed',String(key===provider));};
  for(const config of data.integrations){
   const editor=createIntegrationEditor(context,config,{
    title:names[config.provider],fields:integrationFields[config.provider],labels:fieldLabels,design,
    saveChanges:changes=>saveIntegration(context,config.provider,'research',changes),
    onChange:()=>{const nav=serviceButtons.get(config.provider)?.querySelector('small');if(nav)nav.textContent='已修改，待保存与测试';},
    onReset:()=>{const label=serviceButtons.get(config.provider)?.querySelector('small');if(label)label.textContent='未测试连接';},
    onSaved:saved=>{const nav=serviceButtons.get(config.provider);if(nav){const active=saved.profiles?.find(p=>p.id===saved.active_profile_id);nav.dataset.configured=String(active?.configured??saved.configured);const label=nav.querySelector('small');if(label)label.textContent='已保存，未测试连接';}},
    onTest:result=>{const nav=serviceButtons.get(config.provider)?.querySelector('small');if(nav)nav.textContent=result.success?'所选配置测试通过':'所选配置测试未通过';}
   });const {card}=editor;secretEditors.set(config.provider,editor);
   let targetCard=card;if(config.provider==='firecrawl'&&firecrawlHost){firecrawlHost.append(card);const owner=firecrawlHost.closest?.('#settingsCrawlerCard');if(!owner)continue;const marker=context.root.ownerDocument.createComment('Firecrawl configuration owner');owner.before(marker);context.life.track(()=>{marker.before(owner);marker.remove();owner.hidden=false;});const symbol=owner.querySelector('.settings-section-icon i'),oldClass=symbol?.className;if(symbol)symbol.className='ph ph-file-text';context.life.track(()=>{if(symbol)symbol.className=oldClass;});targetCard=owner;}
   cards.set(config.provider,targetCard);const choose=button(context,config.provider==='firecrawl'?'Firecrawl 网页读取':names[config.provider],()=>selectService(config.provider),'rw-service-button');choose.dataset.provider=config.provider;choose.dataset.configured=String(config.configured===true);let mark=icon(context,({apify:'graph',serpapi:'magnifying-glass',firecrawl:'file-text',aliyun:'translate',feishu:'table'})[config.provider]||'plug');if(design&&config.provider==='feishu'){mark=el(context,'img','rw-service-mark');mark.src='/assets/research/feishu-reference-mark.png';mark.alt='';}choose.append(mark);if(design)choose.append(el(context,'span','rw-service-purpose',({apify:'用于采集广告数据',serpapi:'用于搜索趋势与关键词',firecrawl:'用于读取网页内容',aliyun:'用于多语言翻译',feishu:'用于结果记录与协作'})[config.provider]||''));choose.append(el(context,'small',design?'rw-muted rw-service-state':'rw-muted',config.unavailable?'暂不可读':config.configured?'已配置':'未配置'));if(design){const caret=icon(context,'caret-right');caret.classList.add('rw-service-caret');choose.append(caret);}serviceButtons.set(config.provider,choose);services.append(choose);body.append(targetCard);
  }
  selectService(cards.has(activeProvider)?activeProvider:cards.keys().next().value);
  const callout=el(context,'section','rw-service-callout');callout.append(icon(context,'info'),el(context,'strong','','关于调用方式'),el(context,'p','','是否使用 API 由项目采集方式决定。保存配置不会自动启动采集；本服务与研究共用已有配置。'));bindingDetails.append(callout);const sourcePanel=panel(context,'来源状态','配置存在不代表来源已授权或健康。');sourcePanel.classList.add('rw-service-source-status');for(const source of data.sources||[])sourcePanel.append(el(context,'p','rw-muted',(source.name||source.id||'来源')+' · '+(source.integration_message||source.status||'未知')));const health=el(context,'details','rw-source-health-note');health.append(el(context,'summary','','查看来源可用状态'),sourcePanel);host.append(health);
 }).catch(()=>{if(context.life.active)notify(context,'研究设置暂不可读；请稍后重试。');});return host;
}
