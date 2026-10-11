async function stopScanAction(action){
 if(S.writeBusy){warn('上一项请求尚未完成，请稍后操作。');return;}
 S.writeBusy=true;
 try{
  await api('/projects/'+S.project.id+'/actions/'+action.id+'/stop',{method:'POST',body:JSON.stringify({attempt:action.attempt})});
  await load();
  S.writeBusy=false;
  render();
  warn(action.kind==='landing'?'商品页读取已停止。可重试读取，或打开商品页人工核对。':'已停止本地采集；如果是 Apify 云端任务，请查看实时日志核对停止结果。');
 }
 catch(e){warn('停止未确认：'+e.message+'。请刷新后核对任务状态。','alert');}
 finally{S.writeBusy=false;}
}

function renderScanControls(root){
 const table=root.querySelector('.secondary-research-body > .table-wrap table');if(!table)return;
 const rows=[...table.querySelectorAll('tr')].slice(1);
 S.project.keywords.forEach((word,index)=>{
  const row=rows[index],action=S.keywordActions[word.id];
  if(!row||!action)return;
  const active=['queued','ready','running'].includes(action.status);
  if(!active&&action.status!=='blocked')return;
  if(!active&&(!word.approved||word.status==='archived'))return;
  const status=row.children[2],controls=row.lastElementChild.querySelector('.actions');if(!controls)return;
  for(const control of [...controls.children])if(['开始搜索','重试搜索'].includes(control.textContent))control.remove();
  status.replaceChildren(stateTag(action.display_status||action.status));
  if(active){controls.append(button('停止',()=>stopScanAction(action)));return;}
  if(action.status==='blocked'){
   status.append(el('p','muted',action.diagnostic||action.message||'采集未完成，旧记录未保存具体原因。'));
   if(action.failure_stage)status.append(el('p','muted','失败阶段：'+stageLabel(action.failure_stage)));
   if(action.recovery_action==='manual'){
    status.append(el('p','muted','请先在 Apify 按任务标签 '+action.id+' 核对上次提交，避免重复收费。'));
    controls.append(link('到 Apify 核对提交','https://console.apify.com/actors/XtaWFhbtfxyzqrFmd/runs'));
   }else{
    const label=action.recovery_action==='resume'?'继续查询结果':action.recovery_action==='restart'?'重新搜索':'重试搜索';
    controls.append(button(label,()=>run('scan',{keyword_id:word.id})));
    if(action.recovery_action==='restart')status.append(el('p','muted','重新搜索将创建新任务并计入预算。'));
   }
  }
 });
}

const renderProjectBeforeProviders=renderProject;
renderProject=function(root){
 renderProjectBeforeProviders(root);
 const exploration=explorationPanel();root.querySelector('.secondary-research')?.before(exploration);
 const modes=S.project.collection_modes||{},target=root.querySelector('.secondary-research-body');
 if(target){const panel=box('采集模式',`Meta：${modes.meta==='api'?'API（Apify）':'UI 自动化'} · Trends：${modes.trends==='api'?'API（SerpApi）':'UI 自动化'}`);panel.append(button('设置采集模式',configureCollection));target.prepend(panel);renderScanControls(root);const live=target.querySelector('.live-log-panel');if(live)root.querySelector('details.secondary-research')?.after(live);}
};

// Exploration reuses reviewed keywords, source passages and durable actions.
// It does not infer a successful product or launch the next search on render.
function returnToExploration(keywordId=null){
 if(keywordId)S.explorationKeyword=keywordId;
 S.view='project';S.product=null;render();
 requestAnimationFrame(()=>document.querySelector('[data-exploration-panel]')?.scrollIntoView({block:'start'}));
}
function newSearchEntry(word){
 const id=S.project.id,version=S.project.version;
 openForm('换一个搜索入口','原搜索与结果会保留。尝试更短的精准短语、一个痛点或一个场景；这是待审核的新入口，没有商品原文时不记为有证据的扩词。',fields([['text','新的广告搜索词'],['type','关键词类型','select',true,typeNames],['meaning','为什么尝试这个词','text',false]]),async data=>{
  S.project=await api('/projects/'+id+'/commands',{method:'POST',body:JSON.stringify({action:'add_keyword',version,command_id:newCommandId(),payload:data})});
  const added=S.project.keywords.find(k=>!k.parent_id&&k.text.toLowerCase()===keywordPreview(data.text).replace('实际搜索：','').toLowerCase());if(added)S.explorationKeyword=added.id;
 },{type:word.type});attachKeywordPreview();
}
function explorationControls(word){
 const controls=el('div','actions'),action=S.keywordActions[word.id],active=action&&['queued','ready','running'].includes(action.status);
 if(active){controls.append(stateTag(action.display_status||action.status),button('停止本次搜索',()=>stopScanAction(action)));return controls;}
 if(word.status==='archived'){controls.append(button('恢复并重新审核',()=>command('restore_keyword',{keyword_id:word.id})));return controls;}
 if(action?.status==='blocked'){
  controls.append(el('p','notice',action.diagnostic||action.message||'采集失败，原因见任务记录。'));
  if(action.failure_stage)controls.append(el('p','muted','失败阶段：'+stageLabel(action.failure_stage)));
 }
 if(!word.approved){
  controls.append(button('修改这个词',()=>editKeyword(word)));
  if(!word.needs_normalization&&!word.stale_source&&!word.legacy_source)controls.append(button('审核这个词',()=>command('approve_keyword',{keyword_id:word.id,approved:true})));
 }else if(action?.recovery_action==='manual'&&action.status==='blocked'){
  controls.append(el('p','notice','提交状态不确定，先按任务标签 '+action.id+' 核对云端记录。'),link('核对 Apify 任务','https://console.apify.com/actors/XtaWFhbtfxyzqrFmd/runs'));
 }else if(action?.status==='blocked'||!['complete','queued','running'].includes(word.status)){
  const label=action?.recovery_action==='resume'?'继续查询结果':action?.recovery_action==='restart'?'重新搜索':action?.status==='blocked'?'重试搜索':'搜索这个词';
  controls.append(button(label,()=>run('scan',{keyword_id:word.id}),'primary'));
  if(action?.recovery_action==='restart')controls.append(el('small','muted','将创建新任务并重新计入预算。'));
 }
 if(!['queued','running'].includes(word.status))controls.append(button('暂停这个入口',()=>command('archive_keyword',{keyword_id:word.id})));
 return controls;
}
function expansionChoices(p,parent){
 const node=el('div','exploration-expansion'),rules=S.project.rules||S.project.limits;
 const children=S.project.keywords.filter(k=>k.parent_id===parent.id&&k.product_id===p.id);
 node.append(el('p','',`下一层来源：${parent.text} → ${p.name} · 已保存 ${children.length} 个建议`));
 if(!p.identification?.relevance_confirmed){node.append(button('识别商品：'+p.name,()=>openProduct(p.id,'identification')));return node;}
 if(!(p.expansion_sources||[]).length){node.append(el('p','muted','先读取商品页或补充关联广告，取得原文后再提词。'),button('补充来源：'+p.name,()=>openProduct(p.id,'identification')));return node;}
 if((parent.depth||0)>=(rules.max_depth??3)||children.length>=(rules.expansion_limit??5)){
  node.append(el('p','muted','已达当前扩词上限；可处理已有新词，或继续验证商品。'));
 }else{
  node.append(el('p','muted','从原文提取人群、痛点、场景和卖点，组成下一轮入口。建议需审核后才搜索。'));
  const controls=el('div','actions');controls.append(button('提取下一层建议',()=>run('expand',{product_id:p.id,keyword_id:parent.id})),button('手动提取新词',()=>addKeyword(parent,p)));node.append(controls);
 }
 for(const child of children){const entry=el('div','evidence');entry.dataset.explorationChild=child.id;entry.append(el('b','',child.text),stateTag(child.status),el('p','muted','提词依据：'+(child.source_quote||'旧记录未保存引用')),explorationControls(child));node.append(entry);}
 return node;
}
function productExplorationPanel(p){
 const panel=box('沿这个商品继续找','发现相邻产品与验证当前商品可以分别推进。扩词仍需确认相关性和原文来源。');panel.dataset.productExploration='true';
 panel.append(button('返回探索分支',()=>returnToExploration(p.source_keyword_ids?.[0])));
 const parents=S.project.keywords.filter(k=>(p.source_keyword_ids||[]).includes(k.id)&&k.status!=='archived');
 for(const parent of parents)panel.append(expansionChoices(p,parent));
 if(!parents.length)panel.append(el('p','muted','暂无活动来源词；请在项目中添加搜索入口，或恢复原来源词。'));
 return panel;
}
function explorationPanel(){
 const p=S.project,panel=box('兔子洞探索','搜索入口 → 看广告和商品 → 提取下一层词 → 审核再搜索。每次操作只推进你选择的入口。');panel.dataset.explorationPanel='true';
 panel.append(el('p','muted','暂停入口会保留记录，不会自动暂停已生成的其他词；运行中的搜索请先停止。分支数字是已保存记录，跨分支可能重复。'));
 if(!p.keywords.length){panel.append(button('添加搜索入口',()=>addKeyword()));return panel;}
 const words=[...p.keywords].sort((a,b)=>(a.depth||0)-(b.depth||0));
 if(!words.some(k=>k.id===S.explorationKeyword))S.explorationKeyword=words.find(k=>k.status!=='archived')?.id||words[0].id;
 for(const word of words){
  const branch=el('details','exploration-branch'),parent=p.keywords.find(k=>k.id===word.parent_id),products=p.products.filter(item=>(item.source_keyword_ids||[]).includes(word.id)&&!item.merged_into),children=p.keywords.filter(k=>k.parent_id===word.id),action=S.keywordActions[word.id],needsAttention=action&&['queued','ready','running','blocked'].includes(action.status);
  branch.dataset.explorationKeyword=word.id;branch.open=word.id===S.explorationKeyword||needsAttention;
  const summary=el('summary','',`${word.depth?'第 '+word.depth+' 层':'初始入口'} · ${word.text} · ${word.ads?.length||0} 条广告 / ${products.length} 个关联商品 / ${children.length} 个下层词`);summary.append(stateTag(word.status));branch.append(summary);
  branch.addEventListener('toggle',()=>{if(branch.open)S.explorationKeyword=word.id;});
  if(parent)branch.append(el('p','muted','来自：'+parent.text+' → '+(p.products.find(item=>item.id===word.product_id)?.name||'历史商品')),el('p','', '提词依据：'+(word.source_quote||'旧记录未保存引用')));
  branch.append(explorationControls(word));
  if(word.message)branch.append(el('p','muted',word.message));
  if(word.ads?.length)branch.append(button('查看本轮广告',()=>showAds(word)));
  if(word.status==='complete'&&!word.ads?.length){branch.append(el('p','notice','本次采集 0 条，不代表没有机会。核对地域和精准短语，尝试更短的词或换一个痛点、场景。'),button('换一个搜索入口',()=>newSearchEntry(word)));}
  if(products.length){
   const list=el('details');list.open=products.length<=3;list.append(el('summary','',`查看 ${products.length} 个关联商品，选择下一步`));
   for(const item of products){const card=el('div','evidence');card.append(el('h3','',item.name));if(['observing','rejected'].includes(item.triage?.state)){card.append(el('p','muted','此线索暂未继续探索。'),button('查看线索判断',()=>openProduct(item.id,'identification')));}else{card.append(expansionChoices(item,word));}card.append(button('验证这个商品',()=>openProduct(item.id,item.todos?.[0]?.step||'identification')));list.append(card);}branch.append(list);
  }else if(word.ads?.length)branch.append(el('p','muted','广告尚未关联具体商品，请从广告核对落地页。'));
  panel.append(branch);
 }
 return panel;
}
