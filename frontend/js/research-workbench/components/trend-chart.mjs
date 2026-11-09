import {el,button,link} from './elements.mjs';
import {createActionLogs} from './live-logs.mjs';

/** Task feedback describes execution only; it never confirms or replaces research evidence. */
export function currentTrendsTask(state,product){
 const tracked=state.lastResearchAction,receipt=tracked&&tracked.projectId===state.project?.id&&tracked.kind==='trends'&&tracked.productId===product.id?tracked:null;
 const tasks=(state.actions||[]).filter(a=>a.kind==='trends'&&a.product_id===product.id);
 if(receipt)return tasks.find(a=>a.id===receipt.id)||{id:receipt.id,kind:'trends',product_id:product.id,status:'unknown',awaitingRefresh:true};
 return [...tasks].sort((a,b)=>(Date.parse(b.updated_at||b.created_at)||0)-(Date.parse(a.updated_at||a.created_at)||0))[0]||null;
}
export const trendsTaskBusy=task=>!!task&&(task.awaitingRefresh||['queued','ready','running'].includes(task.status)||['manual_check','unknown'].includes(task.display_status)||task.recovery_action==='manual');

function taskFeedback(context,product){
 const task=currentTrendsTask(context.state,product);if(!task)return null;
 const host=el(context,'section','rw-trends-task-feedback'),status=el(context,'strong'),note=el(context,'p','rw-muted'),tools=el(context,'div','rw-trends-task-tools');
 host.dataset.state=task.status;host.setAttribute('role','status');host.setAttribute('aria-live','polite');status.dataset.trendsTaskStatus='true';
 const uncertain=['manual_check','unknown'].includes(task.display_status)||task.recovery_action==='manual';
 status.textContent=uncertain?'提交结果待人工核对':task.awaitingRefresh?'请求已提交，正在核对最新任务状态':({ready:'已提交，排队等待采集',queued:'已提交，排队等待采集',running:'正在采集 Google Trends…',complete:'采集任务已完成',blocked:'本次采集未完成',failed:'本次采集未完成',stopped:'本次采集已停止',cancelled:'本次采集已取消'})[task.status]||'任务状态待核对';
 note.textContent=uncertain?'请先查看任务详情与执行日志，核对原请求，不要重复提交。':task.awaitingRefresh?'任务回执已保存；正在读取执行状态，请勿重复提交。':task.message||(task.status==='complete'?'已保存数据会显示在对应时间范围；自动采集不代表人工确认。':['blocked','failed'].includes(task.status)?'未取得可确认的新结果；已有证据保留，缺少数据不代表没有需求。':'结果保存后会自动刷新；已有趋势资料继续保留，请勿重复提交。');
 host.append(status,note);
 const logs=createActionLogs(context,{title:'Google Trends 采集日志',friendlyStages:true,friendlyTimes:true});
 tools.append(button(context,'查看执行日志',()=>{void logs.openActionLogs(task.id);}),button(context,'查看任务详情',()=>{context.state.selectedResearchAction=task.id;context.state.researchTaskFilter='all';context.showQueue?.();}));
 host.append(tools,logs.host);return host;
}
/** Display only saved points belonging to this market and physical product identity. */
export function currentTrendSeries(project,product,window='12m'){
 const rows=(product.automatic_trends||[]).filter(row=>row.market===project.market&&row.window===window&&!row.stale_identity&&row.identity_revision===(product.identity_revision||1)&&Array.isArray(row.points)&&row.points.length>=2&&row.points.every(p=>typeof p.value==='number'&&Number.isFinite(p.value)&&p.value>=0&&typeof p.week==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.week)&&Number.isFinite(Date.parse(p.week))));
 return [...rows].sort((a,b)=>(Date.parse(b.observed_at)||0)-(Date.parse(a.observed_at)||0))[0]||null;
}
/** Paginate a display copy; saved points and the chart retain their original order. */
function weeklyDetails(context,series){
 const host=el(context,'details','rw-trend-table'),summary=el(context,'summary'),count=series.points.length,pageSize=10,points=[...series.points].sort((a,b)=>b.week.localeCompare(a.week));
 summary.append(el(context,'span','rw-trend-week-title','查看周度数据'),el(context,'span','rw-trend-week-count',count+' 周'));
 const note=el(context,'p','rw-trend-week-note','每页 10 周，日期从新到旧；热度为相对指数，不代表销量。'),grid=el(context,'table','rw-trend-weekly-grid'),head=el(context,'thead'),headRow=el(context,'tr'),body=el(context,'tbody');
 grid.setAttribute('aria-label','Google Trends 周度热度明细');
 for(const title of ['周起始日期','相对热度']){const cell=el(context,'th','',title);cell.setAttribute('scope','col');headRow.append(cell);}head.append(headRow);grid.append(head,body);
 const footer=el(context,'div','rw-trend-week-footer'),range=el(context,'span','rw-trend-week-range'),tools=el(context,'nav','rw-trend-week-pages'),position=el(context,'span','rw-trend-week-position'),newer=el(context,'button','','上一页'),older=el(context,'button','','下一页');
 range.dataset.trendWeekPage='true';range.setAttribute('role','status');range.setAttribute('aria-live','polite');tools.setAttribute('aria-label','周度数据分页');
 newer.type=older.type='button';newer.setAttribute('aria-label','上一页周度数据');older.setAttribute('aria-label','下一页周度数据');tools.append(newer,position,older);footer.append(range,tools);
 let page=0;const lastPage=Math.ceil(count/pageSize)-1,max=Math.max(100,...points.map(p=>p.value));
 function paint(){
  body.replaceChildren();const start=page*pageSize;
  for(const point of points.slice(start,start+pageSize)){
   const row=el(context,'tr'),date=el(context,'th','',point.week),cell=el(context,'td'),value=el(context,'span','rw-trend-week-value'),number=el(context,'span','rw-trend-week-number',point.value),bar=el(context,'span','rw-trend-week-bar'),fill=el(context,'i');
   row.dataset.trendWeek=point.week;date.setAttribute('scope','row');bar.setAttribute('aria-hidden','true');fill.setAttribute('style','width:'+(point.value/max*100)+'%');bar.append(fill);value.append(bar,number);cell.append(value);row.append(date,cell);body.append(row);
  }
  range.textContent=`第 ${start+1}–${Math.min(start+pageSize,count)} 条，共 ${count} 周`;position.textContent=`${page+1} / ${lastPage+1}`;newer.disabled=page===0;older.disabled=page===lastPage;
 }
 // Local navigation owns its boundary state; the asynchronous action-button helper would re-enable it.
 context.life.listen(newer,'click',()=>{if(context.life.active&&page>0){page--;paint();}});
 context.life.listen(older,'click',()=>{if(context.life.active&&page<lastPage){page++;paint();}});
 host.append(summary,note,grid,footer);paint();return host;
}
export function renderTrendChart(context,product){
 const host=el(context,'section','rw-trend-chart'),tabs=el(context,'nav','rw-trend-tabs'),body=el(context,'div','rw-trend-plot');tabs.setAttribute('aria-label','趋势时间范围');tabs.setAttribute('role','tablist');
 const scope=el(context,'div','rw-trend-scope'),query=el(context,'output'),market=el(context,'output');query.dataset.trendQuery='true';const queryLabel=el(context,'label','','关键词'),marketLabel=el(context,'label','','地区');queryLabel.append(query);marketLabel.append(market);scope.append(queryLabel,marketLabel);scope.hidden=!context.designDirectForms;market.textContent=({US:'美国',CA:'加拿大',GB:'英国',AU:'澳大利亚'})[context.state.project.market]||context.state.project.market||'市场未记录';
 let window='12m',disposePlot=()=>{};const controls=[];
 function render(){
  disposePlot();disposePlot=()=>{};body.replaceChildren();controls.forEach(([value,node])=>node.setAttribute('aria-selected',String(window===value)));
  const series=currentTrendSeries(context.state.project,product,window);query.textContent=series?.query||'尚未保存此范围的数据';
  if(!series){const empty=el(context,'div','rw-trend-empty');empty.append(el(context,'i','ph ph-chart-line'),el(context,'strong','','尚无可绘制的真实趋势序列'),el(context,'p','rw-muted','导入或采集当前市场、当前商品的周度数据后显示。缺失数据不代表没有需求。'));body.append(empty);return;}
  const canvas=el(context,'canvas'),caption=el(context,'p','rw-muted',series.query+' · '+series.market+' · '+(window==='12m'?'过去12个月':'过去5年'));canvas.setAttribute('role','img');canvas.setAttribute('aria-label',caption.textContent+'；保存的周度热度折线，不代表销量');body.append(caption,canvas);
  body.append(el(context,'p','rw-muted','观察时间：'+(series.observed_at||'未记录')+' · '+(series.confirmed?'已人工确认':'自动采集，待人工核实')),link(context,'查看数据来源',series.source_url),weeklyDetails(context,series));
  const draw=()=>{if(!context.life.active||!canvas.getContext)return;const ctx=canvas.getContext('2d');if(!ctx)return;const width=Math.max(240,body.clientWidth||600),height=270,ratio=context.root.ownerDocument.defaultView?.devicePixelRatio||1;canvas.width=width*ratio;canvas.height=height*ratio;canvas.style.width='100%';canvas.style.height=height+'px';ctx.scale(ratio,ratio);const margin={x:38,y:20},w=width-54,h=height-48,max=Math.max(100,...series.points.map(p=>p.value)),xy=(p,i)=>[margin.x+i/(series.points.length-1)*w,margin.y+h-p.value/max*h];ctx.font='11px sans-serif';ctx.lineWidth=1;ctx.strokeStyle='#e4ebf5';ctx.fillStyle='#8290a7';for(let n=0;n<=4;n++){const y=margin.y+n*h/4;ctx.beginPath();ctx.moveTo(margin.x,y);ctx.lineTo(margin.x+w,y);ctx.stroke();ctx.fillText(Math.round(max*(1-n/4)),3,y+4);}ctx.beginPath();series.points.forEach((p,i)=>{const [x,y]=xy(p,i);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.lineTo(margin.x+w,margin.y+h);ctx.lineTo(margin.x,margin.y+h);ctx.closePath();ctx.fillStyle='#eff6ff';ctx.fill();ctx.beginPath();series.points.forEach((p,i)=>{const [x,y]=xy(p,i);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.strokeStyle='#428dff';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#8290a7';ctx.fillText(series.points[0].week,margin.x,height-6);ctx.fillText(series.points.at(-1).week,Math.max(margin.x,width-90),height-6);};
  const Observer=context.root.ownerDocument.defaultView?.ResizeObserver;if(Observer){const observer=new Observer(draw);observer.observe(body);disposePlot=()=>observer.disconnect();}queueMicrotask(draw);
 }
 for(const [value,label] of [['12m','过去12个月'],['5y','过去5年']]){const b=button(context,label,()=>{window=value;render();});b.setAttribute('role','tab');controls.push([value,b]);tabs.append(b);}const feedback=taskFeedback(context,product);if(feedback)host.append(feedback);host.append(scope,tabs,body);render();context.life.track(()=>disposePlot());return host;
}
