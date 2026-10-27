import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import * as media from '../../js/research-workbench/components/ad-copy.mjs';
import {productThumbnail} from '../../js/research-workbench/components/presentation.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(fetchBlob){
 const root=fixtureRoot(),life=createLifecycle(),scope=createLifecycle(),calls=[],revoked=[];
 life.track(()=>scope.dispose());
 const api={blob:async(path,o)=>{calls.push(path);return fetchBlob?fetchBlob(path,o):new Blob(['image'],{type:'image/png'});}};
 const owner={createObjectURL:()=> 'blob:'+Math.random(),revokeObjectURL:url=>revoked.push(url)};
 const c={root,life:scope,context:{objectURLs:owner},state:{project:{id:'p'}},api};
 assert.equal(typeof media.createMediaCache,'function');c.mediaCache=media.createMediaCache({life,api,owner,maxEntries:4,maxBytes:1000});
 return {c,life,calls,revoked};
}
const product={id:'x',identity_revision:1,landing_snapshot:{observed_at:'2026-10-18',images:['one','two','three','four']}};
const button=(host,index)=>host.find(n=>n.attributes['aria-label']==='查看素材 '+index);
const image=host=>host.find(n=>n.tagName==='IMG');

test('viewed images and in-flight requests are reused across switches and page redraws',async()=>{
 const f=fixture();try{
  let host=media.sourcePreview(f.c,{id:'k'},product,[]);await tick();const first=image(host);assert.ok(first);
  assert.ok(f.calls.some(p=>p.endsWith('index=1')),'adjacent image prefetched');
  button(host,2).click();await tick();button(host,1).click();await tick();assert.equal(image(host),first,'decoded element reused');
  assert.equal(f.calls.filter(p=>p.endsWith('index=0')).length,1);
  f.c.life.dispose();f.c.life=createLifecycle();f.life.track(()=>f.c.life.dispose());host=media.sourcePreview(f.c,{id:'k'},product,[]);await tick();assert.ok(image(host));assert.equal(f.calls.filter(p=>p.endsWith('index=0')).length,1);
 }finally{f.life.dispose();}
 assert.equal(new Set(f.revoked).size,f.revoked.length);
});

test('pending and failed image switches keep last successful image, and late results cannot replace selection',async()=>{
 const pending=new Map(),f=fixture(path=>path.endsWith('index=0')?Promise.resolve(new Blob(['ok'],{type:'image/png'})):new Promise((resolve,reject)=>pending.set(path,{resolve,reject})));
 try{const host=media.sourcePreview(f.c,{id:'k'},product,[]);await tick();const first=image(host);
 button(host,3).click();await tick();assert.equal(image(host),first);
 button(host,1).click();await tick();pending.get(f.calls.find(p=>p.endsWith('index=2'))).resolve(new Blob(['late'],{type:'image/png'}));await tick();assert.equal(image(host),first);
 button(host,4).click();await tick();pending.get(f.calls.find(p=>p.endsWith('index=3'))).reject(Error('unavailable'));await tick();assert.equal(image(host),first);assert.ok(host.find(n=>n.textContent.includes('重试')));
 }finally{f.life.dispose();}
});

test('cache is scoped by source identity and releases only unpinned entries under limits',async()=>{
 const f=fixture();try{
  const a=await f.c.mediaCache.acquire('a','/a'),b=await f.c.mediaCache.acquire('b','/b');
  b.release();for(let n=0;n<8;n++){const lease=await f.c.mediaCache.acquire('other'+n,'/other'+n);lease.release();}
  assert.ok(!f.revoked.includes(a.url),'visible image stays alive');a.release();
  const host=media.sourcePreview(f.c,{id:'k'},product,[]);await tick();assert.ok(image(host));
  const changed={...product,identity_revision:2,landing_snapshot:{...product.landing_snapshot,images:['new','two','three','four']}};
  media.sourcePreview(f.c,{id:'k'},changed,[]);await tick();assert.equal(f.calls.filter(p=>p.includes('product_id=x')&&p.endsWith('index=0')).length,2);
 }finally{f.life.dispose();}
});

test('previous and next controls navigate the gallery without rebuilding it',async()=>{
 const f=fixture();try{const host=media.sourcePreview(f.c,{id:'k'},product,[]);await tick();const first=image(host),next=host.find(n=>n.textContent==='下一张'),previous=host.find(n=>n.textContent==='上一张');assert.ok(next);assert.ok(previous);assert.equal(previous.disabled,true);next.click();await tick();assert.ok(image(host));previous.click();await tick();assert.equal(image(host),first);}finally{f.life.dispose();}
});

test('failed cached reads do not retry on redraw, explicit retry can invalidate them',async()=>{
 const f=fixture(async()=>{throw Error('offline');});try{
  await assert.rejects(f.c.mediaCache.acquire('failed','/failure'));await assert.rejects(f.c.mediaCache.acquire('failed','/failure'));assert.equal(f.calls.length,1);
  f.c.mediaCache.invalidate('failed');await assert.rejects(f.c.mediaCache.acquire('failed','/failure'));assert.equal(f.calls.length,2);
 }finally{f.life.dispose();}
});

test('side-by-side product and exact-bound ad previews keep independent selections',async()=>{
 const f=fixture();try{
  const word={id:'k'},ads=[{id:'bound',media:['ad-image']}];
  const productView=media.sourcePreview(f.c,word,product,ads,{fixedSource:'product'});
  const adView=media.sourcePreview(f.c,word,product,ads,{fixedSource:'ad'});await tick();
  assert.equal(productView.find(n=>n.dataset.mediaSource==='product').parentElement.hidden,true);
  assert.ok(f.calls.some(p=>p.includes('source=product')));assert.ok(f.calls.some(p=>p.includes('source=ad')&&p.includes('ad_id=bound')));
  button(productView,2).click();await tick();
  assert.ok(adView.find(n=>n.textContent==='已保存 1 项 · 当前 1 / 1'));
 }finally{f.life.dispose();}
});

test('candidate thumbnail and gallery reuse the same protected product image request',async()=>{
 const f=fixture();try{const p={...product,source_keyword_ids:['k']};f.c.state.project.keywords=[{id:'k'}];
  productThumbnail(f.c,p);media.sourcePreview(f.c,{id:'k'},p,[],{fixedSource:'product'});await tick();
  assert.equal(f.calls.filter(path=>path.includes('source=product')&&path.endsWith('index=0')).length,1);
 }finally{f.life.dispose();}
});
