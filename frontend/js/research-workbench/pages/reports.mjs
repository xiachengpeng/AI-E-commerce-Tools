import { el as nativeEl, button as nativeButton, panel, typeNames } from '../components/elements.mjs';
const channels={meta:'Meta 广告',trends:'Google Trends',pinterest:'Pinterest',tiktok:'TikTok',amazon:'Amazon',similarweb:'Similarweb'};
export function renderReport(context) {
 const state=context.state,root=nativeEl(context,'section','rw-reports');
 const el=(tag,cls='',content)=>nativeEl(context,tag,cls,content),button=(label,fn,cls='')=>nativeButton(context,label,fn,cls),box=(title,note)=>panel(context,title,note),empty=(title,note,btn)=>{const node=box(title,note);if(btn)node.append(btn);return node;};
 const time=v=>v?new Date(v).toLocaleString('zh-CN'):'未记录';
 const api=path=>context.api.request(path,{signal:context.life.signal});
 const heading=el('h1','','结论与复盘');heading.tabIndex=-1;root.append(heading);
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
function renderResearchReview(root){const data=state.researchReview;if(!data)return;const p=state.projects.find(item=>item.id===state.researchReviewId),section=box('研究复盘 · '+(p?.title||'项目'),'以下是已保存事实的描述性统计，不是测试成功率排名；同一商品跨词关联数不可相加。');section.dataset.researchReview='true';section.append(el('p','muted',`累计窗口：${time(data.window?.start)} → ${time(data.window?.end)} · 活动卖家档案 ${data.unique_active_products??0} 个 · 已确认同款分组 ${data.confirmed_concept_groups??0} 组`),el('p','muted',data.association_note||''));const words=el('div','research-section');words.append(el('h3','','关键词表现'));if(!data.keywords?.length)words.append(el('p','empty-inline','尚无关键词，样本不足，不能判断哪类词更好。'));for(const word of data.keywords||[]){researchRow(words,word.text,`类型：${typeNames[word.type]||word.type||'未记录'} · 扫描尝试：${word.scan_attempts===null?'旧记录不可还原':word.scan_attempts} · 完成：${word.scan_completed===null?'未知':word.scan_completed} · 去重广告：${word.ads_found} · 关联商品：${word.associated_products}（首次 ${word.primary_products} / 辅助 ${word.assisting_products}） · 当前保留：${researchRatio(word.retained_rate)} · 当前测试池：${researchRatio(word.test_pool_rate)}`);}section.append(words);const types=el('div','research-section');types.append(el('h3','','关键词类型'));if(!data.keyword_types?.length)types.append(el('p','empty-inline','尚无明确类型，样本不足。'));for(const row of data.keyword_types||[])researchRow(types,typeNames[row.type]||row.type,`${row.keywords} 个词 · 关联商品 ${row.associated_products} · 当前保留 ${researchRatio(row.retained_rate)} · 当前测试池 ${researchRatio(row.test_pool_rate)}`);section.append(types);const sources=el('div','research-section');sources.append(el('h3','','发现来源'));for(const row of data.discovery_sources||[]){const name=row.source==='unattributed'?'来源未明确':channels[row.source]||row.source;researchRow(sources,name,row.status==='not_observed'?'暂无可归因发现记录；不是 0% 成功率。':`商品线索 ${row.candidate_products} · 当前保留 ${researchRatio(row.retained_rate)}`);}section.append(sources);const tests=el('div','research-section');tests.append(el('h3','','已确认测试与原定目标'));if(!data.calibration?.length)tests.append(el('p','empty-inline','无可比的已确认测试轮次；情景估算、草稿和零订单不能当作已实现表现。'));for(const row of data.calibration||[])researchRow(tests,`${row.product_name||'商品'} · 轮次 ${row.run_id}`,`确认记录 ${row.confirmed_records} · 实际 CPA ${row.actual_cpa} / 原定目标 ${row.target_cpa} · 原评分 ${row.score_total} · ${row.comparison==='above_target'?'高于目标':'达到或低于目标'}；这不是产品成功结论。`);for(const prompt of data.review_prompts||[])tests.append(el('p','notice',prompt.message));section.append(tests);root.append(section);}
function renderReports(root){for(const p of state.projects){const n=box(p.title,'报告包含证据缺口、评分版本、人工决定和真实测试记录。');const a=button('下载完整研究报告 ↓',async()=>{const blob=await context.api.blob('/projects/'+encodeURIComponent(p.id)+'/report',{signal:context.life.signal});if(!context.life.active)return;const owner=context.context.objectURLs||globalThis.URL,url=owner.createObjectURL(blob);context.life.track(()=>owner.revokeObjectURL(url));const download=el('a','','保存研究报告');download.href=url;download.download='research-report.md';n.append(download);download.click();});n.append(button('查看研究复盘',()=>showResearchReview(p.id),state.researchReviewId===p.id?'primary':''),a,el('p','muted',`${p.products.length} 个产品档案 · 更新 ${time(p.updated_at)}`));root.append(n);}if(!state.projects.length)root.append(empty('研究报告会在这里积累','无数据时不生成虚假的成功报告。'));if(state.researchReviewLoading)root.append(empty('正在读取研究复盘','这不会启动采集或修改项目。'));else if(state.researchReviewError)root.append(empty('研究复盘暂时不可用',state.researchReviewError,button('重试读取',()=>showResearchReview(state.researchReviewRequestedId||state.researchReviewId))));renderResearchReview(root);}

 renderReports(root);return root;
}
