import { el as nativeEl, button as nativeButton, panel, link as nativeLink, notify, labels } from '../components/elements.mjs';
import {productThumbnail} from '../components/presentation.mjs';
import { nextProductStep } from './product.mjs';
import { adTextPanel as nativeAdText, mediaControl, sourcePreview } from '../components/ad-copy.mjs';
import { mediaPath } from '../services/actions.mjs';
import { createForm, fields } from '../components/forms.mjs';
import { submitCommand } from '../services/commands.mjs';
export function renderTriage(context) {
 const state=context.state,root=nativeEl(context,'section','rw-triage');state.triageSession||={projectId:state.project?.id,processed:0};state.queueLimits||={};
 const el=(tag,cls='',text)=>nativeEl(context,tag,cls,text),button=(label,fn,cls='')=>nativeButton(context,label,fn,cls),box=(title,note)=>panel(context,title,note),link=(label,url)=>nativeLink(context,label,url),product=()=>state.project?.products?.find(p=>p.id===state.product),render=()=>context.navigate('triage');
 let inlineTriageFormHost=null;
 const triageDraft=()=>{const key='rabbit-hole:draft:'+JSON.stringify([state.project.id,state.product,'triage_product']);if(state.drafts?.[key])return state.drafts[key];try{const raw=(context.context?.storage||context.root.ownerDocument.defaultView?.sessionStorage)?.getItem(key);return raw&&new TextEncoder().encode(raw).length<=65536?JSON.parse(raw):null;}catch{return null;}};
 const time=v=>v?new Date(v).toLocaleString('zh-CN'):'未记录';
 const empty=(title,note,btn)=>{const node=box(title,note);if(btn)node.append(btn);return node;};
 const breadcrumbs=host=>{const heading=el('h1','','选品队列');heading.tabIndex=-1;host.append(heading,button('返回探索',()=>context.navigate('project')));};
 const stats=(host,rows)=>{const summary=el('div','rw-queue-summary');for(const [key,value] of rows)summary.append(el('span','rw-muted',key+'：'+value));host.append(summary);};
 const openProduct=(id,step)=>context.openProduct(state.project.id,id,step);
 const openTriage=id=>{if(!state.project.products.some(p=>p.id===id))return;state.product=id;context.navigate('triage');};
 const adTextPanel=(word,ad)=>nativeAdText(context,word,ad);
 const focusPreview=(word,p,ad)=>{
  if(!word.id)return el('p','muted','尚无可核对的来源词，请打开商品原页核对。');
  const ids=new Set((p.candidate_sources||[]).filter(b=>b.keyword_id===word.id).map(b=>b.ad_id));
  return sourcePreview(context,word,p,(word.ads||[]).filter(a=>ids.has(a.id)));
 };
 function form(action,title,help,defs,initial,payload) {
  const id=state.product,key='rabbit-hole:draft:'+JSON.stringify([state.project.id,id,action]);
  const editor=createForm(context,{title,help,defs,initial,key,returnView:'triage',onDiscard:()=>form(action,title,help,defs,initial,payload),submit:async(data,draft,persist)=>{
   const result=await submitCommand({request:(path,options)=>context.api.request(path,{...options,signal:context.life.signal})},{project_id:state.project.id,action,payload:payload(data),draft},persist);
   if(!context.life.active)return;state.project=result;
   if(action==='triage_product'){
    state.triageSession.processed++;state.lastTriage=id;
    if(data.reason_choice&&payload(data).disposition==='retained'){
     state.product=id;
     // Triage and focus retain separate idempotent command identities.
     await context.command('focus_product',{product_id:id});
     if(state.project.focus_product_id===id)context.openProduct(state.project.id,id,nextProductStep(state.project.products.find(p=>p.id===id)));
    }else state.product=result.queues?.triage?.[0]?.product_id||null;
   }
   else if(action==='restore_product')state.product=id;
  }});if(inlineTriageFormHost&&context.designDirectForms){inlineTriageFormHost.replaceChildren(editor.host);if(editor.host.querySelectorAll){const aside=editor.host.querySelector('.rw-form-assistance'),help=el('details','rw-inline-form-help');help.append(el('summary','','填写提示与保存规则'));if(aside){aside.before(help);help.append(aside);}}}else{root.replaceChildren(editor.host);editor.host.querySelector('h1')?.focus({preventScroll:true});}
 }
 function triageProduct(disposition) {
  const p=product(),choices={retained:{'商品明确，值得深挖':'商品明确，值得深挖','广告信号较强':'广告信号较强','有可验证商品页':'有可验证商品页'},observing:{'商品身份不明确':'商品身份不明确','来源暂不可访问':'来源暂不可访问','证据不足，稍后再看':'证据不足，稍后再看'},rejected:{'与当前选品方向不符':'与当前选品方向不符','重复商品':'重复商品','广告信号不足':'广告信号不足'}};
  form('triage_product',disposition==='retained'?'保留这条线索并进入深挖':disposition==='observing'?'暂时观察这条线索':'确认淘汰这条线索','保留不代表通过粗筛；来源和历史全部保留。',fields([['reason_choice','快速判断','choice',true,choices[disposition]],['reason','补充说明（选填）','textarea',false]]),{},data=>({product_id:p.id,disposition,reason:data.reason?data.reason_choice+'：'+data.reason:data.reason_choice}));
 }
 function restoreLead(id){state.product=id;form('restore_product','恢复这条线索','原广告、来源与初筛理由都会保留。恢复后回到待筛队列。',fields([['reason','恢复理由','textarea']]),{},data=>({product_id:id,reason:data.reason}));}
function renderLead(root){
 breadcrumbs(root);const p=product();
 if(!p){root.append(empty('这条线索已不在当前队列','返回选品队列继续。',button('返回选品队列',()=>{state.view='todos';render();})));return;}
 const lead=el('section','panel triage-card');lead.dataset.currentLead='true';
 const identified=p.identification?.relevance_confirmed===true,title=el('h2','',p.name);title.tabIndex=-1;
 lead.append(el('span','eyebrow','当前线索'),title);
 if(!identified)title.append(el('span','rw-tag rw-triage-identity-status','待确认匹配'));
 const remaining=state.project.summary?.pending_triage??state.project.queues?.triage?.length??0,processed=state.triageSession.projectId===state.project.id?state.triageSession.processed:0;
 lead.append(el('p','triage-progress',`本次已处理 ${processed} 条 · 剩余 ${remaining} 条`),el('p','muted','先用三项标准快速判断，不在这里完成全部研究。'));
 const criteria=el('ul','triage-criteria');
 for(const item of ['是否能识别出一个明确可销售的具体商品','商品页或广告来源是否可以核对','当前信号是否值得进入后续深挖'])criteria.append(el('li','',item));
 const criteriaDetail=el('details','rw-triage-criteria-note');criteriaDetail.append(el('summary','','快速判断标准'),criteria);lead.append(criteriaDetail);
 const sourceIds=p.source_keyword_ids||[],sources=state.project.keywords.filter(keyword=>sourceIds.includes(keyword.id));
 for(const source of sources)criteriaDetail.append(el('p','source-line','来源词：'+source.text));
 const exact=[],seen=new Set();
 for(const binding of p.candidate_sources||[]){
  const key=`${binding.keyword_id||''}:${binding.ad_id||''}`;if(seen.has(key))continue;
  const source=state.project.keywords.find(keyword=>keyword.id===binding.keyword_id),ad=source?.ads?.find(item=>item.id===binding.ad_id);
  if(ad){seen.add(key);exact.push({...ad,keyword_id:source.id});}
 }
 const actions=el('div','actions triage-actions');
 actions.setAttribute('aria-label','快速判断操作');
 if(context.designDirectForms&&!((draft)=>draft?.uncertain||draft?.submitting||draft?.submittedHash)(triageDraft())){const radios=[];const intent=state.triageIntent?.productId===p.id?state.triageIntent.disposition:null;let disposition=['retained','observing','rejected'].includes(intent)?intent:'retained';delete state.triageIntent;actions.classList.add('rw-triage-dispositions');actions.append(el('h3','','本次筛选结果'));for(const [value,label,note] of [['retained','保留并深挖','商品值得进一步核实，继续原有深挖流程。'],['observing','暂时观察','保留来源与当前证据，之后再核对。'],['rejected','淘汰这条线索','记录原因；原资料保留，可恢复。']]){const labelNode=el('label'),input=el('input');input.type='radio';input.name='rw-triage-disposition';input.value=value;input.checked=value===disposition;input.setAttribute('aria-label',label);context.life.listen(input,'change',()=>{if(!input.checked)return;const draft=triageDraft();if(draft?.uncertain||draft?.submitting||draft?.submittedHash){for(const radio of radios)radio.checked=radio.value===disposition;notify(context,'保存结果尚待核对，请保持原判断与提交身份，先核对原记录。');return;}disposition=value;triageProduct(value);});radios.push(input);labelNode.append(input,el('strong','',label),el('small','rw-muted',note));actions.append(labelNode);}inlineTriageFormHost=el('div','rw-inline-triage-form');lead.append(actions,inlineTriageFormHost);triageProduct(disposition);}
 else{actions.append(button('保留并深挖',()=>triageProduct('retained'),'primary'),button('暂时观察',()=>triageProduct('observing')),button('淘汰这条线索',()=>triageProduct('rejected'),'danger'));lead.append(actions);}
 function evidenceCard(ad){
  const evidence=el('div','evidence');
  evidence.append(el('b','',ad.advertiser||'未知广告主'),adTextPanel({id:ad.keyword_id},ad,'p','triage-ad-copy'),el('p','muted',`${ad.active?'当前活跃':'状态待核对'} · 开始 ${ad.start_date||'未知'}`),link('查看原广告 ↗','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));
  return evidence;
 }
 const representative=el('div','triage-representative'),ad=exact[0],word=state.project.keywords.find(item=>item.id===ad?.keyword_id)||sources[0]||{id:'',ads:[]};
 const preview=el('div','triage-preview');
 if(context.designDirectForms){const summary=el('section','rw-triage-gallery-summary'),gallery=el('details','rw-triage-full-gallery');gallery.append(el('summary','','查看商品图与绑定广告素材'),focusPreview(word,p,ad));summary.append(productThumbnail(context,p),gallery);preview.append(summary,representative);}else preview.append(focusPreview(word,p,ad),representative);
 representative.append(el('h3','','代表广告 · 第一条关联记录'));
 if(ad){const extra=el('details','rw-triage-ad-details');extra.append(el('summary','','代表广告与来源原文'),evidenceCard(ad));representative.append(extra);}
 else representative.append(el('p','notice',sources.length?'该线索只关联了来源关键词，未绑定具体来源广告。':'该线索没有关联来源词，请根据商品页谨慎判断。'));
 representative.append(link('在新标签页打开商品页 ↗',p.url));
 if(p.landing_snapshot)representative.append(el('p','muted',`页面观察：${p.landing_snapshot.title||'标题未知'} · ${p.landing_snapshot.page_type||'页面类型未知'} · ${time(p.landing_snapshot.observed_at)}`));
 const missing=(p.steps||[]).filter(step=>['identification','coarse'].includes(step.key)&&step.state!=='passed').map(step=>step.label);
 representative.append(el('p','muted','尚待核对：'+(missing.join('、')||'无')));
 const evidenceNote=el('p','muted',`${exact.length} 条关联广告记录 · 不代表独立创意数量或连续投放证明。`);lead.append(evidenceNote);if(lead.insertBefore)lead.insertBefore(preview,title.nextSibling);else lead.append(preview);
 if(exact.length>1){
  const more=el('details','triage-more-ads');
  more.append(el('summary','',`查看全部关联广告（${exact.length} 条） · 另 ${exact.length-1} 条默认收起`));
  let populated=false;
  context.life.listen(more,'toggle',()=>{
   if(!more.open||populated)return;populated=true;
   more.append(el('p','muted','第一条已在上方展示，以下为其余关联记录。'));
   for(const other of exact.slice(1))more.append(evidenceCard(other));
  });
  lead.append(more);
 }
 root.append(lead);
}
function renderFocusCard(root){const id=state.project?.focus_product_id,p=state.project?.products.find(item=>item.id===id);if(!p)return;const guide=state.project.guidance||{},card=box('当前深挖商品',p.name);card.classList.add('focus-card');card.dataset.currentFocus='true';const current=p.steps?.find(step=>step.key===(guide.product_id===p.id?guide.step:null))||p.steps?.find(step=>!['passed','not_applicable'].includes(step.state));if(current)card.append(el('p','muted',`当前阶段：${current.label} · ${current.reason}`));card.append(button('继续深挖',()=>openProduct(p.id,current?.key||'identification'),'primary'));root.append(card);}
function renderTodos(root){if(!state.project){root.append(empty('先进入一个研究项目','选品队列按项目保存，请从研究项目进入。'));return;}breadcrumbs(root);root.append(el('h2','','快速筛选线索'));const summary=state.project.summary||{};stats(root,[['待筛',summary.pending_triage??'未知'],['已保留',summary.retained??'未知'],['观察中',summary.observing??'未知'],['已淘汰',summary.rejected??'未知']]);const groups=[['triage','待快速筛选'],['retained','保留并深挖'],['blocked','等待来源'],['decision','待决策 / 测试'],['observing','观察中'],['rejected','已淘汰']];const tabs=el('nav','rw-queue-tabs');tabs.setAttribute('aria-label','线索队列分类');tabs.setAttribute('role','tablist');const sections=new Map(),buttons=new Map();let selected=state.queueCategory||groups.find(([key])=>state.project.queues?.[key]?.length)?.[0]||'triage';const activate=key=>{state.queueCategory=key;for(const [name,node] of sections)node.hidden=name!==key;for(const [name,node] of buttons)node.setAttribute('aria-selected',String(name===key));state.product=(state.project.queues?.[key]||[]).find(row=>state.project.products.some(p=>p.id===row.product_id&&!p.merged_into))?.product_id||null;render();};for(const [key,title] of groups){const tab=button(title+'（'+(state.project.queues?.[key]?.length||0)+'）',()=>activate(key));tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(key===selected));buttons.set(key,tab);tabs.append(tab);}root.append(tabs);let count=0;for(const [key,title] of groups){const rows=state.project.queues?.[key]||[];if(!rows.length){const emptyGroup=box('该分类暂无商品','可以切换其他分类继续研究。');emptyGroup.dataset.queueCategory=key;emptyGroup.hidden=key!==selected;sections.set(key,emptyGroup);root.append(emptyGroup);continue;}count+=rows.length;const section=box(`${title} · ${rows.length}`),limitKey=`${state.project.id}:${key}`,limit=state.queueLimits[limitKey]||10,visible=rows.slice(0,limit);section.classList.add('queue-group');section.dataset.queueCategory=key;section.hidden=key!==selected;sections.set(key,section);for(const row of visible){const item=el('div','queue-row'),copy=el('div','queue-copy');item.dataset.selected=String(row.product_id===state.product);copy.append(el('b','',row.name));if(key==='triage'){const signal=row.source_ad_count?`精确来源：${row.source_advertiser||'广告主待核对'} · ${row.source_ad_count} 条广告${row.source_active_since?' · 投放始于 '+row.source_active_since:''}`:'仅关联来源词，未绑定具体广告';copy.append(el('p','queue-signal',signal));if(row.landing_observed)copy.append(el('small','queue-signal','已读取商品页'));}copy.append(el('p','muted',row.source_keyword?'来源词：'+row.source_keyword:row.reason||'等待处理'),el('small','muted',row.reason||''));let action,label=row.action_label||'打开';if(key==='triage')action=()=>openTriage(row.product_id);else if(['observing','rejected'].includes(key)){action=()=>restoreLead(row.product_id);label='恢复线索';}else action=()=>openProduct(row.product_id,row.step||'identification');const savedProduct=state.project.products.find(p=>p.id===row.product_id);if(savedProduct)item.append(productThumbnail(context,savedProduct));item.append(copy,button(label,action,key==='triage'?'primary':''));section.append(item);}const remaining=rows.length-visible.length;if(remaining>0)section.append(button(`加载更多（剩余 ${remaining} 条）`,()=>{state.queueLimits[limitKey]=rows.length;render();},'queue-more'));root.append(section);}if(!count)root.append(empty('当前队列已处理完','可以查看结论与复盘，或回到项目补充新的关键词和线索。'));}

 if(!state.product){const first=state.project?.queues?.[state.queueCategory||'triage']?.[0]?.product_id;if(state.project?.products?.some(p=>p.id===first&&!p.merged_into))state.product=first;}
 if(state.product){const workspace=el('div','rw-triage-workspace'),queue=el('div','rw-triage-queue'),detail=el('div','rw-triage-detail');renderTodos(queue);renderLead(detail);workspace.append(queue,detail);root.append(workspace);}else{renderTodos(root);renderFocusCard(root);}
 if(state.lastTriage)root.append(button('撤销刚才判断',async()=>{await context.command('undo_triage_product',{product_id:state.lastTriage});state.product=state.lastTriage;state.lastTriage=null;render();}));
 const p=product();if(p)root.append(button('设为当前深挖商品',async()=>{await context.command('focus_product',{product_id:p.id});openProduct(p.id,'identification');}));
 return root;
}
