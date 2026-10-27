import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../js/research-workbench/api.mjs';
import { loadResearchSettings, saveIntegration, resetResearchDrafts, renderSettings, renderIntegrationSettings } from '../../js/research-workbench/settings.mjs';
import { loadResearchHistory, renderHistory } from '../../js/research-workbench/history.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
import { fixtureRoot } from './dom-fixture.mjs';
const context=api=>({api,root:fixtureRoot(),life:createLifecycle(),state:{project:{id:'p'},drafts:{a:{}},commands:{c:{command_id:'keep',uncertain:true}},projects:[]},context:{},navigate(){}});
test('integration helper restricts destinations, preserves session and one PATCH',async()=>{
 const seen=[];const api=createApi({fetch:async(url,options)=>{seen.push({url,options});return {ok:true,json:async()=>({csrf_token:'fixture'})};}});await api.session();
 await api.integration('apify','research',{method:'PATCH',body:{api_key:''}});
 assert.equal(seen[1].url,'http://127.0.0.1:9503/api/settings/integrations/apify/research');assert.equal(seen[1].options.headers['X-Research-Token'],'fixture');
 await assert.rejects(api.integration('evil','research'));await assert.rejects(api.integration('apify','main'));assert.equal(seen.length,2);
});
test('blank secrets preserved and masked input cannot be submitted',async()=>{
 const calls=[];const c=context({integration:async(...args)=>{calls.push(args);return {version:2,fields:{api_key:'••••••••'}};}});
 await saveIntegration(c,'apify','research',{api_key:'',daily_limit:25});assert.deepEqual(calls[0][2].body,{api_key:'',daily_limit:25});
 await assert.rejects(saveIntegration(c,'apify','research',{api_key:'••••••••'}));assert.equal(calls.length,1);
});
test('load is read only, source status and main binding remain separate',async()=>{
 const calls=[];const c=context({request:async(path)=>{calls.push(path);return path==='/ai-settings'?{source:'main_binding',message:'输入上限',model:'fixture'}:{sources:[]};},integration:async(p,purpose)=>({provider:p,purpose,fields:{api_key:'••••••••'},configured:true})});
 const data=await loadResearchSettings(c);assert.equal(data.integrations.length,5);assert.deepEqual(calls,['/ai-settings','/sources']);assert.equal(data.ai.source,'main_binding');
});
test('reset clears local form drafts only and retains unresolved command identity',()=>{
 const c=context({request:()=>{throw Error('must not request');}});const commands=c.state.commands;resetResearchDrafts(c);assert.deepEqual(c.state.drafts,{});assert.equal(c.state.commands,commands);assert.equal(c.state.project.id,'p');
});
test('history binds cursor/kind to scope and exposes no DELETE',async()=>{
 let path;const c=context({request:async(p)=>{path=p;return {items:[],next_cursor:null};}});await loadResearchHistory(c,{kind:'import',cursor:'saved'});assert.equal(path,'/history?kind=import&project_id=p&cursor=saved');await assert.rejects(loadResearchHistory(c,{kind:'marketing'}));
 const page=renderHistory(c);await new Promise(r=>setImmediate(r));assert.equal(page.find(n=>n.tagName==='BUTTON'&&n.textContent.includes('删除')),null);c.life.dispose();
});
test('settings renders blank password fields and explicit main binding limitations',async()=>{
 const c=context({request:async p=>p==='/ai-settings'?{source:'main_binding',message:'输入上限262144',model:'fixture'}:{sources:[]},integration:async(provider,purpose)=>({provider,purpose,configured:true,fields:{api_key:'••••••••'}})});
 const page=renderIntegrationSettings(c);await new Promise(r=>setImmediate(r));assert.ok(page.find(n=>n.textContent.includes('当前模型不支持')));assert.ok(page.find(n=>n.type==='password'&&n.value===''));assert.ok(page.find(n=>n.tagName==='BUTTON'&&n.textContent==='测试连接'));c.life.dispose();
});
test('draft reset removes persisted unsent form values and retains submitted receipts',()=>{
 const removed=[];const c=context({});c.context.storage={removeItem:key=>removed.push(key)};c.state.drafts={unsent:{command_id:'uuid',values:{name:'draft'}},sent:{command_id:'uuid',submittedHash:'hash',uncertain:false},uncertain:{uncertain:true}};
 resetResearchDrafts(c);assert.deepEqual(removed,['unsent']);assert.deepEqual(Object.keys(c.state.drafts),['sent','uncertain']);
});
test('pending reset retains exact UUID/hash metadata and never writes to the API',()=>{
 let requests=0;const c=context({request:()=>requests++,integration:()=>requests++});const draft={command_id:'same-uuid',submittedHash:'same-hash',uncertain:true,values:{name:'keep'}};c.state.drafts={pending:draft};c.state.commands={pending:{...draft,submitting:true}};let removals=0;c.context.storage={removeItem(){removals++;}};
 resetResearchDrafts(c);assert.equal(c.state.drafts.pending,draft);assert.equal(c.state.commands.pending.command_id,'same-uuid');assert.equal(c.state.commands.pending.submittedHash,'same-hash');assert.equal(c.state.commands.pending.submitting,true);assert.equal(requests,0);assert.equal(removals,0);
});
test('credential edits never enter state or draft storage and clear after saving',async()=>{
 const persisted=[];const c=context({request:async p=>p==='/ai-settings'?{}:{sources:[]},integration:async(provider,purpose,options)=>({provider,purpose,version:2,fields:{},configured:true})});c.context.storage={setItem:(...args)=>persisted.push(args)};
 const host=renderIntegrationSettings(c);await new Promise(r=>setImmediate(r));const card=host.find(n=>n.dataset.integration==='apify'),input=card.find(n=>n.name==='api_key');input.value='synthetic-transient';input.dispatchEvent(new Event('input'));card.find(n=>n.tagName==='BUTTON'&&n.textContent==='保存配置').click();await new Promise(r=>setImmediate(r));assert.equal(input.value,'');assert.equal(JSON.stringify(c.state).includes('synthetic-transient'),false);assert.deepEqual(persisted,[]);c.life.dispose();
});
test('reset includes dormant local form drafts, preserves dormant pending receipts and reports count',()=>{
 const c=context({});const status=c.root.ownerDocument.createElement('p');status.dataset.rwStatus='';c.root.append(status);
 const store=new Map([['rabbit-hole:draft:plain',JSON.stringify({values:{a:'draft'},command_id:'unused'})],['rabbit-hole:draft:pending',JSON.stringify({values:{a:'keep'},command_id:'same-id',submittedHash:'same-hash',uncertain:true})],['rabbit-hole:command:receipt','keep'],['merchant-draft','keep']]);
 c.context.storage={get length(){return store.size;},key:i=>[...store.keys()][i],getItem:k=>store.get(k),removeItem:k=>store.delete(k)};c.state.drafts={};c.state.commands={};
 resetResearchDrafts(c);assert.equal(store.has('rabbit-hole:draft:plain'),false);assert.equal(JSON.parse(store.get('rabbit-hole:draft:pending')).command_id,'same-id');assert.equal(store.get('rabbit-hole:command:receipt'),'keep');assert.equal(store.get('merchant-draft'),'keep');assert.match(status.textContent,/保留待核对提交 1/);
});

test('research tools delegate all API configuration to the main settings entry',async()=>{
 let tab=null,reads=0;const c=context({request:async()=>{reads++;return {sources:[]};},integration:async(provider)=>{reads++;return {provider,fields:{}};}});
 c.context.openMainSettings=value=>{tab=value;};
 const host=renderSettings(c);await new Promise(r=>setImmediate(r));
 assert.equal(host.find(n=>n.type==='password'),null,'research page must not own credential editors');
 const entry=host.find(n=>n.tagName==='BUTTON'&&n.textContent==='打开接口设置');assert.ok(entry);entry.click();await new Promise(r=>setImmediate(r));
 assert.equal(tab,'integrations');assert.equal(reads,1,'only task history is read here, not settings or integration credentials');c.life.dispose();
});

test('unreadable integration settings cannot be mistaken for empty credentials or saved',async()=>{
 let writes=0;const c=context({request:async()=>{throw Error('offline');},integration:async(provider,purpose,options)=>{if(options?.method==='PATCH')writes++;throw Error('offline');}});
 const host=renderIntegrationSettings(c);await new Promise(r=>setImmediate(r));const card=host.find(n=>n.dataset.integration==='apify'),save=card.find(n=>n.tagName==='BUTTON'&&n.textContent==='保存配置');
 assert.equal(save.disabled,true);save.click();await new Promise(r=>setImmediate(r));assert.equal(writes,0);assert.ok(card.find(n=>n.textContent.includes('暂时无法读取')));c.life.dispose();
});

test('history selection previews the exact audit row without new requests or mutations',async()=>{
 let reads=0;const c=context({request:async()=>{reads++;return {items:[{id:'a',action:'confirm_product',project_id:'p',product_id:'one',created_at:'2026-10-19T01:00:00Z'},{id:'b',action:'decide',project_id:'p',product_id:'two',created_at:'2026-10-19T02:00:00Z'}],next_cursor:null};}});
 c.state.projects=[{id:'p',title:'项目'}];const page=renderHistory(c);await new Promise(r=>setImmediate(r));
 const choices=[];const visit=n=>{if(n.tagName==='BUTTON'&&n.textContent==='查看活动详情')choices.push(n);for(const child of n.children||[])visit(child);};visit(page);assert.equal(choices.length,2);
 choices[1].click();await new Promise(r=>setImmediate(r));
 const detail=page.find(n=>n.className==='rw-history-detail');assert.ok(detail);assert.ok(detail.find(n=>n.textContent==='保存人工决定'));assert.equal(reads,1);assert.equal(page.find(n=>n.tagName==='BUTTON'&&n.textContent.includes('删除')),null);c.life.dispose();
});

test('history keeps the rendered row kind while a different tab is loading or fails',async()=>{
 let rejectNext;const c=context({request:async path=>path.includes('kind=activity')?{items:[{id:'a',action:'decide',project_id:'p'}]}:new Promise((_,reject)=>{rejectNext=reject;})});
 const page=renderHistory(c);await new Promise(r=>setImmediate(r));
 page.find(n=>n.tagName==='BUTTON'&&n.textContent==='已保存研究报告').click();
 page.find(n=>n.tagName==='BUTTON'&&n.textContent==='查看活动详情').click();await new Promise(r=>setImmediate(r));
 let detail=page.find(n=>n.className==='rw-history-detail');assert.ok(detail.find(n=>n.textContent==='保存人工决定'));assert.equal(detail.find(n=>n.textContent==='查看研究报告'),null);
 rejectNext(Error('offline'));await new Promise(r=>setImmediate(r));page.find(n=>n.tagName==='BUTTON'&&n.textContent==='查看活动详情').click();await new Promise(r=>setImmediate(r));detail=page.find(n=>n.className==='rw-history-detail');assert.ok(detail.find(n=>n.textContent==='保存人工决定'));assert.equal(detail.find(n=>n.textContent==='查看研究报告'),null);c.life.dispose();
});

test('local draft inspector is read only and uncertain submissions cannot offer automatic continuation',async()=>{
 const {renderLocalDraftIndex}=await import('../../js/research-workbench/settings.mjs');let reads=0;const c=context({request:()=>reads++});c.state.projects=[{id:'r',title:'Research',products:[]}];c.state.drafts={'rabbit-hole:draft:["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","核算这笔订单是否值得做",""]':{values:{aov:'29.9'},uncertain:true}};
 const host=renderLocalDraftIndex(c);assert.ok(host.find(n=>n.textContent==='待核对提交'));assert.equal(host.find(n=>n.textContent==='回到原研究继续'),null);assert.equal(reads,0);c.life.dispose();
});

test('draft index reads persisted rule and revision drafts after refresh without hydrating or resubmitting',async()=>{
 const {renderLocalDraftIndex}=await import('../../js/research-workbench/settings.mjs');let reads=0;const c=context({request:()=>reads++});c.state.drafts={};const project='11111111-1111-4111-8111-111111111111';c.state.projects=[{id:project,title:'Research'}];
 const store=new Map([[`rabbit-hole:draft:["${project}","","configure_rules",""]`,JSON.stringify({values:{min_creatives:'3'},version:2})],[`rabbit-hole:draft:["${project}","22222222-2222-4222-8222-222222222222","revise_test_result",""]`,JSON.stringify({values:{reason:'Check source'},version:2,uncertain:true})]]);c.context.storage={get length(){return store.size;},key:i=>[...store.keys()][i],getItem:key=>store.get(key)};
 const page=renderLocalDraftIndex(c);assert.ok(page.find(n=>n.textContent==='项目规则'));assert.ok(page.find(n=>n.textContent==='修订测试结果'));assert.equal(reads,0);assert.deepEqual(c.state.drafts,{});assert.equal(store.size,2);c.life.dispose();
});

test('history navigation highlights the selected history kind rather than always the activity tab',async()=>{
 const c=context({request:async()=>({items:[]})});const page=renderHistory(c);await new Promise(r=>setImmediate(r));
 const activity=page.find(n=>n.tagName==='BUTTON'&&n.textContent==='研究活动'),reports=page.find(n=>n.tagName==='BUTTON'&&n.textContent==='已保存研究报告');
 assert.equal(activity.attributes['aria-pressed'],'true');reports.click();await new Promise(r=>setImmediate(r));assert.equal(activity.attributes['aria-pressed'],'false');assert.equal(reports.attributes['aria-pressed'],'true');c.life.dispose();
});

test('service switching retains each local editor and keeps its save and test actions inside it',async()=>{
 const calls=[],c=context({request:async path=>path==='/sources'?{sources:[]}:{configured:true,model:'fixture-model'},integration:async(provider,purpose,o={})=>{calls.push({provider,purpose,...o});return {provider,configured:true,version:2,fields:{daily_limit:10}};}});c.root.ownerDocument.body={classList:{contains:()=>true}};
 try{const host=renderIntegrationSettings(c);await new Promise(r=>setImmediate(r));
  assert.equal(host.find(n=>n.className==='rw-service-footer'),null);
  const apify=host.find(n=>n.dataset.integration==='apify'),service=host.find(n=>n.dataset.integration==='serpapi');
  host.find(n=>n.tagName==='BUTTON'&&n.dataset.provider==='serpapi').click();await new Promise(r=>setImmediate(r));assert.equal(apify.hidden,true);assert.equal(service.hidden,false);
  const key=service.find(n=>n.name==='api_key');key.value='isolated-test-value';key.dispatchEvent(new Event('input'));
  host.find(n=>n.tagName==='BUTTON'&&n.dataset.provider==='apify').click();await new Promise(r=>setImmediate(r));
  host.find(n=>n.tagName==='BUTTON'&&n.dataset.provider==='serpapi').click();await new Promise(r=>setImmediate(r));assert.equal(key.value,'isolated-test-value');
  assert.equal(calls.filter(v=>v.method==='PATCH').length,0);service.find(n=>n.className==='rw-account-actions').find(n=>n.tagName==='BUTTON'&&n.textContent==='保存配置').click();await new Promise(r=>setImmediate(r));assert.equal(calls.filter(v=>v.method==='PATCH').length,1);assert.equal(calls.find(v=>v.method==='PATCH').provider,'serpapi');assert.equal(key.value,'');
 }finally{c.life.dispose();}
});
