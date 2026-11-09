import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRoot } from './dom-fixture.mjs';
import { renderCustomerSetup } from '../../js/customer_setup.mjs';
const tick=()=>new Promise(setImmediate);
const template={market:{code:'US',currency:'USD',min_aov:40,max_aov:150,payment_percent:3,payment_fixed:0.3,loss_reserve_percent:5},admission:{daily_candidates:10,daily_keywords:10,daily_scans:2,daily_ai_calls:10,daily_cost_usd:'1',estimated_call_cost_usd:'0.02',estimated_research_scan_cost_usd:'0.20'},trend_thresholds:{coverage:0.8,rising:1.2,declining:0.8,stable_median_ratio:0.8,peak_ratio:0.5,seasonal_ratio:1.5,seasonal_years:3,seasonal_tolerance_weeks:2},browser_concurrency:1,poll_seconds:60,public_dns:'system'};
test('onboarding explains automatic background without providing a disable control',()=>{
 const root=fixtureRoot(),calls=[];
 const panel=renderCustomerSetup({root,save:async b=>calls.push(b),close(){}},{version:'0.2.0',business:null,template,worker_enabled:false});
 root.append(panel);
 assert.equal(calls.length,0);
 assert.ok(root.find(n=>n.dataset.customerBackgroundStatus!==undefined));
 assert.equal(root.find(n=>n.dataset.customerCosts!==undefined),null);
 assert.equal(root.find(n=>n.dataset.customerEnable!==undefined),null);
 assert.equal(root.find(n=>n.tagName==='BUTTON'&&/开启后台|暂停后台/.test(n.textContent)),null);
 assert.ok(root.find(n=>n.textContent==='保存研究规则'));
});
test('saving rules keeps background automatic and updates the waiting status',async()=>{
 const root=fixtureRoot(),calls=[];
 root.append(renderCustomerSetup({root,save:async b=>{calls.push(b);return {business:b.business,worker_enabled:true,restart_required:true};},close(){}},{version:'0.2.0',business:null,template,worker_enabled:true}));
 const status=root.find(n=>n.dataset.customerBackgroundStatus!==undefined);
 assert.match(status?.textContent||'',/等待.*研究规则/);
 root.find(n=>n.dataset.customerRulesConfirmed!==undefined).checked=true;
 root.find(n=>n.textContent==='保存研究规则').click();await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].action,'rules');
 assert.match(status.textContent,/自动运行/);
 assert.doesNotMatch(status.textContent,/等待/);
});
