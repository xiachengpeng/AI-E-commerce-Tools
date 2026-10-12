import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../js/research-workbench/api.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
import { createState } from '../../js/research-workbench/state.mjs';
import { createWorkbench } from '../../js/research-workbench/index.mjs';

test('API pins native 9503 routes, authenticates reads and never repeats mutations', async () => {
 const calls=[];
 const api=createApi({apiBase:'http://127.0.0.1:9503',fetch:async(url,options)=>{calls.push([url,options]); if(url.endsWith('/session'))return {ok:true,json:async()=>({csrf_token:'fixture'})}; throw Error('offline');}});
 await api.session();
 await assert.rejects(api.request('/projects',{method:'POST',body:{command_id:'one'}}),/offline/);
 assert.equal(calls.length,2); assert.equal(calls[1][0],'http://127.0.0.1:9503/api/research/workbench/v1/projects');
 assert.equal(calls[1][1].headers['X-Research-Token'],'fixture');
 await assert.rejects(api.request('//remote/path'),/path/);
 assert.throws(()=>createApi({apiBase:'https://example.com'}),/9503/);
});

test('state belongs to one mounted instance',()=>{const a=createState(),b=createState();a.projects.push({id:'a'});assert.deepEqual(b.projects,[]);});

test('lifecycle closes streams, polling, listeners and requests once',()=>{
 const life=createLifecycle(); const target=new EventTarget();let count=0,closed=0;
 life.listen(target,'change',()=>count++);life.track(()=>closed++);
 life.poll(()=>count++,1000);target.dispatchEvent(new Event('change'));life.dispose();life.dispose();
 target.dispatchEvent(new Event('change'));assert.equal(count,1);assert.equal(closed,1);assert.equal(life.signal.aborted,true);assert.equal(life.active,false);
});

function root(){ const status={textContent:''},list={replaceChildren(){},textContent:''};const value=new EventTarget();value.innerHTML='';value.querySelector=s=>s==='[data-rw-status]'?status:list;value.ownerDocument={createElement:()=>({dataset:{},append(){},textContent:''})};return value; }
test('mount deduplicates and unmount aborts; failed refresh keeps last successful projects',async()=>{
 const host=root();let calls=0,fail=false;const workbench=createWorkbench();
 const context={fetch:async(url)=>{calls++;if(url.endsWith('/session'))return {ok:true,json:async()=>({csrf_token:'fixture'})};if(fail)throw Error('offline');return {ok:true,json:async()=>({projects:[{id:'a',title:'Saved'}]})};}};
 await workbench.mount(host,context);const old=workbench.state.projects;await workbench.mount(host,context);assert.equal(calls,2);
 fail=true;await workbench.refresh();assert.equal(workbench.state.projects,old);
 workbench.unmount();assert.equal(workbench.state,null);
});

test('late session completion after unmount cannot read projects or mutate the root',async()=>{
 let release;let calls=0;const host=root();const workbench=createWorkbench();
 const pending=workbench.mount(host,{fetch:async()=>{calls++;return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({csrf_token:'fixture'})});});}});
 workbench.unmount();release();await pending;assert.equal(calls,1);assert.equal(workbench.state,null);
});

test('different workbenches keep independent roots and session tokens',async()=>{
 const seen=[];
 const transport=token=>async(url,options)=>{seen.push(options.headers['X-Research-Token']);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:token}:{projects:[]}};};
 const a=createWorkbench(),b=createWorkbench();await a.mount(root(),{fetch:transport('a')});await b.mount(root(),{fetch:transport('b')});
 assert.deepEqual(seen,['','a','','b']);a.unmount();assert.deepEqual(b.state.projects,[]);b.unmount();
});

test('lifecycle stops a real interval and closes a registered stream',async()=>{
 const life=createLifecycle();let count=0,closed=0;
 life.poll(()=>count++,5);life.stream({close(){closed++;}});
 await new Promise(resolve=>setTimeout(resolve,20));assert.ok(count>0);
 life.dispose();const stopped=count;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(count,stopped);assert.equal(closed,1);
});

test('API authenticates GET reads and rejects redirected and remote requests',async()=>{
 const seen=[];const api=createApi({apiBase:'http://localhost:9503/api/research/workbench/v1',fetch:async(url,options)=>{seen.push([url,options]);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'read-token'}:{projects:[]}};}});
 await api.session();await api.request('/projects');assert.equal(seen[1][1].headers['X-Research-Token'],'read-token');assert.equal(seen[1][1].redirect,'error');
 await assert.rejects(api.request('/%2e%2e/projects'),/path/);await assert.rejects(api.request('https://example.com'),/path/);
});

test('returning to the same root keeps successful state when the next session is offline',async()=>{
 const host=root(),workbench=createWorkbench();
 await workbench.mount(host,{fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:{projects:[{id:'saved',title:'Saved'}]}})});
 workbench.unmount();await workbench.mount(host,{fetch:async()=>{throw Error('offline');}});
 assert.equal(workbench.state.projects[0]?.id,'saved');workbench.unmount();
});

test('a different root does not inherit cached successful projects',async()=>{
 const workbench=createWorkbench();await workbench.mount(root(),{fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:{projects:[{id:'saved'}]}})});
 workbench.unmount();await workbench.mount(root(),{fetch:async()=>{throw Error('offline');}});assert.deepEqual(workbench.state.projects,[]);workbench.unmount();
});

test('late project response from an old root cannot paint or overwrite a newer mount',async()=>{
 const workbench=createWorkbench();let release;let readStarted;
 const started=new Promise(resolve=>{readStarted=resolve;});
 const pending=workbench.mount(root(),{fetch:async url=>{
  if(url.endsWith('/session'))return {ok:true,json:async()=>({csrf_token:'old'})};
  readStarted();return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({projects:[{id:'old'}]})});});
 }});
 await started;await workbench.mount(root(),{fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'new'}:{projects:[{id:'new'}]}})});
 release();await pending;assert.equal(workbench.state.projects[0].id,'new');workbench.unmount();
});

test('cached DTOs are independent from a detached prior instance',async()=>{
 const host=root(),workbench=createWorkbench();await workbench.mount(host,{fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:{projects:[{id:'saved',title:'Saved'}]}})});
 const detached=workbench.state;workbench.unmount();detached.projects[0].title='late mutation';
 await workbench.mount(host,{fetch:async()=>{throw Error('offline');}});assert.equal(workbench.state.projects[0].title,'Saved');workbench.unmount();
});
