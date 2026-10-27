/** Business-language projections only. Authoritative gates remain on the server. */
export const journeyGroups = [
 {key:'candidate',title:'找到并核实商品',steps:['identification','coarse']},
 {key:'demand',title:'判断需求与竞争',steps:['expansion','channels','funnel']},
 {key:'economics',title:'算收益与风险',steps:['economics','score']},
 {key:'decision',title:'作决定与验证',steps:['decision','test','review']},
];
/** Match the server's bounded scan_all selection; completed words need explicit rescan. */
export function scanCandidates(project={}) {
 const limit=Number.isInteger(project.rules?.scan_batch_limit)?project.rules.scan_batch_limit:20;
 return (project.keywords||[]).filter(w=>w.approved===true&&['ready','blocked'].includes(w.status)).slice(0,limit);
}
/** Resume a saved focus first; otherwise show actual results instead of the first unsearched word. */
export function projectResume(project={}) {
 const focus=(project.products||[]).find(p=>p.id===project.focus_product_id&&!p.merged_into&&!['observing','rejected'].includes(p.triage?.state));
 if(focus){const decided=focus.decision&&!focus.decision.stale&&focus.decision.pool!=='test'&&focus.steps?.find(s=>s.key==='decision')?.state==='passed';return {view:'product',product:focus.id,step:decided?'review':(focus.steps||[]).find(s=>!['passed','not_applicable'].includes(s.state)&&s.key!=='expansion')?.key||'decision'};}
 const products=(project.products||[]).filter(p=>!p.merged_into);
 const words=(project.keywords||[]).filter(w=>w.status!=='archived'),ready=words.filter(w=>w.ads?.length||products.some(p=>(p.source_keyword_ids||[]).includes(w.id))).sort((a,b)=>(Date.parse(b.updated_at)||0)-(Date.parse(a.updated_at)||0));
 const word=ready[0]||words[0];
 return {view:'project',product:null,projectSection:ready.length||products.length?'leads':'keywords',explorationKeyword:word?.id||null};
}
const names={identification:'确认广告对应的具体商品',coarse:'核实广告年龄与独立活跃素材',expansion:'沿可靠来源寻找更多关键词',channels:'补充需求与竞争证据',funnel:'核对广告和商品页表达',economics:'核算真实成本与风险',score:'检查证据并评估',decision:'决定测试、备选、观察或淘汰',test:'准备测试并记录真实结果',review:'保存本轮结论与下一步'};
const evidenceNames={coarse_screen:'广告粗筛',meta:'Meta竞争证据',trends_12m:'近12个月需求趋势',trends_5y:'近5年需求趋势',trends_query_match:'趋势查询一致性',funnel:'广告与商品页表达',economics:'成本与风险',certification_verification:'认证核实',pinterest:'Pinterest辅助证据',tiktok:'TikTok辅助证据',amazon:'Amazon辅助证据',similarweb:'Similarweb流量证据'};
export const evidenceName=key=>evidenceNames[key]||'其他待核实证据';
export function scoreMessage(score={}) {
 if(score.total==null&&(score.missing||[]).length)return '证据不足，暂不能评分。待补充：'+score.missing.map(evidenceName).join('、');
 return score.recommendation||({complete:'研究评分已生成',incomplete:'证据不足，暂不能评分'}[score.status])||'评分状态待核对';
}
export function stepStatusLabel(step={},product={}) {
 if(step.key==='coarse'&&step.state!=='passed'&&product.gates?.coarse_screen?.status==='fail')return '当前未达标';
 if(step.state==='passed'){
  if(step.key==='decision')return '已记录决定';
  if(step.key==='review')return '已保存复盘';
  if(step.key==='identification')return product.identification?.confirmation_method==='ai'?'AI 已匹配':'人工已确认';
  return '已通过';
 }
 return {needs_input:'待补充',blocked:'暂不能继续',pending:'未开始',not_applicable:'本轮无需进行',failed:'未通过'}[step.state]||'状态待核对';
}
export function productTasks(product={}) {
 return (product.steps||[]).filter(s=>['needs_input','blocked','failed'].includes(s.state)&&names[s.key]).map(s=>({...s,title:names[s.key]}));
}
export function evidenceTasks(product={}) {
 const destinations={coarse_screen:'coarse',funnel:'funnel',economics:'economics',certification_verification:'economics',meta:'channels',trends_12m:'channels',trends_5y:'channels',trends_query_match:'channels',pinterest:'channels',tiktok:'channels',amazon:'channels',similarweb:'channels'};
 return (product.requirement_statuses||[]).filter(r=>r.applies!==false&&!['pass','not_applicable'].includes(r.status)).map(r=>({
  key:r.key,title:r.label||'待核实证据',reason:r.status_reason||r.reason||'请核对来源与有效期',blocking:r.blocks_scoring===true,step:destinations[r.key]||null,
 }));
}
export function decisionSummary(product={}) {
 const d=product.decision;
 if(!d)return {label:'尚未作出决定',note:'先核实关键证据，再决定是否值得继续投入。',stale:false};
 const decisionStep=(product.steps||[]).find(s=>s.key==='decision');
 const stale=!!d.stale||!!(decisionStep&&decisionStep.state!=='passed');
 const label={test:'进入测试候选',backup:'备选',observe:'观察',reject:'淘汰'}[d.pool]||'去向待核对';
 return {label:label+(stale?' · 需重新核对':''),reason:d.reason||'',stale,note:stale?'资料、有效期或规则已变化，旧决定保留供参考。':d.pool==='test'?'这是研究决定，不代表已批准投放或已经取得测试结果。':d.pool==='observe'?'暂不进入测试，补齐关键证据后再评估。':d.pool==='reject'?'保留证据与理由，避免重复投入。':d.pool==='backup'?'保留为备选，不代表已进入测试。':'请核对已保存的去向。'};
}
