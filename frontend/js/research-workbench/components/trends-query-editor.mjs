import {el,button} from './elements.mjs';
import {prepareTrendsQuery,trendsQueryBinding,trendsQuerySourceSignature} from '../services/trends-query.mjs';

export function createTrendsQueryEditor(context,selection,product){
 const project=context.state.project,p=product||{id:selection.product_id},binding=trendsQueryBinding(project,p),signature=trendsQuerySourceSignature(project,p);
 const host=el(context,'section','rw-trends-query-editor'),label=el(context,'label','','本次用于核对需求的产品搜索词'),input=el(context,'input');
 input.name='initial_trends_query';input.type='text';input.maxLength=200;input.required=true;input.autocomplete='off';input.setAttribute('aria-label','首次 Trends 查询词');input.value=selection.query||'';label.append(input);
 const status=el(context,'p','rw-muted'),meaning=el(context,'p','rw-trends-query-meaning'),basis=el(context,'p','rw-muted'),quote=el(context,'p','rw-trends-query-quote');
 status.setAttribute('role','status');status.setAttribute('aria-live','polite');meaning.dataset.trendsMeaning='true';
 const alternatives=el(context,'details','rw-trends-query-alternatives'),summary=el(context,'summary','','更换搜索词'),options=el(context,'div','rw-trends-query-options');alternatives.hidden=true;alternatives.append(summary,options);options.hidden=true;
 const tools=el(context,'div','rw-trends-query-tools');let touched=!!input.value,candidates=[],busy=false,locked=false;
 function current(){const latest=context.state.project?.products?.find(item=>item.id===p.id);return context.life.active&&latest&&!latest.merged_into&&trendsQueryBinding(context.state.project,latest)===binding&&trendsQuerySourceSignature(context.state.project,latest)===signature&&(!context.state.product||context.state.product===p.id);}
 function describe(){
  const candidate=candidates.find(c=>c.query===input.value.trim());
  meaning.textContent=candidate?.meaning?'中文释义：'+candidate.meaning:input.value.trim()?'当前查询词未附中文释义，可修改或重新准备。':'';
  basis.textContent=candidate?.basis||(input.value.trim()?'使用你填写的查询词；请确认它描述当前商品。':'');
  quote.textContent=candidate?.source_quote?'商品页原文：'+candidate.source_quote:'';
  quote.hidden=!quote.textContent;
 }
 function choose(candidate){if(locked||!current())return;input.value=candidate.query;selection.query=candidate.query;touched=true;status.textContent='已选择查询词，确认后开始采集。';describe();}
 function drawOptions(){
  options.replaceChildren();alternatives.hidden=candidates.length<2;options.hidden=true;summary.textContent=candidates.length>1?'更换搜索词':'重新准备查询词';
  context.life.listen(alternatives,'toggle',()=>{options.hidden=!alternatives.open;});
  candidates.forEach(candidate=>options.append(button(context,candidate.query+(candidate.meaning?' · '+candidate.meaning:''),()=>choose(candidate))));
 }
 const regenerate=button(context,'重新准备查询词',()=>prepare(true)),supplement=button(context,'补充商品资料',()=>{
  if(locked)return;
  if(context.onEditTrendsProduct)context.onEditTrendsProduct(p.id);
  else context.openProduct?.(project.id,p.id,'identification');
 });
 tools.append(regenerate,supplement);
 async function prepare(refresh=false){
  if(busy||locked||!context.life.active)return;
  busy=true;regenerate.disabled=true;status.textContent='正在根据已核对商品页准备查询词…';
  try{
   const prepared=await prepareTrendsQuery(context,p,{refresh});
   if(!current())return;
   candidates=prepared.candidates;drawOptions();
   const conflict=prepared.reused&&candidates.length>1;
   if(!touched&&!locked&&!conflict){input.value=candidates[0].query;selection.query=input.value;}
   status.textContent=conflict?'已保存的两个时间范围使用了不同词，请在“更换搜索词”中选择本次统一查询词。':touched?'建议已准备好，已保留你填写的查询词。':prepared.reused?'已沿用当前商品此前确认或使用的查询词。':'已推荐产品搜索词，请核对是否描述当前商品。';
   if(conflict)alternatives.open=true;
   describe();
  }catch(error){if(context.life.active){status.textContent=error.message;describe();}}
  finally{busy=false;if(context.life.active)regenerate.disabled=locked;}
 }
 context.life.listen(input,'input',()=>{touched=true;selection.query=input.value;describe();});
 host.append(label,status,meaning,basis,quote,alternatives,tools,
  el(context,'p','rw-muted','确认后使用同一查询词采集近12个月和近5年的趋势。推荐词不代表已验证的热门搜索词；缺少数据不等于没有需求。'),
  el(context,'p','rw-muted','首次准备及重新准备会使用已配置的文本 AI，可能产生费用；已确认的词优先复用。'));
 if(input.value){status.textContent='已保留本次输入，可直接确认或重新准备。';describe();}else void prepare(selection.refresh_query===true);
 return {host,input,isCurrent:current,
  validate(){if(!current())throw Error('商品、市场或来源资料已变化，请关闭后重新核对查询词。');},
  candidate(){const query=input.value.trim(),candidate=candidates.find(c=>c.query===query);return candidate||{query,meaning:'',source_quote:''};},
  setSubmitting(value){locked=value;input.disabled=value;regenerate.disabled=value||busy;supplement.disabled=value;for(const node of options.children)node.disabled=value;}
 };
}
