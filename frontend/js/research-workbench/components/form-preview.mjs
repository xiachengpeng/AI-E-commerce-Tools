/** Non-persisted arithmetic previews only. Server validation remains authoritative. */
export function formPreview(title,values){
 const number=key=>values[key]!==''&&values[key]!=null&&Number.isFinite(Number(values[key]))&&Number(values[key])>=0?Number(values[key]):null;
 if(/测试结果/.test(title)){
  const spend=number('spend'),impressions=number('impressions'),clicks=number('clicks'),orders=number('orders'),revenue=number('revenue');
  const ratio=(a,b,format)=>a!==null&&b>0?format(a/b):'未知';
  return {title:'结果预览',complete:false,note:'草稿预览，不代表已确认结果或盈利。',missing:[],rows:[['CTR',ratio(clicks,impressions,n=>(n*100).toFixed(2)+'%')],['CPA',ratio(spend,orders,n=>'USD '+n.toFixed(2))],['ROAS',ratio(revenue,spend,n=>n.toFixed(2))]]};
 }
 if(/核算|订单测算/.test(title)){
  const costs={goods_cost:'货值',shipping:'运费',packaging:'包装费',tax:'税费',ad_cost:'广告成本',payment_percent:'支付费率',payment_fixed:'支付固定费',reserve_percent:'退款准备金'},missing=Object.keys(costs).filter(k=>number(k)===null).map(k=>costs[k]);
  const aov=number('aov');if(aov===null)missing.unshift('实际客单价');
  let known=0;for(const key of ['goods_cost','shipping','packaging','tax','ad_cost','payment_fixed'])known+=number(key)??0;
  for(const key of ['payment_percent','reserve_percent'])if(aov!==null&&number(key)!==null)known+=aov*number(key)/100;
  const complete=!missing.length;
  return {title:complete?'订单费用预览':'暂不能计算完整贡献利润',complete,missing,note:'仅为输入预览；报价、风险与认证仍需核实，保存后以系统评估为准。',rows:[['已填写成本合计','USD '+known.toFixed(2)],...(complete&&aov>0?[['贡献利润预览','USD '+(aov-known).toFixed(2)],['贡献率预览',((aov-known)/aov*100).toFixed(2)+'%']]:[])]};
 }
 if(/测试计划/.test(title))return {title:'计划预览',complete:false,missing:[],note:'保存计划不会创建广告或自动花费预算。',rows:[['计划总预算',number('budget')===null?'未填写':'USD '+number('budget')],['观察天数',number('days')===null?'未填写':number('days')+' 天'],['目标 CPA',number('success_cpa')===null?'未填写':'USD '+number('success_cpa')],['停止线',number('stop_loss')===null?'未填写':'USD '+number('stop_loss')]]};
 return null;
}
