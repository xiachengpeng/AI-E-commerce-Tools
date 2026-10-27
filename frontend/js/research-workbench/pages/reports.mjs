import { el as nativeEl, button as nativeButton, panel, typeNames } from '../components/elements.mjs';
import { decisionSummary, productTasks } from '../services/journey.mjs';
const channels={meta:'Meta 广告',trends:'Google Trends',pinterest:'Pinterest',tiktok:'TikTok',amazon:'Amazon',similarweb:'Similarweb'};
export function renderReport(context) {
 const state=context.state,root=nativeEl(context,'section','rw-reports');
 const el=(tag,cls='',content)=>nativeEl(context,tag,cls,content),button=(label,fn,cls='')=>nativeButton(context,label,fn,cls),box=(title,note)=>panel(context,title,note),empty=(title,note,btn)=>{const node=box(title,note);if(btn)node.append(btn);return node;};
 const time=v=>v?new Date(v).toLocaleString('zh-CN'):'未记录';
 const api=path=>context.api.request(path,{signal:context.life.signal});
 const heading=el('h1','','结论与复盘');heading.tabIndex=-1;root.append(heading);
 root.append(el('p','rw-muted','先看每个商品的决定、依据和待补事项；评分是研究参考，进入测试候选不等于批准投放。'));
 const selectedId=state.reportProjectId||state.project?.id||state.projects?.[0]?.id;
 const selectedProject=state.projects?.find(p=>p.id===selectedId)||state.projects?.[0];
 if(state.projects?.length){const label=el('label','','查看哪个项目的商品决定'),select=el('select');select.setAttribute('aria-label','结论所属项目');for(const p of state.projects){const option=el('option','',p.title||'研究项目');option.value=p.id;select.append(option);}select.value=selectedProject?.id||'';context.life.listen(select,'change',()=>{state.reportProjectId=select.value;context.navigate('reports');});label.append(select);root.append(label);}
 for(const project of selectedProject?[selectedProject]:[]){
  if(!(project.products||[]).some(p=>!p.merged_into))root.append(box('还没有候选商品','先添加已有商品，或审核搜索词并搜索公开广告，再回来判断哪些值得继续研究。'));
  for(const product of (project.products||[]).filter(p=>!p.merged_into)){
   const summary=decisionSummary(product),card=box(product.name||'待识别商品',project.title||'研究项目');card.classList.add('rw-decision-card');
   card.append(el('strong','',summary.label));if(summary.reason)card.append(el('p','',summary.reason));card.append(el('p','rw-muted',summary.note));
   const score=[...(product.scores||[])].reverse().find(s=>s.revision===product.revision);
   const blocked=(product.requirement_statuses||[]).some(r=>r.blocks_scoring===true);
   card.append(el('p','rw-muted',score?.status==='complete'&&Number.isFinite(score.total)&&!blocked?`当前研究评分：${score.total} / 25`:'尚无可用的完整评分；旧评分不代表当前商品可进入测试。'));
   const tasks=productTasks(product);if(tasks.length)card.append(el('p','rw-muted','待核实：'+tasks.slice(0,3).map(t=>t.title).join('；')+(tasks.length>3?'；另有待办，打开商品查看。':'')));
   const open=button('查看依据与下一步',()=>context.openHistoryProduct(project.id,product.id));open.dataset.resultProduct=product.id;card.append(open);root.append(card);
  }
 }
function researchRatio(value){if(!value)return '样本不足';const base=`${value.numerator}/${value.denominator}`;return value.percent===null?`${base}（样本不足）`:`${base}（${value.percent}%）`;}
async function showResearchReview(id) {
 const requestId=(state.reportRequest||0)+1;state.reportRequest=requestId;
 state.researchReviewRequestedId=id;state.researchReviewLoading=true;state.researchReviewError='';
 try {
  const data=await api('/projects/'+encodeURIComponent(id)+'/intelligence');
  if(!context.life.active||state.reportRequest!==requestId)return;
  state.researchReview=data;state.researchReviewId=id;
 }catch(error){
  if(context.life.active&&state.reportRequest===requestId)state.researchReviewError='研究复盘读取失败：'+error.message+'。可重试，已保存结果保持显示。';
 }finally{
  if(context.life.active&&state.reportRequest===requestId){state.researchReviewLoading=false;context.navigate('reports');}
 }
}
function researchRow(parent,label,details){const row=el('div','research-row');row.append(el('b','',label),el('p','',details));parent.append(row);}
function renderResearchReview(root){
 const data=state.researchReview;if(!data||state.researchReviewId!==selectedProject?.id)return;
 const section=box('项目复盘','基于已保存事实的描述性统计，不代表市场规模或测试成功率。');section.dataset.researchReview='true';
 const scope=el('details','rw-review-stat-scope');scope.append(el('summary','','统计口径与样本范围'),el('p','muted',`累计窗口：${time(data.window?.start)} → ${time(data.window?.end)} · 活动卖家档案 ${data.unique_active_products??'未知'} 个 · 已确认同款分组 ${data.confirmed_concept_groups??'未知'} 组`),el('p','muted',data.association_note||'同一商品跨词关联数不可相加；样本不足时不判断哪类词更好。'));
 const tabs=el('nav','rw-report-review-tabs');tabs.setAttribute('aria-label','项目复盘统计分区');tabs.setAttribute('role','tablist');
 const words=el('section','research-section'),sources=el('section','research-section'),tests=el('section','research-section'),panes=new Map([['keywords',words],['sources',sources],['tests',tests]]),tabButtons=new Map();let active=panes.has(state.reportReviewTab)?state.reportReviewTab:'keywords';
 const select=value=>{active=value;state.reportReviewTab=value;for(const [key,node] of panes){node.dataset.reviewPanel=key;node.hidden=key!==value;}for(const [key,node] of tabButtons)node.setAttribute('aria-selected',String(key===value));};
 for(const [value,label] of [['keywords','关键词表现'],['sources','来源表现'],['tests','已确认测试']]){const tab=button(label,()=>select(value));tab.setAttribute('role','tab');tabButtons.set(value,tab);tabs.append(tab);}
 const count=value=>typeof value==='number'&&Number.isFinite(value)?String(value):'未知';
 if(!data.keywords?.length)words.append(el('p','empty-inline','尚无关键词，样本不足，不能判断哪类词更好。'));
 else{const table=el('table','rw-table'),head=el('tr');for(const label of ['搜索词','扫描完成数','去重广告','关联商品','详情'])head.append(el('th','',label));table.append(head);
  for(const word of data.keywords){const row=el('tr');for(const value of [word.text,count(word.scan_completed),count(word.ads_found),count(word.associated_products)])row.append(el('td','',value));const cell=el('td'),detail=el('details');detail.append(el('summary','','查看口径'));researchRow(detail,typeNames[word.type]||word.type||'类型未记录',`扫描尝试：${word.scan_attempts===null?'旧记录不可还原':count(word.scan_attempts)} · 首次关联 ${count(word.primary_products)} / 辅助关联 ${count(word.assisting_products)} · 当前保留：${researchRatio(word.retained_rate)} · 当前测试池：${researchRatio(word.test_pool_rate)}`);cell.append(detail);row.append(cell);table.append(row);}const wrap=el('div','rw-table-wrap');wrap.append(table);words.append(wrap);
 }
 const types=el('details','rw-review-keyword-types');types.append(el('summary','','关键词类型与留存比例'));if(!data.keyword_types?.length)types.append(el('p','empty-inline','尚无明确类型，样本不足。'));for(const row of data.keyword_types||[])researchRow(types,typeNames[row.type]||row.type,`${count(row.keywords)} 个词 · 关联商品 ${count(row.associated_products)} · 当前保留 ${researchRatio(row.retained_rate)} · 当前测试池 ${researchRatio(row.test_pool_rate)}`);words.append(types);
 if(!data.discovery_sources?.length)sources.append(el('p','empty-inline','尚无可归因的来源样本；不推断为零机会。'));
 for(const row of data.discovery_sources||[]){const name=row.source==='unattributed'?'来源未明确':channels[row.source]||row.source;researchRow(sources,name,row.status==='not_observed'?'暂无可归因发现记录；不是 0% 成功率。':`商品线索 ${count(row.candidate_products)} · 当前保留 ${researchRatio(row.retained_rate)}`);}
 if(!data.calibration?.length)tests.append(el('p','empty-inline','无可比的已确认测试轮次；情景估算、草稿和零订单不能当作已实现表现。'));
 for(const row of data.calibration||[])researchRow(tests,`${row.product_name||'商品'} · 轮次 ${row.run_id}`,`确认记录 ${count(row.confirmed_records)} · 实际 CPA ${row.actual_cpa??'未知'} / 原定目标 ${row.target_cpa??'未知'} · 原评分 ${row.score_total??'未知'} · ${row.comparison==='above_target'?'高于目标':row.comparison==='at_or_below_target'?'达到或低于目标':'请按原目标核对比较口径'}；这不是产品成功结论。`);
 for(const prompt of data.review_prompts||[])tests.append(el('p','notice',prompt.message));
 section.append(tabs,words,sources,tests,scope);select(active);root.append(section);
}
function renderReports(root){for(const p of selectedProject?[selectedProject]:[]){const n=box(p.title,'报告包含证据缺口、评分版本、人工决定和真实测试记录。');n.classList.add('rw-report-delivery');const feedback=el('p','rw-muted');feedback.setAttribute('role','status');let prepared;
 const a=button('下载完整研究报告 ↓',async()=>{
  feedback.textContent='正在准备研究报告…';
  try{if(prepared){prepared.click();feedback.textContent='报告已准备好；未开始下载时可点击保存链接。';return;}
   const blob=await context.api.blob('/projects/'+encodeURIComponent(p.id)+'/report',{signal:context.life.signal});if(!context.life.active)return;
   const owner=context.context?.objectURLs||globalThis.URL,url=owner.createObjectURL(blob);context.life.track(()=>owner.revokeObjectURL(url));
   const download=el('a','','点击保存研究报告');download.href=url;download.download=(p.title||'研究报告').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,100)+'-研究报告.md';n.append(download);prepared=download;download.click();
   feedback.textContent='报告已准备好；未开始下载时可点击保存链接。';
  }catch(error){if(context.life.active)feedback.textContent='报告准备失败，已有研究数据保留。'+error.message;}
 });a.classList.add('primary');n.append(feedback);n.append(a,button('查看研究复盘',()=>showResearchReview(p.id)),el('p','muted',`${p.products.length} 个产品档案 · 更新 ${time(p.updated_at)}`));root.append(n);}if(!state.projects.length)root.append(empty('研究报告会在这里积累','无数据时不生成虚假的成功报告。'));if(state.researchReviewLoading&&state.researchReviewRequestedId===selectedProject?.id)root.append(empty('正在读取研究复盘','这不会启动采集或修改项目。'));else if(state.researchReviewError&&state.researchReviewRequestedId===selectedProject?.id)root.append(empty('研究复盘暂时不可用',state.researchReviewError,button('重试读取',()=>showResearchReview(state.researchReviewRequestedId||state.researchReviewId))));renderResearchReview(root);}

 renderReports(root);const reviewKey=selectedProject?.id+':'+selectedProject?.version;if(context.designDirectForms&&selectedProject&&state.reportAutoReviewKey!==reviewKey)queueMicrotask(()=>{if(context.life.active&&state.reportAutoReviewKey!==reviewKey){state.reportAutoReviewKey=reviewKey;void showResearchReview(selectedProject.id);}});return root;
}
