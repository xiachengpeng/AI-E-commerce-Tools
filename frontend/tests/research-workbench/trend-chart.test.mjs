import test from 'node:test';
import assert from 'node:assert/strict';
import {currentTrendSeries} from '../../js/research-workbench/components/trend-chart.mjs';
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
