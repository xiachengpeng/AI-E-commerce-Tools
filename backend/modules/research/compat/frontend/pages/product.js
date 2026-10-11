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
  ['Required 缺口',summary.required_gaps??0,(summary.required_gaps??0)>0?'attention':'ok'],
  ['Recommended 缺口',summary.recommended_gaps??0,(summary.recommended_gaps??0)>0?'warn':'ok'],
  ['未知项',summary.unknown??0,(summary.unknown??0)>0?'warn':'ok'],
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
function renderProduct(root){breadcrumbs(root);const p=product();if(!p){root.append(empty('产品不存在','请返回研究项目刷新。'));return;}const work=el('div','workspace'),nav=el('div','steps'),steps=p.steps||[],currentIndex=Math.max(0,steps.findIndex(step=>step.key===S.step));for(const [index,step] of steps.entries()){const phase=index<currentIndex?' complete-step':index>currentIndex?' future-step':'';const b=button(step.label,()=>{S.step=step.key;render();},'step-button '+(S.step===step.key?'active':'')+phase);b.append(stateTag(step.state));nav.append(b);}const panel=el('div'),current=p.steps?.find(x=>x.key===S.step);panel.append(evidenceHealth(p,current));const intro=box(current?.label||'产品档案',current?.reason||'请按步骤补齐证据');intro.append(stateTag(current?.state||'pending'));if(current?.next_action)intro.append(el('p','muted','下一步：'+current.next_action));panel.append(intro);if(S.step==='identification')panel.append(offerConceptCard(p));const actionbar=el('div','actions');const details=box('已保存的产物');
if(S.step==='identification'){actionbar.append(button('确认具体商品',confirmProduct,'primary'),button('自动读取商品页',()=>run('landing',{product_id:p.id,landing_mode:S.landingModes[p.id]||'local'})));if(p.identity_history?.length)details.append(el('p','scope-note','商品身份已更换，旧资料保留为历史，需要重新确认当前商品的渠道、漏斗和成本证据。'));details.append(link('商品来源 ↗',p.url),rawDetails('查看身份审计字段',p.identification));if(p.landing_snapshot){details.append(el('h3','','自动页面观察（未代替人工确认）'),kv({title:p.landing_snapshot.title,price:p.landing_snapshot.price,page_type:p.landing_snapshot.page_type,requested_url:p.landing_snapshot.requested_url||'旧记录未保存',final_url:p.landing_snapshot.final_url||p.landing_snapshot.source_url||'未知',http_status_code:p.landing_snapshot.http_status_code??'旧记录未保存',browser_status_code:p.landing_snapshot.browser_status_code??'未使用 / 未保存',rendering_mode:p.landing_snapshot.rendering_mode||'旧记录未保存',observed_at:p.landing_snapshot.observed_at}));}const adIds=p.source_keyword_ids||[];for(const k of S.project.keywords.filter(k=>adIds.includes(k.id)))details.append(button('查看来源广告 · '+k.text,()=>showAds(k)));details.append(optionalResearchDetails(p));}
else if(S.step==='coarse'){actionbar.append(button('确认粗筛素材',confirmCreatives,'primary'));details.append(el('p','scope-note',`粗筛必须同时确认首次投放距今至少 ${S.project.rules?.min_active_days??30} 天、当前仍在投放，并有 ${S.project.rules?.min_creatives??3} 个独立活跃创意；商品已保留不等于通过。`),coarseFacts(p),rawDetails('查看身份审计字段',p.identification),optionalResearchDetails(p));}
else if(S.step==='expansion'){const parents=S.project.keywords.filter(k=>(p.source_keyword_ids||[]).includes(k.id));for(const k of parents)actionbar.append(button('从 '+k.text+' 扩词',()=>addKeyword(k,p),'primary'));if(parents.length)actionbar.append(button('AI 提取扩词建议',()=>run('expand',{product_id:p.id,keyword_id:parents[0].id})));else details.append(el('p','','该商品尚未关联来源关键词，可从项目搜索结果进入有来源的扩词流程。'));if(!(p.expansion_sources||[]).length)details.append(el('p','notice','当前没有可引用来源，请先完成商品页观察或关联广告采集。'));for(const source of p.expansion_sources||[]){const n=el('div','evidence');n.append(el('b','',source.source_kind==='landing'?'商品页来源':'广告来源 · '+(source.ad_id||'')),el('p','muted',`身份版本 ${source.identity_revision}${source.keyword_id?' · 来源关键词 '+source.keyword_id:''}`),el('p','',source.text));details.append(n);}for(const k of S.project.keywords.filter(k=>k.product_id===p.id)){const n=el('div','path-row',k.text+' · '+(labels[k.status]||k.status));if(k.source_quote)n.append(el('p','muted',`${k.source_kind||'旧版来源'} · ${k.source_quote}`));details.append(n);}}
else if(S.step==='channels'){
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
else if(S.step==='funnel'){actionbar.append(button('补充漏斗拆解',funnel,'primary'),button('自动读取商品页',()=>run('landing',{product_id:p.id,landing_mode:S.landingModes[p.id]||'local'})));details.append(kv(p.funnel));if(p.landing_snapshot?.funnel)details.append(el('h3','','自动观察，待你核对'),kv(p.landing_snapshot.funnel));details.append(optionalResearchDetails(p));}
else if(S.step==='economics'){
 actionbar.append(button('填写 / 更新订单测算',economics,'primary'),button('设置承运商物流规则',logisticsProfile),button('新增销量情景估算',salesEstimate));
 details.append(logisticsSummary(p,S.project.logistics_profile));
 if(p.economics){const facts=Object.fromEntries(Object.entries({aov:p.economics.aov,goods_cost:p.economics.goods_cost,shipping:p.economics.shipping,quote_source:p.economics.quote_source,quote_date:p.economics.quote_date}).filter(([,value])=>value!=null&&value!==''));if(Object.keys(facts).length)details.append(kv(facts));}
 details.append(estimateCards(p));
 if(p.economics)details.append(rawDetails('查看订单测算完整字段',p.economics));
 if(p.quote_history?.length){details.append(el('h3','','历史报价对比（不自动复用旧报价）'));for(const q of [...p.quote_history].reverse())details.append(kv({quote_source:q.quote_source,quote_date:q.quote_date,goods_cost:q.goods_cost,shipping:q.shipping,quantity:q.quantity,aov:q.aov}));}
}
else if(S.step==='score'){actionbar.append(button('检查证据并计算评分',()=>command('evaluate',{product_id:p.id}),'primary'));for(const score of [...(p.scores||[])].reverse()){const n=el('div','evidence score-card');n.append(el('div','score',score.total===null||score.total===undefined?'暂不评分':score.total+' / 25'),el('p','',score.recommendation||score.status),el('p','muted',`评分规则 ${score.rule_version} · 算法 ${score.score_version||'旧版'} · 产品版本 ${score.revision} · ${score.revision===p.revision?'当前版本':'历史 / 已过期'}`));if(score.missing?.length)n.append(el('p','','缺项：'+score.missing.join('、')));n.append(scoreDetails(score));details.append(n);}}
else if(S.step==='decision'){actionbar.append(button('确认去向并填写理由',decide,'primary'));details.append(kv(p.decision||{}));}
else if(S.step==='test'){actionbar.append(button('制定 / 批准测试计划',testPlan,'primary'),button('录入真实测试结果',()=>testResult()));details.append(kv(p.test_plan||{}));if(p.test_plan?.checklist){const ul=el('ul','plan-list');for(const x of p.test_plan.checklist)ul.append(el('li','',text(x)));details.append(ul);}if(p.test_runs?.length)details.append(rawDetails('测试轮次历史',p.test_runs));for(const r of [...(p.test_results||[])].reverse()){const n=el('div','evidence'),statusNote=r.legacy?'旧版未绑定轮次，仅供审计':r.superseded?'已有后续版本':r.state==='void'?'当前版本已作废，不参与统计':'当前有效版本';n.append(el('b','',`测试记录 · ${labels[r.state]||r.state||'旧版'} · ${r.period_start||''} 至 ${r.period_end||''}`),el('p','muted',statusNote),rawDetails('查看指标与修订信息',r));if(r.active){const actions=el('div','actions');if(r.state==='draft')actions.append(button('确认',()=>command('confirm_test_result',{product_id:p.id,result_id:r.id}),'primary'));actions.append(button('修订',()=>testResult(r)),button('作废',()=>voidTestResult(r)));n.append(actions);}details.append(n);}}
else if(S.step==='review'){actionbar.append(button('记录复盘与下一轮建议',review,'primary'));for(const r of p.reviews||[])details.append(kv(r));}
intro.append(actionbar);if(!details.childNodes.length)details.append(el('p','','尚无记录'));panel.append(details);work.append(nav,panel);root.append(work);}
function landingReader(p,active){
 const saved=S.productActions[p.id]?.landing_mode;
 if(S.landingModes[p.id]===undefined)S.landingModes[p.id]=saved||'local';
 const label=el('label','connection-field','商品页读取方式'),select=el('select');select.setAttribute('aria-label','商品页读取方式');
 for(const [value,text] of [['local','本地读取（HTTP / 浏览器）'],['firecrawl','Firecrawl API（使用账户额度）']]){const option=el('option','',text);option.value=value;select.append(option);}
 select.value=active?saved||'local':S.landingModes[p.id];select.disabled=!!active;
 select.onchange=()=>{S.landingModes[p.id]=select.value;render();};label.append(select);
 label.append(el('small','muted',select.value==='firecrawl'?'仅点击读取或重试时调用 Firecrawl。失败不会自动切换方式。':'默认在备用机读取，动态页面会使用本地浏览器。'));
 return label;
}
function landingProgress(p){
 const action=S.productActions[p.id]||S.actions.find(a=>a.product_id===p.id&&a.kind==='landing'),snapshot=p.landing_snapshot;
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
 if(S.step==='funnel')next=active?'下一步：等待读取结果，完成后核对页面，再点击「补充漏斗拆解」。':'下一步：核对商品页与已保存的自动观察，再点击「补充漏斗拆解」填写确认结果。';
 card.append(el('p','landing-next',next));
 const controls=el('div','actions');controls.append(link('打开商品页人工核对',p.url));
 if(active)controls.append(button('停止读取',()=>stopScanAction(action)));
 else if(failed||action?.status==='complete'&&!snapshot)controls.append(button('重试读取商品页',()=>run('landing',{product_id:p.id,landing_mode:action?.landing_mode||'local'}),'primary'));
 if(action){controls.append(el('small','muted','任务更新：'+time(action.updated_at)));if(action.failure_stage)card.append(el('p','muted','失败阶段：'+stageLabel(action.failure_stage)));}
 card.append(controls);
 return {card,active};
}

function renderProductGuided(root){
 renderProduct(root);
 const explorationProduct=product();if(explorationProduct)root.append(productExplorationPanel(explorationProduct));
 const p=product(),work=root.querySelector('.workspace'),nav=work?.querySelector('.steps');
 if(!p||!nav)return;
 const steps=p.steps||[],guide=S.project?.guidance,authoritativeKey=guide?.product_id===p.id&&guide.step?guide.step:(p.todos?.[0]?.step||S.step),authoritativeIndex=Math.max(0,steps.findIndex(step=>step.key===authoritativeKey));
 const phases=researchPhases.map(phase=>({...phase,steps:[...phase.steps]}));
 if(!phases.some(phase=>phase.steps.includes(authoritativeKey)))phases[phases.length-1].steps.push(authoritativeKey);
 const currentPhaseIndex=Math.max(0,phases.findIndex(phase=>phase.steps.includes(authoritativeKey)));
 let selectedPhaseIndex=phases.findIndex(phase=>phase.steps.includes(S.step));
 if(selectedPhaseIndex<0)selectedPhaseIndex=currentPhaseIndex;
 nav.replaceChildren();
 phases.forEach((phase,index)=>{
  const status=index<currentPhaseIndex?'已完成':index===currentPhaseIndex?'当前阶段':'未到此步';
  const targetSteps=steps.filter(step=>phase.steps.includes(step.key));
  const target=targetSteps.filter(step=>steps.indexOf(step)<=authoritativeIndex).at(-1)||targetSteps[0];
  const phaseButton=button(phase.label,()=>{if(target){S.step=index===currentPhaseIndex?authoritativeKey:target.key;render();}},'phase-button '+(index===selectedPhaseIndex?'active':'')+(index>currentPhaseIndex?' future-phase':''));
  phaseButton.append(el('small','phase-status',status));
  if(index>currentPhaseIndex)phaseButton.disabled=true;
  nav.append(phaseButton);
  if(index===selectedPhaseIndex){
   const substeps=el('div','phase-substeps');
   for(const step of targetSteps){
    const stepIndex=steps.indexOf(step),future=stepIndex>authoritativeIndex;
    const stepButton=button(step.label,()=>{S.step=step.key;render();},'step-button '+(S.step===step.key?'active':'')+(future?' future-step':''));
    stepButton.append(el('small','',future?'未到此步':labels[step.state]||step.state));
    if(future)stepButton.disabled=true;
    substeps.append(stepButton);
   }
   nav.append(substeps);
  }
 });
 if(['identification','funnel'].includes(S.step)){
  const actionbar=work.querySelector(':scope > div:last-child > .panel .actions'),buttons=[...(actionbar?.querySelectorAll('button')||[])],observe=buttons.find(item=>item.textContent==='自动读取商品页'),confirm=buttons.find(item=>item.textContent==='确认具体商品');
  if(actionbar){const progress=landingProgress(p);actionbar.before(landingReader(p,progress.active));actionbar.parentElement.append(progress.card);if(observe)observe.disabled=!!progress.active;}
  if(observe&&confirm&&!p.landing_snapshot){observe.classList.add('primary');confirm.classList.remove('primary');actionbar.prepend(observe);}
 }
}
function kv(data){const n=el('dl','kv');const names={name:'产品名称',url:'商品链接',active_days:'可观察活跃天数',relevance_confirmed:'相关性已确认',reason:'依据',creatives:'创意证据',hook:'Hook',creative_formats:'创意形式',scenarios:'场景',angles:'角度',cta:'首屏 CTA',trust:'信任证明',faq:'FAQ',bundle:'组合策略',notes:'备注',source_url:'来源',confirmed:'人工确认',unit_price:'单品售价 USD',quantity:'订单件数',aov:'客单价 USD',goods_cost:'订单货值 USD',shipping:'运费 USD',packaging:'包装 USD',tax:'税费 USD',ad_cost:'广告成本 USD',payment_percent:'支付费率 %',payment_fixed:'支付固定费 USD',reserve_percent:'准备金 %',weight_kg:'重量 kg',quote_source:'报价来源',quote_date:'报价时间',quote_confirmed:'报价已确认',pool:'最终去向',budget:'测试预算 USD',days:'观察天数',success_cpa:'目标 CPA',stop_loss:'停止线 USD',approved:'已批准',title:'标题',price:'观察价格',page_type:'页面类型',conclusion:'结论',lessons:'经验与下一步',type:'复盘类型'};for(const [k,v] of Object.entries(data||{})){if(['history','checklist'].includes(k))continue;n.append(el('dt','',names[k]||k),el('dd','',typeof v==='boolean'?(v?'是':'否'):text(v)));}if(!Object.keys(data||{}).length)n.append(el('p','muted','尚无已保存记录'));return n;}
function rawDetails(label,data){const n=el('details');n.append(el('summary','',label),el('pre','',text(data)));return n;}
