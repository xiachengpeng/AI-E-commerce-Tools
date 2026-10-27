import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {createApi} from '../../js/research-workbench/api.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
test('profile API sends explicit version-bound operations and rejects arbitrary destinations',async()=>{
 const calls=[],api=createApi({fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({csrf_token:'fixture'})};}});
 await api.session();
 await api.integrationProfile('apify','reveal',{method:'POST',body:{profile_id:'default',field:'api_key',expected_version:2}});
 assert.ok(calls.at(-1).url.endsWith('/apify/research/reveal'));assert.equal(calls.at(-1).options.cache,'no-store');
 await assert.rejects(api.integrationProfile('evil','reveal',{method:'POST'}));
 await assert.rejects(api.integrationProfile('apify','profiles/../reveal',{method:'POST'}));
});

test('eye reads only on demand, hides saved full key, and disposal scrubs detached inputs',async()=>{
 const {createIntegrationEditor}=await import('../../js/research-workbench/components/integration-editor.mjs');
 const root=fixtureRoot(),life=createLifecycle(),calls=[];
 const config={provider:'apify',purpose:'research',configured:true,version:2,profile_version:2,profile_id:'default',active_profile_id:'default',name:'原有配置',profiles:[{id:'default',name:'原有配置'}],fields:{api_key:'••••••••',daily_limit:8},secret_previews:{api_key:'syn••••••key'}};
 const context={root,life,api:{integrationProfile:async(p,op)=>{calls.push(op);return {value:'synthetic-full-key'};}}};
 const editor=createIntegrationEditor(context,config,{title:'Apify',fields:['api_key','daily_limit'],labels:{api_key:'API Key'}});root.append(editor.card);
 const input=root.find(n=>n.name==='api_key'),eye=root.find(n=>n.dataset.secretToggle==='api_key');
 assert.equal(calls.length,0);assert.equal(input.value,'');assert.equal(input.placeholder,'syn••••••key');
 eye.click();await tick();assert.equal(input.value,'synthetic-full-key');assert.equal(input.type,'text');assert.equal(calls.length,1);
 eye.click();await tick();assert.equal(input.value,'');assert.equal(input.type,'password');
 eye.click();await tick();life.dispose();assert.equal(input.value,'');assert.equal(input.type,'password');
});

test('choosing a saved profile only loads it; activation requires an explicit clean click',async()=>{
 const {createIntegrationEditor}=await import('../../js/research-workbench/components/integration-editor.mjs');
 const root=fixtureRoot(),life=createLifecycle(),calls=[],id='a'.repeat(32);
 const config={provider:'apify',version:2,profile_version:2,profile_id:'default',active_profile_id:'default',name:'原有配置',profiles:[{id:'default',name:'原有配置'},{id,name:'备用'}],fields:{api_key:'••••••••',daily_limit:8}};
 const context={root,life,api:{integrationProfile:async(p,op,options)=>{calls.push({op,options});return {...config,profile_id:id,name:'备用',version:1,profile_version:1,active_version:2};}}};
 const editor=createIntegrationEditor(context,config,{title:'Apify',fields:['api_key','daily_limit'],labels:{}});root.append(editor.card);
 const select=root.find(n=>n.dataset.profileSelect!==undefined);select.value=id;select.dispatchEvent(new Event('change'));await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');
 const input=root.find(n=>n.name==='api_key');input.value='edited';input.dispatchEvent(new Event('input'));
 root.find(n=>n.dataset.profileActivate!==undefined).click();await tick();assert.equal(calls.length,1);
 assert.ok(root.find(n=>n.attributes.role==='status').textContent.includes('先保存'));
 life.dispose();
});

const accountConfig=()=>({provider:'apify',version:2,profile_version:2,profile_id:'default',active_profile_id:'default',name:'主账号',profiles:[{id:'default',name:'主账号',configured:true},{id:'b'.repeat(32),name:'备用账号',configured:true}],configured:true,fields:{api_key:'••••••••',daily_limit:8},secret_previews:{api_key:'syn••••••key'}});
async function accountFixture(api={}) {
 const {createIntegrationEditor}=await import('../../js/research-workbench/components/integration-editor.mjs');
 const root=fixtureRoot(),life=createLifecycle(),calls=[],config=accountConfig();
 const context={root,life,api:{integrationProfile:async(p,op,o)=>{calls.push({op,...o});return {...config,profile_id:op.startsWith('profiles/')?op.slice(9):config.profile_id};},...api}};
 const editor=createIntegrationEditor(context,config,{title:'Apify 广告采集',fields:['api_key','daily_limit'],labels:{api_key:'API Key',daily_limit:'每日调用上限'}});root.append(editor.card);return {root,life,calls,editor};
}
test('account editor keeps save, test and discard together; discard appears only with local changes',async()=>{
 const f=await accountFixture();try{
  const actions=f.root.find(n=>n.className==='rw-account-actions');assert.ok(actions);
  assert.ok(actions.find(n=>n.textContent==='保存配置'));assert.ok(actions.find(n=>n.textContent==='测试连接'));
  const cancel=f.root.find(n=>n.dataset.profileCancel!==undefined);assert.equal(cancel.hidden,true);
  const field=f.root.find(n=>n.name==='daily_limit');field.value='12';field.dispatchEvent(new Event('input'));
  assert.equal(cancel.hidden,false);assert.equal(f.root.find(n=>n.dataset.profileSelect!==undefined).disabled,true);
  cancel.click();await tick();assert.equal(cancel.hidden,true);assert.equal(field.value,'8');assert.equal(f.calls.length,0);
 }finally{f.life.dispose();}
});
test('new account starts empty, focuses its name, cancels without writes and validates an empty name',async()=>{
 const f=await accountFixture();try{
  const add=f.root.find(n=>n.dataset.profileAdd!==undefined);assert.ok(add);add.click();await tick();
  const name=f.root.find(n=>n.attributes['aria-label']==='配置名称');assert.equal(f.root.ownerDocument.activeElement,name);assert.equal(name.value,'');assert.equal(f.root.find(n=>n.dataset.profileSelect!==undefined).value,'');assert.ok(f.root.find(n=>n.textContent==='填写新账号的连接信息')) ;
  assert.equal(f.root.find(n=>n.name==='api_key').value,'');assert.equal(f.root.find(n=>n.dataset.profileActivate!==undefined).hidden,true);
  f.editor.save.click();await tick();assert.equal(f.calls.length,0);assert.match(f.root.find(n=>n.attributes.role==='status').textContent,/名称/);
  f.root.find(n=>n.dataset.profileCancel!==undefined).click();await tick();assert.equal(name.value,'主账号');assert.equal(f.calls.length,0);
 }finally{f.life.dispose();}
});
test('current account is clearly marked and cannot be redundantly activated; selecting backup is only a GET',async()=>{
 const f=await accountFixture();try{
  const activate=f.root.find(n=>n.dataset.profileActivate!==undefined);assert.equal(activate.disabled,true);
  assert.equal(f.root.find(n=>n.className==='rw-account-badge').textContent,'当前使用');
  const select=f.root.find(n=>n.dataset.profileSelect!==undefined);select.value='b'.repeat(32);select.dispatchEvent(new Event('change'));await tick();
  assert.equal(activate.disabled,false);assert.equal(f.root.find(n=>n.className==='rw-account-badge').textContent,'备用账号');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
 }finally{f.life.dispose();}
});
test('activation completion keeps the newly current account locked against duplicate activation',async()=>{
 let writes=0;const id='b'.repeat(32),f=await accountFixture({integrationProfile:async(p,op)=>{if(op==='activate')writes++;return {...accountConfig(),profile_id:id,name:'备用账号',active_profile_id:op==='activate'?id:'default'};}});
 try{const select=f.root.find(n=>n.dataset.profileSelect!==undefined);select.value=id;select.dispatchEvent(new Event('change'));await tick();const activate=f.root.find(n=>n.dataset.profileActivate!==undefined);activate.click();await tick();assert.equal(writes,1);assert.equal(activate.disabled,true);activate.click();await tick();assert.equal(writes,1);}finally{f.life.dispose();}
});
