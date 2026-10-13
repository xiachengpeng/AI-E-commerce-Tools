import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const drafts=await import('../../js/research-workbench/drafts.mjs').catch(()=>({}));
const p='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64);
const key='rabbit-hole:draft:'+JSON.stringify([p,'','添加初始关键词','']);
const record=(extra={})=>({key,data:{values:{text:'dog owners',type:'pain',meaning:'犬主人'},command_id:id,submittedHash:null,uncertain:false,version:2,...extra}});
const bundle=(r=record())=>JSON.parse(JSON.stringify({version:1,source_origin:'https://source.example',drafts:[r]}));
function storage(entries={}){const m=new Map(Object.entries(entries));return {get length(){return m.size;},key:i=>[...m.keys()][i],getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),m};}
const context=(extra={})=>({storage:storage(),state:{drafts:{},commands:{},project:{id:p,version:2}},isCurrent:()=>true,readProject:async()=>({id:p,version:2}),readReceipt:async()=>({contract_version:1,project_id:p,command_id:id,state:'not_observed'}),...extra});
test('explicit export reads known research keys only and preserves original identity, UI hash and absent version',()=>{
 assert.equal(typeof drafts.exportDrafts,'function');const reads=[];const s=storage({[key]:JSON.stringify(record({version:undefined,submittedHash:hash,uncertain:true}).data),'api_key':'never read','rabbit-hole:active-project':p});const get=s.getItem;s.getItem=k=>{reads.push(k);return get(k);};
 const out=drafts.exportDrafts(s,{sourceOrigin:'https://source.example'});assert.deepEqual(out,bundle(record({version:undefined,submittedHash:hash,uncertain:true})));assert.deepEqual(reads,[key]);assert.ok(!JSON.stringify(out).includes('api_key'));
});
test('import preserves identity, checks receipt before stale version and only stages receipt DTO',async()=>{
 const calls=[];const c=context({readReceipt:async()=>{calls.push('receipt');return {contract_version:1,project_id:p,command_id:id,state:'committed',action:'add_keyword',digest:hash,version:3};},readProject:async()=>{calls.push('project');return {id:p,version:99};}});
 const result=await drafts.importDrafts(bundle(record({submittedHash:hash,uncertain:true,version:1})),c);assert.deepEqual(calls,['receipt']);assert.equal(result.needs_review.length,1);assert.equal(result.accepted.length,0);assert.equal(result.needs_review[0].receipt.state,'committed');assert.equal(result.needs_review[0].draft.data.command_id,id);assert.equal(result.needs_review[0].reason,'committed_content_unverified');assert.deepEqual(c.state.drafts,{});assert.deepEqual(c.state.commands,{});assert.equal(c.state.project.version,2);
});
test('server digest and action validated separately, committed known digest accepts receipt only',async()=>{
 const c=context({readReceipt:async()=>({contract_version:1,project_id:p,command_id:id,state:'committed',action:'add_keyword',digest:hash,version:3})});
 const r=await drafts.importDrafts(bundle(record({digest:hash,submittedHash:'b'.repeat(64)})),c);assert.equal(r.accepted[0].receipt.digest,hash);assert.equal(r.accepted[0].mode,'receipt_only');
 const bad=await drafts.importDrafts(bundle(record({digest:'b'.repeat(64)})),context({readReceipt:c.readReceipt}));assert.equal(bad.needs_review[0].reason,'receipt_mismatch');
});
test('missing version and changed version need review, not observed receipt never proves replay safe',async()=>{
 for(const extra of [{version:undefined},{version:1},{version:2,submittedHash:hash,uncertain:true}]){const r=await drafts.importDrafts(bundle(record(extra)),context());assert.equal(r.needs_review.length,1);assert.equal(r.accepted.length,0);}
 const r=await drafts.importDrafts(bundle(),context());assert.equal(r.accepted.length,1);assert.equal(r.accepted[0].mode,'read_only_draft');assert.equal(r.accepted[0].draft.data.command_id,id);
});
test('existing main draft or imported command never overwritten; late async cannot write DTO or storage',async()=>{
 const c=context();c.storage.setItem(key,JSON.stringify(record().data));const r=await drafts.importDrafts(bundle(),c);assert.equal(r.needs_review[0].reason,'existing_main_draft');assert.deepEqual(c.state.drafts,{});
 let resolve;let active=true;const late=context({isCurrent:()=>active,readProject:()=>new Promise(r=>resolve=r)});const pending=drafts.importDrafts(bundle(),late);await new Promise(r=>setImmediate(r));active=false;resolve({id:p,version:2});await pending;assert.equal(late.state.importedDrafts,undefined);assert.equal(late.storage.length,0);
});
test('reject malformed envelope and schema, credential fields, prototype data, HTML, URLs, oversize, unknown kinds',async()=>{
 const malicious=[{...bundle(),token:'secret'},{...bundle(),version:2},{...bundle(),source_origin:'javascript:alert(1)'},bundle(record({values:{text:'<img src=x onerror=alert(1)>'}})),bundle(record({values:{api_key:'fake'}})),bundle(record({values:{text:'https://example.test'}})),bundle(record({values:{text:'x'.repeat(10001)}})),bundle({...record(),key:'rabbit-hole:draft:'+JSON.stringify([p,'','unknown',''])}),bundle(record({values:JSON.parse('{"__proto__":{"polluted":true}}')})),bundle(record({token:'fake'})),bundle(record({values:{confirmed:'true'}}))];
 for(const input of malicious){const c=context();const r=await drafts.importDrafts(input,c);assert.ok(r.rejected.length>0);assert.equal(c.storage.length,0);assert.deepEqual(c.state.drafts,{});}
 const c=context();assert.ok((await drafts.importDrafts('x'.repeat(1048577),c)).rejected.length);assert.equal({}.polluted,undefined);
});
test('source quick command metadata whitelist is distinct from server digest and preserves absent version',async()=>{
 const k='rabbit-hole:command:'+p+':'+hash;const s=storage({[k]:JSON.stringify({command_id:id,submittedHash:hash,uncertain:true})});const out=drafts.exportDrafts(s,{sourceOrigin:'https://source.example'});assert.equal(out.drafts[0].data.digest,undefined);assert.equal(out.drafts[0].data.command_id,id);const r=await drafts.importDrafts(out,context());assert.equal(r.needs_review.length,1);
});
test('standalone script evaluation performs no storage/network/download until explicit user call; matches module export',async()=>{
 const code=await readFile(new URL('../../../scripts/full_merge/draft-export.js',import.meta.url),'utf8');let reads=0,downloads=0;const s=storage({[key]:JSON.stringify(record().data)});const get=s.getItem;s.getItem=k=>{reads++;return get(k);};const sandbox={TextEncoder,URL,sessionStorage:s,location:{origin:'https://source.example'},console,Blob,document:{createElement:()=>({click(){downloads++;},remove(){}}),body:{append(){}}}};sandbox.globalThis=sandbox;sandbox.URL={...URL,createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}}; // URL constructor remains available through window fixture below.
 sandbox.URL=class extends URL {static createObjectURL(){return 'blob:fixture';}static revokeObjectURL(){}};
 vm.runInNewContext(code,sandbox);assert.equal(reads,0);assert.equal(downloads,0);const out=sandbox.exportResearchDrafts();assert.equal(downloads,1);assert.deepEqual(JSON.parse(JSON.stringify(out)),drafts.exportDrafts(s,{sourceOrigin:'https://source.example'}));
});

import { renderSettings } from '../../js/research-workbench/settings.mjs';
import { fixtureRoot } from './dom-fixture.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
function uiContext(){return {root:fixtureRoot(),life:createLifecycle(),state:{projects:[],drafts:{},commands:{}},context:{storage:storage()},api:{request:async path=>path==='/ai-settings'?{}:path==='/sources'?{sources:[]}:{},integration:async provider=>({provider,fields:{}})}};}
test('settings exposes user import/export controls, read-only preview and no automatic request',async()=>{
 const c=uiContext();const page=renderSettings(c);const file=page.find(n=>n.tagName==='INPUT'&&n.type==='file');assert.ok(file);assert.ok(page.find(n=>n.tagName==='BUTTON'&&n.textContent==='导出本标签页研究草稿'));const importButton=page.find(n=>n.tagName==='BUTTON'&&n.textContent==='读取并核对草稿包');assert.ok(importButton);
 file.files=[{size:100,text:async()=>JSON.stringify(bundle(record({version:undefined})))}];await importButton.click();await new Promise(r=>setImmediate(r));assert.equal(c.state.importedDrafts.length,1);assert.deepEqual(c.state.drafts,{});assert.ok(page.find(n=>n.tagName==='PRE'&&n.textContent.includes('dog owners')));assert.ok(page.find(n=>n.textContent.includes('未导出的旧标签页草稿未迁移')));c.life.dispose();
});
test('late file read after settings disposal never imports or changes newer state',async()=>{
 const c=uiContext(),page=renderSettings(c);let resolve;const file=page.find(n=>n.type==='file');assert.ok(file);file.files=[{size:100,text:()=>new Promise(r=>resolve=r)}];const b=page.find(n=>n.tagName==='BUTTON'&&n.textContent==='读取并核对草稿包');b.click();c.life.dispose();resolve(JSON.stringify(bundle()));await new Promise(r=>setImmediate(r));assert.equal(c.state.importedDrafts,undefined);
});

test('real LAN fallback fingerprint format exports without replacing it',()=>{
 const fallback='change:123:abcdef:10203040';const k='rabbit-hole:command:'+p+':'+fallback;const s=storage({[k]:JSON.stringify({command_id:id,submittedHash:fallback,uncertain:true})});const out=drafts.exportDrafts(s,{sourceOrigin:'https://source.example'});assert.equal(out.drafts[0].data.submittedHash,fallback);
});
test('envelope getters and own poisoned prototype never execute',async()=>{
 let called=0;const input={source_origin:'https://source.example',drafts:[]};Object.defineProperty(input,'version',{enumerable:true,get(){called++;return 1;}});const r=await drafts.importDrafts(input,context());assert.equal(called,0);assert.equal(r.rejected.length,1);
});
test('duplicate import archive is preserved without multiplying pending records',async()=>{
 const c=context();await drafts.importDrafts(bundle(),c);await drafts.importDrafts(bundle(),c);assert.equal(c.state.importedDrafts.length,1);
});

test('known legacy schema fields preserve boolean types and exclude URL/file/product state',async()=>{
 const cases=[['new_project',{title:'Shop',direction:'Pet',market:'US'}],['confirm_product',{name:'Dog bowl',reason:'Observed',relevance_confirmed:true}],['confirm_creatives',{active_days:'40',creative_1_id:'ad1',creative_1_distinct:true,creative_1_active:false}],['补充 Similarweb 证据',{observed_at:'2026-10-01T12:00',conclusion:'observed',notes:'No inference',confirmed:false,direct_share:'10',monthly_visits:'200',traffic_scope:'domain',traffic_period:'October',not_applicable:false,reason:''}],['核算这笔订单是否值得做',{unit_price:'20',quantity:'1',quote_confirmed:true,fragile:'false',certification_required:false,certification_verified:false}],['triage_retained',{reason_choice:'商品明确，值得深挖',reason:''}],['记录真实测试结果',{period_start:'2026-01-01',period_end:'2026-01-02',spend:'20',confirmed:false}],['项目规则与预算',{min_active_days:'30',reason:'Observed'}]];
 for(const [kind,values] of cases){const k='rabbit-hole:draft:'+JSON.stringify([kind==='new_project'?'new':p,'',kind,'']);const data={values,command_id:id,submittedHash:null,uncertain:false};const out=drafts.exportDrafts(storage({[k]:JSON.stringify(data)}),{sourceOrigin:'https://source.example'});assert.deepEqual(out.drafts[0].data,data);}
 for(const values of [{name:'Dog',url:'https://example.test'},{name:'Dog',relevance_confirmed:'true'},{name:'Dog',facts:{confirmed:true}}]){const k='rabbit-hole:draft:'+JSON.stringify([p,'','confirm_product','']);assert.throws(()=>drafts.exportDrafts(storage({[k]:JSON.stringify({values,command_id:id,submittedHash:null,uncertain:false})}),{sourceOrigin:'https://source.example'}));}
});

test('malformed receipt metadata is not staged as committed data',async()=>{
 const c=context({readReceipt:async()=>({contract_version:1,project_id:p,command_id:id,state:'committed',action:'add_keyword',digest:'<script>unsafe</script>'})});const r=await drafts.importDrafts(bundle(record({submittedHash:hash})),c);assert.equal(r.needs_review[0].reason,'receipt_mismatch');assert.equal(r.needs_review[0].receipt,undefined);
});
test('import review archive is bounded across multiple explicit files',async()=>{
 const c=context();c.state.importedDrafts=Array.from({length:100},(_,i)=>({draft:{key:'archive'+i,data:{command_id:'old'+i}}}));const result=await drafts.importDrafts(bundle(),c);assert.equal(result.rejected.length,1);assert.equal(c.state.importedDrafts.length,100);
});

test('import preview wraps long JSON text in narrow native settings',async()=>{
 const c=uiContext();c.state.importedDrafts=[{mode:'read_only_draft',source_origin:'https://source.example',draft:record()}];const page=renderSettings(c);const pre=page.find(n=>n.tagName==='PRE');assert.equal(pre.attributes.style,'white-space:pre-wrap;overflow-wrap:anywhere');c.life.dispose();
});
