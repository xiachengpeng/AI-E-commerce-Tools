import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {adTextPanel} from '../../js/research-workbench/components/ad-copy.mjs';
import {render} from '../../js/research-workbench/pages/focused-exploration.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const nodes=n=>[n,...n.children.flatMap(nodes)];
const visible=n=>{for(let p=n;p;p=p.parentElement)if(p.hidden)return false;return true;};
function fixture(){const root=fixtureRoot(),life=createLifecycle(),writes=[],copied=[],word={id:'k',text:'repair',status:'complete',approved:true,ads:[{id:'a',advertiser:'A',primary_text:'Original ad copy',media:[]}]},product={id:'p',name:'Lead',url:'https://shop.example/p',identity_revision:1,source_keyword_ids:['k'],candidate_sources:[{keyword_id:'k',ad_id:'a'}],identification:{},steps:[],landing_snapshot:{title:'Observed product',price:'EUR 19.95',images:[],final_url:'https://shop.example/p',page_type:'product'}};
 root.ownerDocument.defaultView={navigator:{clipboard:{writeText:async v=>copied.push(v)}}};
 return {root,life,context:{},word,product,writes,copied,state:{project:{id:'r',version:1,keywords:[word],products:[product]},actions:[],productActions:{}},api:{request:async(path,o)=>{writes.push([path,o]);return {translated:'中文广告译文'};},blob:async()=>new Blob(['x'],{type:'image/png'})},navigate(){},selectProduct(){},showProductIdentity(){},showQueue:s=>writes.push(s)};
}
test('compact copy toolbar translates on demand once and always copies the saved original',async()=>{
 const c=fixture();try{const card=adTextPanel(c,c.word,c.word.ads[0]),toolbar=card.find(n=>n.className==='rw-ad-copy-toolbar');assert.ok(toolbar);assert.equal(c.writes.length,0);const zh=toolbar.find(n=>n.textContent==='中'),original=toolbar.find(n=>n.textContent==='原'),copy=toolbar.find(n=>n.attributes['aria-label']==='复制原文');assert.ok(zh&&original&&copy);zh.click();await tick();assert.equal(card.find(n=>n.tagName==='BLOCKQUOTE').textContent,'中文广告译文');copy.click();await tick();assert.deepEqual(c.copied,['Original ad copy']);original.click();await tick();zh.click();await tick();assert.equal(c.writes.length,1);assert.equal(c.writes[0][1].body.expected_text,'Original ad copy');}finally{c.life.dispose();}
});
test('late translation cannot switch the reader back from original or issue a duplicate request',async()=>{
 const c=fixture();let finish;c.api.request=async()=>{c.writes.push('translate');return new Promise(r=>finish=r);};
 try{const card=adTextPanel(c,c.word,c.word.ads[0]),zh=card.find(n=>n.textContent==='中'),original=card.find(n=>n.textContent==='原');assert.ok(zh&&original);zh.click();await tick();original.click();await tick();zh.click();await tick();assert.equal(c.writes.length,1);original.click();await tick();finish({translated:'中文广告译文'});await tick();assert.equal(card.find(n=>n.tagName==='BLOCKQUOTE').textContent,'Original ad copy');}finally{c.life.dispose();}
});
test('product facts, price, read errors and logs are visible only in the product tab',async()=>{
 const c=fixture();c.state.productActions.p={id:'landing',kind:'landing',status:'blocked',diagnostic:'HTTP 404',attempt:1};
 try{const page=render(c),productPanel=page.find(n=>n.dataset.leadContent==='product'),adPanel=page.find(n=>n.dataset.leadContent==='ad');assert.ok(productPanel&&adPanel);page.find(n=>n.dataset.mediaSource==='ad').click();await tick();assert.equal(visible(productPanel),false);assert.equal(visible(adPanel),true);assert.ok(!nodes(page).some(n=>visible(n)&&n.textContent.includes('HTTP 404')));page.find(n=>n.dataset.mediaSource==='product').click();await tick();assert.equal(visible(adPanel),false);assert.equal(visible(productPanel),true);assert.ok(nodes(productPanel).some(n=>n.textContent==='EUR 19.95'));assert.ok(nodes(productPanel).some(n=>n.textContent==='Observed product'));assert.ok(!c.writes.length);}finally{c.life.dispose();}
});
test('ad copy follows the selected bound ad, never another ad or the previous source',async()=>{
 const c=fixture();c.word.ads.push({id:'b',advertiser:'B',primary_text:'Second bound copy',media:[]});c.product.candidate_sources.push({keyword_id:'k',ad_id:'b'});
 try{const page=render(c);page.find(n=>n.dataset.mediaSource==='ad').click();await tick();const choose=page.find(n=>n.attributes['aria-label']==='选择当前商品的来源广告');choose.value='b';choose.dispatchEvent(new Event('change'));await tick();const visibleCopy=nodes(page).filter(n=>n.tagName==='BLOCKQUOTE'&&visible(n));assert.deepEqual(visibleCopy.map(n=>n.textContent),['Second bound copy']);}finally{c.life.dispose();}
});
test('discovery card sits under the checklist and retains confirmation, evidence and depth gates',()=>{
 for(const mode of ['unconfirmed','missing_source','limit','ready']){const c=fixture();if(mode!=='unconfirmed')c.product.identification.relevance_confirmed=true;if(['limit','ready'].includes(mode))c.product.expansion_sources=[{source_id:'s'}];if(mode==='limit')c.word.depth=3;
  try{const page=render(c),card=page.find(n=>n.className==='rw-lead-discovery'),checklist=page.find(n=>n.className==='rw-focus-evidence');assert.ok(card);assert.equal(card.parentElement,checklist.parentElement);assert.ok(card.parentElement.children.indexOf(card)>card.parentElement.children.indexOf(checklist));assert.equal(card.dataset.discoveryState,mode);assert.equal(Boolean(card.find(n=>n.textContent==='AI 提取搜索词')),mode==='ready');assert.equal(c.writes.length,0);}finally{c.life.dispose();}
 }
});

test('price display uses corrected saved observation with currency and grouping, not legacy truncated price',async()=>{
 const {productFacts}=await import('../../js/research-workbench/components/product-facts.mjs');
 const c=fixture();try{c.product.landing_snapshot.price='124';c.product.landing_snapshot.price_observation={amount:'1249.00',currency:'USD',source:'sale_text',reparsed_saved_evidence:true};const card=productFacts(c,c.product);assert.ok(nodes(card).some(n=>n.textContent==='USD 1,249.00'));assert.ok(!nodes(card).some(n=>n.textContent==='124'));}finally{c.life.dispose();}
});

test('unresolved corrected price never falls back to the stored truncated amount',async()=>{
 const {productFacts}=await import('../../js/research-workbench/components/product-facts.mjs');const c=fixture();try{c.product.landing_snapshot.price='124';c.product.landing_snapshot.price_observation={amount:null,currency:null};const card=productFacts(c,c.product);assert.ok(nodes(card).some(n=>n.textContent==='未获取售价'));assert.ok(!nodes(card).some(n=>n.textContent==='124'));}finally{c.life.dispose();}
});

test('product details immediately follow gallery, with read status and logs after the facts',()=>{
 const c=fixture();try{const page=render(c),panel=page.find(n=>n.dataset.leadContent==='product');assert.equal(panel.children[0].className,'rw-product-facts');assert.equal(panel.children[1].dataset.productPageStatus,'true');}finally{c.life.dispose();}
});

test('candidate names label bound ad page names without mislabelling manually named products',async()=>{
 const {renderCandidateList}=await import('../../js/research-workbench/components/presentation.mjs');const c=fixture();
 try{const list=renderCandidateList(c,[{id:'a',name:'Quick Covers',candidate_sources:[{keyword_id:'k',ad_id:'a',advertiser:'Quick Covers'}]},{id:'b',name:'手动录入的车灯',candidate_sources:[{advertiser:'Quick Covers'}]}],'a',()=>{});const rows=nodes(list).filter(n=>n.dataset.candidateId);assert.ok(nodes(rows[0]).some(n=>n.textContent==='广告主页'));assert.ok(nodes(rows[0]).some(n=>n.textContent==='Quick Covers'));assert.ok(nodes(rows[1]).some(n=>n.textContent==='商品名称'));assert.ok(!nodes(rows[1]).some(n=>n.textContent==='广告主页'));}finally{c.life.dispose();}
});

test('saved mismatch shows its reason and correction action while blocking keyword expansion',()=>{
 const c=fixture();c.product.identification={relevance_confirmed:false,relevance_result:'mismatch',reason:'广告为另一型号'};c.product.expansion_sources=[{source_id:'s'}];try{const page=render(c);assert.ok(nodes(page).some(n=>n.textContent==='不一致原因：广告为另一型号'));assert.ok(nodes(page).some(n=>n.textContent==='重新核对商品与广告'));assert.ok(!nodes(page).some(n=>n.textContent==='AI 提取搜索词'));assert.ok(nodes(page).some(n=>n.textContent==='人工确认不一致'));}finally{c.life.dispose();}
});

test('keyword selector displays Chinese meaning while keeping IDs and original search text unchanged',()=>{
 const c=fixture();c.word.text='"wall repair kit"';c.word.meaning='墙面修补套件';try{const page=render(c),select=page.find(n=>n.attributes['aria-label']==='切换搜索词');assert.equal(select.value,'k');assert.equal(select.children[0].value,'k');assert.match(select.children[0].textContent,/wall repair kit.*墙面修补套件/);assert.ok(nodes(page).some(n=>n.textContent==='中文释义：墙面修补套件'));assert.equal(c.word.text,'"wall repair kit"');assert.equal(c.writes.length,0);}finally{c.life.dispose();}
});
test('missing keyword meaning is disclosed without automatic translation requests',()=>{
 const c=fixture();try{const page=render(c);assert.ok(nodes(page).some(n=>n.textContent.includes('中文释义待补充')));assert.equal(c.writes.length,0);}finally{c.life.dispose();}
});

test('variant prices show range, package totals and per-piece estimates without changing business data',async()=>{const {productFacts}=await import('../../js/research-workbench/components/product-facts.mjs');const c=fixture();try{c.product.landing_snapshot.price_observation={amount:null,currency:null,ranges:[{currency:'USD',min:'29.99',max:'109.99'}],options:[{id:'one',label:'Buy 1',amount:'29.99',currency:'USD',quantity:1,unit_amount:'29.99'},{id:'three',label:'Buy 2 Get 1 Free (3 Pcs)',amount:'59.99',currency:'USD',quantity:3,unit_amount:'20.00'},{id:'six',label:'Buy 4 Get 2 Free (6 Pcs)',amount:'109.99',currency:'USD',quantity:6,unit_amount:'18.33'}]};const before=JSON.stringify(c.product),card=productFacts(c,c.product);assert.ok(nodes(card).some(n=>n.textContent==='USD 29.99–109.99 · 多套餐'));assert.ok(nodes(card).some(n=>n.textContent==='USD 20.00 / 件'));const select=nodes(card).find(n=>n.attributes['aria-label']==='查看套餐价格');select.value='three';select.dispatchEvent(new Event('change'));assert.ok(nodes(card).some(n=>n.textContent==='USD 59.99'));assert.equal(JSON.stringify(c.product),before);assert.equal(c.writes.length,0);}finally{c.life.dispose();}});

test('mixed currency variants do not form a misleading combined price range or invent quantities',async()=>{const {productFacts}=await import('../../js/research-workbench/components/product-facts.mjs');const c=fixture();try{c.product.landing_snapshot.price_observation={amount:null,ranges:[{currency:'USD',min:'10.00',max:'10.00'},{currency:'CAD',min:'20.00',max:'20.00'}],options:[{id:'a',label:'Small',amount:'10.00',currency:'USD',quantity:null,unit_amount:null},{id:'b',label:'Large',amount:'20.00',currency:'CAD',quantity:null,unit_amount:null}]};const card=productFacts(c,c.product);assert.ok(nodes(card).some(n=>n.textContent==='多套餐 · 多币种'));assert.ok(nodes(card).some(n=>n.textContent==='件数待核对'));assert.ok(!nodes(card).some(n=>n.textContent==='USD 10.00–20.00'));}finally{c.life.dispose();}});
