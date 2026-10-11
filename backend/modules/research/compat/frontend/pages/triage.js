function renderTriage(root){
 breadcrumbs(root);const p=product();
 if(!p){root.append(empty('这条线索已不在当前队列','返回选品队列继续。',button('返回选品队列',()=>{S.view='todos';render();})));return;}
 const lead=el('section','panel triage-card');lead.dataset.currentLead='true';
 const identified=p.identification?.relevance_confirmed===true,title=el('h2','',identified?p.name:'待识别商品');title.tabIndex=-1;
 lead.append(el('span','eyebrow','当前线索'),title);
 if(!identified)lead.append(el('p','current-record',`当前记录：${p.name}`));
 const remaining=S.project.summary?.pending_triage??S.project.queues?.triage?.length??0,processed=S.triageSession.projectId===S.project.id?S.triageSession.processed:0;
 lead.append(el('p','triage-progress',`本次已处理 ${processed} 条 · 剩余 ${remaining} 条`),el('p','muted','先用三项标准快速判断，不在这里完成全部研究。'));
 const criteria=el('ul','triage-criteria');
 for(const item of ['是否能识别出一个明确可销售的具体商品','商品页或广告来源是否可以核对','当前信号是否值得进入后续深挖'])criteria.append(el('li','',item));
 lead.append(criteria);
 const sourceIds=p.source_keyword_ids||[],sources=S.project.keywords.filter(keyword=>sourceIds.includes(keyword.id));
 for(const source of sources)lead.append(el('p','source-line','来源词：'+source.text));
 const exact=[],seen=new Set();
 for(const binding of p.candidate_sources||[]){
  const key=`${binding.keyword_id||''}:${binding.ad_id||''}`;if(seen.has(key))continue;
  const source=S.project.keywords.find(keyword=>keyword.id===binding.keyword_id),ad=source?.ads?.find(item=>item.id===binding.ad_id);
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
 const representative=el('div','triage-representative'),ad=exact[0],word=S.project.keywords.find(item=>item.id===ad?.keyword_id)||sources[0]||{id:'',ads:[]};
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
  more.addEventListener('toggle',()=>{
   if(!more.open||populated)return;populated=true;
   more.append(el('p','muted','第一条已在上方展示，以下为其余关联记录。'));
   for(const other of exact.slice(1))more.append(evidenceCard(other));
  });
  lead.append(more);
 }
 root.append(lead);
}
function renderFocusCard(root){const id=S.project?.focus_product_id,p=S.project?.products.find(item=>item.id===id);if(!p)return;const guide=S.project.guidance||{},card=box('当前深挖商品',p.name);card.classList.add('focus-card');card.dataset.currentFocus='true';const current=p.steps?.find(step=>step.key===(guide.product_id===p.id?guide.step:null))||p.steps?.find(step=>!['passed','not_applicable'].includes(step.state));if(current)card.append(el('p','muted',`当前阶段：${current.label} · ${current.reason}`));card.append(button('继续深挖',()=>openProduct(p.id,current?.key||'identification'),'primary'));root.append(card);}
