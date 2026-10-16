import { submitMutation,restoreDraft } from '../services/commands.mjs';
import { el,button,panel,notify } from '../components/elements.mjs';
import { createActionService,actionStatus } from '../services/actions.mjs';
export function renderVerification(context,word){
 const {state}=context,products=state.project.products.filter(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id));
 const unconfirmed=p=>!p.identification?.relevance_confirmed&&['pending','retained'].includes(p.triage?.state||'pending');
 const reviews=products.filter(p=>unconfirmed(p)&&p.verification?.status==='needs_review'),mismatches=products.filter(p=>unconfirmed(p)&&p.verification?.status==='mismatch');
 const action=state.verificationActions?.[word.id],active=action&&['ready','queued','running'].includes(action.status),manual=action&&(action.recovery_action==='manual'||['unknown','manual_check'].includes(action.display_status||action.status));
 const root=panel(context,'自动核对商品',`${products.filter(p=>p.identification?.relevance_confirmed).length} 个已匹配 · ${reviews.length} 个待确认 · ${mismatches.length} 个可能不相关`);root.dataset.verificationPanel='true';
 state.verificationModes||={};state.focusReviewOnly||={};const label=el(context,'label','','商品页读取方式'),mode=el(context,'select');mode.setAttribute('aria-label','自动核对的商品页读取方式');
 for(const [value,text] of [['local','本地读取'],['firecrawl','Firecrawl']]){const option=el(context,'option','',text);option.value=value;mode.append(option);}mode.value=state.verificationModes[word.id]||'local';mode.disabled=!!active;context.life.listen(mode,'change',()=>{state.verificationModes[word.id]=mode.value;});label.append(mode);root.append(label);
 const run=retry=>context.showQueue({kind:'verify',keyword_id:word.id,landing_mode:mode.value,...(retry?{retry_review:true}:{})});const start=button(context,'自动核对当前词',()=>run(false));start.disabled=!!active||!!manual||!products.length;root.append(start);
 if(active){const service=createActionService(context);root.append(button(context,'停止自动核对',async()=>{await service.stop(action);if(context.life.active)await context.refreshProject?.();}));const progress=action.progress||{};root.append(el(context,'p','',`${action.stage||'正在读取缺失商品页'} · 商品页完成 ${progress.complete||0}/${progress.total||0} · 读取失败 ${progress.failed||0}`));}
 else if(manual)root.append(el(context,'p','rw-notice','提交结果不确定，请先按任务 '+action.id+' 人工核对；不会自动重试。'));
 else if(action?.status==='blocked'||reviews.length||mismatches.length)root.append(button(context,'重新核对疑点',()=>run(true)));
 if(action){root.append(el(context,'p','',actionStatus(action)));if(action.diagnostic||action.message)root.append(el(context,'p','rw-notice',action.diagnostic||action.message));if(action.result?.total!=null)root.append(el(context,'p','',`本批完成：${action.result.matched} 个匹配，${action.result.needs_review} 个待确认，${action.result.mismatch} 个可能不相关。`));}
 const park=mismatches.filter(p=>(p.triage?.state||'pending')==='pending');if(park.length){const skip=button(context,`批量跳过不相关线索（${park.length}）`,async()=>{
  if(state.writeBusy)throw Error('上一项请求尚未完成');state.writeBusy=true;
  const id=state.project.id,valid=()=>context.life.active&&state.project?.id===id;
  const storage=context.context?.storage||context.root.ownerDocument.defaultView?.sessionStorage;
  let savedCount=0,failedDraft,failedPersist;
  try{
   const fresh=await context.api.request('/projects/'+encodeURIComponent(id),{signal:context.life.signal});if(!valid())return;state.project=fresh;
   const current=fresh.products.filter(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id)&&unconfirmed(p)&&p.verification?.status==='mismatch'&&(p.triage?.state||'pending')==='pending');
   for(const p of current){
    if(!valid())return;
    const key='rabbit-hole:park:'+id+':'+p.id+':'+p.verification.checked_at;state.commands||={};
    let saved;try{saved=JSON.parse(storage?.getItem(key)||'null');}catch{}
    const draft=state.commands[key]||{...restoreDraft(saved||{}),version:saved?.version??state.project.version};state.commands[key]=draft;
    const persist=()=>{try{storage?.setItem(key,JSON.stringify({...draft,submitting:undefined}));}catch{}};
    failedDraft=draft;failedPersist=persist;
    const result=await submitMutation({request:(path,options)=>context.api.request(path,{...options,signal:context.life.signal})},'/projects/'+encodeURIComponent(id)+'/commands',{action:'triage_product',version:draft.version,payload:{product_id:p.id,disposition:'observing',reason:'按自动核对依据批量跳过，暂存观察，可恢复：'+(p.verification.reason||'可能不相关')}},draft,persist);
    if(!valid())return;state.project=result;savedCount++;delete state.commands[key];try{storage?.removeItem(key);}catch{}
   }
   if(valid())notify(context,'已批量暂存到观察中，证据保留，可恢复。');
  }catch(error){
   if(valid())notify(context,`本次已暂存 ${savedCount} 个，其余未确认：${error.message}。已保存记录与提交身份保留，请核对后显式重试。`);
   if(error.status===409&&valid()){try{const project=await context.api.request('/projects/'+encodeURIComponent(id),{signal:context.life.signal});if(valid()){state.project=project;if(failedDraft){failedDraft.version=project.version;failedPersist();}}}catch{/* Retain the last saved project and original identity. */}}
   throw error;
  }finally{state.writeBusy=false;if(valid())context.redraw?.();}
 });skip.disabled=!!active;root.append(skip,el(context,'p','rw-muted','逐项保存到观察中，保留证据，可从选品队列恢复。'));}
 const filterLabel=el(context,'label','','只看需人工确认'),filter=el(context,'input');filter.type='checkbox';filter.name='verification_review_only';filter.checked=!!state.focusReviewOnly[word.id];context.life.listen(filter,'change',()=>{state.focusReviewOnly[word.id]=filter.checked;state.focusIndices||={};state.focusIndices[word.id]=0;context.navigate('project');});filterLabel.append(filter);root.append(filterLabel,el(context,'p','rw-muted','每批最多20个；补读商品页并调用AI，Firecrawl可能计费。不确定结果保留人工入口。'));
 for(const p of [...reviews,...mismatches])root.append(panel(context,p.name,p.verification.reason||'请核对原来源'),button(context,'人工核对：'+p.name,()=>context.selectProduct(p.id)));
 return root;
}
