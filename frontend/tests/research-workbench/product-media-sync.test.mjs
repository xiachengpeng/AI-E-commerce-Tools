import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {render} from '../../js/research-workbench/pages/focused-exploration.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const word={id:'k',text:'repair',approved:true,status:'complete',ads:[{id:'a',advertiser:'Bound source',primary_text:'Full original '.repeat(40),media:[]},{id:'unrelated',primary_text:'Must not display'}]};
 const product={id:'p',name:'Product',url:'https://shop.example/products/p',source_keyword_ids:['k'],candidate_sources:[{keyword_id:'k',ad_id:'a'}]};
 const queued=[];return {root:fixtureRoot(),life:createLifecycle(),context:{},state:{project:{id:'r',version:1,keywords:[word],products:[product]},actions:[],productActions:{}},queued,showQueue:s=>queued.push(s),navigate(){},selectProduct(){},api:{blob:async()=>new Blob(['x'],{type:'image/png'})},product};
}
function all(node,fn){return node.children.flatMap(n=>[...(fn(n)?[n]:[]),...all(n,fn)]);}
test('one complete bound ad copy lives under the media, never a duplicate excerpt or unrelated ad',()=>{
 const c=fixture();try{const page=render(c),media=page.find(n=>n.className==='rw-lead-media');assert.equal(all(page,n=>n.tagName==='BLOCKQUOTE').length,1);assert.ok(media.find(n=>n.tagName==='BLOCKQUOTE'&&n.textContent.length>320));assert.ok(media.find(n=>n.textContent==='查看原广告'));assert.ok(!page.find(n=>n.textContent.includes('来源广告原文 · 节选')));assert.ok(!page.find(n=>n.textContent==='Must not display'));}finally{c.life.dispose();}
});
test('missing product images offer an explicit local read and never enqueue on mount',async()=>{
 const c=fixture();try{const page=render(c);await tick();assert.equal(c.queued.length,0);const read=page.find(n=>n.textContent==='读取商品图与信息');assert.ok(read);read.click();assert.deepEqual(c.queued,[{kind:'landing',product_id:'p',landing_mode:'local'}]);}finally{c.life.dispose();}
});
test('running, failed and no-image snapshots explain the actual product-page state',()=>{
 for(const [action,snapshot,expected] of [[{status:'running'},null,'正在读取商品页'],[{status:'blocked',diagnostic:'商品页返回 HTTP 403'},null,'商品页返回 HTTP 403'],[{status:'complete'},{images:[],page_type:'category'},'分类页']]){
  const c=fixture();c.state.productActions.p={kind:'landing',id:'task',...action};c.product.landing_snapshot=snapshot;
  try{const page=render(c);assert.ok(page.find(n=>n.textContent.includes(expected)),expected);if(action.status==='running')assert.ok(!page.find(n=>n.textContent==='读取商品图与信息'));assert.equal(c.queued.length,0);}finally{c.life.dispose();}
 }
});
test('choosing a paid reader only affects the next explicit confirmation and keeps saved results',async()=>{
 const c=fixture();c.product.landing_snapshot={images:[],title:'Saved product',page_type:'product'};
 try{const page=render(c),select=page.find(n=>n.attributes['aria-label']==='当前商品页读取方式');select.value='firecrawl';select.dispatchEvent(new Event('change'));await tick();assert.equal(c.queued.length,0);assert.equal(c.product.landing_snapshot.title,'Saved product');page.find(n=>n.textContent==='重新读取商品页').click();assert.deepEqual(c.queued,[{kind:'landing',product_id:'p',landing_mode:'firecrawl'}]);}finally{c.life.dispose();}
});
test('page logs open in place for the exact task and attempt without pagination or writes',async()=>{
 const c=fixture(),calls=[];c.state.productActions.p={id:'old-page-task',kind:'landing',status:'blocked',attempt:3};
 c.api.request=async(path,options)=>{calls.push([path,options]);return {logs:[],cursor:0};};c.api.stream=async()=>new ReadableStream({start(controller){controller.close();}});
 try{const page=render(c);page.find(n=>n.textContent==='查看商品页日志').click();await tick();assert.ok(calls.some(([path])=>path.includes('live-logs?')&&path.includes('action_id=old-page-task')));assert.ok(calls.every(([,o])=>!o.method));assert.equal(c.queued.length,0);assert.ok(page.find(n=>n.dataset.actionLogPanel==='true'&&!n.hidden));}finally{c.life.dispose();}
});
