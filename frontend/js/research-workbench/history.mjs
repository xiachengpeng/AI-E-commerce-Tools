import { el, button, panel, notify } from './components/elements.mjs';
export const historyKinds=Object.freeze({activity:'研究活动',report:'已保存研究报告',import:'营销档案导入'});
export async function loadResearchHistory(context,{kind='activity',cursor=null,projectId=context.state.project?.id||null}={}) {
 if(!Object.hasOwn(historyKinds,kind))throw Error('研究历史类型无效');
 const query=new URLSearchParams({kind});if(projectId)query.set('project_id',projectId);if(cursor)query.set('cursor',cursor);
 return context.api.request('/history?'+query,{signal:context.life.signal});
}
export function renderHistory(context) {
 const host=el(context,'section','rw-history'),heading=el(context,'h1','','研究历史');heading.tabIndex=-1;host.append(heading,el(context,'p','rw-muted','持久审计只读；营销模块原历史与恢复入口保持。'));
 const tabs=el(context,'nav','rw-toolbar'),body=el(context,'div'),more=el(context,'div');host.append(tabs,body,more);
 let generation=0,kind=context.state.historyKind||'activity',cursor=null,rows=[];
 async function load(append=false){const id=++generation;try{
  const data=await loadResearchHistory(context,{kind,cursor:append?cursor:null});if(!context.life.active||generation!==id)return;
  rows=append?[...rows,...data.items]:data.items;cursor=data.next_cursor||null;body.replaceChildren();more.replaceChildren();
  if(!rows.length)body.append(el(context,'p','rw-muted',kind==='report'?'尚无成功保存的报告；实时下载不计入已保存报告。':'尚无此类历史记录。'));
  for(const row of rows){const card=panel(context,historyKinds[kind],(row.created_at||'未记录时间')+' · '+(row.action||row.status||''));
   if(row.project_id)card.append(button(context,'打开研究项目',()=>context.openProject(row.project_id)));
   if(row.product_id)card.append(button(context,'打开商品档案',()=>context.openHistoryProduct(row.project_id,row.product_id)));
   if(kind==='report')card.append(button(context,'查看研究报告',()=>context.navigate('reports')));
   for(const artifact of row.artifacts||[])card.append(el(context,'p','rw-muted','营销产物：'+artifact.module+' #'+artifact.history_id+' · '+(artifact.created_at||artifact.history_timestamp||artifact.timestamp||'旧记录未保存时间')));
   body.append(card);
  }if(cursor)more.append(button(context,'加载更多',()=>load(true)));
 }catch(error){if(context.life.active&&generation===id)notify(context,error.message+'。已有历史保留。');}}
 for(const [value,label] of Object.entries(historyKinds))tabs.append(button(context,label,()=>{kind=value;context.state.historyKind=kind;return load();}));void load();return host;
}
