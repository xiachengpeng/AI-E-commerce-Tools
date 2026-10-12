import test from 'node:test';
import assert from 'node:assert/strict';
import { newCommandId, submissionFingerprint, submitCommand, submitMutation, restoreDraft, safeDraft } from '../../js/research-workbench/services/commands.mjs';
import { keywordSearchSummary } from '../../js/research-workbench/components/elements.mjs';

test('native IDs are UUIDs and payload fingerprints preserve the legacy serialization',async()=>{
 const ids=new Set(Array.from({length:100},()=>newCommandId()));assert.equal(ids.size,100);
 for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 assert.equal(await submissionFingerprint({action:'add_keyword',payload:{text:'pet'}}),'8c88db25241c54d31155e97a7829f475abca79295f376a90de701058288b8f1e');
});
test('uncertain command is sent once and preserves the same ID hash and values for a retry',async()=>{
 const draft={command_id:newCommandId(),submittedHash:null,uncertain:false,version:2};let calls=0;
 const args={project_id:'p',version:2,action:'add_keyword',payload:{text:'pet'},draft};
 const api={request:async()=>{calls++;throw Error('offline');}};
 await assert.rejects(submitCommand(api,args),/offline/);const first={...draft};
 await assert.rejects(submitCommand(api,args),/offline/);assert.equal(calls,2);assert.deepEqual(draft,first);
 await assert.rejects(submitCommand(api,{...args,payload:{text:'changed'}}),/原输入/);assert.equal(calls,2);
});
test('legacy submittedHash with changed payload never silently replaces command identity',async()=>{
 const draft={command_id:newCommandId(),submittedHash:'legacy-hash',uncertain:false,version:2},before={...draft};let calls=0;
 await assert.rejects(submitCommand({request:async()=>calls++},{project_id:'p',version:2,action:'edit_keyword',payload:{text:'changed'},draft}),/原输入/);
 assert.deepEqual(draft,before);assert.equal(calls,0);
});
test('409 preserves identity and submitted hash while allowing explicit refreshed version retry',async()=>{
 const bodies=[],draft={command_id:newCommandId(),submittedHash:null,uncertain:false,version:2};
 const api={request:async(path,{body})=>{bodies.push(body);if(bodies.length===1)throw Object.assign(Error('conflict'),{status:409});return {id:'p',version:4};}};
 const args={project_id:'p',version:2,action:'approve_keyword',payload:{keyword_id:'k',approved:true},draft};
 await assert.rejects(submitCommand(api,args),/conflict/);const hash=draft.submittedHash,id=draft.command_id;
 draft.version=3;await submitCommand(api,{...args,version:3});assert.equal(draft.command_id,id);assert.equal(draft.submittedHash,hash);assert.equal(bodies[1].version,3);assert.equal(bodies[1].command_id,id);
});
test('create uses the same mutation identity contract and single attempt',async()=>{
 const draft={command_id:newCommandId()},calls=[];
 await assert.rejects(submitMutation({request:async(path,options)=>{calls.push([path,options]);throw Error('offline');}},'/projects',{title:'Fixture',direction:'Research',market:'US'},draft),/offline/);
 assert.equal(calls.length,1);assert.equal(calls[0][1].body.command_id,draft.command_id);assert.equal(draft.uncertain,true);
});
test('draft storage excludes source URLs files oversized and embedded links, retains legacy identity',()=>{
 const id=newCommandId(),draft=safeDraft({text:'pet',url:'https://example.com',quote:'see https://example.com',file:'content',large:'x'.repeat(10001)},[{key:'url',type:'url'},{key:'file',type:'file'}],{command_id:id,submittedHash:'old',uncertain:true});
 assert.deepEqual(draft.values,{text:'pet'});assert.equal(restoreDraft(draft).submittedHash,'old');assert.equal(restoreDraft(draft).command_id,id);
});
test('Unknown and stopped outcomes never become successful zero-result searches',()=>{
 assert.match(keywordSearchSummary({id:'k',status:'blocked',ads:[]},{k:{status:'blocked',display_status:'stopped'}}),/不算零结果/);
 assert.equal(keywordSearchSummary({id:'k',status:'complete',ads:[]},{k:{status:'complete',result:{}}}),'已完成 · 本次条数未记录');
 assert.equal(keywordSearchSummary({id:'k',status:'complete',ads:[]},{}),'本次采集 0 条（限定样本）');
});

import { fixtureRoot } from './dom-fixture.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
import { render as renderProjects } from '../../js/research-workbench/pages/projects.mjs';
import { render as renderExploration } from '../../js/research-workbench/pages/exploration.mjs';
import { render as renderFocused } from '../../js/research-workbench/pages/focused-exploration.mjs';
import { render as renderForm } from '../../js/research-workbench/pages/project-forms.mjs';
import { createWorkbench } from '../../js/research-workbench/index.mjs';
function pageContext(project=null){return {root:fixtureRoot(),life:createLifecycle(),state:{projects:[],project,keywordActions:{},drafts:{},view:'projects'},api:{request:async()=>({})},context:{},navigate(){},openProject(){},openForm(){},showQueue(){},selectProduct(){},command(){}};}
test('project page exposes create and persisted projects without inventing summary counts',()=>{
 const c=pageContext();c.state.projects=[{id:'p',title:'Saved',market:'US',keywords:[],products:[]}];const node=renderProjects(c);
 assert.equal(node.querySelector('h1').textContent,'研究项目');assert.ok(node.find(n=>n.textContent==='＋ 新建研究'));assert.ok(node.find(n=>n.textContent==='Saved'));c.life.dispose();
});
test('keyword review blocks stale citation and normalization; manual recovery cannot auto-search',()=>{
 const project={id:'p',title:'P',market:'US',keywords:[{id:'k',text:'pet',status:'pending_review',needs_normalization:true}],products:[]};const c=pageContext(project);
 let node=renderExploration(c);assert.equal(node.find(n=>n.textContent==='审核通过'),null);
 project.keywords[0]={id:'k',text:'pet',status:'blocked',approved:true};c.state.keywordActions={k:{id:'a',status:'blocked',recovery_action:'manual'}};node=renderFocused(c);
 assert.ok(node.find(n=>n.textContent.includes('提交状态不确定')));assert.equal(node.find(n=>n.textContent==='搜索这个词'),null);c.life.dispose();
});
test('project form preserves fixed market semantics and root-owned editor resources',()=>{
 const c=pageContext();const node=renderForm(c,{kind:'new_project'});assert.equal(node.querySelector('h1').textContent,'开始一项新研究');
 assert.equal(node.querySelector('form').elements.namedItem('market').value,'US');assert.equal(node.querySelector('form').elements.namedItem('direction').tagName,'TEXTAREA');c.life.dispose();
});
test('navigation focuses native heading after direct selection and successful create',async()=>{
 const root=fixtureRoot(),wb=createWorkbench();let current;
 const project={id:'p',title:'Fixture',direction:'R',market:'US',version:1,keywords:[],products:[]};
 await wb.mount(root,{onSelectProject:(id,c)=>{current=c;},fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?project:{projects:[project]}})});
 const select=root.querySelector('[data-rw-projects]').find(n=>n.textContent==='Fixture');select.click();await new Promise(r=>setTimeout(r,0));
 assert.equal(root.ownerDocument.activeElement?.tagName,'H1');assert.equal(wb.state.project.id,'p');
 current.navigate('projects');assert.equal(root.ownerDocument.activeElement?.textContent,'研究项目');current.acceptProject(project);assert.equal(root.ownerDocument.activeElement?.textContent,'Fixture');wb.unmount();
});
test('late initial project refresh cannot replace a new form or steal heading focus',async()=>{
 const root=fixtureRoot(),wb=createWorkbench();let finish;const started=new Promise(resolve=>{finish=resolve;});let release;
 const mounting=wb.mount(root,{fetch:async url=>{if(url.endsWith('/session'))return {ok:true,json:async()=>({csrf_token:'fixture'})};finish();return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({projects:[]})}));}});
 await started;root.querySelector('[data-rw-page]').find(n=>n.textContent==='＋ 新建研究').click();const focused=root.ownerDocument.activeElement;
 release();await mounting;assert.ok(root.ownerDocument.activeElement===focused);assert.ok(root.querySelector('[data-rw-page]').querySelector('h1')===focused);wb.unmount();
});
test('replaced sidebar buttons release their listeners before root unmount',async()=>{
 const root=fixtureRoot(),wb=createWorkbench();let reads=0;const transport=async url=>{reads++;return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:{projects:[{id:'p',title:'P'}]}};};
 await wb.mount(root,{fetch:transport});const old=root.querySelector('[data-rw-projects]').find(n=>n.textContent==='P');await wb.refresh();const before=reads;old.click();await new Promise(r=>setTimeout(r,0));assert.equal(reads,before);wb.unmount();
});
test('native form renders with browser read-only select and textarea type properties',()=>{
 const c=pageContext(),create=c.root.ownerDocument.createElement;
 c.root.ownerDocument.createElement=tag=>{const node=create(tag);if(['select','textarea'].includes(tag))Object.defineProperty(node,'type',{get:()=>tag==='select'?'select-one':'textarea'});return node;};
 assert.doesNotThrow(()=>renderForm(c,{kind:'new_project'}));c.life.dispose();
});
test('market selector has a field-only accessible name independent of option text',()=>{
 const c=pageContext();const node=renderForm(c,{kind:'new_project'});assert.equal(node.querySelector('select').attributes['aria-label'],'目标市场');c.life.dispose();
});
test('product selection stays native and passes only validated IDs to the optional future handler',async()=>{
 const root=fixtureRoot(),wb=createWorkbench(),selected=[];const project={id:'p',title:'P',keywords:[],products:[{id:'product',name:'Product'}]};let current;
 await wb.mount(root,{onSelectProject:(id,c)=>current=c,onSelectProduct:(selection,c)=>selected.push(selection),fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?project:{projects:[project]}})});
 root.querySelector('[data-rw-projects]').find(n=>n.textContent==='P').click();await new Promise(r=>setTimeout(r,0));
 current.selectProduct('unknown');assert.equal(selected.length,0);assert.equal(wb.state.view,'project');
 current.showQueue({kind:'scan',keyword_id:'k'});current.selectProduct('product');assert.equal(wb.state.view,'product');assert.equal(root.querySelector('[data-rw-page]').querySelector('h1').textContent,'产品档案');assert.deepEqual(selected,[{projectId:'p',productId:'product'}]);assert.equal(root.querySelector('[data-rw-page]').querySelector('pre'),null);wb.unmount();
});
test('LAN HTTP fallback detects edits and creates valid command identities without subtle crypto',async()=>{
 const cryptoProvider={getRandomValues:array=>globalThis.crypto.getRandomValues(array)};
 assert.match(newCommandId(cryptoProvider),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 const hash=await submissionFingerprint({text:'private form content'},cryptoProvider);
 assert.match(hash,/^change:/);assert.equal(hash.includes('private form content'),false);assert.notEqual(hash,await submissionFingerprint({text:'edited'},cryptoProvider));
});
test('uncertain quick-review identity survives a new workbench instance in the same tab',async()=>{
 const store=new Map(),storage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
 const project={id:'p',title:'P',version:1,keywords:[{id:'k',text:'pet',status:'pending_review'}],products:[]},sent=[];let current;
 const fetch=async(url,options)=>{if(options.method==='POST'){sent.push(JSON.parse(options.body));throw Error('offline');}return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?project:{projects:[project]}};};
 async function attempt(){const root=fixtureRoot(),wb=createWorkbench();await wb.mount(root,{storage,fetch,onSelectProject:(id,c)=>current=c});root.querySelector('[data-rw-projects]').find(n=>n.textContent==='P').click();await new Promise(r=>setTimeout(r,0));await current.command('approve_keyword',{keyword_id:'k',approved:true});wb.unmount();}
 await attempt();await attempt();assert.equal(sent.length,2);assert.equal(sent[0].command_id,sent[1].command_id);assert.equal(JSON.stringify([...store.values()]).includes('csrf_token'),false);
});
test('older in-flight refresh cannot overwrite a successfully saved command version',async()=>{
 const root=fixtureRoot(),wb=createWorkbench();let current,delay=false,release,startedResolve;const started=new Promise(r=>startedResolve=r);
 const project={id:'p',title:'P',version:1,keywords:[],products:[]};
 const fetch=async(url,options)=>{
  if(options.method==='POST')return {ok:true,json:async()=>({...project,version:2})};
  if(url.endsWith('/session'))return {ok:true,json:async()=>({csrf_token:'fixture'})};
  if(url.endsWith('/projects/p'))return {ok:true,json:async()=>project};
  if(url.endsWith('/projects')&&delay){startedResolve();return new Promise(r=>release=()=>r({ok:true,json:async()=>({projects:[project]})}));}
  return {ok:true,json:async()=>({projects:[project]})};
 };
 await wb.mount(root,{fetch,onSelectProject:(id,c)=>current=c});root.querySelector('[data-rw-projects]').find(n=>n.textContent==='P').click();await new Promise(r=>setTimeout(r,0));
 delay=true;const refresh=wb.refresh();await started;await current.command('archive_keyword',{keyword_id:'k'});release();await refresh;assert.equal(wb.state.project.version,2);wb.unmount();
});
test('committed receipt replay uses the same submitted content hash after a background version refresh',async()=>{
 const draft={command_id:newCommandId(),version:2},bodies=[];let committed;
 const api={request:async(path,{body})=>{bodies.push(body);if(!committed){committed={id:body.command_id,action:body.action,payload:body.payload};throw Error('response lost after commit');}
  assert.equal(body.command_id,committed.id);assert.deepEqual({action:body.action,payload:body.payload},{action:committed.action,payload:committed.payload});return {id:'p',version:5};}};
 const args={project_id:'p',version:2,action:'approve_keyword',payload:{keyword_id:'k',approved:true},draft};
 await assert.rejects(submitCommand(api,args),/response lost/);const hash=draft.submittedHash;draft.version=5;
 assert.deepEqual(await submitCommand(api,args),{id:'p',version:5});assert.equal(draft.submittedHash,hash);assert.equal(draft.uncertain,false);assert.equal(bodies.length,2);assert.equal(bodies[1].version,5);
});
test('manual child keyword emits the original single-source command payload without inferred facts',async()=>{
 const project={id:'p',version:3,title:'P',keywords:[{id:'parent',text:'pet',depth:0}],products:[]};
 const product={id:'product',expansion_sources:[{source_id:'source',source_kind:'ad',ad_id:'ad',identity_revision:2}]};const c=pageContext(project),sent=[];
 c.api={request:async(path,options)=>{sent.push([path,options.body]);return {...project,version:4};}};
 const node=renderForm(c,{kind:'add_keyword',parent:project.keywords[0],product});const form=node.querySelector('form');
 form.elements.namedItem('text').value='dog owners';form.elements.namedItem('source_quote').value='For dog owners';form.dispatchEvent(new Event('submit',{cancelable:true}));
 await new Promise(r=>setTimeout(r,0));assert.equal(sent.length,1);assert.equal(sent[0][0],'/projects/p/commands');assert.equal(sent[0][1].version,3);assert.equal(sent[0][1].action,'add_keyword');
 assert.deepEqual(sent[0][1].payload,{text:'dog owners',type:'pain',source_id:'source',source_quote:'For dog owners',source_kind:'ad',parent_id:'parent',product_id:'product'});c.life.dispose();
});

test('in-flight quick command remount releases only the transient lock and explicitly retries the same identity',async()=>{
 const root=fixtureRoot(),wb=createWorkbench(),sent=[];let current,rejectFirst,startedResolve;const started=new Promise(r=>startedResolve=r);
 const project={id:'p',title:'P',version:1,keywords:[{id:'k',text:'pet',status:'ready',approved:true}],products:[]};
 const fetch=async(url,options)=>{
  if(options.method==='POST'){sent.push(JSON.parse(options.body));if(sent.length===1){startedResolve();return new Promise((resolve,reject)=>rejectFirst=()=>reject(Error('lost reply')));}return {ok:true,json:async()=>({...project,version:2})};}
  return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?project:{projects:[project]}};
 };
 const context={fetch,onSelectProject:(id,c)=>current=c};
 await wb.mount(root,context);root.querySelector('[data-rw-projects]').find(n=>n.textContent==='P').click();await new Promise(r=>setTimeout(r,0));
 const pending=current.command('archive_keyword',{keyword_id:'k'});await started;
 const original=Object.values(wb.state.commands)[0];assert.equal(original.submitting,true);const identity={command_id:original.command_id,submittedHash:original.submittedHash};
 wb.unmount();rejectFirst();await pending;await wb.mount(root,context);
 assert.equal(sent.length,1);const restored=Object.values(wb.state.commands)[0];assert.equal(restored.uncertain,true);assert.equal(restored.submitting,undefined);assert.equal(restored.command_id,identity.command_id);assert.equal(restored.submittedHash,identity.submittedHash);
 root.querySelector('[data-rw-projects]').find(n=>n.textContent==='P').click();await new Promise(r=>setTimeout(r,0));await current.command('archive_keyword',{keyword_id:'k'});
 assert.equal(sent.length,2);assert.equal(sent[1].command_id,identity.command_id);assert.deepEqual(sent[1].payload,sent[0].payload);assert.equal(wb.state.project.version,2);wb.unmount();
});

for(const [name,wordStatus,action,expectZero] of [
 ['unrecorded count','complete',{status:'complete',result:{}},false],
 ['blocked current run','complete',{status:'blocked'},false],
 ['running current run','complete',{status:'running'},false],
 ['queued current run','complete',{status:'ready'},false],
 ['explicit zero count','ready',{status:'complete',result:{ads:0}},true],
 ['explicit empty receipt','complete',{status:'complete',result:{empty:true}},true]
])test('focused zero-result notice respects authoritative summary: '+name,()=>{
 const project={id:'p',title:'P',keywords:[{id:'k',text:'pet',status:wordStatus,approved:true,ads:[]}],products:[]};const c=pageContext(project);c.state.keywordActions={k:action};
 const node=renderFocused(c),notice=node.find(n=>n.className==='rw-notice'&&n.textContent.startsWith('本次采集 0 条'));
 assert.equal(Boolean(notice),expectZero);assert.equal(Boolean(node.find(n=>n.textContent==='换一个搜索入口')),expectZero);c.life.dispose();
});
