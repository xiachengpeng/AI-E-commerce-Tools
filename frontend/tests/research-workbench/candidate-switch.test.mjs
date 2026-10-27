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
