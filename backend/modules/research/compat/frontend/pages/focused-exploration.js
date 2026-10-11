'use strict';

// Focused browsing changes local navigation only; collection still uses durable actions.
S.focusIndices = {};
S.focusLogsOpen = false;
S.focusLibraryOpen = false;
S.verificationModes = {};
S.focusReviewOnly = {};
S.verificationParkCommands = {};

function focusIcon(name) {
 const img=el('img','focus-icon');img.src='/workbench/ui-icons/'+name+'.svg';img.alt='';img.width=20;img.height=20;return img;
}
function focusIconButton(label,icon,fn,cls='') {
 const node=button(label,fn,cls);node.prepend(focusIcon(icon));return node;
}
function focusFacts(values) {
 const list=el('dl','focus-facts');
 for(const [label,value] of values)list.append(el('dt','',label),el('dd','',value));
 return list;
}
function focusWords() {
 return S.project?.keywords||[];
}
function focusCurrentWord() {
 const words=focusWords();let word=words.find(item=>item.id===S.explorationKeyword);
 if(!word)word=words.find(item=>item.status!=='archived'&&item.ads?.length)||words.find(item=>item.status!=='archived')||words[0];
 if(word)S.explorationKeyword=word.id;
 return word;
}
function focusProducts(word) {
 return S.project.products.filter(item=>(item.source_keyword_ids||[]).includes(word.id)&&!item.merged_into
  &&(!S.focusReviewOnly[word.id]||(!item.identification?.relevance_confirmed&&['pending','retained'].includes(item.triage?.state||'pending')&&['needs_review','mismatch'].includes(item.verification?.status))));
}
function focusPosition(word,items) {
 const key=S.project.id+':'+word.id;
 const index=Math.min(Math.max(0,S.focusIndices[key]||0),Math.max(0,items.length-1));
 S.focusIndices[key]=index;
 return index;
}
function focusMove(word,delta,items) {
 const key=S.project.id+':'+word.id;
 S.focusIndices[key]=Math.max(0,Math.min(items.length-1,focusPosition(word,items)+delta));render();
}
function chooseFocusKeyword() {
 openForm('切换搜索词','选择只会切换当前视图；新词需审核后才能搜索。',[],async()=>{});
 $('submit-form').classList.add('hidden');
 const root=$('form-fields'),label=el('label','wide','查找搜索词'),input=el('input');
 input.type='search';input.placeholder='搜索关键词、类型或状态';label.append(input);root.append(label);
 const choices=el('div','wide focus-keyword-list');root.append(choices);
 const draw=()=>{
  const query=input.value.toLowerCase().trim();choices.replaceChildren();
  for(const word of focusWords().filter(item=>[item.text,typeNames[item.type],labels[item.status],keywordSearchSummary(item)].join(' ').toLowerCase().includes(query))){
   const choice=button('',()=>{S.explorationKeyword=word.id;closeDialog();render();});
   choice.dataset.keywordChoice=word.id;
   const copy=el('span','focus-keyword-copy');copy.append(el('strong','',word.text),el('small','',`${typeNames[word.type]||word.type} · ${word.parent_id?'第 '+word.depth+' 层':'初始入口'} · ${keywordSearchSummary(word)}`));
   choice.append(copy,stateTag(S.keywordActions[word.id]?.display_status||word.status));choice.classList.toggle('selected',word.id===S.explorationKeyword);choices.append(choice);
  }
  if(!choices.childNodes.length)choices.append(el('p','muted','没有匹配的搜索词。'));
 };
 input.oninput=draw;draw();input.focus();
}
function focusBoundAds(p,word) {
 if(!p)return word.ads||[];
 const ids=new Set((p.candidate_sources||[]).filter(binding=>binding.keyword_id===word.id).map(binding=>binding.ad_id));
 return (word.ads||[]).filter(ad=>ids.has(ad.id));
}
function focusMedia(word,p,ad,source) {
 const adMedia=Array.isArray(ad?.media)?ad.media:[],pageImages=p?.landing_snapshot?.images||[];
 const items=source==='ad'?adMedia:pageImages.map(url=>({kind:'image',url}));
 return {items:items.filter(item=>{try{const u=new URL(item.url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}).slice(0,12),origin:source==='ad'?'广告素材':'商品页图片 · 非广告素材'};
}
function focusPreview(word,p,ad) {
 const preview=el('section','focus-source'),baseKey=S.project.id+':'+word.id+':'+(p?.id||ad?.id||'entry');
 S.focusMediaSources??={};
 const source=S.focusMediaSources[baseKey]||((ad?.media||[]).length?'ad':(p?.landing_snapshot?.images||[]).length?'product':'ad');
 S.focusMediaSources[baseKey]=source;
 const media=focusMedia(word,p,ad,source),key=baseKey+':'+source;
 const toolbar=el('div','focus-media-toolbar'),choices=el('div','focus-media-modes');
 choices.setAttribute('aria-label','素材类型');
 for(const [value,label] of [['product','商品图'],['ad','广告素材']]){
  const choice=button(label,()=>{S.focusMediaSources[baseKey]=value;render();},source===value?'selected':'');
  choice.setAttribute('aria-pressed',String(source===value));choices.append(choice);
 }
 toolbar.append(choices);preview.append(toolbar);
 S.focusMediaIndices??={};
 let index=Math.max(0,Math.min(media.items.length-1,S.focusMediaIndices[key]||0));
 const stage=el('div','focus-media-stage');stage.dataset.mediaStage='true';
 function missing(title,note){
  stage.replaceChildren();const empty=el('div','focus-media-empty');
  empty.append(focusIcon('photo-off'),el('h3','',title),el('p','muted',note));stage.append(empty);
 }
 if(media.items.length){
  const item=media.items[index],node=el(item.kind==='video'?'video':'img','focus-media-content');
  node.src=item.url;
  if(item.kind==='video'){node.controls=true;node.preload='none';node.playsInline=true;if(item.preview_url)node.poster=item.preview_url;}
  else{node.alt=media.origin+' '+(index+1);node.referrerPolicy='no-referrer';}
  node.onerror=()=>missing('素材暂时无法加载','来源链接可能过期或被限制。请在右侧打开原广告核对；已保存原文仍可阅读。');
  stage.append(node,el('span','focus-media-origin',media.origin));
 }else{
  missing(source==='product'?'尚未保存商品图':ad?'这条广告未保存图片或视频':p?'尚无当前商品的图片或视频':'从一个搜索词开始',
   source==='product'?'请先读取商品页或打开商品来源核对；不会用广告素材替代商品图。':ad?'可在右侧阅读已保存原文，或打开原广告查看素材。后续采集会保留可用素材链接。':p?'这条线索未绑定具体广告，不能用同一关键词下的其他广告代替。请打开商品来源核对。':'添加并审核入口词，再搜索广告。结果会在这里显示。');
 }
 const feedback=el('p','focus-download-feedback');feedback.dataset.downloadFeedback='true';feedback.setAttribute('role','status');
 const download=button('下载当前素材',()=>focusDownload(word,p,ad,source,index,download,feedback),'focus-download');
 download.disabled=!media.items.length;toolbar.append(download);
 preview.append(feedback,stage);
 if(media.items.length){
  const thumbs=el('div','focus-media-thumbs');thumbs.setAttribute('aria-label','素材列表');
  media.items.forEach((item,i)=>{
   const thumb=button('',()=>{S.focusMediaIndices[key]=i;render();},i===index?'selected':'');thumb.setAttribute('aria-label','查看素材 '+(i+1));thumb.setAttribute('aria-pressed',String(i===index));
   const url=item.kind==='image'?item.url:item.preview_url;
   if(url){const image=el('img');image.src=url;image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';image.onerror=()=>{image.remove();thumb.append(focusIcon('photo-off'));};thumb.append(image);}
   else{thumb.append(focusIcon('file-text'),el('small','',item.kind==='video'?'视频 '+(i+1):'图片 '+(i+1)));}
   thumbs.append(thumb);
  });preview.append(thumbs);
 }
 const action=S.keywordActions[word.id];
 if(action?.result?.evidence_id){
  const image=el('img','focus-capture');image.src='/workbench/api/projects/'+S.project.id+'/actions/'+action.id+'/screenshot';image.alt='本轮搜索页面截图，非当前商品专属素材';image.loading='lazy';
  const capture=el('details','focus-capture-details');capture.append(el('summary','','查看本轮搜索页面截图 · 非当前商品专属素材'),image);
  image.onerror=()=>{capture.remove();};preview.append(capture);
 }
 return preview;
}
async function focusDownload(word,p,ad,source,index,node,feedback){
 node.disabled=true;node.textContent='下载中…';feedback.textContent='正在读取当前素材，请稍候。';
 const query=new URLSearchParams({keyword_id:word.id,product_id:p?.id||'',ad_id:ad?.id||'',source,index:String(index)});
 try{
  const response=await fetch('/workbench/api/projects/'+S.project.id+'/media-download?'+query);
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(typeof data.detail==='string'?data.detail:'下载失败，请打开原来源核对。');}
  const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=el('a');
  anchor.href=url;anchor.download=response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]||'rabbit-hole-media';
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
  feedback.textContent='已交给浏览器下载，请查看下载列表。';
 }catch(error){feedback.textContent=error.message||'下载失败，请稍后重试或打开原来源。';}
 finally{node.disabled=false;node.textContent='下载当前素材';}
}
async function focusCopyOriginal(original,node){
 let copied=false;
 try{
  if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(original);copied=true;}
  else{const field=el('textarea');field.value=original;field.style.position='fixed';field.style.left='-9999px';document.body.append(field);field.select();copied=document.execCommand('copy');field.remove();}
 }catch{}
 node.textContent=copied?'已复制原文':'复制未完成，请选择原文复制';
}


async function focusParkMismatches(word) {
 if(S.writeBusy){warn('上一项保存尚未完成，请稍后再试。');return;}
 S.writeBusy=true;let saved=0;
 try{
  const projectId=S.project.id;
  S.project=await api('/projects/'+projectId);
  const items=S.project.products.filter(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id)
   &&!p.identification?.relevance_confirmed&&['pending','retained'].includes(p.triage?.state||'pending')&&p.verification?.status==='mismatch'&&(p.triage?.state||'pending')==='pending');
  for(const p of items){
   const key=projectId+':'+p.id+':'+p.verification.checked_at;
   const payload={product_id:p.id,disposition:'observing',reason:'按自动核对依据批量跳过，暂存观察，可恢复：'+(p.verification.reason||'可能不相关')};
   S.verificationParkCommands[key] ||= newCommandId();
   S.project=await api('/projects/'+projectId+'/commands',{method:'POST',body:JSON.stringify({
    action:'triage_product',version:S.project.version,command_id:S.verificationParkCommands[key],payload})});saved++;
  }
  const remaining=focusProducts(word),index=remaining.findIndex(p=>(p.triage?.state||'pending')==='pending');
  if(index>=0)S.focusIndices[projectId+':'+word.id]=index;
  S.writeBusy=false;await afterSave('已批量跳过 '+saved+' 个不相关线索，暂存到观察中；证据保留，可从选品队列恢复。');
 }catch(e){
  try{await load();}catch{}
  render();warn('本次已暂存 '+saved+' 个线索；其余未确认完成：'+e.message+'。可刷新核对后重试，已保存记录保留。');
 }finally{S.writeBusy=false;}
}

function focusVerificationPanel(word) {
 const section=el('section','focus-verification');section.dataset.verificationPanel='true';
 const products=S.project.products.filter(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id));
 const matched=products.filter(p=>p.identification?.relevance_confirmed).length;
 const reviews=products.filter(p=>!p.identification?.relevance_confirmed&&['pending','retained'].includes(p.triage?.state||'pending')&&p.verification?.status==='needs_review').length;
 const mismatches=products.filter(p=>!p.identification?.relevance_confirmed&&['pending','retained'].includes(p.triage?.state||'pending')&&p.verification?.status==='mismatch').length;
 const action=S.verificationActions?.[word.id],active=action&&['ready','running'].includes(action.status);
 const heading=el('div','focus-verification-heading');
 heading.append(el('strong','','自动核对商品'),el('span','muted',matched+' 个已匹配 · '+reviews+' 个待确认 · '+mismatches+' 个可能不相关'));
 section.append(heading);
 const controls=el('div','actions'),label=el('label','','商品页读取方式'),select=el('select');
 select.setAttribute('aria-label','自动核对的商品页读取方式');
 for(const [value,text] of [['local','本地读取'],['firecrawl','Firecrawl']]){const option=el('option','',text);option.value=value;select.append(option);}
 select.value=S.verificationModes[word.id]||'local';select.disabled=!!active;
 select.onchange=()=>{S.verificationModes[word.id]=select.value;};label.append(select);
 const runBatch=retry=>run('verify',{keyword_id:word.id,landing_mode:S.verificationModes[word.id]||'local',...(retry?{retry_review:true}:{})});
 const start=button('自动核对当前词',()=>runBatch(false),'primary');start.disabled=!!active||!products.length;
 controls.append(start,label);
 if(active)controls.append(button('停止自动核对',async()=>{
  try{await api('/projects/'+S.project.id+'/actions/'+action.id+'/stop',{method:'POST',body:JSON.stringify({attempt:action.attempt})});await afterSave('已停止自动核对及本批次发起的商品页读取；已保存结果保留。');}catch(e){warn(e.message);}
 }));
 else if(action?.status==='blocked'||reviews||mismatches)controls.append(button('重新核对疑点',()=>runBatch(true)));
 const skippable=products.filter(p=>!p.identification?.relevance_confirmed&&p.verification?.status==='mismatch'&&(p.triage?.state||'pending')==='pending');
 if(skippable.length){const skip=button('批量跳过不相关线索（'+skippable.length+'）',()=>focusParkMismatches(word));skip.title='暂存到观察中，保留历史并可恢复';skip.disabled=!!active;controls.append(skip);}
 const filterLabel=el('label','','只看需人工确认'),filter=el('input');filter.type='checkbox';filter.checked=!!S.focusReviewOnly[word.id];
 filter.onchange=()=>{S.focusReviewOnly[word.id]=filter.checked;S.focusIndices[S.project.id+':'+word.id]=0;render();};filterLabel.prepend(filter);controls.append(filterLabel);
 section.append(controls,el('p','muted','每批最多20个；补读商品页并调用AI（Firecrawl可能计费）。明确匹配直接开放提词；不确定的保留人工入口。'));
 if(active){const progress=action.progress||{},status=action.stage==='ai_verify'?'正在核对广告与商品页':action.stage==='verification_save'?'正在保存核对结果':'正在读取缺失商品页';section.append(el('p','',status+' · 商品页完成 '+(progress.complete||0)+'/'+(progress.total||0)+' · 读取失败 '+(progress.failed||0)));}
 else if(action?.status==='blocked')section.append(el('p','notice','自动核对未完成：'+(action.diagnostic||action.message||'原因未确定')+'；可重新核对或人工确认。'));
 else if(action?.result?.total!=null)section.append(el('p','', '本批完成：'+action.result.matched+' 个匹配，'+action.result.needs_review+' 个待确认，'+action.result.mismatch+' 个可能不相关。'));
 const feedback=S.verificationFeedback;
 if(feedback?.projectId===S.project.id&&feedback.keywordId===word.id)section.append(el('p','',feedback.message));
 if(reviews||mismatches){const list=el('details','focus-review-list');list.append(el('summary','', '待你处理的疑点（'+(reviews+mismatches)+'）'));
  for(const p of products.filter(p=>!p.identification?.relevance_confirmed&&['pending','retained'].includes(p.triage?.state||'pending')&&['needs_review','mismatch'].includes(p.verification?.status))){
   const row=el('div','evidence');row.append(el('strong','',p.name),el('p','',p.verification.reason||'请核对原来源'),button('人工确认这个商品',()=>confirmProduct(p.id,{stayInExploration:true})),button('判断或跳过这个商品',()=>openTriage(p.id)));list.append(row);
  }section.append(list);
 }
 return section;
}

function focusLeadInfo(word,p,ad) {
 const info=el('section','focus-lead-info'),confirmed=p?.identification?.relevance_confirmed===true;
 const automatic=confirmed&&p?.identification?.confirmation_method==='ai';
 const status=el('p','focus-review-note',p?(confirmed?(automatic?'AI匹配明确 · 可以继续提词，粗筛仍需单独核验':'相关性已确认 · 粗筛与渠道验证仍需分别核对'):'待核验 · 需确认与关键词相关、具体商品及原文来源，才能继续提取下层词。'):ad?'待核验 · 广告采集结果仍需确认具体商品与原文来源。':'先审核并搜索入口词，再从真实广告中识别商品。');
 status.prepend(focusIcon('circle-dot'));info.append(status);
 info.append(el('h2','',p?.name||ad?.advertiser||'当前搜索入口'));
 if(p?.verification){const proof=el('details','focus-verification-proof');proof.append(el('summary','',automatic?'查看AI匹配依据':'查看自动核对疑点'),el('p','',p.verification.reason||''));for(const cite of p.verification.citations||[])proof.append(el('blockquote','',(cite.source_kind==='ad'?'广告原文：':'商品页原文：')+cite.source_quote));info.append(proof);}
 const meta=el('div','focus-ad-meta');meta.append(el('span','',ad?'来源：Meta 广告库（公开广告）':p?'来源：已保存商品线索':'来源：当前关键词'));
 if(p?.created_at||ad?.observed_at)meta.append(el('span','', '发现时间：'+new Date(p?.created_at||ad.observed_at).toLocaleDateString('zh-CN')));
 info.append(meta);
 if(ad){
  const quote=adTextPanel(word,ad,'blockquote','focus-source-quote'),original=ad.primary_text||'';
  quote.classList.add('focus-copy-card');
  if(usableAdCopy(original)){const copy=button('复制原文',()=>focusCopyOriginal(original,copy),'focus-copy-original');quote.prepend(copy);}
  info.append(quote);
 }else{
  const passage=p?.expansion_sources?.find(item=>item.source_kind==='landing')?.text;
  if(passage){const quote=el('blockquote','focus-source-quote',passage),card=el('div','focus-copy-card');card.append(quote,el('small','muted','商品页原文 · 未代替人工核验'));info.append(card);}
  else if(p)info.append(el('p','focus-copy-unavailable','未绑定具体广告，尚无可核对的广告原文。可打开商品来源人工核验。'));
 }
 if(!p){
  info.dataset.searchEntryHelp='true';
  if(!ad){info.append(el('p','',keywordSearchSummary(word)),el('p','muted',keywordEntryHint(word)));
   const action=S.keywordActions[word.id];if(!action&&word.message)info.append(el('p','muted',word.message));
   if(!word.approved&&word.status!=='archived')info.append(el('p','notice','下一步：修改或审核这个词；审核后点击「搜索这个词」。'));}
  if(keywordSearchSummary(word).startsWith('本次采集 0 条'))info.append(el('p','notice','本次采集 0 条，不代表没有机会。核对地域和精准短语，尝试更短的词或换一个痛点、场景。'),button('换一个搜索入口',()=>newSearchEntry(word)));
  if(ad){
   const actions=el('div','actions focus-lead-actions');actions.append(button('添加具体商品',addProduct,'primary'),link('查看原广告','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));info.append(actions);
   info.append(focusFacts([['广告编号',ad.id],['记录的状态',ad.active?'当前活跃':'状态待核对'],['开始日期',ad.start_date||'未知']]));
  }
  return info;
 }
 const actions=el('div','actions focus-lead-actions');
 const next=focusIconButton(confirmed?'继续验证商品':'确认具体商品','circle-check',()=>confirmed?openProduct(p.id,p.todos?.[0]?.step||'identification'):confirmProduct(p.id,{stayInExploration:true}),'primary focus-primary');
 next.setAttribute('aria-label',confirmed?'验证这个商品':'识别商品：'+p.name);next.append(focusIcon('arrow-right'));
 actions.append(next);
 if(ad)actions.append(link('查看原广告','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));
 else actions.append(link('查看商品来源',p.url));
 actions.append(focusIconButton('先跳过','chevron-right',()=>{const items=focusProducts(word);if(focusPosition(word,items)<items.length-1)focusMove(word,1,items);else warn('已到最后一条线索，可切换搜索词或快速判断这条线索。');},'focus-skip'));
 info.append(actions);
 const identity=p.identification||{},data=el('div','focus-info-grid');
 const facts=el('div');facts.append(el('h3','','基础信息（'+(confirmed?'相关性已确认':'待核验')+'）'),focusFacts([['商品名称',confirmed?p.name:'待识别'],['品牌',identity.brand||'未知'],['商品链接',p.url?'已保存 · 待核对':'待确认'],['商品相关性',confirmed?'已确认':'待确认'],['原广告绑定',ad?'已绑定':'未绑定具体广告'],['首次投放距今',adAgeLabel(identity)],['当前状态',activeStatusLabel(identity.currently_active)]]));
 const help=el('div','focus-help');help.append(focusIcon('circle-dot'),el('strong','','核验提醒'));
 const list=el('ul');for(const note of ['先确认广告中的商品与搜索词 '+word.text+' 是否相关。','核实具体商品及原文来源后，再进入下一步提取下层词。','首次投放年龄不代表持续投放；采集完成不代表通过粗筛。'])list.append(el('li','',note));help.append(list);
 data.append(facts,help);info.append(data);
 const quick=el('div','focus-secondary-actions');quick.append(link('打开商品来源',p.url),button('读取商品页',()=>openProduct(p.id,'identification'),'ghost'),...(confirmed?[button('纠正商品确认',()=>confirmProduct(p.id,{stayInExploration:true}),'ghost')]:[]),button('快速判断这条线索',()=>openTriage(p.id),'ghost'));info.append(quick);
 return info;
}
function focusedExpansion(word,p) {
 const section=el('section','focus-expansion');
 section.append(el('div','focus-expansion-heading','从这个线索继续挖'));
 if(p?.identification?.relevance_confirmed){
  section.append(expansionChoices(p,word));
 }else{
  const steps=el('div','focus-expansion-steps');
  for(const [icon,label] of [['circle-check','确认商品相关性'],['link','核对单一原文来源'],['file-text','提取人群、痛点、场景、卖点']]){
   const step=el('div');step.append(focusIcon(icon),el('span','',label));steps.append(step);
  }
  const disabled=button('提取下一层词',()=>{},'focus-expand-disabled');disabled.disabled=true;
  section.append(el('p','muted','先确认商品相关性和可引用原文，再提取下一层词；新词仍需审核。'),steps,disabled);
 }
 const children=S.project.keywords.filter(item=>item.parent_id===word.id);
 if(children.length){
  const list=el('details','focus-child-list');list.append(el('summary','',children.length+' 个下层词 · 选择下一轮入口'));
  for(const child of children)list.append(button(child.text,()=>{S.explorationKeyword=child.id;render();}));
  section.append(list);
 }
 return section;
}
explorationPanel=function() {
 const panel=el('section','focus-exploration');panel.dataset.explorationPanel='true';
 const word=focusCurrentWord();
 const toolbar=el('div','focus-toolbar');
 toolbar.append(el('h2','','兔子洞探索'),el('p','muted','搜索入口 → 看广告和商品 → 提取下一层词 → 审核再搜索。'));
 const tools=el('div','actions');tools.append(focusIconButton('切换搜索词','search',chooseFocusKeyword),button('添加入口词',()=>addKeyword()));
 tools.append(button('AI 生成入口词',()=>run('keywords')));
 toolbar.append(tools);panel.append(toolbar);
 const guide=el('p','muted','先用常见入口找广告，再从广告和商品页提取人群、痛点、场景、卖点；新词审核后再搜。');guide.dataset.entryGuide='true';panel.append(guide);
 if(!word){const emptyState=empty('从一个入口词开始探索','先添加一个类目、痛点或场景词；审核后再搜索。',button('添加搜索入口',()=>addKeyword(),'primary'));panel.append(emptyState);return panel;}
 panel.append(focusVerificationPanel(word));
 const products=focusProducts(word),items=S.focusReviewOnly[word.id]?products:products.length?products:(word.ads||[]),index=focusPosition(word,items),p=products[index],ads=focusBoundAds(p,word),ad=products.length?ads[0]:items[index];
 const work=el('section','focus-workspace');work.dataset.focusWorkspace='true';work.dataset.explorationKeyword=word.id;
 const head=el('div','focus-workspace-head'),path=el('div','focus-lineage');
 const parent=S.project.keywords.find(item=>item.id===word.parent_id);
 path.append(el('span','',parent?parent.text:'初始入口'),el('strong','',word.text),el('span','',items.length?'线索 '+(index+1)+' / '+items.length:'尚无线索'));
 const arrows=el('div','focus-arrows'),prev=focusIconButton('上一条线索','chevron-left',()=>focusMove(word,-1,items),'icon-button'),next=focusIconButton('下一条线索','chevron-right',()=>focusMove(word,1,items),'icon-button');
 prev.disabled=index===0;next.disabled=!items.length||index===items.length-1;arrows.append(prev,next);path.append(arrows);
 const stages=el('div','focus-stages'),current=p?.identification?.relevance_confirmed?2:0;
 for(const [i,label] of ['看广告','识别商品','提取下层词'].entries()){if(i)stages.append(focusIcon('arrow-right'));const step=el('span',i===current?'active':'');step.append(el('b','focus-stage-number',i+1),el('span','',label));stages.append(step);}
 head.append(path,stages);work.append(head);
 const scan=el('div','focus-search-status');scan.dataset.searchSummary='true';scan.append(stateTag(S.keywordActions[word.id]?.display_status||word.status),el('span','muted',`${keywordSearchSummary(word)} · ${products.length} 个关联商品`),explorationControls(word));work.append(scan);
 if(word.source_quote)work.append(el('p','focus-parent-quote','提词依据：'+word.source_quote));
 const body=el('div','focus-body');body.append(focusPreview(word,p,ad),focusLeadInfo(word,p,ad));work.append(body);
 panel.append(work,focusedExpansion(word,p));
 return panel;
};

const renderProjectBeforeFocus=renderProject;
renderProject=function(root) {
 renderProjectBeforeFocus(root);root.classList.add('focus-project');
 const rows=[...root.querySelectorAll('.secondary-research table tr')].slice(1);
 S.project.keywords.forEach((word,index)=>{const cell=rows[index]?.children[2];if(cell&&!cell.textContent.includes(keywordSearchSummary(word)))cell.append(el('p','muted',keywordSearchSummary(word)));});
 const focused=root.querySelector('[data-exploration-panel]'),crumbs=root.querySelector('.breadcrumbs');
 if(focused){root.insertBefore(focused,crumbs?.nextSibling||root.firstChild);focused.querySelector('[data-entry-guide]').after(keywordFeedbackNode(true));}
 if(crumbs)document.querySelector('header > div:first-child').prepend(crumbs);
 const guide=root.querySelector('.guidance-hero'),currentWord=focusCurrentWord(),currentProducts=currentWord?focusProducts(currentWord):[],currentProduct=currentProducts.length?currentProducts[focusPosition(currentWord,currentProducts)]:null;
 if(guide){
  guide.classList.add('focus-guidance');
  if(!currentProduct)guide.remove();
  else{
   guide.replaceChildren();guide.dataset.guidanceProduct=currentProduct.id;
   const state=currentProduct.triage?.state;
   if(state==='retained'){
    guide.append(el('h2','','继续研究当前商品 · '+currentProduct.name),el('p','muted','已保留这条线索；可继续探索相邻产品，也可单独进入当前商品的研究步骤。'),button('打开当前商品研究',()=>openProduct(currentProduct.id,currentProduct.todos?.[0]?.step||'identification'),'primary'));
   }else if(['observing','rejected'].includes(state)){
    guide.append(el('h2','','当前线索 · '+currentProduct.name),el('p','muted',state==='observing'?'此线索暂时观察，可查看档案后决定是否恢复。':'此线索已淘汰，可查看档案后决定是否恢复。'),button('查看当前线索档案',()=>openProduct(currentProduct.id,'identification')));
   }else{
    guide.append(el('h2','','判断当前商品是否值得保留 · '+currentProduct.name),el('p','muted','可沿当前来源继续挖词，也可判断是否保留、观察或淘汰；保留后再进入详细研究。'),button('判断是否保留当前商品',()=>openTriage(currentProduct.id),'primary'));
   }
  }
 }
 const stats=root.querySelector('.stats');if(stats)stats.classList.add('focus-stats');
 const live=root.querySelector('.live-log-panel'),actions=root.querySelector('.action-record')?.closest('.panel'),logs=el('details','focus-log-drawer');
 logs.open=S.focusLogsOpen;logs.ontoggle=()=>{S.focusLogsOpen=logs.open;};
 const summary=el('summary');summary.append(focusIcon('list-details'),el('strong','','任务与日志（最近 '+S.actions.length+' 条）'),el('span','muted','查看执行阶段、失败原因与历史'));logs.append(summary);
 if(live)logs.append(live);if(actions)logs.append(actions);if(live||actions)focused?.after(logs);
 const library=root.querySelector('.secondary-products'),head=library?.previousElementSibling;
 if(library){const all=el('details','focus-library');all.open=S.focusLibraryOpen||!S.project.keywords.length;all.ontoggle=()=>{S.focusLibraryOpen=all.open;};all.append(el('summary','',S.project.products.length+' 个商品档案 · 查看全部'));library.before(all);if(head?.classList.contains('section-head'))all.append(head);all.append(library);}
 const secondary=root.querySelector('details.secondary-research > summary');if(secondary)secondary.textContent='补充线索与研究设置';
};
const renderBeforeFocus=render;
render=function() {
 document.querySelector('header .breadcrumbs')?.remove();
 $('content').classList.remove('focus-project');
 renderBeforeFocus();
 document.body.dataset.view=S.view;
 if(S.focusFeedbackPending){S.focusFeedbackPending=false;requestAnimationFrame(()=>document.querySelector(S.secondaryResearchOpen?'.secondary-research [data-keyword-feedback]:not(.hidden)':'[data-entry-feedback]:not(.hidden)')?.scrollIntoView({block:'nearest'}));}
 if(S.view==='project'&&S.project){const word=focusCurrentWord();if(word)$('subtitle').textContent=S.project.keywords.length+' 个关键词 · 当前查看 '+word.text+' · '+(word.ads||[]).length+' 条广告（样本） · '+focusProducts(word).length+' 个关联商品 · '+S.project.keywords.filter(item=>item.parent_id===word.id).length+' 个下层词';}
 if(['project','product','triage'].includes(S.view)){
  const modes=S.project?.collection_modes||{};$('connection').textContent='Meta '+(modes.meta==='api'?'API':'UI')+' · '+$('connection').textContent.replace(/^(?:Meta (?:API|UI) · )+/, '');
 }
};
