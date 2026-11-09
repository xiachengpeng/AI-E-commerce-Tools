import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {fixtureRoot} from './dom-fixture.mjs';

const load=()=>import('../../js/research-workbench/services/trends-query.mjs');
function fixture(){
 const values=new Map(),product={id:'x',name:'FixtureBrand',url:'https://example.test/shower',identity_revision:2,identification:{relevance_confirmed:true,identity_revision:2},landing_snapshot:{identity_revision:2,title:'The Filtered Shower Head',body_text:'A filtered shower head for everyday showers.',json_ld:[{'@type':'Product',name:'Filtered Shower Head',brand:{name:'FixtureBrand'}}]}};
 const context={root:fixtureRoot(),life:createLifecycle(),state:{project:{id:'p',market:'US',products:[product]},product:'x'},context:{queryStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)}}};
 return {context,product,values};
}
const suggested={query:'filtered shower head',meaning:'过滤花洒',source_id:'title',source_quote:'Filtered Shower Head'};
const response=(candidates=[suggested])=>({candidates:[{content:{parts:[{text:JSON.stringify({candidates})}]}}]});

test('confirmed query and meaning survive a new context but never cross project, market or product identity',async t=>{
 const {rememberTrendsQuery,restoreTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 rememberTrendsQuery(c,p,suggested);const other={...c,state:{...c.state}};
 assert.equal(restoreTrendsQuery(other,p)[0].query,'filtered shower head');assert.equal(restoreTrendsQuery(other,p)[0].meaning,'过滤花洒');
 for(const changed of [{...p,id:'y'},{...p,identity_revision:3},{...p,url:'https://example.test/other'}])assert.deepEqual(restoreTrendsQuery(c,changed),[]);
 c.state.project={...c.state.project,market:'DE'};assert.deepEqual(restoreTrendsQuery(c,p),[]);
 c.state.project={...c.state.project,id:'other',market:'US'};assert.deepEqual(restoreTrendsQuery(c,p),[]);
});

test('current confirmed history restores a query; stale and other-market evidence are ignored',async t=>{
 const {restoreTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 p.evidence=[{channel:'trends',query:'old shower',window:'12m',identity_revision:1,market:'US',confirmed:true},{channel:'trends',query:'fremd',window:'5y',identity_revision:2,market:'DE',confirmed:true},{channel:'trends',query:'filtered shower head',window:'12m',identity_revision:2,market:'US',confirmed:true}];
 assert.deepEqual(restoreTrendsQuery(c,p).map(x=>x.query),['filtered shower head']);
});

test('different latest window queries remain alternatives instead of silently choosing one',async t=>{
 const {restoreTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 p.automatic_trends=[{query:'shower filter',window:'12m',identity_revision:2,market:'US',observed_at:'2026-10-30T00:00:00Z'},{query:'filtered shower head',window:'5y',identity_revision:2,market:'US',observed_at:'2026-10-31T00:00:00Z'}];
 assert.deepEqual(restoreTrendsQuery(c,p).map(x=>x.query).sort(),['filtered shower head','shower filter']);
});

test('preparing a saved query never calls external AI',async t=>{
 const {rememberTrendsQuery,prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 rememberTrendsQuery(c,p,suggested);c.context.callAI=()=>{throw Error('must not call');};
 const result=await prepareTrendsQuery(c,p);assert.equal(result.candidates[0].query,'filtered shower head');assert.equal(result.reused,true);
});

test('one grounded AI request supplies regional language, Chinese meaning and a verbatim basis without broad discovery keywords',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());let submitted;
 c.state.project.title='租房';c.state.project.keywords=[{text:'rental organization'}];
 c.context.callAI=async(...args)=>{submitted=args;return response();};
 const result=await prepareTrendsQuery(c,p);assert.equal(result.candidates[0].query,'filtered shower head');assert.equal(result.candidates[0].meaning,'过滤花洒');assert.equal(result.candidates[0].source_quote,'Filtered Shower Head');
 assert.equal(submitted[0],'text');const payload=JSON.stringify(submitted[1]);assert.match(payload,/US/);assert.match(payload,/English/);assert.match(payload,/Chinese/);assert.match(payload,/Filtered Shower Head/);assert.doesNotMatch(payload,/rental organization|租房/);
 assert.equal(c.state.commands,undefined,'suggestion does not submit a research action');
});

test('simultaneous suggestion preparation shares a request and later openings reuse the validated result',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());let finish,count=0;
 c.context.callAI=async()=>{count++;return new Promise(r=>finish=r);};
 const first=prepareTrendsQuery(c,p),second=prepareTrendsQuery(c,p);finish(response());
 assert.equal((await first).candidates[0].query,'filtered shower head');await second;await prepareTrendsQuery(c,p);assert.equal(count,1);
});

test('missing or unresolved product facts explain the missing context before any AI call',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());c.context.callAI=()=>{throw Error('must not call');};
 for(const changed of [{...p,landing_snapshot:null},{...p,identification:{relevance_confirmed:false}},{...p,landing_snapshot:{...p.landing_snapshot,identity_revision:1}}])await assert.rejects(prepareTrendsQuery(c,changed),/商品|核对/);
});

test('manually confirmed exact product URLs can prepare a query when link density falsely labels the snapshot as a category',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 p.url='https://shop.example/products/filtered-shower-head';
 p.landing_snapshot={...p.landing_snapshot,requested_url:p.url,final_url:'https://shop.example/products/filtered-shower-head',page_type:'category',needs_product_resolution:true};
 c.context.callAI=async()=>response();
 const result=await prepareTrendsQuery(c,p);
 assert.equal(result.candidates[0].query,'filtered shower head');
});

test('category URLs still require product resolution even after ad relevance is confirmed',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 p.url='https://shop.example/collections/shower';
 p.landing_snapshot={...p.landing_snapshot,requested_url:p.url,final_url:p.url,page_type:'category',needs_product_resolution:true};
 c.context.callAI=()=>{throw Error('must not call');};
 await assert.rejects(prepareTrendsQuery(c,p),/商品|核对/);
});

test('invalid AI basis, pure brand, links and missing Chinese meaning cannot become query suggestions',async t=>{
 const {prepareTrendsQuery}=await load();
 for(const invalid of [{...suggested,source_quote:'an unsupported claim'},{...suggested,source_id:'unknown'},{...suggested,query:'FixtureBrand'},{...suggested,query:'https://example.test'},{...suggested,meaning:'filtered shower head'}]){
  const {context:c,product:p}=fixture();t.after(()=>c.life.dispose());c.context.callAI=async()=>response([invalid]);
  await assert.rejects(prepareTrendsQuery(c,p),/建议|查询词/);
 }
});

test('confirmed brand is rejected even when the product page omits JSON-LD',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 p.identification.brand='FixtureBrand';p.landing_snapshot.title='FixtureBrand Filtered Shower Head';p.landing_snapshot.json_ld=[];
 c.context.callAI=async()=>response([{query:'FixtureBrand',meaning:'品牌名',source_id:'title',source_quote:'FixtureBrand'}]);
 await assert.rejects(prepareTrendsQuery(c,p),/建议|查询词/);
});

test('JSON-LD product suggestions are scoped to the current canonical product URL',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 p.landing_snapshot.json_ld=[{'@type':'Product',name:'Filtered Shower Head',url:'https://example.test/shower'},{'@type':'Product',name:'Countertop Toaster',url:'https://example.test/toaster'}];
 c.context.callAI=async()=>response([{query:'countertop toaster',meaning:'台面烤面包机',source_id:'product_2',source_quote:'Countertop Toaster'}]);
 await assert.rejects(prepareTrendsQuery(c,p),/建议|查询词/);
});

test('JSON fences and split response text are supported without repairing invalid JSON',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 const json=JSON.stringify({candidates:[suggested]});c.context.callAI=async()=>({candidates:[{content:{parts:[{text:'```json\n'+json.slice(0,20)},{text:json.slice(20)+'\n```'}]}}]});
 assert.equal((await prepareTrendsQuery(c,p)).candidates[0].query,'filtered shower head');
 c.context.callAI=async()=>({text:'{broken'});await assert.rejects(prepareTrendsQuery(c,p,{refresh:true}),/建议/);
});

test('late recommendations are rejected after identity or market changes',async t=>{
 const {prepareTrendsQuery}=await load();
 for(const change of [c=>{c.state.project.market='DE';},c=>{c.state.project.products[0].identity_revision=3;},c=>c.life.dispose()]){
  const {context:c,product:p}=fixture();t.after(()=>c.life.dispose());let finish;c.context.callAI=async()=>new Promise(r=>finish=r);
  const pending=prepareTrendsQuery(c,p);change(c);finish(response());await assert.rejects(pending,/变化|取消/);
 }
});

test('blocked storage and malformed saved records do not block manual use or produce fabricated translations',async t=>{
 const {rememberTrendsQuery,restoreTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());
 c.context.queryStorage={getItem(){throw Error('denied');},setItem(){throw Error('denied');}};
 assert.doesNotThrow(()=>rememberTrendsQuery(c,p,{query:'shower filter'}));assert.equal(restoreTrendsQuery(c,p)[0].meaning,'');
});

test('provider failures do not expose arbitrary upstream diagnostics in the query editor',async t=>{
 const {prepareTrendsQuery}=await load(),{context:c,product:p}=fixture();t.after(()=>c.life.dispose());c.context.callAI=async()=>{throw Error('provider-private-diagnostic');};
 await assert.rejects(prepareTrendsQuery(c,p),error=>!/provider-private/.test(error.message)&&/AI|模型/.test(error.message));
});
