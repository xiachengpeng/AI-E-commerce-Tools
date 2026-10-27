import {el,button} from './elements.mjs';
import {createActionLogs} from './live-logs.mjs';

/** Read saved observations; enqueue only after the user's explicit confirmation. */
export function productPageStatus(context,product,{showFacts=true}={}){
 const action=context.state.productActions?.[product.id],snapshot=product.landing_snapshot;
 const active=['ready','queued','running'].includes(action?.status),failed=['blocked','failed','stopped'].includes(action?.status);
 const uncertain=action?.recovery_action==='manual'||['unknown','manual_check'].includes(action?.display_status);
 const images=snapshot?.images||[],host=el(context,'section','rw-product-page-status');host.dataset.productPageStatus='true';host.setAttribute('role','status');host.setAttribute('aria-live','polite');
 const heading=el(context,'div','rw-product-page-heading'),body=el(context,'div'),controls=el(context,'div','rw-product-page-actions');
 let title,note;
 if(active){title=action.status==='running'?'正在读取商品页':'商品图与信息已排队';note='完成后将显示商品页保存的图片与信息。广告素材可继续查看，不会自动调用 AI 核对。';}
 else if(failed){title=uncertain?'商品页读取结果需核对':'商品页读取未完成';note=action.diagnostic||action.message||'请查看任务日志，核对商品链接或更换读取方式。';}
 else if(snapshot){title=images.length?'已读取商品图与信息':'商品页已读取，未提取到商品图';note=snapshot.page_type==='category'?'来源是分类页，需定位具体商品链接后再核实。':images.length?'图片来自商品页，仍需核对是否为广告中的具体商品。':'该页面没有提供可识别的商品图片，可能需要网页渲染或访问验证；请打开来源核对。';}
 else{title='尚未读取商品图与信息';note='广告采集与商品页读取是两项来源；新搜索后会自动排队本地补读，每词最多20个。已有线索可直接读取。';}
 body.append(el(context,'strong','',title),el(context,'p','rw-muted',note));heading.append(body);host.append(heading);
 if(showFacts&&snapshot?.title)host.append(el(context,'p','rw-product-page-title',snapshot.title));
 if(showFacts&&['string','number'].includes(typeof snapshot?.price))host.append(el(context,'p','rw-muted','页面价格：'+snapshot.price+' · 尚未人工确认'));
 if(snapshot&&(active||failed))host.append(el(context,'p','rw-muted','当前仍展示上次保存的商品资料，不代表本次读取成功。'));
 if(!active&&product.url&&!uncertain&&(!snapshot||!images.length||failed)){
  context.state.landingModes||={};const label=el(context,'label','','读取方式'),select=el(context,'select');select.setAttribute('aria-label','当前商品页读取方式');
  for(const [value,text] of [['local','本地读取（不调用付费接口）'],['firecrawl','Firecrawl（消耗额度）']]){const option=el(context,'option','',text);option.value=value;select.append(option);}
  select.value=context.state.landingModes[product.id]||action?.landing_mode||'local';context.life.listen(select,'change',()=>{context.state.landingModes[product.id]=select.value;});label.append(select);
  controls.append(label,button(context,failed||snapshot?'重新读取商品页':'读取商品图与信息',()=>context.showQueue({kind:'landing',product_id:product.id,landing_mode:select.value}),'rw-primary'));
 }
 if(action){
  const key=context.state.project.id+':'+product.id+':'+action.id+':'+action.attempt;
  let logs,opened=context.state.openProductPageLog===key;
  const toggle=button(context,opened?'收起商品页日志':'查看商品页日志',()=>{opened=!opened;context.state.openProductPageLog=opened?key:null;paintLogs();});toggle.setAttribute('aria-expanded',String(opened));
  const paintLogs=()=>{toggle.textContent=opened?'收起商品页日志':'查看商品页日志';toggle.setAttribute('aria-expanded',String(opened));if(!opened){logs?.closeActionLogs();return;}
   if(!logs){logs=createActionLogs(context,{autoScroll:false,showClose:false,friendlyStages:true,friendlyTimes:true,attempt:action.attempt,title:'商品页读取日志',note:'仅显示当前商品本次读取的执行记录。'});host.append(logs.host);}
   void logs.openActionLogs(action.id);
  };
  controls.append(toggle);if(opened)queueMicrotask(()=>{if(context.life.active)paintLogs();});
 }
 if(!product.url)host.append(el(context,'p','rw-notice','缺少商品链接，请先补充具体商品来源。'));
 if(controls.children.length)host.append(controls);return host;
}
