import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {render} from '../../js/research-workbench/pages/focused-exploration.mjs';

const nodes=n=>[n,...n.children.flatMap(nodes)];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const root=fixtureRoot(),life=createLifecycle(),navigation=[],writes=[],identities=[];
 const word={id:'w',text:'repair',status:'complete',approved:true,ads:[{id:'a',primary_text:'First original',media:[]},{id:'b',primary_text:'Second original',media:[]}]};
 const product=(id,name,ad)=>({id,name,url:'https://example.test/'+id,identity_revision:1,source_keyword_ids:['w'],candidate_sources:[{keyword_id:'w',ad_id:ad}],identification:{},steps:[],landing_snapshot:{title:name+' details',price:'USD 10.00',images:[],final_url:'https://example.test/'+id,page_type:'product'}});
 const c={root,life,context:{},state:{project:{id:'r',version:1,keywords:[word],products:[product('p1','First product','a'),product('p2','Second product','b')]},actions:[],productActions:{}},navigate:v=>navigation.push(v),api:{request:async(...args)=>{writes.push(args);return {};},blob:async()=>new Blob()},selectProduct(){},showProductIdentity:id=>identities.push(id),showQueue(){}};
 return {c,navigation,writes,identities};
}
test('candidate selection changes only detail data and pressed state, keeping list, controls and focus mounted',async()=>{
 const {c,navigation,writes,identities}=fixture();try{
  const page=render(c),list=page.find(n=>n.className==='rw-candidate-list'),toolbar=page.find(n=>n.className==='rw-search-toolbar'),second=page.find(n=>n.dataset.candidateId==='p2');
  list.scrollTop=120;c.root.scrollTop=380;second.focus();second.click();await tick();
  assert.deepEqual(navigation,[]);assert.deepEqual(writes,[]);
  assert.equal(page.find(n=>n.className==='rw-candidate-list'),list);assert.equal(page.find(n=>n.className==='rw-search-toolbar'),toolbar);
  assert.equal(list.scrollTop,120);assert.equal(c.root.scrollTop,380);assert.equal(c.root.ownerDocument.activeElement,second);
  assert.equal(second.attributes['aria-pressed'],'true');assert.equal(page.find(n=>n.dataset.candidateId==='p1').attributes['aria-pressed'],'false');
  assert.ok(nodes(page).some(n=>n.tagName==='H2'&&n.textContent==='Second product'));assert.ok(nodes(page).some(n=>n.textContent==='Second product details'));
  page.find(n=>n.dataset.productIdentityTrigger==='p2').click();await tick();assert.deepEqual(identities,['p2']);
 }finally{c.life.dispose();}
});
test('previous and next change the same detail host without page navigation and ignore repeated selected clicks',async()=>{
 const {c,navigation}=fixture();try{
  const page=render(c),host=page.find(n=>n.className==='rw-source-workspace'),firstGallery=page.find(n=>n.dataset.sourcePreview);
  page.find(n=>n.dataset.candidateId==='p1').click();await tick();assert.equal(page.find(n=>n.dataset.sourcePreview),firstGallery);
  page.find(n=>n.textContent==='下一条线索').click();await tick();assert.equal(c.state.focusIndices.w,1);assert.equal(page.find(n=>n.className==='rw-source-workspace'),host);
  const oldPrevious=page.find(n=>n.textContent==='上一条线索');oldPrevious.click();await tick();assert.equal(c.state.focusIndices.w,0);
  oldPrevious.click();await tick();assert.equal(c.state.focusIndices.w,0);assert.deepEqual(navigation,[]);
  assert.equal(page.find(n=>n.textContent==='上一条线索').disabled,true);assert.equal(page.find(n=>n.textContent==='下一条线索').disabled,false);
 }finally{c.life.dispose();}
});
test('switching disposes the previous detail scope so late translations cannot change its content',async()=>{
 const {c,navigation}=fixture();let finish;
 c.api.request=()=>new Promise(resolve=>{finish=resolve;});
 try{
  const page=render(c);page.find(n=>n.dataset.mediaSource==='ad').click();await tick();const oldQuote=page.find(n=>n.tagName==='BLOCKQUOTE');
  page.find(n=>n.attributes['aria-label']==='切换为中文').click();await tick();assert.equal(typeof finish,'function');
  page.find(n=>n.dataset.candidateId==='p2').click();await tick();finish({translated:'旧商品的延迟译文'});await tick();
  assert.equal(oldQuote.textContent,'First original');assert.ok(!nodes(page).some(n=>n.textContent==='旧商品的延迟译文'));assert.deepEqual(navigation,[]);
  page.find(n=>n.dataset.mediaSource==='ad').click();await tick();assert.ok(nodes(page).some(n=>n.tagName==='BLOCKQUOTE'&&n.textContent==='Second original'));
 }finally{c.life.dispose();}
});
test('the next preview reserves the previous media height while its own source is loading',async()=>{
 const {c}=fixture(),create=c.root.ownerDocument.createElement;
 // Supply only layout measurements missing from the small DOM fixture; rendering stays real.
 c.root.ownerDocument.createElement=tag=>{const n=create(tag),query=n.querySelector.bind(n);n.style={};n.getBoundingClientRect=()=>({height:n.className==='rw-media-preview'?308:1000});n.querySelector=s=>s.startsWith('.')?n.find(x=>x.className===s.slice(1)):query(s);return n;};
 try{const page=render(c);page.find(n=>n.dataset.candidateId==='p2').click();await tick();assert.equal(page.find(n=>n.className==='rw-media-preview').style.minHeight,'308px');}finally{c.life.dispose();}
});
test('lead judgment opens an inline form without navigating or saving',async()=>{
 const {c,navigation,writes}=fixture();c.state.drafts={};try{
  const page=render(c);page.find(n=>n.textContent==='暂存观察').click();await tick();
  assert.deepEqual(navigation,[]);assert.deepEqual(writes,[]);
  assert.ok(page.find(n=>n.tagName==='FORM'));
  assert.ok(page.find(n=>n.textContent==='保存判断'));
 }finally{c.life.dispose();}
});
for(const [label,disposition,reason] of [['保留并深挖','retained','商品明确，值得深挖'],['暂存观察','observing','商品身份不明确'],['淘汰这条线索','rejected','与当前选品方向不符']]){
 test(`inline ${disposition} saves the chosen lead and reason without changing pages`,async()=>{
  const {c,navigation,writes}=fixture();c.state.drafts={};const focus=[];c.command=async(action,payload)=>focus.push([action,payload]);
  c.api.request=async(path,options)=>{writes.push([path,options]);const p=c.state.project;return {...p,version:2,products:p.products.map(x=>x.id==='p1'?{...x,triage:{state:disposition}}:x)};};
  try{const page=render(c);page.find(n=>n.textContent===label).click();await tick();assert.equal(writes.length,0);
   page.find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,20));
   assert.equal(writes.length,1);assert.equal(writes[0][1].body.action,'triage_product');assert.deepEqual(writes[0][1].body.payload,{product_id:'p1',disposition,reason});assert.deepEqual(navigation,[]);
   assert.ok(nodes(page).some(n=>n.textContent.includes(({retained:'当前初筛：保留深挖',observing:'当前初筛：暂存观察',rejected:'当前初筛：已淘汰'})[disposition])));
   assert.equal(focus.length,disposition==='retained'?1:0);
  }finally{c.life.dispose();}
 });
}
test('uncertain judgment cannot be silently replaced with a different outcome',async()=>{
 const {c}=fixture();c.state.drafts={};let calls=0;c.api.request=async()=>{calls++;throw Error('network error');};
 try{const page=render(c);page.find(n=>n.textContent==='暂存观察').click();page.find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,20));
  page.find(n=>n.textContent==='淘汰这条线索').click();await tick();assert.equal(calls,1);assert.ok(nodes(page).some(n=>n.textContent.includes('保存状态尚待核对')));
 }finally{c.life.dispose();}
});
test('expansion progress and results are shown beside the current lead without mixing other leads',()=>{
 const {c}=fixture();c.state.project.products[0].identification={relevance_confirmed:true};c.state.project.products[0].expansion_sources=[{source_kind:'ad'}];
 c.state.actions=[{id:'a',kind:'expand',product_id:'p1',keyword_id:'w',status:'running'}];try{
  let page=render(c);assert.ok(nodes(page).some(n=>n.textContent.includes('搜索词提取')&&n.textContent.includes('处理中')));assert.equal(page.find(n=>n.textContent==='AI 提取搜索词').disabled,true);
  c.state.actions=[{id:'a',kind:'expand',product_id:'p1',keyword_id:'w',status:'complete',result:{suggestions:2}},{id:'b',kind:'expand',product_id:'p2',keyword_id:'w',status:'failed'}];page=render(c);assert.ok(nodes(page).some(n=>n.textContent.includes('新增 2 个待审核关键词')));assert.ok(!nodes(page).some(n=>n.textContent.includes('提取失败')));
 }finally{c.life.dispose();}
});
test('new expansion stays visible while its record is loading, and uncertain results require checking',()=>{
 const {c}=fixture();c.state.project.products[0].identification={relevance_confirmed:true};c.state.project.products[0].expansion_sources=[{source_kind:'ad'}];c.state.lastResearchAction={id:'a',projectId:'r',kind:'expand',productId:'p1',keywordId:'w'};
 try{let page=render(c);assert.ok(nodes(page).some(n=>n.textContent.includes('请求已提交')));assert.equal(page.find(n=>n.textContent==='AI 提取搜索词').disabled,true);
 c.state.actions=[{id:'a',kind:'expand',product_id:'p1',keyword_id:'w',status:'blocked',display_status:'manual_check',recovery_action:'manual'}];page=render(c);assert.ok(nodes(page).some(n=>n.textContent.includes('核对结果，不要重复提交')));assert.equal(page.find(n=>n.textContent==='AI 提取搜索词').disabled,true);
 }finally{c.life.dispose();}
});
