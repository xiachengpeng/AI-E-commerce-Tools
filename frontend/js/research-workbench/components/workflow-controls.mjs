import {el,button} from './elements.mjs';
import {stepStatusLabel} from '../services/journey.mjs';

const sections=[
 ['identification','coarse'],['channels','funnel'],['economics','score'],['decision','test','review']
];
const titles={identification:'核对商品与广告',coarse:'核实广告证据',channels:'需求与竞争',funnel:'广告与商品页分析',economics:'订单利润与风险',score:'检查证据与评分',decision:'记录决定',test:'测试计划与结果',review:'复盘'};
/** Visible tasks stay outside the direct editor and its folded legacy overview. */
export function renderWorkflowControls(context){
 const {state}=context,product=state.project?.products?.find(p=>p.id===state.product&&!p.merged_into);
 if(!product)return null;
 const group=sections.find(keys=>keys.includes(state.step));if(!group)return null;
 const host=el(context,'section','rw-workflow-controls'),nav=el(context,'nav','rw-workflow-tasks');nav.setAttribute('aria-label','当前阶段的任务');
 for(const key of group){const step=product.steps?.find(s=>s.key===key)||{key,state:'pending'};
  const b=button(context,'',()=>context.openProduct(state.project.id,product.id,key),'rw-workflow-task');b.dataset.workflowStep=key;b.setAttribute('aria-current',key===state.step?'step':'false');
  b.append(el(context,'strong','',titles[key]),el(context,'span','rw-muted',stepStatusLabel(step,product)));nav.append(b);
 }
 host.append(nav);
 const actions=el(context,'div','rw-workflow-shortcuts');
 if(['identification','coarse'].includes(state.step)){
  actions.append(el(context,'p','rw-muted','先判断是否值得继续。保留不等于通过筛选；证据不足可以先观察。'));
  for(const [value,title] of [['retained','保留并深挖'],['observing','暂存观察'],['rejected','淘汰这条线索']])if(value!==product.triage?.state)actions.append(button(context,title,()=>context.openTriage?.(product.id,value),value==='rejected'?'rw-danger':''));
 }else{
  const next={channels:'funnel',funnel:'economics',economics:'score',score:'decision',decision:'review',test:'review'}[state.step];
  if(next)actions.append(button(context,({funnel:'下一步：分析广告与商品页',economics:'下一步：核算订单利润',score:'下一步：检查证据与评分',decision:'下一步：记录决定',review:'查看复盘'})[next],()=>context.openProduct(state.project.id,product.id,next)));
 }
 host.append(actions);return host;
}
