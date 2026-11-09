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

const singleAd={id:'bound',observed_at:'2026-10-30',media:[{kind:'video',url:'https://cdn.example/saved.mp4'}]};
const retryButton=host=>host.find(n=>n.tagName==='BUTTON'&&n.textContent.includes('重试读取素材'));
const status=host=>host.find(n=>n.attributes.role==='status');

test('explicit retry stays visible while pending, sends one bound read and identifies repeated failures',async()=>{
 let rejectRetry;
 const f=fixture(()=>f.calls.length===1?Promise.reject(Error('来源连接失败')):new Promise((resolve,reject)=>{rejectRetry=reject;}));
 try{
  const host=media.sourcePreview(f.c,{id:'k'},product,[singleAd],{fixedSource:'ad'});await tick();
  const retry=retryButton(host);assert.equal(retry.hidden,false);const initial=status(host).textContent;
  retry.click();retry.click();await tick();
  assert.equal(f.calls.length,2,'double click must issue just one explicit retry');
  assert.equal(f.calls[0],f.calls[1],'retry must preserve the exact saved source binding');
  assert.equal(retry.hidden,false,'retry action remains visible');assert.equal(retry.disabled,true);
  assert.equal(retry.attributes['aria-busy'],'true');assert.match(status(host).textContent,/正在重试/);
  rejectRetry(Error('来源连接失败'));await tick();
  assert.equal(retry.disabled,false);assert.equal(retry.attributes['aria-busy'],'false');
  assert.notEqual(status(host).textContent,initial);assert.match(status(host).textContent,/第 1 次重试失败/);
  retry.click();await tick();rejectRetry(Error('来源连接失败'));await tick();
  assert.equal(f.calls.length,3);assert.match(status(host).textContent,/第 2 次重试失败/);
 }finally{f.life.dispose();}
});

test('retry after a displayed video errors fetches and displays a fresh media element',async()=>{
 const f=fixture(()=>new Blob(['video'],{type:'video/mp4'}));
 try{
  const host=media.sourcePreview(f.c,{id:'k'},product,[singleAd],{fixedSource:'ad'});await tick();
  const first=host.find(n=>n.tagName==='VIDEO');assert.ok(first);const firstUrl=first.src;
  first.dispatchEvent(new Event('error'));
  const retry=retryButton(host);assert.equal(retry.hidden,false);retry.click();await tick();
  assert.equal(f.calls.length,2,'a failed current video cannot take the same-key no-op path');
  const replacement=host.find(n=>n.tagName==='VIDEO');assert.notEqual(replacement,first);assert.notEqual(replacement.src,firstUrl);
  assert.ok(f.revoked.includes(firstUrl),'failed media lease is released after replacement');
  assert.equal(retry.hidden,true);assert.match(status(host).textContent,/已重新读取素材/);
  replacement.dispatchEvent(new Event('loadedmetadata'));assert.match(status(host).textContent,/重试成功/);
 }finally{f.life.dispose();}
 assert.equal(new Set(f.revoked).size,f.revoked.length);
});

test('late retry failure cannot overwrite a different selected source or survive teardown',async()=>{
 let rejectRetry;
 const f=fixture(path=>path.includes('source=product')?new Blob(['product'],{type:'image/png'}):f.calls.filter(p=>p.includes('source=ad')).length===1?Promise.reject(Error('offline')):new Promise((resolve,reject)=>{rejectRetry=reject;}));
 try{
  const host=media.sourcePreview(f.c,{id:'k'},product,[singleAd]);await tick();
  retryButton(host).click();await tick();
  host.find(n=>n.dataset.mediaSource==='product').click();await tick();const current=image(host);assert.ok(current);
  rejectRetry(Error('old retry failed'));await tick();assert.equal(image(host),current);assert.doesNotMatch(status(host).textContent,/old retry failed/);
  const text=status(host).textContent;f.c.life.dispose();assert.equal(status(host).textContent,text);
 }finally{f.life.dispose();}
});

test('events from a previous video cannot replace the status of a pending retry',async()=>{
 let resolveRetry;
 const f=fixture(()=>f.calls.length===1?new Blob(['first'],{type:'video/mp4'}):new Promise(resolve=>{resolveRetry=resolve;}));
 try{
  const host=media.sourcePreview(f.c,{id:'k'},product,[singleAd],{fixedSource:'ad'});await tick();
  const first=host.find(n=>n.tagName==='VIDEO');first.dispatchEvent(new Event('error'));
  retryButton(host).click();await tick();const loading=status(host).textContent;
  first.dispatchEvent(new Event('error'));first.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(status(host).textContent,loading,'the old video must not overwrite active retry feedback');
  resolveRetry(new Blob(['replacement'],{type:'video/mp4'}));await tick();
  assert.notEqual(host.find(n=>n.tagName==='VIDEO'),first);
 }finally{f.life.dispose();}
});

test('a retry resolving after its preview is disposed releases the lease without painting',async()=>{
 let resolveRetry;
 const f=fixture(()=>f.calls.length===1?Promise.reject(Error('offline')):new Promise(resolve=>{resolveRetry=resolve;}));
 try{
  const host=media.sourcePreview(f.c,{id:'k'},product,[singleAd],{fixedSource:'ad'});await tick();
  retryButton(host).click();await tick();const loading=status(host).textContent;
  f.c.life.dispose();resolveRetry(new Blob(['late'],{type:'video/mp4'}));await tick();
  assert.equal(status(host).textContent,loading);assert.equal(host.find(n=>n.tagName==='VIDEO'),null);
 }finally{f.life.dispose();}
 assert.equal(f.revoked.length,1);assert.equal(new Set(f.revoked).size,f.revoked.length);
});
