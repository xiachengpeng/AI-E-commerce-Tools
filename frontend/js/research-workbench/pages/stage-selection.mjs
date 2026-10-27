import {el,button,notify} from '../components/elements.mjs';
export const stageTitles={channels:'需求与竞争',economics:'算清利润',decision:'做决定'};
/** Select an identity before opening a product-specific stage; no research command here. */
export function renderStageSelection(context){
 const {state}=context,target=stageTitles[state.stageTarget]?state.stageTarget:'channels',title=stageTitles[target];
 const root=el(context,'section','rw-stage-selection'),heading=el(context,'h1','','选择商品 · '+title);heading.tabIndex=-1;
 root.append(heading,el(context,'p','rw-muted','需求、利润和决定分别归属具体商品，请先选择本次要研究的商品。'));
 const products=(state.project.products||[]).filter(p=>!p.merged_into),card=el(context,'section','rw-panel rw-stage-selection-card');
 if(!products.length){
  card.append(el(context,'h2','','当前项目还没有商品'),el(context,'p','rw-muted','先在“核实商品”中从广告线索选择商品，或添加已有商品链接。'),button(context,'去核实商品',()=>{state.projectSection='leads';context.navigate('project');},'rw-primary'),button(context,'添加已有商品',()=>context.openForm({kind:'add_product'})));
 }else{
  const label=el(context,'label','','要研究的商品'),select=el(context,'select');select.setAttribute('aria-label','选择研究商品');
  const placeholder=el(context,'option','','请选择商品（'+products.length+' 个）');placeholder.value='';select.append(placeholder);
  for(const product of products){const words=(state.project.keywords||[]).filter(w=>(product.source_keyword_ids||[]).includes(w.id));const option=el(context,'option','',(product.name||'未命名商品')+(words[0]?' · 来源词：'+words[0].text:''));option.value=product.id;select.append(option);}
  select.value=products.some(p=>p.id===state.stageProduct)?state.stageProduct:'';label.append(select);
  const summary=el(context,'p','rw-stage-selection-summary'),proceed=button(context,'进入「'+title+'」',()=>{
   const product=state.project.products?.find(p=>p.id===select.value&&!p.merged_into);
   if(!product){notify(context,'该商品已变化，请重新选择。');return;}
   context.openProduct(state.project.id,product.id,target);
  },'rw-primary');proceed.dataset.stageContinue='true';
  const sync=()=>{state.stageProduct=select.value||null;proceed.disabled=!products.some(p=>p.id===select.value);const p=products.find(p=>p.id===select.value);summary.textContent=p?'本次研究：'+p.name+' · '+title:'选择后可查看现有证据或补充资料；不会自动采集、评分或作出决定。';};
  context.life.listen(select,'change',sync);sync();card.append(label,summary,proceed,button(context,'返回核实商品',()=>{state.projectSection='leads';context.navigate('project');}));
 }
 card.append(el(context,'p','rw-muted','进入页面不代表证据已通过；保存和执行仍按原有审核规则进行。'));root.append(card);return root;
}
