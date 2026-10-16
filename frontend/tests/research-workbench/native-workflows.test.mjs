import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRoot } from './dom-fixture.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
import { renderActions } from '../../js/research-workbench/pages/actions.mjs';
import { render as exploration } from '../../js/research-workbench/pages/exploration.mjs';
import { renderProduct } from '../../js/research-workbench/pages/product.mjs';
const tick=()=>new Promise(r=>setTimeout(r,20));
const find=(root,text)=>root.find(n=>n.tagName==='BUTTON'&&n.textContent===text);
function fixture(handler=()=>({})){
 const root=fixtureRoot();root.innerHTML='<p data-rw-status></p>';const calls=[];
 const c={root,life:createLifecycle(),state:{project:{id:'p',version:7,market:'DE',title:'Research',keywords:[{id:'k',text:'travel',approved:true}],products:[{id:'x',name:'Source',source_keyword_ids:['k'],identification:{},triage:{state:'pending'}}]},actions:[],commands:{},product:'x',step:'channels'},api:{request:async(path,options={})=>{calls.push({path,...options});if(path==='/sources')return {sources:[]};if(path.endsWith('/events'))return {events:[]};if(path.includes('/actions?'))return {actions:[]};return handler(path,options);}},navigate:()=>{},showQueue:selection=>{c.state.queueSelection=selection;},selectProduct:()=>{},openForm:()=>{},command:()=>{}};
 return {c,calls};
}
test('native Trends initial merchant workflow preserves explicit market query, identity and one enqueue',async()=>{
 const {c,calls}=fixture(()=>({disposition:'created'}));
 try{const product=renderProduct(c);find(product,'自动查 Trends').click();await tick();assert.deepEqual(c.state.queueSelection,{kind:'trends',product_id:'x'});
 const queue=renderActions(c);await tick();assert.equal(calls.filter(v=>v.method==='POST').length,0);
 const input=queue.find(n=>n.name==='initial_trends_query');assert.ok(input,'initial explicit query input');assert.ok(queue.find(n=>n.textContent.includes('DE')));
 const submit=find(queue,'确认提交：采集 Trends');submit.click();await tick();assert.equal(calls.filter(v=>v.method==='POST').length,0);
 input.value='  Reisetasche für Hunde  ';input.dispatchEvent(new Event('input'));submit.click();await tick();
 const posts=calls.filter(v=>v.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/projects/p/actions');assert.equal(posts[0].body.product_id,'x');assert.equal(posts[0].body.query,'Reisetasche für Hunde');assert.equal(posts[0].body.version,7);assert.match(posts[0].body.command_id,/^[a-f0-9-]{36}$/);assert.equal(c.state.project.market,'DE');
 }finally{c.life.dispose();}
});
test('native Trends uncertain submit preserves typed input and forbids automatic duplicate or changed replay',async()=>{
 const {c,calls}=fixture(()=>{throw Error('lost reply');});c.state.queueSelection={kind:'trends',product_id:'x'};
 try{const queue=renderActions(c);const input=queue.find(n=>n.name==='initial_trends_query');assert.ok(input);input.value='Hunde Tasche';input.dispatchEvent(new Event('input'));const submit=find(queue,'确认提交：采集 Trends');submit.click();await tick();assert.equal(input.value,'Hunde Tasche');assert.equal(calls.filter(v=>v.method==='POST').length,1);input.value='different';input.dispatchEvent(new Event('input'));submit.click();await tick();assert.equal(calls.filter(v=>v.method==='POST').length,1);}finally{c.life.dispose();}
});
test('native verification initial review stop and deliberate mismatch parking preserve contracts',async()=>{
 const {c,calls}=fixture((path,options)=>options.body?.action?{...c.state.project,version:8}:structuredClone(c.state.project));const product=c.state.project.products[0];product.verification={status:'mismatch',reason:'Source differs',checked_at:'t'};
 c.command=async(action,payload)=>{calls.push({command:action,payload});};
 try{let page=exploration(c);assert.equal(calls.filter(v=>v.method).length,0);const mode=page.find(n=>n.attributes['aria-label']==='自动核对的商品页读取方式');assert.ok(mode);mode.value='firecrawl';mode.dispatchEvent(new Event('change'));find(page,'自动核对当前词').click();await tick();assert.deepEqual(c.state.queueSelection,{kind:'verify',keyword_id:'k',landing_mode:'firecrawl'});
 let queue=renderActions(c);find(queue,'确认提交：核对商品').click();await tick();assert.equal(calls.find(v=>v.method==='POST').body.landing_mode,'firecrawl');
 page=exploration(c);find(page,'重新核对疑点').click();await tick();assert.equal(c.state.queueSelection.retry_review,true);queue=renderActions(c);find(queue,'确认提交：核对商品').click();await tick();assert.equal(calls.filter(v=>v.method==='POST').at(-1).body.retry_review,true);
 c.state.verificationActions={k:{id:'verify',kind:'verify',status:'running',attempt:3,progress:{complete:1,total:2,failed:0}}};page=exploration(c);assert.ok(page.find(n=>n.textContent.includes('1/2')));find(page,'停止自动核对').click();await tick();const stop=calls.find(v=>v.path==='/projects/p/actions/verify/stop');assert.deepEqual(stop.body,{attempt:3,version:7});
 c.state.verificationActions={};page=exploration(c);const filter=page.find(n=>n.name==='verification_review_only');assert.ok(filter);filter.checked=true;filter.dispatchEvent(new Event('change'));assert.equal(c.state.focusReviewOnly.k,true);
 find(page,'批量跳过不相关线索（1）').click();await tick();assert.equal(calls.find(v=>v.body?.action==='triage_product')?.body.action,'triage_product');assert.equal(calls.find(v=>v.body?.action==='triage_product').body.payload.disposition,'observing');assert.equal(product.identification.relevance_confirmed,undefined);
 }finally{c.life.dispose();}
});
test('native Feishu status preview exact approval stale rejection and original blocked retry have no entry mutations',async()=>{
 let previewCalls=0;const {c,calls}=fixture((path,options)=>{
 if(path.endsWith('/sync')&&!options.method)return {runs:[{id:'r',version:5,status:'blocked',message:'retry original',error_code:'retryable'},{id:'u',version:4,status:'blocked',error_code:'unknown_write',message:'manual guard'}]};
 if(path.endsWith('/preview')){previewCalls++;return {version:7,digest:'exact',records:3,tables:[{name:'summary',exists:true}]};}
 if(path.endsWith('/sync')&&options.method){const error=Error('preview stale');error.status=409;throw error;}return {};
 });
 try{const page=exploration(c);const entry=find(page,'飞书同步与状态');assert.ok(entry);entry.click();await tick();assert.equal(c.state.view,'sync');const {renderSync}=await import('../../js/research-workbench/pages/sync.mjs');const sync=renderSync(c);await tick();assert.equal(calls.filter(v=>v.method).length,0);assert.ok(sync.find(n=>n.textContent.includes('版本 5')));
 find(sync,'预览当前版本同步').click();await tick();assert.equal(previewCalls,1);assert.deepEqual(calls.find(v=>v.path.endsWith('/preview')).body,{version:7});find(sync,'确认同步此版本').click();await tick();assert.deepEqual(calls.find(v=>v.path.endsWith('/sync')&&v.method).body,{version:7,digest:'exact'});assert.equal(find(sync,'确认同步此版本'),null);
 find(sync,'重新核对并重试').click();await tick();assert.ok(calls.find(v=>v.path==='/projects/p/sync/r/retry'));assert.equal(calls.filter(v=>v.path==='/projects/p/sync/u/retry').length,0);
 }finally{c.life.dispose();}
});
test('native progress refresh consumes projections outside first twenty, preserves edits and cleans poll with late scope fence',async()=>{
 const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval;let poll,cleared=0,release;globalThis.setInterval=fn=>{poll=fn;return 91;};globalThis.clearInterval=id=>{if(id===91)cleared++;};
 const {c}=fixture();c.state.step='identification';c.state.productActions={x:{id:'landing',kind:'landing',product_id:'x',status:'ready',attempt:1}};let refreshed=0;c.refreshProject=async()=>{refreshed++;};
 try{renderProduct(c);assert.equal(typeof poll,'function','active product view owns a poll');await poll();assert.equal(refreshed,1);c.life.dispose();assert.equal(cleared,1);
 const {createSnapshotRefresher}=await import('../../js/research-workbench/services/snapshot.mjs');const f=fixture();let draw=0;f.c.redraw=()=>draw++;f.c.editing=true;
 f.c.api.request=async path=>path.includes('/actions?')?{actions:[],product_actions:{x:{id:'outside20',status:'complete'}},verification_actions:{k:{id:'v',status:'complete'}},keyword_actions:{}}:{...f.c.state.project,version:8,products:[{id:'x',name:'completed'}]};
 const refresh=createSnapshotRefresher(f.c);await refresh();assert.equal(f.c.state.project.products[0].name,'completed');assert.equal(f.c.state.productActions.x.id,'outside20');assert.equal(draw,0);f.c.editing=false;f.c.state.project.version=7;await refresh();assert.equal(draw,1);
 f.c.api.request=async()=>new Promise(r=>release=r);const pending=refresh();f.c.state.project={id:'other',version:1};release({id:'p',version:9});await pending;assert.equal(f.c.state.project.id,'other');f.c.life.dispose();
 }finally{c.life.dispose();globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;}
});
test('native Feishu ambiguous approval submits once and missing credentials remain actionable',async()=>{
 let ambiguous=false;const {c,calls}=fixture((path,o)=>{if(path.endsWith('/sync')&&!o.method)return {runs:[]};if(path.endsWith('/preview'))return {version:7,digest:'same',records:1,tables:[]};ambiguous=true;throw Error('lost');});
 try{const {renderSync}=await import('../../js/research-workbench/pages/sync.mjs');let page=renderSync(c);await tick();find(page,'预览当前版本同步').click();await tick();find(page,'确认同步此版本').click();await tick();assert.equal(ambiguous,true);
 page=renderSync(c);find(page,'预览当前版本同步').click();await tick();find(page,'确认同步此版本').click();await tick();assert.equal(calls.filter(v=>v.path==='/projects/p/sync'&&v.method==='POST').length,1);
 c.api.request=async()=>{const e=Error('凭据未配置');e.status=503;throw e;};renderSync(c);await tick();assert.match(c.root.querySelector('[data-rw-status]').textContent,/研究与集成.*凭据/);
 }finally{c.life.dispose();}
});
test('native verification unknown outcome never enables new verify or review replay',()=>{
 const {c,calls}=fixture();try{c.state.verificationActions={k:{id:'v',status:'blocked',display_status:'manual_check',recovery_action:'manual'}};const page=exploration(c);assert.equal(find(page,'自动核对当前词').disabled,true);assert.equal(find(page,'重新核对疑点'),null);assert.equal(calls.filter(v=>v.method).length,0);}finally{c.life.dispose();}
});
test('native mismatch batch saves every eligible original product with progressive versions and retains partial failure identity',async()=>{
 const {c,calls}=fixture();c.state.project.products=[1,2].map(n=>({id:'x'+n,name:'Mismatch '+n,source_keyword_ids:['k'],identification:{},triage:{state:'pending'},verification:{status:'mismatch',reason:'different '+n,checked_at:'t'}}));
 const authoritative=structuredClone(c.state.project);let fail=true;
 c.api.request=async(path,options={})=>{calls.push({path,...options});if(!options.method)return structuredClone(authoritative);if(options.body.payload.product_id==='x2'&&fail)throw Error('lost second');authoritative.version++;authoritative.products.find(p=>p.id===options.body.payload.product_id).triage={state:'observing'};return structuredClone(authoritative);};
 try{let page=exploration(c);find(page,'批量跳过不相关线索（2）').click();await tick();assert.equal(calls.filter(v=>v.method==='POST').length,2);assert.deepEqual(calls.filter(v=>v.method==='POST').map(v=>v.body.version),[7,8]);assert.equal(c.state.project.products[0].triage.state,'observing');assert.match(c.root.querySelector('[data-rw-status]').textContent,/lost second/);const original=calls.filter(v=>v.method==='POST')[1].body.command_id;
 fail=false;page=exploration(c);find(page,'批量跳过不相关线索（1）').click();await tick();const posts=calls.filter(v=>v.method==='POST');assert.equal(posts.length,3);assert.equal(posts[2].body.command_id,original);assert.equal(posts[2].body.payload.product_id,'x2');assert.equal(c.state.project.products[1].triage.state,'observing');}finally{c.life.dispose();}
});
test('native Feishu successful approval refreshes durable status and stale local preview never submits',async()=>{
 let runs=[];const {c,calls}=fixture((path,o)=>{if(path.endsWith('/sync')&&!o.method)return {runs};if(path.endsWith('/preview'))return {version:c.state.project.version,digest:'v'+c.state.project.version,records:2,tables:[{name:'Products',exists:false}]};runs=[{id:'approved',version:o.body.version,status:'ready',message:'queued'}];return runs[0];});
 try{const {renderSync}=await import('../../js/research-workbench/pages/sync.mjs');let page=renderSync(c);await tick();find(page,'预览当前版本同步').click();await tick();find(page,'确认同步此版本').click();await tick();assert.ok(page.find(n=>n.textContent==='版本 7 · ready'));assert.equal(calls.filter(v=>v.path.endsWith('/sync')&&v.method==='POST').length,1);
 page=renderSync(c);find(page,'预览当前版本同步').click();await tick();c.state.project.version=8;find(page,'确认同步此版本').click();await tick();assert.equal(calls.filter(v=>v.path.endsWith('/sync')&&v.method==='POST').length,1);assert.equal(find(page,'确认同步此版本'),null);
 }finally{c.life.dispose();}
});
test('native late sync preview and status after project switch cannot approve or overwrite current page',async()=>{
 let finish;const {c}=fixture(()=>new Promise(r=>finish=r));const {renderSync}=await import('../../js/research-workbench/pages/sync.mjs');
 try{const page=renderSync(c);c.state.project={id:'other',version:1};finish({runs:[{id:'late',version:7,status:'blocked'}]});await tick();assert.equal(page.find(n=>n.textContent==='版本 7 · blocked'),null);
 c.state.project={id:'p',version:7};find(page,'预览当前版本同步').click();await tick();c.life.dispose();finish({version:7,digest:'late',records:9,tables:[]});await tick();assert.equal(find(page,'确认同步此版本'),null);
 }finally{c.life.dispose();}
});
test('native actual workbench queue completion and return refresh project without mutation or global refresh',async()=>{
 const {createWorkbench}=await import('../../js/research-workbench/index.mjs');const root=fixtureRoot(),wb=createWorkbench(),requests=[];let current;
 let project={id:'p',version:7,title:'Merchant',market:'DE',keywords:[{id:'k',text:'travel',approved:true}],products:[{id:'x',name:'Before',source_keyword_ids:['k'],identification:{}}]};
 const fetch=async(url,o)=>{requests.push({url,method:o.method});let data=url.endsWith('/session')?{csrf_token:'fake'}:url.endsWith('/projects/p')?structuredClone(project):url.includes('/actions?')?{actions:[],verification_actions:{k:{id:'v',status:'complete'}},product_actions:{x:{id:'beyond20',status:'complete'}}}:url.endsWith('/sources')?{sources:[]}:url.endsWith('/events')?{events:[]}:{projects:[structuredClone(project)]};return {ok:true,json:async()=>data};};
 try{await wb.mount(root,{fetch,onSelectProject:(id,c)=>current=c});find(root.querySelector('[data-rw-projects]'),'Merchant').click();await tick();assert.equal(wb.state.verificationActions.k.id,'v');current.showQueue();await tick();project={...project,version:8,products:[{...project.products[0],name:'Authoritative result'}]};find(root.querySelector('[data-rw-page]'),'刷新任务状态').click();await tick();assert.equal(wb.state.project.products[0].name,'Authoritative result');find(root.querySelector('[data-rw-page]'),'返回探索').click();await tick();assert.ok(root.querySelector('[data-rw-page]').find(n=>n.textContent==='Authoritative result'));assert.equal(wb.state.productActions.x.id,'beyond20');assert.equal(requests.some(r=>r.method!=='GET'),false);}finally{wb.unmount();}
});
test('native polling preserves the current dirty product form DOM and its original submission version',async()=>{
 const {createSnapshotRefresher}=await import('../../js/research-workbench/services/snapshot.mjs');const {c,calls}=fixture();c.context={};c.state.drafts={};c.state.projects=[];c.state.step='review';
 const before=structuredClone(c.state.project);let latest={...before,version:8};c.api.request=async(path,o={})=>{calls.push({path,...o});if(o.method==='POST'){const e=Error('stale');e.status=409;throw e;}return path.includes('/actions?')?{actions:[]}:latest;};
 try{let redraw=0;c.redraw=()=>redraw++;const page=renderProduct(c);find(page,'记录复盘与下一轮建议').click();await tick();const input=page.find(n=>n.name==='conclusion');input.value='My unsaved careful conclusion';input.dispatchEvent(new Event('input'));const form=page.querySelector('form');await createSnapshotRefresher(c)();assert.equal(c.state.project.version,8);assert.ok(page.querySelector('form')===form,'same dirty form remains mounted');assert.equal(input.value,'My unsaved careful conclusion');assert.equal(redraw,0);
 form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();const posted=calls.find(v=>v.method==='POST');assert.equal(posted.body.version,7);assert.equal(posted.body.payload.conclusion,'My unsaved careful conclusion');assert.equal(input.value,'My unsaved careful conclusion');assert.equal(calls.filter(v=>v.method==='POST').length,1);
 }finally{c.life.dispose();}
});
test('native dirty form remount keeps saved base version after authoritative background update',async()=>{
 const {createForm}=await import('../../js/research-workbench/components/forms.mjs');const {c}=fixture();c.context={};c.state.drafts={};
 try{const defs=[{key:'note',label:'Research note',type:'text'}];const first=createForm(c,{title:'Edit',key:'edit',defs,submit(){}});first.inputs.get('note').value='Unsaved facts';first.persist();c.state.project.version=8;const restored=createForm(c,{title:'Edit',key:'edit',defs,submit(){}});assert.equal(restored.inputs.get('note').value,'Unsaved facts');assert.equal(restored.draft.version,7);}finally{c.life.dispose();}
});
test('native header refresh keeps open product form edits and captured base version',async()=>{
 const {createWorkbench}=await import('../../js/research-workbench/index.mjs');const root=fixtureRoot(),wb=createWorkbench();let project={id:'p',version:7,title:'Merchant',market:'DE',keywords:[],products:[{id:'x',name:'Before',identification:{}}]};
 const fetch=async(url,o)=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?structuredClone(project):url.includes('/actions?')?{actions:[]}:{projects:[structuredClone(project)]}});
 try{await wb.mount(root,{fetch});find(root.querySelector('[data-rw-projects]'),'Merchant').click();await tick();wb.openProduct('p','x','review');const page=root.querySelector('[data-rw-page]');find(page,'记录复盘与下一轮建议').click();await tick();const input=page.find(n=>n.name==='conclusion');input.value='Keep these edits';input.dispatchEvent(new Event('input'));const form=page.querySelector('form');project={...project,version:8};await wb.refresh();assert.ok(page.querySelector('form')===form,'same dirty form remains mounted');assert.equal(input.value,'Keep these edits');assert.equal(Object.values(wb.state.drafts)[0].version,7);}finally{wb.unmount();}
});
test('native mismatch partial failure remains visible when redraw disposes the old page',async()=>{
 const {c}=fixture();c.state.project.products[0].verification={status:'mismatch',reason:'different',checked_at:'t'};c.api.request=async(path,o={})=>{if(o.method)throw Error('partial save unconfirmed');return structuredClone(c.state.project);};c.redraw=()=>c.life.dispose();
 try{const page=exploration(c);find(page,'批量跳过不相关线索（1）').click();await tick();assert.match(c.root.querySelector('[data-rw-status]').textContent,/partial save unconfirmed/);}finally{c.life.dispose();}
});
test('native Feishu uncertain_create explicit retry preserves original checkpoint run and never starts a new sync',async()=>{
 const {c,calls}=fixture((path,o)=>!o.method?{runs:[{id:'checkpoint-run',version:3,status:'blocked',error_code:'uncertain_create',message:'unconfirmed create'}]}:{id:'checkpoint-run',version:3,status:'ready'});
 try{const {renderSync}=await import('../../js/research-workbench/pages/sync.mjs');const page=renderSync(c);await tick();assert.ok(page.find(n=>n.textContent.includes('先核对远端检查点')));assert.equal(calls.filter(v=>v.method).length,0);find(page,'重新核对并重试').click();await tick();const posts=calls.filter(v=>v.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/projects/p/sync/checkpoint-run/retry');assert.deepEqual(posts[0].body,{});assert.equal(calls.some(v=>v.path==='/projects/p/sync'&&v.method==='POST'),false);}finally{c.life.dispose();}
});
test('native in-flight mismatch remount releases transient lock but preserves uncertain command identity',async()=>{
 const {createWorkbench}=await import('../../js/research-workbench/index.mjs');const root=fixtureRoot(),wb=createWorkbench(),sent=[];let release;
 const project={id:'p',version:7,title:'Merchant',market:'DE',keywords:[{id:'k',text:'travel'}],products:[{id:'x',name:'Mismatch',source_keyword_ids:['k'],identification:{},triage:{state:'pending'},verification:{status:'mismatch',reason:'different',checked_at:'t'}}]};
 const fetch=async(url,o)=>{if(o.method==='POST'){sent.push(JSON.parse(o.body));if(sent.length===1)return new Promise((_,reject)=>release=()=>reject(Error('lost first reply')));throw Error('still uncertain');}return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?structuredClone(project):url.includes('/actions?')?{actions:[]}:{projects:[structuredClone(project)]}};};
 try{await wb.mount(root,{fetch});find(root.querySelector('[data-rw-projects]'),'Merchant').click();await tick();find(root.querySelector('[data-rw-page]'),'批量跳过不相关线索（1）').click();await tick();assert.equal(sent.length,1);wb.unmount();release();await tick();await wb.mount(root,{fetch});find(root.querySelector('[data-rw-page]'),'批量跳过不相关线索（1）').click();await tick();assert.equal(sent.length,2);assert.equal(sent[0].command_id,sent[1].command_id);assert.equal(sent[1].version,7);}finally{wb.unmount();}
});
