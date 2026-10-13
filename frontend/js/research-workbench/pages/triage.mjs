import { el as nativeEl, button as nativeButton, panel, link as nativeLink, notify, labels } from '../components/elements.mjs';
import { adTextPanel as nativeAdText, mediaControl } from '../components/ad-copy.mjs';
import { mediaPath } from '../services/actions.mjs';
import { createForm, fields } from '../components/forms.mjs';
import { submitCommand } from '../services/commands.mjs';
export function renderTriage(context) {
 const state=context.state,root=nativeEl(context,'section','rw-triage');state.triageSession||={projectId:state.project?.id,processed:0};state.queueLimits||={};
 const el=(tag,cls='',text)=>nativeEl(context,tag,cls,text),button=(label,fn,cls='')=>nativeButton(context,label,fn,cls),box=(title,note)=>panel(context,title,note),link=(label,url)=>nativeLink(context,label,url),product=()=>state.project?.products?.find(p=>p.id===state.product),render=()=>context.navigate('triage');
 const time=v=>v?new Date(v).toLocaleString('zh-CN'):'未记录';
 const empty=(title,note,btn)=>{const node=box(title,note);if(btn)node.append(btn);return node;};
 const breadcrumbs=host=>{const heading=el('h1','','选品队列');heading.tabIndex=-1;host.append(heading,button('返回探索',()=>context.navigate('project')));};
 const stats=(host,rows)=>{for(const [key,value] of rows)host.append(el('p','rw-muted',key+'：'+value));};
 const openProduct=(id,step)=>context.openProduct(state.project.id,id,step);
 const openTriage=id=>{if(!state.project.products.some(p=>p.id===id))return;state.product=id;context.navigate('triage');};
 const adTextPanel=(word,ad)=>nativeAdText(context,word,ad);
 const focusPreview=(word,p,ad)=>{
  const preview=el('section');preview.append(el('h3','','已保存来源素材'));
  for(const [index] of (ad?.media||[]).slice(0,12).entries())preview.append(mediaControl(context,mediaPath(state.project.id,{keyword_id:word.id,ad_id:ad.id,source:'ad',index}),'读取广告素材 '+(index+1)));
  if(word.id)for(const [index] of (p?.landing_snapshot?.images||[]).slice(0,12).entries())preview.append(mediaControl(context,mediaPath(state.project.id,{keyword_id:word.id,product_id:p.id,source:'product',index}),'读取商品页图片 '+(index+1)));
  if(!(ad?.media||[]).length&&!(p?.landing_snapshot?.images||[]).length)preview.append(el('p','rw-muted','尚无当前线索保存的素材；请打开原广告或商品页核对。'));
  return preview;
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
     if(state.project.focus_product_id===id)context.openProduct(state.project.id,id,'identification');
    }else state.product=result.queues?.triage?.[0]?.product_id||null;
   }
   else if(action==='restore_product')state.product=id;
  }});root.replaceChildren(editor.host);editor.host.querySelector('h1')?.focus({preventScroll:true});
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
 const identified=p.identification?.relevance_confirmed===true,title=el('h2','',identified?p.name:'待识别商品');title.tabIndex=-1;
 lead.append(el('span','eyebrow','当前线索'),title);
 if(!identified)lead.append(el('p','current-record',`当前记录：${p.name}`));
 const remaining=state.project.summary?.pending_triage??state.project.queues?.triage?.length??0,processed=state.triageSession.projectId===state.project.id?state.triageSession.processed:0;
 lead.append(el('p','triage-progress',`本次已处理 ${processed} 条 · 剩余 ${remaining} 条`),el('p','muted','先用三项标准快速判断，不在这里完成全部研究。'));
 const criteria=el('ul','triage-criteria');
 for(const item of ['是否能识别出一个明确可销售的具体商品','商品页或广告来源是否可以核对','当前信号是否值得进入后续深挖'])criteria.append(el('li','',item));
 lead.append(criteria);
 const sourceIds=p.source_keyword_ids||[],sources=state.project.keywords.filter(keyword=>sourceIds.includes(keyword.id));
 for(const source of sources)lead.append(el('p','source-line','来源词：'+source.text));
 const exact=[],seen=new Set();
 for(const binding of p.candidate_sources||[]){
  const key=`${binding.keyword_id||''}:${binding.ad_id||''}`;if(seen.has(key))continue;
  const source=state.project.keywords.find(keyword=>keyword.id===binding.keyword_id),ad=source?.ads?.find(item=>item.id===binding.ad_id);
  if(ad){seen.add(key);exact.push({...ad,keyword_id:source.id});}
 }
 const actions=el('div','actions triage-actions');
 actions.setAttribute('aria-label','快速判断操作');
 actions.append(button('保留并深挖',()=>triageProduct('retained'),'primary'),button('暂时观察',()=>triageProduct('observing')),button('淘汰这条线索',()=>triageProduct('rejected'),'danger'));
 lead.append(actions);
 function evidenceCard(ad){
  const evidence=el('div','evidence');
  evidence.append(el('b','',ad.advertiser||'未知广告主'),adTextPanel({id:ad.keyword_id},ad,'p','triage-ad-copy'),el('p','muted',`${ad.active?'当前活跃':'状态待核对'} · 开始 ${ad.start_date||'未知'}`),link('查看原广告 ↗','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));
  return evidence;
 }
 const representative=el('div','triage-representative'),ad=exact[0],word=state.project.keywords.find(item=>item.id===ad?.keyword_id)||sources[0]||{id:'',ads:[]};
 const preview=el('div','triage-preview');
 preview.append(focusPreview(word,p,ad),representative);
 representative.append(el('h3','','代表广告 · 第一条关联记录'));
 if(ad)representative.append(evidenceCard(ad));
 else representative.append(el('p','notice',sources.length?'该线索只关联了来源关键词，未绑定具体来源广告。':'该线索没有关联来源词，请根据商品页谨慎判断。'));
 representative.append(link('在新标签页打开商品页 ↗',p.url));
 if(p.landing_snapshot)representative.append(el('p','muted',`页面观察：${p.landing_snapshot.title||'标题未知'} · ${p.landing_snapshot.page_type||'页面类型未知'} · ${time(p.landing_snapshot.observed_at)}`));
 const missing=(p.steps||[]).filter(step=>['identification','coarse'].includes(step.key)&&step.state!=='passed').map(step=>step.label);
 representative.append(el('p','muted','尚待核对：'+(missing.join('、')||'无')));
 lead.append(el('p','muted',`${exact.length} 条关联广告记录 · 不代表独立创意数量或连续投放证明。`),preview);
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
function renderTodos(root){if(!state.project){root.append(empty('先进入一个研究项目','选品队列按项目保存，请从研究项目进入。'));return;}breadcrumbs(root);root.append(el('h2','','快速筛选线索'));const summary=state.project.summary||{};stats(root,[['待筛',summary.pending_triage??'未知'],['已保留',summary.retained??'未知'],['观察中',summary.observing??'未知'],['已淘汰',summary.rejected??'未知']]);const groups=[['triage','待快速筛选'],['retained','保留并深挖'],['blocked','等待来源'],['decision','待决策 / 测试'],['observing','观察中'],['rejected','已淘汰']];let count=0;for(const [key,title] of groups){const rows=state.project.queues?.[key]||[];if(!rows.length)continue;count+=rows.length;const section=box(`${title} · ${rows.length}`),limitKey=`${state.project.id}:${key}`,limit=state.queueLimits[limitKey]||10,visible=rows.slice(0,limit);section.classList.add('queue-group');for(const row of visible){const item=el('div','queue-row'),copy=el('div','queue-copy');copy.append(el('b','',row.name));if(key==='triage'){const signal=row.source_ad_count?`精确来源：${row.source_advertiser||'广告主待核对'} · ${row.source_ad_count} 条广告${row.source_active_since?' · 投放始于 '+row.source_active_since:''}`:'仅关联来源词，未绑定具体广告';copy.append(el('p','queue-signal',signal));if(row.landing_observed)copy.append(el('small','queue-signal','已读取商品页'));}copy.append(el('p','muted',row.source_keyword?'来源词：'+row.source_keyword:row.reason||'等待处理'),el('small','muted',row.reason||''));let action,label=row.action_label||'打开';if(key==='triage')action=()=>openTriage(row.product_id);else if(['observing','rejected'].includes(key)){action=()=>restoreLead(row.product_id);label='恢复线索';}else action=()=>openProduct(row.product_id,row.step||'identification');item.append(copy,button(label,action,key==='triage'?'primary':''));section.append(item);}const remaining=rows.length-visible.length;if(remaining>0)section.append(button(`加载更多（剩余 ${remaining} 条）`,()=>{state.queueLimits[limitKey]=rows.length;render();},'queue-more'));root.append(section);}if(!count)root.append(empty('当前队列已处理完','可以查看结论与复盘，或回到项目补充新的关键词和线索。'));}

 if(state.product)renderLead(root);else{renderTodos(root);renderFocusCard(root);}
 if(state.lastTriage)root.append(button('撤销刚才判断',async()=>{await context.command('undo_triage_product',{product_id:state.lastTriage});state.product=state.lastTriage;state.lastTriage=null;render();}));
 const p=product();if(p)root.append(button('设为当前深挖商品',async()=>{await context.command('focus_product',{product_id:p.id});openProduct(p.id,'identification');}));
 return root;
}
