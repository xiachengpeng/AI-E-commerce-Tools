import {frameIdentityResult,isMismatch} from './identity-result.mjs';
import {stageTitles} from '../pages/stage-selection.mjs';
import {el,button,link} from './elements.mjs';
import {mediaPath} from '../services/actions.mjs';
import {sourcePreview} from './ad-copy.mjs';
import {decisionSummary,scoreMessage,scanCandidates} from '../services/journey.mjs';
import {createLifecycle} from '../lifecycle.mjs';
import {sourceMediaKey} from '../services/media-cache.mjs';

const productPages={identification:['06','确认具体商品','对照商品与广告来源，确认后再继续。'],coarse:['07','这些广告足以支持继续研究吗？','核实广告年龄、当前投放状态和独立创意。'],expansion:['08','从可靠原文，找到下一条线索','只引用当前商品、当前来源的原文，新词仍需审核。'],channels:['09','有没有持续需求，竞争是否可进入？','结合多渠道证据，判断需求与竞争，避免只看单一来源。'],funnel:['10','广告吸引了谁，商品页如何说服？','对照实际观察，区分事实、线索和仍未核实的内容。'],economics:['11','一笔订单，真正能留下多少？','核算真实订单成本；未知费用保持未知。'],score:['12','先补齐证据，再看评分','评分是研究参考，缺少必要证据时暂不评分。'],decision:['13','现在值得测试，还是先放一放？','结合已核实证据，记录人工决定与理由。'],test:['14','先写清成功线和停止线','保存计划不会创建广告或自动花费预算。'],review:['16','这轮研究学到了什么？','记录依据、未知项与下一步，让线索回到下一轮研究。']};
const pages={projects:['01','我的选品研究','从一个方向或已有商品开始，逐步核实是否值得测试。'],project:['04','核实商品','对照商品与广告来源，确认后再继续。'],triage:['05','把精力放在下一件值得研究的商品上','逐项筛选，保留值得深挖的线索。'],reports:['17','这轮选品，留下了什么结论？','查看商品去向、关键依据与下一步。'],actions:['18','任务在做什么，哪里需要你处理','已保存结果保留；未完成不等于零结果。'],paths:['19','每条线索，都能追溯来源','搜索词 → 来源广告 → 具体商品 → 下一层搜索词。'],sync:['21','先核对摘要，再同步到飞书','只同步明确批准的版本，后续修改不会自动写入。'],history:['22','每次修改和决定，都有迹可循','查看保存的修改、决定和版本；研究历史长期保留。'],settings:['23','草稿安全保留，需要时再继续','接口在系统设置统一管理，草稿导入只作人工核对。']};
export function designPage(state){
 let row=state.view==='product'?productPages[state.step]||productPages.identification:pages[state.view]||pages.projects;
 if(state.view==='product_selection')row=[({channels:'09',economics:'11',decision:'13'})[state.stageTarget]||'09','选择商品 · '+(stageTitles[state.stageTarget]||stageTitles.channels),'请先选择要研究的具体商品。'];
 if(state.view==='product'&&state.step==='test'&&state.testPane==='results')row=['15','真实测试结果','只记录实际执行结果，核对来源和统计区间。'];
 if(state.view==='project'&&state.projectSection==='keywords')row=['03','先选好搜索词，再找广告','审核搜索词后再搜索，保留每条新词的来源。'];
 if(state.view==='form')row=state.form?.kind==='new_project'?['02','开始一项新研究','先确定卖给谁，再寻找值得测试的商品。']:state.form?.kind?.startsWith('configure')?['20','项目规则、预算与采集方式','只影响当前项目；变更后相关评分与决定需要重新核对。']:['03','准备与审核搜索词','新词审核后才搜索，不会自动开始采集。'];
 if(state.view==='form'&&state.form?.parent)row=productPages.expansion;
 return {number:row[0],title:row[1],description:row[2],journey:['product_selection','product','project','triage','reports'].includes(state.view)||state.view==='form'&&['new_project','add_keyword','edit_keyword','new_search_entry'].includes(state.form?.kind)};
}
export function icon(context,name){const node=el(context,'i','ph ph-'+name);node.setAttribute('aria-hidden','true');return node;}
export function formSection(def,title){
 if(def.group)return def.group;
 if(/项目规则与预算/.test(title))return /scan|budget/.test(def.key)?'采集与预算':/depth|expansion|ai_/.test(def.key)?'扩词与 AI 上限':'选品标准与证据时效';
 if(/核算|订单测算/.test(title)){
  if(['unit_price','quantity','aov','bundle_reason'].includes(def.key))return '售价与订单';
  if(['goods_cost','shipping','packaging','tax','ad_cost','payment_percent','payment_fixed','reserve_percent'].includes(def.key))return '成本与费用';
  if(['weight_kg','package_length_cm','package_width_cm','package_height_cm'].includes(def.key))return '包装与物流';
  if(['quote_source','quote_date','quote_confirmed'].includes(def.key))return '报价来源与时效';
  return '风险与认证';
 }
 if(/测试结果/.test(title))return ['period_start','period_end','source_url','confirmed','reason'].includes(def.key)?'统计口径与来源':'费用与转化';
 if(/粗筛素材/.test(title)&&def.key.startsWith('creative_'))return '创意 '+def.key.split('_')[1]+' · 待人工核实';
 return '';
}
/** Only saved source media, through the existing protected endpoint and bounded cache. */
export function productThumbnail(context,product){
 const host=el(context,'span','rw-product-thumb');host.append(icon(context,'package'));host.setAttribute('aria-label','商品来源缩略图');
 const word=context.state.project?.keywords?.find(w=>(product.source_keyword_ids||[]).includes(w.id));
 if(!word||!product.landing_snapshot?.images?.length||!context.mediaCache)return host;
 const projectId=context.state.project.id,key=sourceMediaKey(projectId,word.id,'product',product.id,product.identity_revision,product.landing_snapshot.observed_at,product.landing_snapshot.images,0);
 const load=()=>context.mediaCache.acquire(key,mediaPath(projectId,{keyword_id:word.id,product_id:product.id,source:'product',index:0})).then(lease=>{
  if(!lease)return;if(!context.life.active){lease.release();return;}context.life.track(()=>lease.release());
  const image=el(context,'img');image.alt=product.name||'商品来源图片';image.src=lease.url;context.life.listen(image,'error',()=>{image.remove();});host.append(image);
 }).catch(()=>{});
 const Observer=context.root.ownerDocument.defaultView?.IntersectionObserver;
 if(Observer){const observer=new Observer(entries=>{if(context.life.active&&entries.some(entry=>entry.isIntersecting)){observer.disconnect();void load();}},{root:context.root,rootMargin:'160px'});observer.observe(host);context.life.track(()=>observer.disconnect());}else void load();return host;
}
/** Exact bound ad thumbnail through the same project-scoped media cache. */
export function adThumbnail(context,word,ad){
 const host=el(context,'span','rw-ad-thumb');host.append(icon(context,'megaphone'));host.setAttribute('aria-label','绑定广告来源素材');if(!ad?.media?.length||!context.mediaCache)return host;
 const id=context.state.project.id,key=sourceMediaKey(id,word.id,'ad',ad.id,0,ad.observed_at,ad.media,0);void context.mediaCache.acquire(key,mediaPath(id,{keyword_id:word.id,ad_id:ad.id,source:'ad',index:0})).then(lease=>{if(!lease)return;if(!context.life.active){lease.release();return;}context.life.track(()=>lease.release());const video=lease.type?.startsWith('video/'),media=el(context,video?'video':'img');if(video){media.preload='metadata';media.muted=true;media.playsInline=true;media.setAttribute('aria-label','绑定来源广告视频');context.life.track(()=>{media.pause?.();media.removeAttribute('src');media.load?.();});}else media.alt='绑定来源广告素材';context.life.listen(media,'error',()=>media.remove());media.src=lease.url;host.append(media);}).catch(()=>{});return host;
}
export function renderCandidateList(context,products,selectedId,onSelect){
 const host=el(context,'section','rw-candidate-list');host.setAttribute('aria-label','候选商品');
 host.append(el(context,'h2','','候选商品（'+products.length+'）'),el(context,'p','rw-candidate-help','先从广告线索核实商品；广告主页名称不等于商品名称。'));
 if(!products.length)host.append(el(context,'p','rw-muted','尚无匹配的商品线索。'));
 for(const product of products){
  const row=button(context,'',()=>onSelect(product),'rw-candidate-row');row.dataset.candidateId=product.id;row.setAttribute('aria-pressed',String(product.id===selectedId));
  const copy=el(context,'span','rw-candidate-copy'),fromAd=(product.candidate_sources||[]).some(source=>source.advertiser&&source.advertiser===product.name);copy.append(el(context,'small','rw-candidate-origin',fromAd?'广告主页':'商品名称'),el(context,'strong','',product.name||'待识别商品'),el(context,'span','rw-tag',product.identification?.relevance_confirmed?(product.identification.confirmation_method==='ai'?'AI 已匹配，待人工核对':'人工已确认'):isMismatch(product)?'人工确认不一致':'待确认匹配'));
  row.append(productThumbnail(context,product),copy,icon(context,'caret-right'));host.append(row);
 }return host;
}
export function renderJourney(context){
 const state=context.state,host=el(context,'nav','rw-design-journey');host.setAttribute('aria-label','研究进度');
 const entries=[['找线索','选择搜索词，找到公开广告',null],['核实商品','确认来源与独立活跃素材','identification'],['需求与竞争','核对需求、竞争与商品页','channels'],['算清利润','估算成本，核实风险','economics'],['做决定','记录决定、测试与复盘','decision']];
 const isNew=state.view==='form'&&state.form?.kind==='new_project';if(isNew)entries.unshift(['新建研究','确定方向与目标',null]);
 const group=state.view==='product_selection'?({channels:2,economics:3,decision:4}[state.stageTarget]??2):state.view==='product'?({identification:1,coarse:1,expansion:2,channels:2,funnel:2,economics:3,score:3,decision:4,test:4,review:4}[state.step]??1):state.view==='reports'?4:state.view==='triage'||state.view==='project'&&state.projectSection!=='keywords'?1:state.view==='form'&&state.form?.parent?2:0;
 entries.forEach(([title,note,step],index)=>{const b=button(context,'',()=>{if(!step){state.projectSection='keywords';context.navigate('project');}else if(state.project.products?.some(p=>p.id===state.product&&!p.merged_into))context.openProduct(state.project.id,state.product,step);else if(step==='identification'){state.projectSection='leads';context.navigate('project');}else{state.stageTarget=step;state.stageProduct=null;context.navigate('product_selection');}},'rw-journey-stop');b.disabled=!state.project||isNew;b.setAttribute('aria-current',index===group?'step':'false');b.append(el(context,'span','rw-step-number',index+1));const copy=el(context,'span');copy.append(el(context,'strong','',title),el(context,'small','',note));b.append(copy);host.append(b);});return host;
}

/** A selector precondition only; saving still uses every authoritative backend gate. */
export function decisionOptionAvailability(product,rules={}){
 const score=[...(product.scores||[])].reverse().find(s=>s.revision===product.revision),complete=score?.status==='complete'&&typeof score.total==='number'&&Number.isFinite(score.total)&&!(score.hard_failures||[]).length,missing=(product.requirement_statuses||[]).some(r=>r.applies!==false&&r.blocks_scoring&&!['pass','not_applicable'].includes(r.status));
 return Object.fromEntries([['test','test_score'],['backup','backup_score']].map(([pool,key])=>[pool,Boolean(complete&&!missing&&(typeof rules[key]!=='number'||score.total>=rules[key]))]));
}

/** Add read-only source context around the existing form, without changing inputs. */
export function frameProductForm(context,product,host,title,{inputs}={}){
 if(!host.querySelectorAll||!product)return host;
 host.dataset.productForm='true';
 const heading=host.querySelector('h1'),identity=el(context,'div','rw-design-product-line');
 const formStep={'确认具体商品':'identification','确认粗筛素材':'coarse','广告与漏斗拆解':'funnel','核算这笔订单是否值得做':'economics','做出人工决策':'decision','确认测试计划':'test','记录复盘，回流下一轮关键词':'review','从线索继续扩词':'expansion'}[title];
 if(heading&&formStep){heading.textContent=productPages[formStep][1];const description=Array.from(host.children).find(n=>n.tagName==='P');if(description){const full=description.textContent;description.textContent=productPages[formStep][2];const rules=el(context,'details','rw-form-business-rules');rules.append(el(context,'summary','','业务规则与填写说明'),el(context,'p','rw-muted',full));host.append(rules);}}
 if(heading&&title==='记录真实测试结果')heading.textContent='真实测试结果';
 identity.append(productThumbnail(context,product),el(context,'strong','',product.name),el(context,'span','rw-muted','当前商品 · 输入未保存前不会改变研究资料'));
 heading?.after(identity);
 if(['test','review','expansion'].includes(formStep)){const description=Array.from(host.children).find(n=>n.tagName==='P');description?.after(identity);identity.classList.add('rw-product-context-band');identity.append(el(context,'span','rw-tag',product.identification?.relevance_confirmed===true?'已确认商品相关性':'商品相关性待核实'));}
 if(/确认具体商品|漏斗拆解/.test(title)){
  const word=context.state.project.keywords?.find(w=>(product.source_keyword_ids||[]).includes(w.id));
  const workspace=host.querySelector('.rw-form-workspace');
  if(word&&workspace){
   const media=el(context,'div','rw-form-source'),ids=new Set((product.candidate_sources||[]).filter(b=>b.keyword_id===word.id).map(b=>b.ad_id));
   const ads=(word.ads||[]).filter(a=>ids.has(a.id));media.classList.add('rw-source-comparison');
   for(const [source,label] of (title==='广告与漏斗拆解'?[['ad','广告（绑定来源）'],['product','商品页（来源）']]:[['product','商品页（来源）'],['ad','原广告（绑定来源）']])){const card=el(context,'section','rw-source-comparison-card');card.append(el(context,'h3','',label),sourcePreview(context,word,product,ads,{fixedSource:source}));media.append(card);}
   if(title==='确认具体商品'){
    const sourceHeading=el(context,'h2','rw-source-compare-title','商品与广告来源对比'),reading=el(context,'div','rw-identity-read-status');reading.append(icon(context,'info'),el(context,'strong','',product.landing_snapshot?'已读取商品页 · 待人工核对':'尚无已保存的商品页观察'),el(context,'span','rw-muted','请核对商品页与绑定广告是否一致。'));const frame=el(context,'section','rw-identity-source-frame');frame.append(reading,sourceHeading,media);workspace.insertBefore(frame,workspace.firstChild);
    const tabs=el(context,'nav','rw-identity-tabs');tabs.setAttribute('aria-label','商品录入方式');const current=el(context,'span','','当前商品：'+product.name);current.setAttribute('aria-current','page');tabs.append(current,button(context,'添加已有商品',()=>context.openForm({kind:'add_product'})));workspace.before(tabs);
    const form=workspace.querySelector('form'),question=el(context,'h2','rw-identity-question','广告与商品是否一致？');form.prepend(question);frameIdentityResult(context,form,inputs);form.id='rw-identity-form-'+product.id;const footer=form.querySelector('.rw-form-footer'),save=footer.querySelector('button[type=submit]');save.setAttribute('form',form.id);save.textContent='保存核对结果';const tools=el(context,'section','rw-identity-footer-tools');tools.append(el(context,'p','rw-muted','更换商品链接会让旧证据需重核，历史保留。'),footer);workspace.after(tools);
    for(const [index,card] of Array.from(media.children).entries()){card.querySelector('h3')?.after(link(context,index===0?'查看商品来源':'查看原广告',index===0?product.url:ads[0]?'https://www.facebook.com/ads/library/?id='+encodeURIComponent(ads[0].id):null));}
   }else workspace.insertBefore(media,workspace.firstChild);workspace.classList.add('rw-form-with-source');const assistance=workspace.querySelector('.rw-form-assistance');if(assistance){const help=el(context,'details','rw-inline-form-help');help.append(el(context,'summary','','填写提示与来源说明'),assistance);if(title==='广告与漏斗拆解')workspace.after(help);else workspace.querySelector('form')?.append(help);}
  }
 }
 if(/核算|订单测算/.test(title)&&inputs){const group=host.querySelector('[data-form-group="售价与订单"]');if(group){const row=el(context,'label','rw-order-reference','参考收入（USD）'),output=el(context,'output');row.append(output);const aov=inputs.get('aov')?.parentElement;if(aov)aov.before(row);else group.append(row);const update=()=>{const price=inputs.get('unit_price')?.value,quantity=inputs.get('quantity')?.value;output.textContent=price!==''&&quantity!==''&&price!=null&&quantity!=null&&Number.isFinite(Number(price))&&Number.isFinite(Number(quantity))? (Number(price)*Number(quantity)).toFixed(2):'未知';};for(const key of ['unit_price','quantity']){const input=inputs.get(key);if(input)context.life.listen(input,'input',update);}update();}host.classList.add('rw-order-economics');inputs.get('tax').placeholder='未核实';inputs.get('ad_cost').placeholder='待填写';
  const bundle=inputs.get('bundle_reason')?.parentElement;if(bundle){const detail=el(context,'details','rw-bundle-reason');detail.append(el(context,'summary','','多件组合依据（每单多件时必填）'));bundle.before(detail);detail.append(bundle);detail.open=Number(inputs.get('quantity')?.value)>1||Boolean(inputs.get('bundle_reason')?.value);const sync=()=>{if(Number(inputs.get('quantity')?.value)>1)detail.open=true;};context.life.listen(inputs.get('quantity'),'input',sync);}
  const costs=host.querySelector('[data-form-group="订单成本与费用"]');if(costs){for(const name of ['goods_cost','shipping','packaging','tax','ad_cost','payment_percent','payment_fixed','reserve_percent']){const row=inputs.get(name)?.parentElement;if(row)costs.append(row);}}
  const form=host.querySelector('form'),footer=form.querySelector('.rw-form-footer'),bottom=el(context,'section','rw-order-bottom'),quote=el(context,'section','rw-order-quote'),risk=el(context,'section','rw-order-risk'),tools=el(context,'section','rw-order-footer-tools');
  const chooseTab=label=>Array.from(form.querySelectorAll('[role=tab]')).find(b=>b.textContent===label)?.click();
  const updateBottom=()=>{quote.replaceChildren(el(context,'h2','','报价来源'));risk.replaceChildren(el(context,'h2','','风险与合规'));const quoteRows=[['来源',inputs.get('quote_source')?.value||'尚未填写'],['报价日',inputs.get('quote_date')?.value?.replace('T',' ')||'未记录'],['报价核对',inputs.get('quote_confirmed')?.checked?'已核对':'尚未核对']];for(const [label,value] of quoteRows){const row=el(context,'p');row.append(el(context,'span','rw-muted',label),el(context,'span','',value));quote.append(row);}quote.append(button(context,'核对报价来源',()=>chooseTab('报价来源')));for(const [key,label] of [['logistics_risk','物流风险'],['compliance_risk','合规风险'],['ip_risk','侵权风险'],['certification_verified','认证核实']]){const value=inputs.get(key)?.value;const row=el(context,'p');row.append(el(context,'span','rw-muted',label),el(context,'span','rw-tag',({low:'低',medium:'中',high:'高',true:'已核实',false:'尚未核实'})[value]||'待核实'));risk.append(row);}risk.append(button(context,'核对风险与认证',()=>chooseTab('风险认证')));};
  for(const key of ['quote_source','quote_date','quote_confirmed','logistics_risk','compliance_risk','ip_risk','certification_verified']){const input=inputs.get(key);if(input){context.life.listen(input,'input',updateBottom);context.life.listen(input,'change',updateBottom);}}updateBottom();
  form.id='rw-order-form-'+product.id;const save=footer.querySelector('button[type=submit]');save.setAttribute('form',form.id);save.textContent='保存测算资料';tools.append(footer);bottom.append(quote,risk,tools);host.querySelector('.rw-form-workspace').after(bottom);

 }
 if(title==='广告与漏斗拆解'&&inputs?.get('notes')){const wrap=inputs.get('notes').parentElement,detail=el(context,'details','rw-funnel-notes');detail.append(el(context,'summary','','补充说明与未知项'));wrap.before(detail);detail.append(wrap);detail.open=Boolean(inputs.get('notes').value);}
 if(title==='做出人工决策'){
  const availability=decisionOptionAvailability(product,context.state.project.rules||{});for(const radio of host.querySelectorAll('input[name=ui-decision-pool]')){if(availability[radio.value]===false){radio.disabled=true;const option=radio.parentElement;option.dataset.unavailable='true';option.append(el(context,'span','rw-option-unavailable','暂不可选'));option.title='需要当前资料版本的完整评分与证据；保存时仍由系统校验全部门槛。';}}
  const workspace=host.querySelector('.rw-form-workspace'),summary=el(context,'aside','rw-decision-evidence');
  identity.remove();summary.append(identity,el(context,'h2','','先看已核实的依据'));host.classList.add('rw-decision-form');
  for(const step of product.steps||[]){if(!['identification','coarse','channels','funnel','economics','score'].includes(step.key))continue;const row=el(context,'div','rw-decision-evidence-row');row.append(el(context,'strong','',step.label),el(context,'span','rw-tag',step.state==='passed'?'已核实':'待核实'),el(context,'p','rw-muted',step.reason||'请核对当前阶段资料'));summary.append(row);}
  const score=product.scores?.at(-1);summary.append(el(context,'p','rw-notice',score?scoreMessage(score):'暂不评分 · 尚无完整研究评分'),el(context,'p','rw-muted',decisionSummary(product).note));
  if(workspace){workspace.insertBefore(summary,workspace.firstChild);workspace.classList.add('rw-form-decision');}
 }
 if(title==='记录复盘，回流下一轮关键词'){
  const aside=host.querySelector('.rw-form-assistance');if(aside){const decision=decisionSummary(product),score=[...(product.scores||[])].reverse().find(s=>s.revision===product.revision),results=(product.test_results||[]).filter(r=>r.active&&!r.legacy&&!r.superseded&&r.state!=='void');aside.replaceChildren(el(context,'h2','','本轮摘要'));for(const [symbol,label,value] of [['check-square','当前决定',decision.label],['chart-bar','当前评分',score?.status==='complete'&&Number.isFinite(score.total)?score.total+' / 25':'证据不足，暂不评分'],['clipboard-text','有效测试记录',results.length+' 条'],['archive','复盘记录',(product.reviews||[]).length+' 条']]){const row=el(context,'div','rw-review-summary-row');row.append(icon(context,symbol),el(context,'strong','',label),el(context,'p','rw-muted',value));aside.append(row);}aside.append(el(context,'p','rw-notice','研究结论与真实测试结果分别保留。没有真实结果时，不应声称测试成功。'));}
 }
 if(title==='确认粗筛素材'){
  const form=host.querySelector('form'),groups=Array.from(host.querySelectorAll('.rw-field-group')),requirements=el(context,'div','rw-coarse-requirements'),progress=el(context,'div','rw-coarse-progress');
  const observed=[];for(const binding of product.candidate_sources||[]){const ad=context.state.project.keywords?.find(w=>w.id===binding.keyword_id)?.ads?.find(a=>a.id===binding.ad_id);if(ad&&!observed.some(a=>a.id===ad.id))observed.push(ad);}const dates=observed.map(a=>a.start_date).filter(v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)).sort(),times=observed.map(a=>a.observed_at).filter(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))).sort((a,b)=>Date.parse(a)-Date.parse(b)),observation=el(context,'section','rw-coarse-observation');for(const [label,value] of [['来源中最早投放日',dates[0]||'未记录'],['最近采集观察',times.at(-1)?.slice(0,10)||'未记录']]){const cell=el(context,'div');cell.append(el(context,'small','',label),el(context,'strong','',value));observation.append(cell);}const age=inputs.get('active_days')?.parentElement;if(age)observation.append(age);const continuity=el(context,'div');continuity.append(el(context,'small','','期间连续投放'),el(context,'strong','',({verified:'已验证',continuous:'已验证',interrupted:'曾中断'})[product.identification?.continuity_status]||'未验证'));observation.append(continuity);form.prepend(observation);
  for(const [symbol,copy] of [['file-text','当前筛选标准'],['clock','首次投放距今 ≥ '+(context.state.project.rules?.min_active_days??30)+' 天'],['broadcast','核对当前投放状态'],['stack','独立活跃创意 ≥ '+(context.state.project.rules?.min_creatives??3)+' 个']]){const item=el(context,'span');item.append(icon(context,symbol),el(context,'span','',copy));requirements.append(item);}form.before(requirements);
  const update=()=>{const values=Object.fromEntries([...inputs].map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.value])),status=creativeReviewProgress(values,groups.length);progress.replaceChildren();for(const [label,value] of [['已填写来源',status.identified],['本次确认独立',status.distinct],['本次确认活跃',status.active]]){const cell=el(context,'div');cell.append(el(context,'small','',label),el(context,'strong','',value+' / '+groups.length));progress.append(cell);}progress.append(el(context,'p','rw-muted','这是本次填写进度，不是已保存的通过结论；不足标准也可保存真实观察。'));};
  for(const input of inputs.values()){context.life.listen(input,'input',update);context.life.listen(input,'change',update);}update();form.querySelector('.rw-form-footer')?.before(progress);
  Array.from(host.querySelectorAll('.rw-field-group')).forEach((group,index)=>{const id=inputs?.get('creative_'+(index+1)+'_id'),url=inputs?.get('creative_'+(index+1)+'_url'),preview=creativeObservation(context,product,id,url),edit=el(context,'details','rw-creative-source-editor'),summary=el(context,'p','rw-creative-source-id');edit.append(el(context,'summary','','核对 / 修改素材来源'));for(const input of [id,url])if(input){edit.append(input.parentElement);context.life.listen(input,'invalid',()=>{edit.open=true;});}const update=()=>summary.textContent='来源标识：'+(id?.value||'待填写');update();if(id)context.life.listen(id,'input',update);group.insertBefore(preview,group.children[1]||null);edit.append(summary);group.append(edit);});
 }
 if(['确认粗筛素材','确认测试计划','记录真实测试结果','修订测试结果'].includes(title)){
  const form=host.querySelector('form'),footer=form.querySelector('.rw-form-footer');form.id='rw-stage-form-'+product.id;footer.querySelector('button[type=submit]').setAttribute('form',form.id);const tools=el(context,'section','rw-stage-footer-tools'),note=el(context,'p','rw-stage-next-note',title==='确认测试计划'?'下一步：在广告平台人工执行，再回来录入实际结果。':title==='确认粗筛素材'?'保存后在本页查看筛选结果；未达标也会保留真实观察。':'核对实际来源与统计区间；修订保留原版本。');if(title==='确认粗筛素材'){const progress=host.querySelector('.rw-coarse-progress');if(progress)tools.append(progress);}tools.append(footer,note);host.querySelector('.rw-form-workspace').after(tools);if(title==='确认粗筛素材'){const assistance=host.querySelector('.rw-form-assistance');if(assistance)tools.after(assistance);}
 }
 return host;
}

/** Evidence grouping never replaces the backend dimension calculation or hard gates. */
export function scoreEvidenceGroups(product){
 const score=[...(product.scores||[])].reverse().find(s=>s.revision===product.revision),requirements=product.requirement_statuses||[];
 return [['demand_trend','需求趋势',['trends_12m','trends_5y','trends_query_match'],'channels','chart-line'],['creative_space','素材空间',['coarse_screen','funnel'],'coarse','images'],['profit_logistics','利润与物流',['economics'],'economics','calculator'],['competition','竞争强度',['meta','pinterest','tiktok','amazon','similarweb'],'channels','chart-bar'],['compliance_risk','合规风险',['certification_verification'],'economics','shield-check']].map(([key,label,keys,step,symbol])=>{
  const rows=requirements.filter(r=>keys.includes(r.key)&&r.applies!==false),dimension=score?.dimensions?.find(d=>d.key===key),value=typeof dimension?.score==='number'&&Number.isFinite(dimension.score)?dimension.score:null;
  return {key,label,step,symbol,requirements:rows,score:value,status:rows.some(r=>r.blocks_scoring&&!['pass','not_applicable'].includes(r.status))?'待补证':value!==null?'已计算':'待评估',reason:dimension?.reason||rows.filter(r=>!['pass','not_applicable'].includes(r.status)).map(r=>r.label||r.status_reason||r.key).join('、')||'尚无当前资料版本的维度计算结果'};
 });
}
/** Form progress only: final distinctness and eligibility are validated by the backend. */
export function creativeReviewProgress(values,count){
 const result={identified:0,distinct:0,active:0,distinctActive:0},seen=new Set();
 for(let n=1;n<=count;n++){const key=String(values['creative_'+n+'_id']||'').trim();if(!key||seen.has(key))continue;seen.add(key);result.identified++;const distinct=values['creative_'+n+'_distinct']===true,active=values['creative_'+n+'_active']===true;if(distinct)result.distinct++;if(active)result.active++;if(distinct&&active)result.distinctActive++;}return result;
}
export function creativePreviewBinding(project,product,id,url=''){
 id=(id||'').trim();url=(url||'').trim();let urlId='';
 if(url){try{const parsed=new URL(url);if(['www.facebook.com','facebook.com'].includes(parsed.hostname)&&parsed.pathname.replace(/\/$/,'')==='/ads/library')urlId=parsed.searchParams.get('id')||'';}catch{return null;}}
 if(id&&urlId&&id!==urlId)return null;const target=id||urlId;if(!target)return null;
 for(const binding of product.candidate_sources||[]){if(binding.ad_id!==target)continue;const word=project.keywords?.find(w=>w.id===binding.keyword_id),ad=word?.ads?.find(a=>a.id===target);if(ad)return {word,ad};}return null;
}
function creativeObservation(context,product,idInput,urlInput){
 const host=el(context,'div','rw-creative-observation');let release=()=>{},key=null;
 const paint=()=>{const binding=creativePreviewBinding(context.state.project,product,idInput?.value,urlInput?.value),next=binding?binding.word.id+':'+binding.ad.id:'missing';if(next===key)return;key=next;release();host.replaceChildren();
  if(binding){const life=createLifecycle();release=context.life.track(()=>life.dispose());const note=el(context,'details','rw-creative-binding-note');note.append(el(context,'summary','','素材绑定说明'),el(context,'p','rw-muted','只展示当前素材标识对应的绑定广告。采集日期与状态已自动读取；独立性不确定时再人工核对。'));host.append(sourcePreview({...context,life},binding.word,product,[binding.ad],{fixedSource:'ad'}),note);}
  else host.append(el(context,'p','rw-media-empty','当前创意 ID / 链接没有对应的已保存绑定素材。请打开证据链接人工核对；不会用其他广告补图。'));
 };
 for(const input of [idInput,urlInput])if(input){context.life.listen(input,'input',paint);context.life.listen(input,'change',paint);}paint();return host;
}

/** Reflow existing nodes, retaining their handlers, data contracts and validation. */
export function decoratePage(context,page){
 const design=designPage(context.state);page.dataset.designPage=design.number;page.classList.add('rw-designed-page');
 // Tiny Node test fixtures intentionally do not implement CSS queries/layout.
 if(!page.querySelectorAll)return page;
 const heading=page.querySelector('h1');if(heading){heading.classList.add('rw-design-title');if(context.state.view!=='form')heading.textContent=design.title;}
 const move=(parent,node)=>{if(node){node.remove();parent.append(node);}};
 if(context.state.view==='project'&&context.state.projectSection==='keywords'){
  const section=page.querySelector('.rw-keyword-section');
  if(section){const workspace=el(context,'div','rw-keyword-workspace'),preview=el(context,'aside','rw-keyword-preview'),project=context.state.project,main=el(context,'div','rw-keyword-preview-main'),footer=el(context,'div','rw-keyword-preview-footer'),wordsList=el(context,'div','rw-keyword-preview-words');section.before(workspace);workspace.append(preview);move(workspace,section);preview.append(main,footer);main.append(el(context,'h2','','本轮搜索预览'),el(context,'p','rw-muted','只处理已审核的搜索词，未审核的新词不会自动开始搜索。'),el(context,'h3','','本轮待搜索词'),wordsList);
   const words=scanCandidates(project);for(const word of words)wordsList.append(el(context,'p','rw-search-preview-word',word.text));if(!words.length)wordsList.append(el(context,'p','rw-notice','没有待执行词。先审核新词，或在已完成词的操作中选择重新搜索并补充。'));
   footer.append(el(context,'p','rw-muted','最终执行范围、来源可用性与费用提示，以执行前确认窗口为准。'));
   const scan=Array.from(section.querySelectorAll('button')).find(b=>b.textContent==='扫描全部已审核词');move(footer,scan);
  }
 }
 if(context.state.view==='product'&&page.dataset.expansionOverview==='true')return page;
 if(context.state.view==='product'&&!page.dataset.editing){
  const p=context.state.project.products?.find(p=>p.id===context.state.product);page.dataset.currentProductStep=context.state.step;
  const workspace=page.querySelector('.workspace'),body=workspace?.lastElementChild;
  if(workspace&&body){
   if(heading){const description=el(context,'p','rw-design-product-description',design.description);heading.after(description);}
   const more=el(context,'details','rw-product-navigation-more');more.append(el(context,'summary','','完整检查清单与研究导航'));for(const node of Array.from(page.children)){if(node.tagName==='BUTTON'&&node.textContent==='返回探索')move(more,node);}const stages=Array.from(workspace.children).find(n=>n.tagName==='DETAILS');move(more,stages);page.append(more);

   const identity=el(context,'div','rw-design-product-line');identity.append(productThumbnail(context,p),el(context,'strong','',p?.name||'待识别商品'),el(context,'span','rw-muted','来源已保存不代表全部证据已确认'));heading?.after(identity);if(context.state.step==='score'){identity.classList.add('rw-product-context-band');page.querySelector('.rw-design-product-description')?.after(identity);}
   const guide=body.querySelector('[data-task-guide]');if(guide){guide.classList.add('rw-design-guide');const disclosure=el(context,'details','rw-product-guidance');disclosure.append(el(context,'summary','','当前建议与待补证据'));guide.before(disclosure);move(disclosure,guide);if(context.state.step==='score')disclosure.open=true;}
   const offer=Array.from(body.children).find(n=>n.querySelector('h2')?.textContent==='同款卖家商品（可选）');if(offer){const disclosure=el(context,'details','rw-product-secondary');disclosure.append(el(context,'summary','','同款卖家与重复档案管理'));offer.before(disclosure);move(disclosure,offer);}
   const related=Array.from(body.children).find(n=>n.querySelector('h2')?.textContent==='需求与竞争：先看证据，再决定投入');if(related){const disclosure=el(context,'details','rw-product-secondary');disclosure.append(el(context,'summary','','相关研究任务'));related.before(disclosure);move(disclosure,related);}
   const intro=Array.from(body.children).find(n=>n.classList.contains('rw-panel')&&!n.dataset.taskGuide&&n.querySelector('.actions'));
   if(intro)intro.classList.add('rw-design-stage-intro');
   const content=Array.from(body.children).find(n=>n.classList.contains('rw-panel')&&n.querySelector('h2')?.textContent==='已保存的产物');
   if(content){content.classList.add('rw-design-artifacts');content.querySelector('h2').textContent='研究依据与已保存资料';}
   if(['identification','funnel','coarse'].includes(context.state.step)&&p){
    const word=context.state.project.keywords?.find(w=>(p.source_keyword_ids||[]).includes(w.id));
    if(word){const layout=el(context,'div','rw-identity-layout'),media=el(context,'div','rw-identity-media');media.dataset.productMediaSlot='true';const ids=new Set((p.candidate_sources||[]).filter(b=>b.keyword_id===word.id).map(b=>b.ad_id));media.append(sourcePreview(context,word,p,(word.ads||[]).filter(a=>ids.has(a.id))));layout.append(media);move(layout,intro);body.insertBefore(layout,body.firstChild);}
   }
   if(context.state.step==='channels'&&content){const grid=content.querySelector('.rw-channel-grid'),trend=grid?.querySelector('[data-channel-card="trends"]');if(grid&&trend){const layout=el(context,'div','rw-demand-workspace'),main=el(context,'section','rw-demand-main'),other=el(context,'section','rw-demand-platforms');main.append(trend);const trendHeading=trend.querySelector('h2');if(trendHeading)trendHeading.textContent='1. Google Trends 趋势证据';if(intro){const actions=intro.querySelector('.actions');if(actions)trend.querySelector('h2')?.after(actions);const info=el(context,'details','rw-demand-stage-note');info.append(el(context,'summary','','查看当前阶段说明'));move(info,intro);main.append(info);}for(const card of Array.from(grid.children)){const details=el(context,'details','rw-channel-note');details.append(el(context,'summary','','查看证据说明'));for(const node of Array.from(card.children))if(node.tagName==='P')move(details,node);card.append(details);}for(const name of ['meta','similarweb','amazon','pinterest','tiktok']){const card=grid.querySelector('[data-channel-card=\"'+name+'\"]');if(card)grid.append(card);}const channelInfo={meta:['meta-logo','查看广告数量与主要卖点'],similarweb:['chart-bar','查看网站流量与来源'],amazon:['shopping-bag','查看在售商品与竞争情况'],pinterest:['pinterest-logo','查看相关内容热度'],tiktok:['tiktok-logo','查看话题热度与内容量']};for(const card of Array.from(grid.children)){const info=channelInfo[card.dataset.channelCard];if(info){card.prepend(icon(context,info[0]));card.querySelector('h2')?.after(el(context,'p','rw-channel-purpose',info[1]));}}other.append(el(context,'h2','','2. 其他渠道证据'),grid);const evidenceEditor=content.querySelector('.rw-channel-inline-editor');if(evidenceEditor)other.append(evidenceEditor);layout.append(main,other);body.insertBefore(layout,body.firstChild);}}
   if(context.state.step==='score'){
    const layout=el(context,'div','rw-score-workspace'),checklist=el(context,'section','rw-score-checklist'),result=el(context,'aside','rw-score-result'),gaps=body.querySelector('.rw-task-gaps');
    checklist.append(el(context,'h2','','证据检查与当前状态'),el(context,'p','rw-muted','缺少必要证据时暂不评分；维度结果以系统计算为准。'));
    for(const dimension of scoreEvidenceGroups(p)){const row=el(context,'section','rw-score-evidence-row'),copy=el(context,'div');copy.append(el(context,'h3','',dimension.label),el(context,'p','rw-muted',dimension.reason));row.append(icon(context,dimension.symbol),copy,el(context,'span','rw-tag',dimension.status),el(context,'strong','',dimension.score===null?'— / 5':dimension.score+' / 5'),button(context,'去核实',()=>context.openProduct(context.state.project.id,p.id,dimension.step)));checklist.append(row);}
    const allGaps=el(context,'details','rw-score-all-gaps');allGaps.append(el(context,'summary','','完整证据清单与补充入口'));checklist.append(allGaps);if(gaps){gaps.open=true;move(allGaps,gaps);}else checklist.append(el(context,'p','rw-muted','请以当前阶段提示与最新评估结果核对证据。'));
    const blocking=(p.requirement_statuses||[]).filter(r=>r.applies!==false&&r.blocks_scoring&&!['pass','not_applicable'].includes(r.status));
    if(blocking.length){const notice=el(context,'section','rw-score-blocking');notice.append(icon(context,'warning-circle'),el(context,'h2','','暂不能评分'),el(context,'p','rw-muted',blocking.map(r=>r.label||r.key).join('、')+'仍需核实。'));result.append(notice,el(context,'h2','rw-score-gap-heading','需要补充的关键证据'));for(const gap of blocking){const group=scoreEvidenceGroups(p).find(d=>d.requirements.some(r=>r.key===gap.key)),row=el(context,'section','rw-score-missing-row');row.append(icon(context,group?.symbol||'file-text'),el(context,'strong','',gap.label||gap.key),el(context,'p','rw-muted',gap.status_reason||'请核对来源后补充保存'),button(context,'去补充',()=>context.openProduct(context.state.project.id,p.id,group?.step||'channels'),'rw-primary'));result.append(row);}}
    const archive=el(context,'details','rw-score-records');archive.open=!blocking.length;archive.append(el(context,'summary','','当前评估与历史记录'));move(archive,intro);move(archive,content);result.append(archive);layout.append(checklist,result);body.insertBefore(layout,body.firstChild);
    const evaluate=Array.from(archive.querySelectorAll('button')).find(b=>b.textContent==='检查证据并计算评分');if(evaluate){const footer=el(context,'div','rw-score-footer');evaluate.remove();footer.append(el(context,'p','rw-muted','当前评分由系统依据已保存证据计算，仅作研究参考。'),evaluate);layout.after(footer);}
   }
   if(context.state.step==='expansion'&&content){const sources=Array.from(content.querySelectorAll('.rw-expansion-source')),words=Array.from(content.querySelectorAll('.rw-expansion-child'));if(sources.length||words.length){const layout=el(context,'div','rw-expansion-workspace'),left=el(context,'section'),right=el(context,'section');left.append(el(context,'h3','','当前商品的可引用来源'));sources.forEach(n=>move(left,n));right.append(el(context,'h3','','已保存的新词 · 审核后再搜索'));words.forEach(n=>move(right,n));if(!words.length)right.append(el(context,'p','rw-muted','还没有从当前商品保存新词。'));if(intro)move(left,intro);layout.append(left,right);body.insertBefore(layout,body.firstChild);content.querySelector('h2')?.remove();}}
  }
 }
 if(context.state.view==='reports'){
  const rows=Array.from(page.querySelectorAll('.rw-decision-card'));if(rows.length){
   const project=context.state.projects.find(p=>p.id===(context.state.reportProjectId||context.state.project?.id||context.state.projects[0]?.id))||context.state.projects[0];
   const products=(project?.products||[]).filter(p=>!p.merged_into),selected=products.find(p=>p.id===context.state.reportSelectedProduct)||products[0];
   const workspace=el(context,'div','rw-report-workspace'),list=el(context,'div','rw-decision-list');rows[0].before(workspace);workspace.append(list);list.append(el(context,'h2','rw-report-list-title','候选商品结论（'+products.length+'）'));const columns=el(context,'div','rw-report-table-head');for(const label of ['商品','当前去向','关键依据','评分','下一步'])columns.append(el(context,'span','',label));list.append(columns);rows.forEach((row,index)=>{move(list,row);const p=products[index];if(p){row.dataset.selected=String(selected?.id===p.id);const heading=row.querySelector('h2'),identity=el(context,'div','rw-report-product-cell'),full=el(context,'details','rw-report-row-details');full.hidden=true;full.append(el(context,'summary','','查看完整摘要与原操作'));for(const node of Array.from(row.children)){if(node!==heading&&node.tagName!=='STRONG')move(full,node);}if(heading)identity.append(productThumbnail({...context,state:{...context.state,project}},p),heading);row.insertBefore(identity,row.firstChild);const score=[...(p.scores||[])].reverse().find(s=>s.revision===p.revision),blocked=(p.requirement_statuses||[]).some(r=>r.blocks_scoring===true);const basis=(p.requirement_statuses||[]).filter(r=>r.applies!==false&&r.blocks_scoring&&!['pass','not_applicable'].includes(r.status)).map(r=>r.label||r.key).slice(0,2).join('、')||decisionSummary(p).reason||'请核对研究资料';row.append(el(context,'span','rw-report-basis',basis),el(context,'span','rw-report-score',score?.status==='complete'&&Number.isFinite(score.total)&&!blocked?score.total+' / 25':'待补证'),button(context,'查看依据',()=>{context.state.reportSelectedProduct=p.id;context.navigate('reports');},'rw-report-select'),full);}});
   if(selected){
    const detail=el(context,'aside','rw-report-detail'),summary=decisionSummary(selected),section=(symbol,title)=>{const header=el(context,'h3','rw-report-section-heading');header.append(icon(context,symbol),el(context,'span','',title));detail.append(header);};
    detail.append(el(context,'h2','',selected.name),productThumbnail({...context,state:{...context.state,project}},selected));
    section('files','当前资料版本');detail.append(el(context,'p','rw-muted',selected.revision===undefined?'版本未记录':'v'+selected.revision));if(selected.url)detail.append(link(context,'查看商品来源',selected.url));
    section('note-pencil','人工决定与理由');detail.append(el(context,'strong','',summary.label));if(summary.reason)detail.append(el(context,'p','',summary.reason));detail.append(el(context,'p','rw-muted',summary.note));
    section('warning-circle','未完成证据');const gaps=(selected.steps||[]).filter(step=>step.state!=='passed'),extra=el(context,'details','rw-report-more-gaps');extra.append(el(context,'summary','','查看全部待核实项（'+gaps.length+'）'));gaps.forEach((step,index)=>{const row=el(context,'p','rw-report-gap',step.label+' · '+(step.reason||'待核实'));if(index<3)detail.append(row);else extra.append(row);});if(gaps.length>3)detail.append(extra);if(!gaps.length)detail.append(el(context,'p','rw-muted','当前步骤没有待补项；是否可测试仍以完整业务校验为准。'));
    section('check-square','已确认测试');const confirmed=(selected.test_results||[]).filter(row=>row.state==='confirmed'&&row.active===true&&!row.superseded&&!row.legacy);detail.append(el(context,'p','rw-muted',confirmed.length?'当前有效且已确认记录：'+confirmed.length+' 条':'暂无当前有效且已确认的真实测试记录。'));
    section('arrow-right','下一步');detail.append(el(context,'p','rw-muted',gaps[0]?gaps[0].label+'：'+(gaps[0].reason||'先核对来源与证据。'):'打开商品核对当前决定与后续计划。'));
    const original=rows[products.findIndex(p=>p.id===selected.id)]?.querySelector('.rw-report-row-details');if(original){original.hidden=false;move(detail,original);}detail.append(button(context,'打开商品研究',()=>context.openHistoryProduct(project.id,selected.id),'rw-primary'));workspace.append(detail);
   }
   const left=el(context,'section','rw-report-main');list.before(left);move(left,list);for(const node of Array.from(page.querySelectorAll('.rw-report-delivery,[data-research-review]')))move(left,node);
  }
 }
 if(context.state.view==='triage'){
  const workspace=page.querySelector('.rw-triage-workspace'),heading=workspace?.querySelector('h1');if(workspace&&heading){heading.remove();workspace.before(heading,el(context,'p','rw-triage-description',design.description));}
 }
 if(context.state.view==='sync')page.classList.add('rw-design-sync');
 if(context.state.view==='actions')page.classList.add('rw-design-tasks');
 if(context.state.view==='history')page.classList.add('rw-design-history');
 return page;
}
