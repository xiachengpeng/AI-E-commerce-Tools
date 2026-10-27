import {el,button} from './elements.mjs';
/** Successful persistence and server screening are separate outcomes. */
export function creativeResult(context,product,{onEdit,onBack,onNext,onTriage}){
 const root=el(context,'section','rw-creative-result');root.dataset.creativeSavedResult='';
 const coarse=product?.steps?.find(step=>step.key==='coarse'),passed=coarse?.state==='passed',known=coarse&&['passed','needs_input','failed','blocked','pending'].includes(coarse.state);
 const heading=el(context,'h1','',passed?'已保存，广告粗筛已通过':known?'已保存，广告证据尚未达标':'已保存，筛选状态待核对');heading.tabIndex=-1;
 const status=el(context,'div','rw-creative-saved-status');status.setAttribute('role','status');status.append(heading,el(context,'p','rw-muted',product?.name||'当前商品'),el(context,'p','',coarse?.reason||'资料已保存。请核对服务端最新筛选结果，不需要重复保存。'));root.append(status);
 if(!passed){
  const identity=product?.identification||{},rules=context.state.project.rules||{},days=identity.ad_age_days??identity.active_days,count=identity.distinct_active_creatives;
  const gaps=el(context,'ul','rw-creative-saved-gaps');
  const minDays=rules.min_active_days??30,minCount=rules.min_creatives??3;
  if(typeof days!=='number'||!Number.isFinite(days))gaps.append(el(context,'li','','广告年龄尚无可确认记录，需要补充投放日期依据。'));
  else if(days<minDays)gaps.append(el(context,'li','',`已保存广告年龄 ${days} 天，距离 ${minDays} 天标准还差 ${minDays-days} 天；不能靠重复保存补足。`));
  if(identity.currently_active!==true)gaps.append(el(context,'li','','需要补充当前仍在投放的证据。'));
  if(!Number.isInteger(count)||count<minCount)gaps.append(el(context,'li','',`已保存独立活跃创意 ${Number.isInteger(count)?count:'未知'} 个，当前标准为 ${minCount} 个；补充真实素材并核实，不能重复计算同一素材。`));
  if(gaps.children.length)root.append(gaps);
 }
 const controls=el(context,'div','rw-creative-result-actions');
 controls.append(button(context,passed?'修改已保存广告证据':'继续补充广告证据',onEdit,passed?'':'rw-primary'),button(context,'返回搜索词找更多广告',onBack));
 if(passed)controls.append(button(context,'继续核对需求与竞争',onNext,'rw-primary'));
 if(!passed&&onTriage)controls.append(button(context,'暂存观察',()=>onTriage('observing')),button(context,'不再研究这条线索',()=>onTriage('rejected'),'rw-danger'));
 root.append(el(context,'p','rw-notice',passed?'本次通过的是广告年龄、当前状态与创意数量筛选；连续投放是否得到验证仍需查看独立证据。':'证据不足可以暂存观察，明显不合适可以淘汰并保留原因，不需要先补完所有表单。'));
 root.append(controls,el(context,'p','rw-creative-result-note','保存成功不等于筛选通过。未达到标准的观察仍会保留；没有重新采集、调用 AI 或重复提交。'));
 return root;
}
