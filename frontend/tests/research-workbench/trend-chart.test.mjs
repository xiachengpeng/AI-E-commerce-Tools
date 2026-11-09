import test from 'node:test';
import assert from 'node:assert/strict';
import {currentTrendSeries} from '../../js/research-workbench/components/trend-chart.mjs';
import {renderTrendChart} from '../../js/research-workbench/components/trend-chart.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
const row={market:'US',window:'12m',identity_revision:2,query:'tool',observed_at:'2026-10-19T00:00:00Z',points:[{week:'2026-10-01',value:0},{week:'2026-10-08',value:30}]};
test('trend chart uses the latest exact market/window/current identity series and retains explicit zeros',()=>{
 const p={identity_revision:2,automatic_trends:[{...row,market:'CA'},{...row,identity_revision:1},{...row,window:'5y'},row]};
 assert.deepEqual(currentTrendSeries({market:'US'},p,'12m').points,row.points);assert.equal(currentTrendSeries({market:'DE'},p,'12m'),null);
 assert.equal(currentTrendSeries({market:'US'},{...p,automatic_trends:[{...row,stale_identity:true}]},'12m'),null);
});
test('missing, malformed or nonfinite trend points never become a synthetic line',()=>{
 for(const points of [[],[{week:'bad',value:1},{week:'2026-10-08',value:2}],[{week:'2026-10-01',value:null},{week:'2026-10-08',value:2}],[{week:'2026-10-01',value:Infinity},{week:'2026-10-08',value:2}]])assert.equal(currentTrendSeries({market:'US'},{identity_revision:2,automatic_trends:[{...row,points}]},'12m'),null);
 assert.equal(currentTrendSeries({market:'US'},{},'12m'),null);
});

test('trend scope displays only the selected saved query and keeps missing windows explicit',async()=>{
 const {renderTrendChart}=await import('../../js/research-workbench/components/trend-chart.mjs');const {fixtureRoot}=await import('./dom-fixture.mjs');const {createLifecycle}=await import('../../js/research-workbench/lifecycle.mjs');const root=fixtureRoot(),life=createLifecycle();const host=renderTrendChart({root,life,designDirectForms:true,state:{project:{market:'US'}}},{identity_revision:2,automatic_trends:[row]});
 try{assert.equal(host.find(n=>n.dataset.trendQuery==='true').textContent,'tool');host.find(n=>n.tagName==='BUTTON'&&n.textContent==='过去5年').click();assert.equal(host.find(n=>n.dataset.trendQuery==='true').textContent,'尚未保存此范围的数据');}finally{life.dispose();}
});

function taskFixture(actions=[]){
 const root=fixtureRoot(),life=createLifecycle(),calls=[],product={id:'x',identity_revision:2};
 const context={root,life,state:{project:{id:'p',market:'US'},actions},showQueue:selection=>calls.push(selection),api:{request:async(path,options)=>{calls.push({path,options});return {logs:[]};},stream:async()=>{throw Error('no stream');}}};
 return {context,product,calls};
}

test('acknowledged Trends request shows visible progress before its task record is refreshed',t=>{
 const {context:c,product:p,calls}=taskFixture();t.after(()=>c.life.dispose());
 c.state.lastResearchAction={id:'new',projectId:'p',kind:'trends',productId:'x'};
 const host=renderTrendChart(c,p),status=host.find(n=>n.dataset.trendsTaskStatus==='true');
 assert.ok(status,'progress belongs beside the Trends chart');assert.match(status.textContent,/已提交/);
 assert.equal(calls.length,0,'rendering feedback never submits or retries a collection');
});

for(const [state,expected] of [['ready',/排队/],['running',/采集.*中|正在采集/],['blocked',/采集未完成/],['complete',/任务已完成/]])test('Trends chart displays the '+state+' task instead of unexplained empty results',t=>{
 const task={id:'task',kind:'trends',product_id:'x',status:state,message:state==='blocked'?'来源读取未完成，请核对。':''};
 const {context:c,product:p,calls}=taskFixture([task]);t.after(()=>c.life.dispose());
 const host=renderTrendChart(c,p),status=host.find(n=>n.dataset.trendsTaskStatus==='true');assert.ok(status);assert.match(status.textContent,expected);
 if(state==='blocked')assert.ok(host.find(n=>n.textContent==='来源读取未完成，请核对。'));
 host.find(n=>n.tagName==='BUTTON'&&n.textContent==='查看任务详情').click();
 assert.equal(c.state.selectedResearchAction,'task');assert.equal(c.state.researchTaskFilter,'all');assert.deepEqual(calls,[undefined]);
});

test('Trends task feedback ignores other products and keeps saved chart data after a new failure',t=>{
 const {context:c,product:p}=taskFixture([{id:'other',kind:'trends',product_id:'y',status:'running'}]);t.after(()=>c.life.dispose());
 assert.equal(renderTrendChart(c,p).find(n=>n.dataset.trendsTaskStatus==='true'),null);
 c.state.actions.push({id:'failed',kind:'trends',product_id:'x',status:'blocked',updated_at:'2026-11-01T00:00:00Z'});p.automatic_trends=[row];
 const host=renderTrendChart(c,p);assert.match(host.find(n=>n.dataset.trendsTaskStatus==='true').textContent,/采集未完成/);
 assert.ok(host.find(n=>n.tagName==='CANVAS'),'failed refresh does not erase saved evidence');
});

const descendants=node=>[node,...(node.children||[]).flatMap(descendants)];
const weeklyRows=host=>descendants(host).filter(node=>node.tagName==='TR'&&node.dataset.trendWeek);
function weeklyFixture(count=23){
 const f=taskFixture(),points=Array.from({length:count},(_,i)=>({week:new Date(Date.UTC(2026,0,4+i*7)).toISOString().slice(0,10),value:i%5}));
 f.product.automatic_trends=[{...row,points}];return {...f,points,host:renderTrendChart(f.context,f.product)};
}
test('weekly details show only ten newest saved points without modifying their order or values',t=>{
 const f=weeklyFixture();t.after(()=>f.context.life.dispose());const original=structuredClone(f.points);
 const rows=weeklyRows(f.host);assert.equal(rows.length,10,'a long series cannot expand into an unbounded table');
 assert.deepEqual(rows.map(r=>r.dataset.trendWeek),f.points.slice(-10).reverse().map(p=>p.week));
 assert.deepEqual(rows.map(r=>Number(r.find(n=>n.className==='rw-trend-week-number').textContent)),f.points.slice(-10).reverse().map(p=>p.value));
 assert.ok(f.host.find(n=>n.tagName==='TH'&&n.textContent==='周起始日期'));
 assert.ok(f.host.find(n=>n.tagName==='TH'&&n.textContent==='相对热度'));
 assert.match(f.host.find(n=>n.dataset.trendWeekPage==='true').textContent,/1–10.*23/);
 assert.deepEqual(f.points,original,'display sorting cannot reorder saved evidence');assert.equal(f.calls.length,0);
});
test('weekly pagination reaches every saved point and keeps first and last controls disabled',async t=>{
 const f=weeklyFixture();t.after(()=>f.context.life.dispose());const older=f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='下一页'),newer=f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='上一页');
 assert.ok(older&&newer,'local pagination controls');assert.equal(newer.disabled,true);assert.equal(older.disabled,false);
 const shown=weeklyRows(f.host).map(r=>r.dataset.trendWeek);older.click();await Promise.resolve();shown.push(...weeklyRows(f.host).map(r=>r.dataset.trendWeek));
 assert.equal(newer.disabled,false);assert.equal(weeklyRows(f.host).length,10);older.click();await Promise.resolve();shown.push(...weeklyRows(f.host).map(r=>r.dataset.trendWeek));
 assert.equal(weeklyRows(f.host).length,3);assert.equal(older.disabled,true);assert.deepEqual(shown,[...f.points].reverse().map(p=>p.week));
 assert.match(f.host.find(n=>n.dataset.trendWeekPage==='true').textContent,/21–23.*23/);older.click();assert.equal(weeklyRows(f.host).length,3);
 assert.equal(weeklyRows(f.host).at(-1).find(n=>n.className==='rw-trend-week-number').textContent,'0');
 newer.click();newer.click();await Promise.resolve();assert.equal(newer.disabled,true);assert.equal(weeklyRows(f.host)[0].dataset.trendWeek,f.points.at(-1).week);assert.equal(f.calls.length,0,'paging never refetches or collects');
});
test('short series retain exact zeros and time-window switching resets to the newest page of that series',t=>{
 const f=weeklyFixture();t.after(()=>f.context.life.dispose());f.product.automatic_trends.push({...row,window:'5y',points:[{week:'2021-01-03',value:0},{week:'2021-01-10',value:100}]});
 const next=f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='下一页');assert.ok(next);next.click();
 f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='过去5年').click();
 assert.deepEqual(weeklyRows(f.host).map(r=>r.dataset.trendWeek),['2021-01-10','2021-01-03']);
 assert.equal(f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='下一页').disabled,true);
 assert.equal(f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='上一页').disabled,true);
 assert.equal(weeklyRows(f.host)[1].find(n=>n.className==='rw-trend-week-number').textContent,'0');
 f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='过去12个月').click();assert.equal(weeklyRows(f.host)[0].dataset.trendWeek,f.points.at(-1).week);assert.equal(f.calls.length,0);
});
