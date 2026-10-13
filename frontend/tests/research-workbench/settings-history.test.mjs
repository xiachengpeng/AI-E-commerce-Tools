import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../js/research-workbench/api.mjs';
import { loadResearchSettings, saveIntegration, resetResearchDrafts, renderSettings } from '../../js/research-workbench/settings.mjs';
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
 const page=renderSettings(c);await new Promise(r=>setImmediate(r));assert.ok(page.find(n=>n.textContent.includes('当前模型不支持')));assert.ok(page.find(n=>n.type==='password'&&n.value===''));assert.equal(page.find(n=>n.tagName==='BUTTON'&&n.textContent.includes('测试连接')),null);c.life.dispose();
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
 const host=renderSettings(c);await new Promise(r=>setImmediate(r));const card=host.find(n=>n.dataset.integration==='apify'),input=card.find(n=>n.name==='api_key');input.value='synthetic-transient';input.dispatchEvent(new Event('input'));card.find(n=>n.tagName==='BUTTON').click();await new Promise(r=>setImmediate(r));assert.equal(input.value,'');assert.equal(JSON.stringify(c.state).includes('synthetic-transient'),false);assert.deepEqual(persisted,[]);c.life.dispose();
});
test('reset includes dormant local form drafts, preserves dormant pending receipts and reports count',()=>{
 const c=context({});const status=c.root.ownerDocument.createElement('p');status.dataset.rwStatus='';c.root.append(status);
 const store=new Map([['rabbit-hole:draft:plain',JSON.stringify({values:{a:'draft'},command_id:'unused'})],['rabbit-hole:draft:pending',JSON.stringify({values:{a:'keep'},command_id:'same-id',submittedHash:'same-hash',uncertain:true})],['rabbit-hole:command:receipt','keep'],['merchant-draft','keep']]);
 c.context.storage={get length(){return store.size;},key:i=>[...store.keys()][i],getItem:k=>store.get(k),removeItem:k=>store.delete(k)};c.state.drafts={};c.state.commands={};
 resetResearchDrafts(c);assert.equal(store.has('rabbit-hole:draft:plain'),false);assert.equal(JSON.parse(store.get('rabbit-hole:draft:pending')).command_id,'same-id');assert.equal(store.get('rabbit-hole:command:receipt'),'keep');assert.equal(store.get('merchant-draft'),'keep');assert.match(status.textContent,/保留待核对提交 1/);
});
