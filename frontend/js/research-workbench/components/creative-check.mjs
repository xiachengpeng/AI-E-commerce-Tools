import {el,button} from './elements.mjs';
import {creativeEvidence} from '../services/creative-evidence.mjs';
export function creativeCheck(context,product){
 const host=el(context,'section','rw-creative-check');host.dataset.creativeCheck='';host.setAttribute('aria-label','已有广告证据自动检查');
 const body=el(context,'div','rw-creative-check-body');body.setAttribute('aria-live','polite');
 const paint=()=>{
  const report=creativeEvidence(context.state.project,product);body.replaceChildren();
  const metrics=el(context,'div','rw-creative-check-metrics');
  for(const [name,value] of [['实际关联广告',report.rows.filter(row=>row.ad).length+' 条'],['有素材引用',report.rows.filter(row=>row.hasMedia).length+' 条'],['已确认独立活跃创意',report.confirmedCount+' / '+report.requiredCount+' 个']]){const item=el(context,'div');item.append(el(context,'span','',name),el(context,'strong','',value));metrics.append(item);}body.append(metrics);
  const checks=el(context,'ul','rw-creative-check-results');
  const entries=[['广告年龄',report.ageDays===null?'缺少有效的投放日期或近期观察':report.ageDays+' 天 · '+(report.ageDays>=report.requiredDays?'达到':'未达到')+report.requiredDays+' 天标准'],['投放状态',report.activeCount+' 条在最近24小时的采集记录中为活跃；不代表此刻仍投放'],['素材去重',report.duplicateCount?'发现 '+report.duplicateCount+' 条完全相同的素材引用，不能重复计数':'未发现完全相同的素材引用；不同链接仍可能是同一素材'],['独立性复核',report.pendingCount?'有 '+report.pendingCount+' 条素材需对照内容确认是否独立':'没有可直接补充独立性确认的近期素材']];
  for(const [name,text] of entries){const item=el(context,'li');item.append(el(context,'strong','',name),el(context,'span','',text));checks.append(item);}body.append(checks);
  let next=!report.rows.length?'尚未绑定广告素材。先返回搜索词补充广告，再检查。':report.missingMediaCount?'有 '+report.missingMediaCount+' 条记录缺少素材引用，请打开原广告核对或补充采集。':report.missingCount?'距离当前标准还缺 '+report.missingCount+' 个已核验的独立活跃创意；先复核已有素材，不足再补充。':'已有近期证据达到数量要求，请核对并保存本次资料；是否通过以服务端为准。';
  body.append(el(context,'p','rw-creative-check-next','下一步：'+next),el(context,'p','rw-creative-check-note','创意是同一商品的不同广告图片或视频，不是商品数量。以下只展示实际记录；新增加的外部证据需你核对。自动检查不保存、不调用外部接口，也不证明连续投放或盈利。'));
 };
 const header=el(context,'header','rw-creative-check-heading');header.append(el(context,'h2','','已自动检查现有证据'),button(context,'重新检查已有证据',paint));host.append(header,body);paint();return host;
}
