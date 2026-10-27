import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRoot } from './dom-fixture.mjs';
import { createSettingsIntegrations, createSettingsWorkerStatus } from '../../js/settings_research.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function transport(calls){return async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/sources')?{sources:[]}:url.endsWith('/ai-settings')?{model:'fixture'}:{provider:url.split('/').at(-2),purpose:'research',configured:true,version:1,fields:{api_key:'••••••••'}}};};}
test('main settings mounts once, reads only, and nests research Firecrawl in the existing provider card',async()=>{
 const calls=[],host=fixtureRoot(),firecrawlHost=fixtureRoot(),panel=createSettingsIntegrations();
 await panel.mount(host,{fetch:transport(calls),firecrawlHost});await tick();
 assert.equal(calls.length,8);assert.ok(calls.every(c=>c.options.method==='GET'));
 assert.equal(host.find(n=>n.dataset.integration==='firecrawl'),null);assert.ok(firecrawlHost.find(n=>n.dataset.integration==='firecrawl'));
 assert.ok(host.find(n=>n.dataset.integration==='apify'));const secret=host.find(n=>n.type==='password');assert.equal(secret.value,'');
 await panel.mount(host,{fetch:transport(calls),firecrawlHost});assert.equal(calls.length,8);
 panel.unmount();assert.equal(host.children.length,0);assert.equal(firecrawlHost.children.length,0);assert.equal(calls[0].options.signal.aborted,true);
});
test('leaving settings during session acquisition prevents credential reads and late rendering',async()=>{
 const host=fixtureRoot(),panel=createSettingsIntegrations();let release,calls=0;
 const pending=panel.mount(host,{fetch:async()=>{calls++;return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({csrf_token:'fixture'})}));}});
 panel.unmount();release();await pending;await tick();assert.equal(calls,1);assert.equal(host.children.length,0);
});

test('late credential reads cannot repopulate either editor after leaving settings',async()=>{
 const host=fixtureRoot(),firecrawlHost=fixtureRoot(),panel=createSettingsIntegrations(),pending=[];
 await panel.mount(host,{firecrawlHost,fetch:async(url)=>url.endsWith('/session')?{ok:true,json:async()=>({csrf_token:'fixture'})}:new Promise(resolve=>pending.push(()=>resolve({ok:true,json:async()=>url.endsWith('/sources')?{sources:[]}:{provider:url.split('/').at(-2),configured:true,fields:{}}}))) });
 assert.equal(pending.length,7);panel.unmount();for(const resolve of pending)resolve();await tick();
 assert.equal(host.children.length,0);assert.equal(firecrawlHost.children.length,0);
});

test('integration pane has explicit saved-credential tests and no runtime status',async()=>{
 const calls=[],host=fixtureRoot(),panel=createSettingsIntegrations();
 await panel.mount(host,{fetch:transport(calls)});await tick();
 assert.equal(host.find(n=>n.dataset.workerStatus!==undefined),null);
 const card=host.find(n=>n.dataset.integration==='apify');
 const probe=card.find(n=>n.tagName==='BUTTON'&&n.textContent==='测试连接');assert.ok(probe);
 assert.ok(!calls.some(c=>c.options.method==='POST'));
 probe.click();await tick();assert.equal(calls.at(-1).options.method,'POST');assert.ok(calls.at(-1).url.endsWith('/apify/research/test'));
 panel.unmount();
});

test('runtime observation mounts only in its own pane and stops on teardown',async()=>{
 const host=fixtureRoot(),panel=createSettingsWorkerStatus(),calls=[];
 await panel.mount(host,{fetch:transport(calls)});await tick();
 assert.ok(host.find(n=>n.dataset.workerStatus!==undefined));assert.equal(calls.length,2);
 assert.ok(calls[1].url.endsWith('/runtime-status'));
 panel.unmount();assert.equal(host.children.length,0);assert.ok(calls[0].options.signal.aborted);
});
test('editing credentials requires a save before testing and never sends the draft',async()=>{
 const host=fixtureRoot(),panel=createSettingsIntegrations(),calls=[];
 await panel.mount(host,{fetch:transport(calls)});await tick();
 const card=host.find(n=>n.dataset.integration==='apify'),input=card.find(n=>n.name==='api_key');
 input.value='never-transmit-draft';input.dispatchEvent(new Event('input'));
 card.find(n=>n.tagName==='BUTTON'&&n.textContent==='测试连接').click();await tick();
 assert.equal(calls.length,8);assert.ok(card.find(n=>n.attributes?.role==='status').textContent.includes('先保存'));
 panel.unmount();
});
