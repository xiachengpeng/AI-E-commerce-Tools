import { el as nativeEl, button as nativeButton, panel, link as nativeLink, notify, marketNames, typeNames, labels as nativeLabels } from '../components/elements.mjs';
import { createForm, fields } from '../components/forms.mjs';
import { submitMutation, newCommandId } from '../services/commands.mjs';
import { renderAds } from '../components/ad-copy.mjs';
export const productSteps=['identification','coarse','expansion','channels','funnel','economics','score','decision','test','review'];
const channels={meta:'Meta 广告',trends:'Google Trends',pinterest:'Pinterest',tiktok:'TikTok',amazon:'Amazon',similarweb:'Similarweb'};
const dimensionNames={demand_trend:'需求趋势',creative_space:'素材空间',profit_logistics:'利润与物流',competition:'竞争强度',compliance_risk:'合规风险'};
const gateNames={contribution_margin:'贡献毛利率',aov_range:'客单价范围',packed_weight:'订单重量',risk_level:'风险等级',trend_peak:'趋势见顶',similarweb_direct_share:'直接流量占比'};
const labels={...nativeLabels,passed:'通过',needs_input:'待你补充',not_applicable:'不适用',draft:'草稿',void:'已作废',failed:'不通过'};
const time=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未记录';
const text=v=>typeof v==='object'?JSON.stringify(v,null,2):String(v??'未记录');
const adAgeDays=i=>i.ad_age_days??(i.active_days>0?i.active_days:null);
const adAgeLabel=i=>adAgeDays(i)===null?'未知':`${adAgeDays(i)} 天`;
export function renderProduct(context) {
 const state=context.state,root=nativeEl(context,'section','rw-product');
 state.step=productSteps.includes(state.step)?state.step:'identification';state.landingModes||={};state.productActions||={};
 const el=(tag,cls='',content)=>nativeEl(context,tag,cls,content),button=(label,fn,cls='')=>nativeButton(context,label,fn,cls),link=(label,url)=>nativeLink(context,label,url),box=(title,note)=>panel(context,title,note),stateTag=value=>el('span','rw-tag',labels[value]||value||'未知');
 const product=()=>state.project?.products?.find(p=>p.id===state.product);
 const warn=message=>notify(context,message),render=()=>context.navigate('product');
 const breadcrumbs=host=>{const h=el('h1','',product()?.name||'产品档案');h.tabIndex=-1;host.append(h,button('返回探索',()=>context.navigate('project')));};
 const empty=(title,note)=>box(title,note);
 const command=(action,payload)=>context.command(action,payload);
 const run=(kind,payload)=>context.showQueue({kind,...payload});
 const addKeyword=(parent,p)=>context.openForm({kind:'add_keyword',parent,product:p});
 const showAds=()=>{root.replaceChildren(renderAds(context),button('返回档案',render));};
 const stageLabel=stage=>stage||'旧记录未保存阶段';
 const stopScanAction=action=>context.showQueue({kind:action.kind,product_id:action.product_id});
 let activeDraft,activePersist;
 async function api(path,options={}) {
  const body=typeof options.body==='string'?JSON.parse(options.body):options.body;
  if(options.method==='POST'){
   if(!activeDraft)throw Error('缺少表单提交身份');
   const content={...body,version:activeDraft.version};delete content.command_id;
   const result=await submitMutation({request:(target,options)=>context.api.request(target,{...options,signal:context.life.signal})},path,content,activeDraft,activePersist);if(!context.life.active)throw new DOMException('Page disposed','AbortError');return result;
  }
  return context.api.request(path,{...options,body,signal:context.life.signal});
 }
 function openForm(title,help,defs,onSubmit,initial={},spec={}) {
  const key='rabbit-hole:draft:'+JSON.stringify([state.project.id,state.product,spec.type||title,spec.objectId||initial.id||'']);
  const form=createForm(context,{title,help,defs,initial,key,submit:async(data,draft,persist)=>{
   activeDraft=draft;activePersist=persist;
   try{await onSubmit(data);if(!context.life.active)return;const index=state.projects?.findIndex(p=>p.id===state.project.id);if(index>=0)state.projects[index]=state.project;}
   finally{activeDraft=null;activePersist=null;}
  },returnView:'product',successView:spec.successView,onDiscard:()=>openForm(title,help,defs,onSubmit,initial,spec)});
  root.replaceChildren(form.host);form.host.querySelector('h1')?.focus({preventScroll:true});
 }
 function formAction(action,title,help,defs,initial={}) {
  const pid=state.product;
  openForm(title,help,defs,async data=>{state.project=await api('/projects/'+state.project.id+'/commands',{method:'POST',body:{action,version:state.project.version,payload:{...data,...(pid?{product_id:pid}:{})}}});},initial,{type:action});
 }
function continuityLabel(value){return {verified:'已验证',continuous:'已验证',interrupted:'曾中断',unknown:'未验证'}[value]||'未验证';}
function activeStatusLabel(value){return value===true?'正在投放':value===false?'已停止':'未知';}
function scoreValidity(product){const score=[...(product.scores||[])].reverse().find(item=>item.revision===product.revision);if(!score)return '尚未计算';if(score.status==='complete'&&score.total!==null&&score.total!==undefined)return '当前有效';if(score.status==='rejected')return '当前有效 · 未通过硬门槛';return '证据不足，暂不可评分';}
function evidenceHealth(product,current){
 const summary=product.requirement_summary||{},identity=product.identification||{},health=el('section','evidence-health');
 health.dataset.evidenceHealth='true';
 const heading=el('div','evidence-health-heading');
 heading.append(el('div','',`身份版本 ${product.identity_revision||1} · ${product.name}`),el('span','tag '+(current?.state||'pending'),`${current?.label||'当前阶段'} · ${labels[current?.state]||current?.state||'未开始'}`));
 health.append(heading);
 const facts=el('div','health-grid');
 for(const [label,value,tone] of [
  ['Required 缺口',summary.required_gaps??'未知',(summary.required_gaps??'未知')>0?'attention':'ok'],
  ['Recommended 缺口',summary.recommended_gaps??'未知',(summary.recommended_gaps??'未知')>0?'warn':'ok'],
  ['未知项',summary.unknown??'未知',(summary.unknown??'未知')>0?'warn':'ok'],
  ['评分有效性',scoreValidity(product),scoreValidity(product)==='当前有效'?'ok':'attention'],
 ]){const item=el('div','health-item '+tone);item.append(el('small','',label),el('strong','',value));facts.append(item);}
 health.append(facts);
 const confirmed=el('div','confirmed-facts');
 confirmed.append(
  el('span','',`商品相关性：${identity.relevance_confirmed===true?'已确认':'待确认'}`),
  el('span','',`首次投放距今：${adAgeLabel(identity)}`),
  el('span','',`当前状态：${activeStatusLabel(identity.currently_active)}`),
  el('span','',`连续性：${continuityLabel(identity.continuity_status)}`),
 );
 health.append(confirmed,el('p','next-action','下一步：'+(current?.next_action||'按当前阶段补齐证据')));
 return health;
}
function coarseFacts(product){const identity=product.identification||{},facts=el('div','coarse-facts');facts.append(el('p','',`首次投放距今：${adAgeLabel(identity)}`),el('p','',`当前状态：${activeStatusLabel(identity.currently_active)}`),el('p','',`连续性：${continuityLabel(identity.continuity_status)}`));return facts;}
function scoreDetails(score){
 const root=el('div','score-breakdown');
 for(const dimension of score.dimensions||[]){const name=dimensionNames[dimension.key]||dimension.key,card=el('section','score-dimension');card.dataset.scoreDimension=dimension.key;card.append(el('div','score-dimension-heading',name),el('div','score dimension-score',dimension.score==null?'—':dimension.score+' / 5'),el('p','',dimension.reason||'未记录评分说明'));const detail=el('details');detail.append(el('summary','',`查看${name}评分依据`));const body=el('dl','score-audit');for(const [label,value] of [['规则 ID',(dimension.rule_ids||[]).join('、')||'未记录'],['证据 ID',(dimension.evidence_ids||[]).join('、')||'无'],['计算方法',dimension.calculation||'未记录'],['缺失证据',(dimension.missing_evidence||[]).join('、')||'无'],['计算时间',time(dimension.calculated_at)]])body.append(el('dt','',label),el('dd','',value));detail.append(body);card.append(detail);root.append(card);}
 if(score.final_gates?.length){root.append(el('h3','','最终硬门槛'));for(const gate of score.final_gates){const row=el('div','gate-row');row.append(stateTag(gate.status),el('b','',gateNames[gate.key]||gate.key),el('span','',gate.reason||''),el('small','muted',`规则 ID：${gate.rule_id||'未记录'} · 证据 ID：${(gate.evidence_ids||[]).join('、')||'无'}`));root.append(row);}}
 root.append(rawDetails('审计原始快照',score));return root;
}
function weightLabel(value){return value==null?'未知':`${Number(value).toLocaleString('zh-CN')} kg`;}
function logisticsSummary(product,profile){
 const economics=product.economics||{},card=el('section','evidence logistics-summary');
 card.append(el('b','','包装与物流核算'),el('p','',`实际重：${weightLabel(economics.actual_weight_kg??economics.weight_kg)}`),el('p','',`体积重：${weightLabel(economics.volumetric_weight_kg)}`),el('p','',`计费重：${weightLabel(economics.chargeable_weight_kg)}`));
 if(profile){card.append(el('p','',`承运商：${profile.carrier||'未知'} · ${profile.service||'线路未知'}`),el('p','muted',`体积重除数：${profile.volumetric_divisor_cm3_per_kg??'未知'} cm³/kg · ${profile.confirmed?'已核对':'未确认'}`));if(profile.source_url)card.append(link('查看承运商规则 ↗',profile.source_url));}
 else card.append(el('p','notice','尚未设置已核对的承运商规则；没有来源时计费重保持未知。'));
 if(economics.logistics_stale)card.append(el('p','notice','商品身份已变更，包装与物流数据需重新核对。'));
 if(economics.quote_freshness){const names={fresh:'有效期内',stale:'待复核',expired:'已过期',unknown:'时效未知'},freshness=economics.quote_freshness;card.append(el('p',freshness.status==='expired'?'notice':'muted',`报价时效：${names[freshness.status]||'时效未知'} · ${freshness.reason||'未提供日期'}`));if(freshness.valid_until)card.append(el('p','muted',`报价有效至：${time(freshness.valid_until)}`));}
 const flags=[['fragile','易碎'],['battery','含电池'],['liquid','液体'],['powder','粉末'],['magnetic','磁性'],['oversized','超大件']];
 if(flags.some(([key])=>economics[key]!=null))card.append(el('p','muted','特殊属性：'+flags.map(([key,label])=>`${label}${economics[key]===true?'是':economics[key]===false?'否':'未知'}`).join(' · ')));
 return card;
}
function estimateCards(product){
 const root=el('div','estimate-list'),scopeNames={domain:'域名',store:'店铺',product:'当前商品',landing_page:'落地页'};
 for(const estimate of [...(product.estimates||[])].reverse()){
  const card=el('section','evidence estimate-card');card.dataset.salesEstimate='true';
  card.append(el('b','','情景估算，不是真实测试'),el('p','',`访问量范围：${scopeNames[estimate.traffic_scope]||'未知'} · ${estimate.traffic_period||'周期未知'} · ${estimate.monthly_visits_snapshot??'未知'} 次访问/月`));
  if(estimate.stale)card.append(el('p','notice','旧情景：来源、客单价、商品身份或来源有效期已变化，需重新核对后估算。'));
  for(const [key,label,cvr] of [['low','低',estimate.cvr_low],['base','基准',estimate.cvr_base],['high','高',estimate.cvr_high]]){
   const row=estimate.scenarios?.[key]||{};
   card.append(el('p','',`${label} · CVR ${cvr??'未知'}% · 来源范围月订单 ${row.monthly_orders??'未知'} · 月营收 USD ${row.monthly_revenue??'未知'}`));
  }
  if(estimate.scenarios?.product_monthly_orders==null)card.append(el('p','notice','商品级订单/营收：未知；域名或店铺访问量不能直接归因到该商品。'));
  else card.append(el('p','',`商品级订单情景：${estimate.scenarios.product_monthly_orders.base??'未知'} 单/月（基准，非实际销量）`));
  card.append(el('p','muted',`CVR 来源/假设：${estimate.cvr_source||'未知'}`));root.append(card);
 }
 return root;
}
function renderSourceProduct(root){breadcrumbs(root);const p=product();if(!p){root.append(empty('产品不存在','请返回研究项目刷新。'));return;}const work=el('div','workspace'),nav=el('div','steps'),steps=p.steps||[],currentIndex=Math.max(0,steps.findIndex(step=>step.key===state.step));for(const [index,step] of steps.entries()){const phase=index<currentIndex?' complete-step':index>currentIndex?' future-step':'';const b=button(step.label,()=>{state.step=step.key;context.navigate('product');},'step-button '+(state.step===step.key?'active':'')+phase);b.dataset.productStep=step.key;b.append(stateTag(step.state));nav.append(b);}const panel=el('div'),current=p.steps?.find(x=>x.key===state.step);panel.append(evidenceHealth(p,current));const intro=box(current?.label||'产品档案',current?.reason||'请按步骤补齐证据');intro.append(stateTag(current?.state||'pending'));if(current?.next_action)intro.append(el('p','muted','下一步：'+current.next_action));panel.append(intro);if(state.step==='identification')panel.append(offerConceptCard(p));const actionbar=el('div','actions');const details=box('已保存的产物');
if(state.step==='identification'){actionbar.append(button('确认具体商品',confirmProduct,'primary'),button('自动读取商品页',()=>run('landing',{product_id:p.id,landing_mode:state.landingModes[p.id]||'local'})));if(p.identity_history?.length)details.append(el('p','scope-note','商品身份已更换，旧资料保留为历史，需要重新确认当前商品的渠道、漏斗和成本证据。'));details.append(link('商品来源 ↗',p.url),rawDetails('查看身份审计字段',p.identification));if(p.landing_snapshot){details.append(el('h3','','自动页面观察（未代替人工确认）'),kv({title:p.landing_snapshot.title,price:p.landing_snapshot.price,page_type:p.landing_snapshot.page_type,requested_url:p.landing_snapshot.requested_url||'旧记录未保存',final_url:p.landing_snapshot.final_url||p.landing_snapshot.source_url||'未知',http_status_code:p.landing_snapshot.http_status_code??'旧记录未保存',browser_status_code:p.landing_snapshot.browser_status_code??'未使用 / 未保存',rendering_mode:p.landing_snapshot.rendering_mode||'旧记录未保存',observed_at:p.landing_snapshot.observed_at}));}const adIds=p.source_keyword_ids||[];for(const k of state.project.keywords.filter(k=>adIds.includes(k.id)))details.append(button('查看来源广告 · '+k.text,()=>showAds(k)));details.append(optionalResearchDetails(p));}
else if(state.step==='coarse'){actionbar.append(button('确认粗筛素材',confirmCreatives,'primary'));details.append(el('p','scope-note',`粗筛必须同时确认首次投放距今至少 ${state.project.rules?.min_active_days??30} 天、当前仍在投放，并有 ${state.project.rules?.min_creatives??3} 个独立活跃创意；商品已保留不等于通过。`),coarseFacts(p),rawDetails('查看身份审计字段',p.identification),optionalResearchDetails(p));}
else if(state.step==='expansion'){const parents=state.project.keywords.filter(k=>(p.source_keyword_ids||[]).includes(k.id));for(const k of parents)actionbar.append(button('从 '+k.text+' 扩词',()=>addKeyword(k,p),'primary'));if(parents.length)actionbar.append(button('AI 提取扩词建议',()=>run('expand',{product_id:p.id,keyword_id:parents[0].id})));else details.append(el('p','','该商品尚未关联来源关键词，可从项目搜索结果进入有来源的扩词流程。'));if(!(p.expansion_sources||[]).length)details.append(el('p','notice','当前没有可引用来源，请先完成商品页观察或关联广告采集。'));for(const source of p.expansion_sources||[]){const n=el('div','evidence');n.append(el('b','',source.source_kind==='landing'?'商品页来源':'广告来源 · '+(source.ad_id||'')),el('p','muted',`身份版本 ${source.identity_revision}${source.keyword_id?' · 来源关键词 '+source.keyword_id:''}`),el('p','',source.text));details.append(n);}for(const k of state.project.keywords.filter(k=>k.product_id===p.id)){const n=el('div','path-row',k.text+' · '+(labels[k.status]||k.status));if(k.source_quote)n.append(el('p','muted',`${k.source_kind||'旧版来源'} · ${k.source_quote}`));details.append(n);}}
else if(state.step==='channels'){
 for(const c of Object.keys(channels))actionbar.append(button('＋ '+channels[c],()=>evidence(c)));
 actionbar.append(button('导入 Trends CSV',trendsImport,'primary'),button('自动查 Trends',()=>run('trends',{product_id:p.id})));
 const freshnessNames={fresh:'有效期内',stale:'待复核',expired:'已过期',unknown:'时效未知'},scopeNames={domain:'域名',store:'店铺',product:'当前商品',landing_page:'落地页',unknown:'未知'};
 for(const e of p.evidence||[]){
  const n=el('div','evidence');
  n.append(el('b','',(channels[e.channel]||e.channel)+' '+(e.window||'')),el('p','',`${e.conclusion||e.reason||'待补充'} · ${e.confirmed?'人工已确认':'尚未确认'}`));
  n.append(el('p',e.freshness_status==='expired'?'notice':'muted',`${freshnessNames[e.freshness_status]||'时效未知'}${e.freshness_status==='expired'||e.freshness_status==='stale'?' / 重新核对':''} · ${e.freshness_reason||'没有明确时效信息'}`));
  if(e.channel==='similarweb')n.append(el('p','',`范围：${scopeNames[e.traffic_scope]||'未知'} · ${e.traffic_period||'周期未知'} · 月访问量 ${e.monthly_visits??'未知'}`));
  n.append(el('p','muted',time(e.observed_at)),link('来源 ↗',e.source_url));
  if(e.notes)n.append(el('p','',e.notes));details.append(n);
 }
 for(const e of p.automatic_trends||[]){const c=e.classification||{},n=el('div','evidence');n.append(el('b','',`自动 Trends · ${e.window||'旧记录窗口未知'}`),el('p','',`${e.conclusion||'待补充'} · 分类器 ${c.classifier_version||'旧记录未保存'}`),el('p','muted','观察时间 '+time(e.observed_at)));if(c.features)n.append(rawDetails('有限分类特征',c.features));details.append(n);}
 if(p.automatic_trends_error)details.append(el('p','notice',p.automatic_trends_error));
}
else if(state.step==='funnel'){actionbar.append(button('补充漏斗拆解',funnel,'primary'),button('自动读取商品页',()=>run('landing',{product_id:p.id,landing_mode:state.landingModes[p.id]||'local'})));details.append(kv(p.funnel));if(p.landing_snapshot?.funnel)details.append(el('h3','','自动观察，待你核对'),kv(p.landing_snapshot.funnel));details.append(optionalResearchDetails(p));}
else if(state.step==='economics'){
 actionbar.append(button('填写 / 更新订单测算',economics,'primary'),button('设置承运商物流规则',logisticsProfile),button('新增销量情景估算',salesEstimate));
 details.append(logisticsSummary(p,state.project.logistics_profile));
 if(p.economics){const facts=Object.fromEntries(Object.entries({aov:p.economics.aov,goods_cost:p.economics.goods_cost,shipping:p.economics.shipping,quote_source:p.economics.quote_source,quote_date:p.economics.quote_date}).filter(([,value])=>value!=null&&value!==''));if(Object.keys(facts).length)details.append(kv(facts));}
 details.append(estimateCards(p));
 if(p.economics)details.append(rawDetails('查看订单测算完整字段',p.economics));
 if(p.quote_history?.length){details.append(el('h3','','历史报价对比（不自动复用旧报价）'));for(const q of [...p.quote_history].reverse())details.append(kv({quote_source:q.quote_source,quote_date:q.quote_date,goods_cost:q.goods_cost,shipping:q.shipping,quantity:q.quantity,aov:q.aov}));}
}
else if(state.step==='score'){actionbar.append(button('检查证据并计算评分',()=>command('evaluate',{product_id:p.id}),'primary'));for(const score of [...(p.scores||[])].reverse()){const n=el('div','evidence score-card');n.append(el('div','score',score.total===null||score.total===undefined?'暂不评分':score.total+' / 25'),el('p','',score.recommendation||score.status),el('p','muted',`评分规则 ${score.rule_version} · 算法 ${score.score_version||'旧版'} · 产品版本 ${score.revision} · ${score.revision===p.revision?'当前版本':'历史 / 已过期'}`));if(score.missing?.length)n.append(el('p','','缺项：'+score.missing.join('、')));n.append(scoreDetails(score));details.append(n);}}
else if(state.step==='decision'){actionbar.append(button('确认去向并填写理由',decide,'primary'));details.append(kv(p.decision||{}));}
else if(state.step==='test'){actionbar.append(button('制定 / 批准测试计划',testPlan,'primary'),button('录入真实测试结果',()=>testResult()));details.append(kv(p.test_plan||{}));if(p.test_plan?.checklist){const ul=el('ul','plan-list');for(const x of p.test_plan.checklist)ul.append(el('li','',text(x)));details.append(ul);}if(p.test_runs?.length)details.append(rawDetails('测试轮次历史',p.test_runs));for(const r of [...(p.test_results||[])].reverse()){const n=el('div','evidence'),statusNote=r.legacy?'旧版未绑定轮次，仅供审计':r.superseded?'已有后续版本':r.state==='void'?'当前版本已作废，不参与统计':'当前有效版本';n.append(el('b','',`测试记录 · ${labels[r.state]||r.state||'旧版'} · ${r.period_start||''} 至 ${r.period_end||''}`),el('p','muted',statusNote),rawDetails('查看指标与修订信息',r));if(r.active){const actions=el('div','actions');if(r.state==='draft')actions.append(button('确认',()=>command('confirm_test_result',{product_id:p.id,result_id:r.id}),'primary'));actions.append(button('修订',()=>testResult(r)),button('作废',()=>voidTestResult(r)));n.append(actions);}details.append(n);}}
else if(state.step==='review'){actionbar.append(button('记录复盘与下一轮建议',review,'primary'));for(const r of p.reviews||[])details.append(kv(r));}
intro.append(actionbar);if(!details.children.length)details.append(el('p','','尚无记录'));panel.append(details);work.append(nav,panel);root.append(work);}
function landingReader(p,active){
 const saved=state.productActions[p.id]?.landing_mode;
 if(state.landingModes[p.id]===undefined)state.landingModes[p.id]=saved||'local';
 const label=el('label','connection-field','商品页读取方式'),select=el('select');select.setAttribute('aria-label','商品页读取方式');
 for(const [value,text] of [['local','本地读取（HTTP / 浏览器）'],['firecrawl','Firecrawl API（使用账户额度）']]){const option=el('option','',text);option.value=value;select.append(option);}
 select.value=active?saved||'local':state.landingModes[p.id];select.disabled=!!active;
 context.life.listen(select,'change',()=>{state.landingModes[p.id]=select.value;render();});label.append(select);
 label.append(el('small','muted',select.value==='firecrawl'?'仅点击读取或重试时调用 Firecrawl。失败不会自动切换方式。':'默认在备用机读取，动态页面会使用本地浏览器。'));
 return label;
}
function landingProgress(p){
 const action=state.productActions[p.id]||state.actions.find(a=>a.product_id===p.id&&a.kind==='landing'),snapshot=p.landing_snapshot;
 const active=action&&['ready','running','queued'].includes(action.status),failed=action&&['blocked','failed'].includes(action.status);
 const stopped=action?.error_code==='stopped',card=el('section','landing-progress'+(failed?' landing-progress-error':''));
 card.dataset.landingProgress='true';card.setAttribute('role','status');card.setAttribute('aria-live','polite');
 let title,next;
 if(active){
  title=action.status==='running'?'正在读取商品页':'等待读取商品页';
  next='下一步：等待读取结果；完成后核对商品名称与页面，再点击「确认具体商品」。也可以打开原页人工核对。';
 }else if(failed){
  title=stopped?'读取已停止':'商品页读取失败';
  next='下一步：重试读取，或打开商品页人工核对后点击「确认具体商品」。失败不会覆盖以前保存的证据。';
 }else if(snapshot){
  title='已保存商品页读取结果';
  next='下一步：核对下面的标题、页面与商品是否一致，再点击「确认具体商品」。自动读取不代表已通过粗筛。';
 }else{
  title=action?.status==='complete'?'读取任务已结束，当前商品没有可用读取结果':'尚未读取商品页';
  next='下一步：点击「自动读取商品页」，或打开商品页人工核对后点击「确认具体商品」。';
 }
 card.append(el('b','',title));
 const reader=action?.landing_mode||(snapshot?.rendering_mode==='firecrawl'?'firecrawl':'local');
 card.append(el('p','muted','读取方式：'+(reader==='firecrawl'?'Firecrawl API':'本地读取（HTTP / 浏览器）')));
 if(reader==='firecrawl'&&(active||failed))card.append(el('p','muted','云端请求可能已计费；停止会阻止结果写入，重试会重新调用 Firecrawl。'));
 if(active)card.append(el('p','muted',action.status==='running'?'当前阶段：'+stageLabel(action.stage):'请求已排队，等待执行。无需重复点击；此处每5秒自动更新。'));
 if(failed)card.append(el('p','notice',action.diagnostic||action.message||'原因未确定，请查看任务详情或人工核对原页。'));
 if(snapshot){
  if(snapshot.json_ld_warning)card.append(el('p','notice',snapshot.json_ld_warning));
  card.append(el('p','muted',active||failed?'以下是此前保存的结果，不代表本次读取成功。':'读取结果仍需人工核对。'));
  card.append(kv({title:snapshot.title||'未获取标题',price:snapshot.price||'未获取价格',page_type:({product:'商品页',category:'分类页',other:'其他页面'})[snapshot.page_type]||snapshot.page_type||'未知'}));
  if(snapshot.observed_at)card.append(el('p','muted','实际读取时间：'+time(snapshot.observed_at)));
 }
 if(state.step==='funnel')next=active?'下一步：等待读取结果，完成后核对页面，再点击「补充漏斗拆解」。':'下一步：核对商品页与已保存的自动观察，再点击「补充漏斗拆解」填写确认结果。';
 card.append(el('p','landing-next',next));
 const controls=el('div','actions');controls.append(link('打开商品页人工核对',p.url));
 if(active)controls.append(button('停止读取',()=>stopScanAction(action)));
 else if(failed||action?.status==='complete'&&!snapshot)controls.append(button('重试读取商品页',()=>run('landing',{product_id:p.id,landing_mode:action?.landing_mode||'local'}),'primary'));
 if(action){controls.append(el('small','muted','任务更新：'+time(action.updated_at)));if(action.failure_stage)card.append(el('p','muted','失败阶段：'+stageLabel(action.failure_stage)));}
 card.append(controls);
 return {card,active};
}

function kv(data){const n=el('dl','kv');const names={name:'产品名称',url:'商品链接',active_days:'可观察活跃天数',relevance_confirmed:'相关性已确认',reason:'依据',creatives:'创意证据',hook:'Hook',creative_formats:'创意形式',scenarios:'场景',angles:'角度',cta:'首屏 CTA',trust:'信任证明',faq:'FAQ',bundle:'组合策略',notes:'备注',source_url:'来源',confirmed:'人工确认',unit_price:'单品售价 USD',quantity:'订单件数',aov:'客单价 USD',goods_cost:'订单货值 USD',shipping:'运费 USD',packaging:'包装 USD',tax:'税费 USD',ad_cost:'广告成本 USD',payment_percent:'支付费率 %',payment_fixed:'支付固定费 USD',reserve_percent:'准备金 %',weight_kg:'重量 kg',quote_source:'报价来源',quote_date:'报价时间',quote_confirmed:'报价已确认',pool:'最终去向',budget:'测试预算 USD',days:'观察天数',success_cpa:'目标 CPA',stop_loss:'停止线 USD',approved:'已批准',title:'标题',price:'观察价格',page_type:'页面类型',conclusion:'结论',lessons:'经验与下一步',type:'复盘类型'};for(const [k,v] of Object.entries(data||{})){if(['history','checklist'].includes(k))continue;n.append(el('dt','',names[k]||k),el('dd','',typeof v==='boolean'?(v?'是':'否'):text(v)));}if(!Object.keys(data||{}).length)n.append(el('p','muted','尚无已保存记录'));return n;}
function rawDetails(label,data){const n=el('details');n.append(el('summary','',label),el('pre','',text(data)));return n;}

function mergeProduct(source){const peers=state.project.products.filter(x=>x.id!==source.id&&x.identity_key===source.identity_key);if(!peers.length){warn('当前没有同一商品身份的活动档案可合并。');return;}const options=Object.fromEntries(peers.map(x=>[x.id,x.name+' · '+x.url]));const id=state.project.id,version=state.project.version;openForm('合并重复商品档案','来源档案会保留为只读历史；测试结果不会转记到目标档案。合并后目标评分与决定需重新核对。',fields([['target_product_id','保留档案','select',true,options],['reason','合并理由','textarea']]),async d=>{state.project=await api('/projects/'+id+'/commands',{method:'POST',body:JSON.stringify({action:'merge_products',version,command_id:newCommandId(),payload:{...d,source_product_id:source.id}})});state.product=null;state.view='project';},{},{type:'merge_products',objectId:source.id,successView:'project'});}

function offerConceptCard(p){
 const concept=(state.project.product_concepts||[]).find(item=>item.id===p.concept_id&&item.status==='active'),card=box('同款卖家商品（可选）','只把确认是同一实物的不同卖家档案关联起来；价格、物流、广告、证据、评分和测试仍分别保留。');card.dataset.offerConcept='true';
 if(concept){card.append(el('h3','',concept.name),el('p','scope-note','证据保留在各卖家档案，不会因为同款关联而合并。'));for(const offer of state.project.products.filter(item=>item.concept_id===concept.id)){const row=el('p','offer-row',`${offer.name} · ${offer.url}`);if(offer.id===p.id)row.append(el('span','tag','当前卖家'));card.append(row);}const history=el('details');history.append(el('summary','','查看关联与拆分历史'));for(const item of concept.history||[])history.append(el('p','muted',`${time(item.at)} · ${{linked:'人工关联',split:'移出卖家',undo_link:'撤销关联',dissolved:'分组结束'}[item.action]||item.action}${item.reason?' · '+item.reason:''}`));card.append(history);if(['linked','undo_link'].includes(concept.history?.at(-1)?.action))card.append(button('撤销最近关联',()=>command('undo_offer_link',{concept_id:concept.id})));card.append(button('移出此卖家商品',()=>openForm('移出此卖家商品','移出只解除同款关联，不删除卖家档案、来源或历史。',fields([['reason','移出理由','textarea']]),async data=>{state.project=await api('/projects/'+state.project.id+'/commands',{method:'POST',body:JSON.stringify({action:'split_product_offer',version:state.project.version,command_id:newCommandId(),payload:{product_id:p.id,...data}})});},{},{type:'split_product_offer',objectId:p.id})));}
 const peers=state.project.products.filter(item=>item.id!==p.id&&!item.concept_id&&item.identity_key!==p.identity_key);if(peers.length){const options=Object.fromEntries(peers.map(item=>[item.id,`${item.name} · ${item.url}`]));card.append(button('关联同款商品的其他卖家',()=>openForm('关联同款卖家商品','请亲自核对两处页面确为同一实物。不同卖家的价格、Bundle、物流和证据不会转移或共用。',fields([['second_product_id','卖家商品','select',true,options],...(concept?[]:[['name','商品概念名称']]),['reason','对照依据','textarea']]),async data=>{state.project=await api('/projects/'+state.project.id+'/commands',{method:'POST',body:JSON.stringify({action:'link_product_offers',version:state.project.version,command_id:newCommandId(),payload:{first_product_id:p.id,...data}})});},{},{type:'link_product_offers',objectId:p.id})));}else if(!concept)card.append(el('p','muted','目前没有其他可关联的卖家档案。先添加另一家店的准确商品链接。'));
 return card;
}
function confirmProduct(productId=null,{stayInExploration=false}={}){productId=typeof productId==='string'?productId:null;const p=productId?state.project.products.find(item=>item.id===productId):product();if(!p){warn('当前商品不存在，请刷新后重试。');return;}const i=p.identification||{},version=state.project.version;openForm('确认具体商品','这里只确认广告对应哪个商品。素材数量和活跃天数在下一步单独核对；更换商品链接会使旧证据失效但保留历史。',fields([['name','产品名称'],['url','准确商品详情页','url'],['reason','广告与商品相关性依据','textarea'],['relevance_confirmed','我已核对广告与此商品相关','checkbox',false]]),async data=>{state.project=await api('/projects/'+state.project.id+'/commands',{method:'POST',body:JSON.stringify({action:'confirm_product',version,command_id:newCommandId(),payload:{...data,product_id:p.id}})});if(stayInExploration){state.view='project';state.nextFeedback={message:data.relevance_confirmed?'已确认当前商品。可继续提词，或判断是否保留并研究。':'已保存当前商品信息。确认广告相关性后才能继续提词。'};}else state.step='coarse';},{...i,name:p.name,url:p.url},{type:'confirm_product',objectId:p.id});}
function confirmCreatives(){const p=product(),i=p.identification||{},creativeCount=Math.max(3,state.project.rules?.min_creatives||3,(i.creatives||[]).length),defs=fields([['active_days','首次投放距今天数','number']]);for(let n=1;n<=creativeCount;n++)defs.push(...fields([[`creative_${n}_id`,`创意 ${n} · 广告 / 素材唯一标识`,'text',false],[`creative_${n}_url`,`创意 ${n} · 可核验证据链接`,'url',false],[`creative_${n}_distinct`,`创意 ${n} · 确认与其他素材不同`,'checkbox',false],[`creative_${n}_active`,`创意 ${n} · 当前正在投放`,'checkbox',false]]));const initial={...i,active_days:adAgeDays(i)};(i.creatives||[]).slice(0,creativeCount).forEach((c,k)=>{initial[`creative_${k+1}_id`]=c.id;initial[`creative_${k+1}_url`]=c.source_url;initial[`creative_${k+1}_distinct`]=c.distinct;initial[`creative_${k+1}_active`]=c.active;});const version=state.project.version;openForm('确认粗筛素材',`必须同时确认首次投放距今至少 ${state.project.rules?.min_active_days??30} 天、广告当前仍在投放，并找到 ${state.project.rules?.min_creatives??3} 个独立、活跃、可核验创意。广告年龄不代表期间从未中断；连续性没有历史观察时保持“未验证”。`,defs,async data=>{const creatives=[];for(let n=1;n<=creativeCount;n++){if(data[`creative_${n}_id`]||data[`creative_${n}_url`])creatives.push({id:data[`creative_${n}_id`],source_url:data[`creative_${n}_url`],distinct:data[`creative_${n}_distinct`],active:data[`creative_${n}_active`]});for(const suffix of ['id','url','distinct','active'])delete data[`creative_${n}_${suffix}`];}state.project=await api('/projects/'+state.project.id+'/commands',{method:'POST',body:JSON.stringify({action:'confirm_creatives',version,command_id:newCommandId(),payload:{...data,product_id:p.id,identity_revision:p.identity_revision,creatives}})});},initial,{type:'confirm_creatives',objectId:p.id});}
function evidence(channel){
 const defs=fields([['source_url','来源链接','url',false],['observed_at','实际观察 / 采集时间','datetime'],['conclusion','观察结论'],['notes','证据原文、范围与解释','textarea',false],['confirmed','我已核对来源与结论','checkbox',false],['review_due_at','明确复核日期（选填）','datetime',false],['valid_until','来源明确有效期（选填）','datetime',false]]);
 if(channel==='trends')defs.splice(2,1,...fields([['query','查询词'],['window','时间窗','select',true,{'12m':'过去12个月','5y':'过去5年'}],['conclusion','人工观察结论','select',true,{rising:'缓慢上升','stable-high':'高位平稳',seasonal:'季节性',declining:'下降',peaked:'见顶','insufficient-data':'证据不足'}]]));
 if(channel==='meta')defs.push(...fields([['advertiser_count','已确认相关广告主数量','number'],['brand_concentration','品牌集中度','select',true,{low:'低',medium:'中',high:'高'}],['differentiation','产品差异化','select',true,{low:'低',medium:'中',high:'高'}]]));
 if(channel==='similarweb')defs.push(...fields([['direct_share','直接流量占比（%）','number',false],['monthly_visits','月访问量估算','number',false],['traffic_scope','访问量所属范围','select',true,{'':'请选择范围',domain:'域名',store:'店铺',product:'当前商品',landing_page:'落地页'}],['traffic_url','访问量覆盖的网址','url',false],['traffic_period','访问量统计周期','text',false]]));
 if(!['meta','trends'].includes(channel))defs.push(...fields([['not_applicable','本渠道不适用 / 暂缺，接受有限证据标记','checkbox',false],['reason','不适用或暂缺的理由','textarea',false]]));
 const p=product(),version=state.project.version;
 openForm('补充 '+channels[channel]+' 证据','这是人工提交的证据。填写月访问量时必须说明范围、网址和周期；无明确复核/有效期限就留空，不自动过期。',defs,async d=>{state.project=await api('/projects/'+state.project.id+'/commands',{method:'POST',body:JSON.stringify({action:'evidence',version,command_id:newCommandId(),payload:{...d,product_id:p.id,channel,market:state.project.market}})});});
}
function trendsImport(){const p=product(),version=state.project.version;openForm('导入 Google Trends 周度 CSV','请导出'+marketNames[state.project.market]+'、单个查询词的数据。12个月与5年分别导入；程序校验搜索词、地区和连续周数据。',fields([['query','准确查询词'],['market','市场','select',true,{[state.project.market]:marketNames[state.project.market]}],['window','时间窗','select',true,{'12m':'过去12个月','5y':'过去5年'}],['source_url','原始 Trends 页面链接','url'],['observed_at','导出时间','datetime'],['csv','周度 CSV 文件','file'],['confirmed','确认此文件来自上述页面和范围','checkbox',false]]),async d=>{state.project=await api('/projects/'+state.project.id+'/trends-import',{method:'POST',body:JSON.stringify({...d,product_id:p.id,version,command_id:newCommandId()})});});}
function funnel(){formAction('funnel','广告与漏斗拆解','只填写实际观察。未访问的邮件、弃购和再营销请在备注标未知；不要填写推测事实。',fields([['source_url','主要证据来源','url'],['hook','前三秒 Hook / 首句'],['creative_formats','创意形式','array'],['scenarios','使用场景','array'],['angles','创意角度','array'],['cta','首屏 CTA'],['trust','评论 / UGC / 信任证明'],['faq','FAQ、物流与退货说明'],['bundle','Bundle 与价格策略'],['notes','补充说明 / 未知项','textarea',false],['confirmed','以上已核对，事实与推断已分开','checkbox',false]]),product().funnel||{});}
function addCreativeReference(){formAction('add_creative_reference','记录创意参考','只记录可借鉴的结构和你实际观察到的来源；不要复制、上传第三方创意素材。',fields([['source_ad_id','来源广告 ID'],['source_url','原广告链接','url'],['observed_at','实际观察时间','datetime'],['format','创意形式'],['hook','Hook（简述，不复制完整广告文案）'],['pattern_note','可借鉴的表现模式','textarea'],['category','类目','text',false],['audience','目标人群','text',false],['pain_point','痛点','text',false],['scene','场景','text',false],['angle','创意角度','text',false],['cta','CTA','text',false],['duration_seconds','时长（秒）','number',false],['notes','备注','textarea',false]]));}
function recordFunnelInvestigation(){formAction('record_funnel_investigation','记录漏斗调查','脚本存在只算“观察到”，不代表邮件、弃购或再营销流程正常。确认或未发现必须实际测试对应流程。',fields([['area','调查项目','select',true,{email_marketing:'邮件营销',abandoned_cart:'弃购',analytics:'分析追踪',retargeting:'再营销'}],['status','调查状态','select',true,{not_checked:'尚未检查',unknown:'未知',observed:'观察到线索',confirmed:'实际测试确认',not_found:'实际测试未发现',not_applicable:'不适用'}],['method','核对方法','select',false,{'':'未测试 / 未填写',script_detected:'仅发现脚本',actual_subscription:'实际订阅邮件',actual_abandonment:'实际弃购流程',account_analytics:'查看账户分析数据',actual_retargeting_test:'实际再营销测试',manual_observation:'人工观察页面'}],['source_url','证据链接（观察/确认/未发现必填）','url',false],['observed_at','实际观察时间','datetime',false],['reason','不适用理由','textarea',false],['notes','观察记录','textarea',false]]));}
function optionalResearchDetails(p){const n=el('details','optional-research');n.open=state.optionalResearchOpen;context.life.listen(n,'toggle',()=>{state.optionalResearchOpen=n.open;});n.append(el('summary','','辅助研究：创意参考、邮件/弃购/分析/再营销'));const body=el('div','secondary-research-body'),signal=p.evergreen_signal||{status:'unknown'},signalNames={observed:'观察到一年以上广告存续线索',not_observed:'目前未观察到一年以上存续线索',unknown:'未知，证据不足'};body.append(el('p','scope-note',`${signalNames[signal.status]||signalNames.unknown}。仅说明广告存续，不证明持续投放或盈利；不改变评分。`));const actions=el('div','actions');actions.append(button('记录创意参考',addCreativeReference),button('记录漏斗调查',recordFunnelInvestigation));body.append(actions);const refs=p.creative_references||[];body.append(el('h3','','创意参考'));if(!refs.length)body.append(el('p','muted','尚无参考记录；这不影响主流程。'));for(const r of [...refs].reverse()){const row=el('div','evidence');row.append(el('b','',`${r.source_ad_id} · ${r.format}`),el('p','',`${r.hook} · ${r.pattern_note}`),el('p','muted',`${r.stale_identity?'旧商品身份 · ':''}观察 ${time(r.observed_at)}`),link('原广告 ↗',r.source_url),rawDetails('完整文字记录',r));body.append(row);}const areaNames={email_marketing:'邮件营销',abandoned_cart:'弃购',analytics:'分析追踪',retargeting:'再营销'},statusNames={unknown:'未知',not_checked:'未检查',observed:'观察到线索',confirmed:'实际测试确认',not_found:'实际测试未发现',not_applicable:'不适用'},latest=new Map();for(const r of p.funnel_investigations||[])if(!r.stale_identity)latest.set(r.area,r);body.append(el('h3','','漏斗调查（当前商品身份）'));for(const [key,label] of Object.entries(areaNames)){const r=latest.get(key);body.append(el('p','',`${label}：${r?statusNames[r.status]||r.status:'未检查'}${r?.method==='script_detected'?' · 仅发现脚本，流程未确认':''}`));}if(p.funnel_investigations?.length)body.append(rawDetails('查看漏斗调查历史',p.funnel_investigations));n.append(body);return n;}
function logisticsProfile(){const profile=state.project.logistics_profile||{},id=state.project.id,version=state.project.version;openForm('设置承运商物流规则','请从真实承运商报价或规则填写体积重除数。没有来源时留空，不使用通用默认值。',fields([['carrier','承运商'],['service','线路 / 服务'],['source_url','规则来源链接','url'],['observed_at','核对时间','datetime'],['volumetric_divisor_cm3_per_kg','体积重除数（cm³/kg，可留空）','number',false],['confirmed','我已核对规则来源','checkbox',false]]),async data=>{state.project=await api('/projects/'+id+'/commands',{method:'POST',body:JSON.stringify({action:'set_logistics_profile',version,command_id:newCommandId(),payload:data})});},profile,{type:'logistics_profile'});}
function salesEstimate(){const p=product(),sources=(p.evidence||[]).filter(e=>e.channel==='similarweb'&&e.confirmed&&e.monthly_visits!=null&&e.traffic_scope&&e.traffic_scope!=='unknown'&&!e.stale_identity&&e.freshness_status!=='expired');if(!sources.length){warn('先补充未过期、带范围、网址和周期的 Similarweb 访问量证据。');return;}const options=Object.fromEntries(sources.map(e=>[e.id,`${e.traffic_scope} · ${e.traffic_period||'周期未知'} · ${e.monthly_visits} 次访问`]));formAction('add_sales_estimate','新增销量情景估算','这只是情景估算，不是真实测试。CVR 必须由你输入并说明来源；域名流量不会变成商品营收。',fields([['traffic_evidence_id','访问量证据','select',true,options],['cvr_low','低情景 CVR（%）','number'],['cvr_base','基准情景 CVR（%）','number'],['cvr_high','高情景 CVR（%）','number'],['cvr_source','CVR 来源或明确假设','textarea']]));}
function economics(){const defs=fields([['unit_price','单品售价（USD）','number'],['quantity','每笔订单件数','number'],['aov','预计客单价（USD）','number'],['goods_cost','整笔订单货值（USD）','number'],['shipping','整笔订单运费（USD）','number'],['packaging','订单包装费（USD）','number'],['tax','税费 / 关税（USD）','number'],['ad_cost','预估每单广告成本（USD）','number'],['payment_percent','支付费率（%，如2.9）','number'],['payment_fixed','支付固定费（USD）','number'],['reserve_percent','退款/拒付准备金（%）','number'],['weight_kg','包装后订单实际重量（kg）','number'],['package_length_cm','包装长度（cm）','number',false],['package_width_cm','包装宽度（cm）','number',false],['package_height_cm','包装高度（cm）','number',false],['quote_source','真实报价来源','url'],['quote_date','报价日期','datetime'],['bundle_reason','多件组合依据（多件必填）','textarea',false]]);for(const [key,label] of [['logistics_risk','物流风险'],['compliance_risk','合规风险'],['ip_risk','侵权风险']])defs.push(...fields([[key,label,'select',true,{low:'低',medium:'中',high:'高'}]]));for(const [key,label] of [['fragile','易碎'],['battery','含电池'],['liquid','液体'],['powder','粉末'],['magnetic','磁性'],['oversized','超大件']])defs.push(...fields([[key,label,'select',false,{'':'未知',false:'否',true:'是'}]]));defs.push(...fields([['quote_confirmed','报价真实有效，已确认规格与数量','checkbox',false],['certification_required','该产品需要认证','checkbox',false],['certification_verified','所需认证已核实','checkbox',false]]));const p=product(),version=state.project.version,initial={...(p.economics||{})};for(const key of ['fragile','battery','liquid','powder','magnetic','oversized'])initial[key]=initial[key]==null?'':String(initial[key]);openForm('核算这笔订单是否值得做',`目标市场：${marketNames[state.project.market]}。费用统一折算为 USD 后填写；按目标国家核实物流、税费和认证。不确定的成本不要填0。尺寸缺失或未设置承运商除数时体积重保持未知。报价超过 ${state.project.rules?.quote_valid_days??14} 天需要更新。`,defs,async data=>{for(const key of ['fragile','battery','liquid','powder','magnetic','oversized'])if(data[key]!=null)data[key]=data[key]==='true';state.project=await api('/projects/'+state.project.id+'/commands',{method:'POST',body:JSON.stringify({action:'economics',version,command_id:newCommandId(),payload:{...data,product_id:p.id}})});},initial);}
function decide(){formAction('decide','做出人工决策',`测试池需要最新完整评分≥${state.project.rules?.test_score??18}且通过硬门槛；备选池最低${state.project.rules?.backup_score??15}分。你也可以选择观察或淘汰，并说明理由。`,fields([['pool','最终去向','select',true,{observe:'观察',test:'测试池',backup:'备选池',reject:'淘汰'}],['reason','决定依据','textarea']]));}
function testPlan(){formAction('test_plan','确认测试计划','保存计划不会创建广告或花费预算。先明确预算、观察周期、成功线和停止线。',fields([['budget','总预算（USD）','number'],['days','观察天数','number'],['success_cpa','目标 CPA（USD）','number'],['stop_loss','停止线：最高可承受花费（USD）','number'],['notes','测试假设与执行说明','textarea'],['approved','我批准此测试计划（不代表授权自动投放）','checkbox',false]]),product().test_plan||{});}
function testResult(result=null){const revising=Boolean(result),defs=fields([['period_start','统计开始时间','datetime'],['period_end','统计结束时间','datetime'],['spend','广告花费（USD）','number'],['impressions','展示数','number'],['clicks','点击数','number'],['add_to_carts','加购数','number'],['checkouts','发起结账数','number'],['orders','订单数','number'],['revenue','订单收入（USD）','number'],['refunds','退款订单数','number'],['source_url','广告 / 店铺报表来源','url'],['confirmed','已确认统计口径及真实来源','checkbox',false]]);if(revising)defs.push(...fields([['reason','修订理由','textarea']]));const id=state.project.id,version=state.project.version,pid=state.product;openForm(revising?'修订测试结果':'记录真实测试结果','只录入实际结果。修订会创建新版本，原记录继续保留；相同轮次的有效周期不能重叠。',defs,async data=>{state.project=await api('/projects/'+id+'/commands',{method:'POST',body:JSON.stringify({action:revising?'revise_test_result':'test_result',version,command_id:newCommandId(),payload:{...data,product_id:pid,...(revising?{result_id:result.id}:{})}})});},result||{});}
function voidTestResult(result){const id=state.project.id,version=state.project.version,pid=state.product;openForm('作废测试结果','作废会追加一条可审计记录，原数据不会删除，但不会继续参与统计。',fields([['reason','作废理由','textarea']]),async data=>{state.project=await api('/projects/'+id+'/commands',{method:'POST',body:JSON.stringify({action:'void_test_result',version,command_id:newCommandId(),payload:{...data,product_id:pid,result_id:result.id}})});},{},{type:'void_test_result',objectId:result.id});}
function review(){formAction('review','记录复盘，回流下一轮关键词','无真实测试结果时，只能形成研究复盘，不能声称测试成功。新增关键词默认待审核。',fields([['conclusion','本轮结论','textarea'],['lessons','有效线索、失败原因与下一步','textarea'],['next_keywords','下一轮关键词建议','array',false]]));}

 const p=product();renderSourceProduct(root);if(p&&state.project.products.some(other=>other.id!==p.id&&other.identity_key===p.identity_key&&p.identity_key))root.append(button('合并重复档案',()=>mergeProduct(p)));
 if(p&&!p.merged_into){const handoff=button('将当前商品交接到营销工具',()=>context.onSelectProduct?.({project_id:state.project.id,product_id:p.id,source_version:state.project.version,identity_revision:p.identity_revision||1}));handoff.dataset.productHandoff='';root.append(handoff);}
 if(p&&['identification','funnel'].includes(state.step)){const progress=landingProgress(p);root.append(landingReader(p,progress.active),progress.card);}
 return root;
}
