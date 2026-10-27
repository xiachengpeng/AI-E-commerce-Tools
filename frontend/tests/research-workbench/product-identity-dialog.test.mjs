import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {createState} from '../../js/research-workbench/state.mjs';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const until=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,1));assert.ok(predicate(),'asynchronous operation completed');};
const nodes=n=>[n,...n.children.flatMap(nodes)];
function project(){return {id:'r',version:4,title:'Identity project',market:'US',keywords:[{id:'k',text:'repair',status:'complete',ads:[]}],products:[{id:'p',name:'Widget',url:'https://shop.example/product',identity_revision:1,revision:1,source_keyword_ids:['k'],candidate_sources:[],identification:{},steps:['identification','coarse','channels','economics','decision'].map(key=>({key,label:key,state:'pending'}))}]};}
function fixture(){const state={...createState(),project:project(),view:'project',projectSection:'leads'},calls=[];return {root:fixtureRoot(),life:createLifecycle(),context:{},state,calls,navigate:v=>calls.push(v),openForm(){},showQueue(){},command(){},api:{request:async()=>{throw Error('Unexpected request');}}};}

test('lead identity opens a modal without replacing the research page or issuing a request',async()=>{
 const root=fixtureRoot(),wb=createWorkbench(),p=project(),requests=[];
 try{await wb.mount(root,{fetch:async(url,o)=>{requests.push(o.method);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/r')?p:url.includes('/actions?')?{actions:[]}:{projects:[p]}};}});
  nodes(root).find(n=>n.tagName==='BUTTON'&&n.textContent==='继续选品').click();await tick();const before=wb.state.view,background=nodes(root).find(n=>n.dataset.rwPage!==undefined).children[0];
  const trigger=nodes(root).find(n=>n.tagName==='BUTTON'&&n.textContent==='核对商品与广告');assert.ok(trigger);
  const controls=nodes(root).find(n=>n.className==='rw-focus-controls'),checklist=nodes(root).find(n=>n.className==='rw-focus-evidence');assert.ok(controls);assert.equal(controls.parentElement,checklist.parentElement);assert.ok(controls.parentElement.children.indexOf(controls)<controls.parentElement.children.indexOf(checklist));assert.ok(nodes(controls).includes(trigger));assert.equal(nodes(controls).filter(n=>n.textContent==='下一条线索').length,1);assert.equal(nodes(root).filter(n=>n.className==='rw-lead-footer').length,0);
  trigger.focus();trigger.click();await tick();
  assert.equal(wb.state.view,before);assert.ok(nodes(root).find(n=>n.dataset.productIdentityDialog==='true'));assert.equal(nodes(root).find(n=>n.dataset.rwPage!==undefined).children[0],background);assert.ok(requests.every(m=>m==='GET'));
  nodes(root).find(n=>n.attributes['aria-label']==='关闭商品核对').click();await tick();assert.ok(!nodes(root).find(n=>n.dataset.productIdentityDialog==='true'));assert.equal(root.ownerDocument.activeElement,trigger);
 }finally{wb.unmount();}
});

test('modal reuses original identity payload, version and unchecked confirmation; save closes through success callback',async()=>{
 const {createProductIdentityDialog}=await import('../../js/research-workbench/components/product-identity-dialog.mjs');
 const c=fixture(),sent=[],saved=[];c.api.request=async(path,o)=>{sent.push(o.body);return {...c.state.project,version:5};};
 try{const d=createProductIdentityDialog(c,'p',{onCancel(){},onSaved:(p,id)=>saved.push([p.version,id])});const form=nodes(d.dialog).find(n=>n.tagName==='FORM');assert.ok(form);
  assert.equal(nodes(form).find(n=>n.name==='relevance_confirmed').checked,false);nodes(form).find(n=>n.name==='reason').value='Compared source';form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();await tick();
  assert.equal(sent.length,1);assert.equal(sent[0].action,'confirm_product');assert.equal(sent[0].version,4);assert.equal(sent[0].payload.product_id,'p');assert.equal(sent[0].payload.relevance_confirmed,false);assert.match(sent[0].command_id,/^[0-9a-f-]{36}$/);assert.deepEqual(saved,[[5,'p']]);
 }finally{c.life.dispose();}
});

test('saving blocks Escape/close; rejected save keeps inputs and submission identity in the modal',async()=>{
 const {createProductIdentityDialog}=await import('../../js/research-workbench/components/product-identity-dialog.mjs');
 const c=fixture();let reject,closed=0;const sent=[];c.api.request=async(path,o)=>{sent.push(o.body);return new Promise((resolve,r)=>reject=r);};
 try{const d=createProductIdentityDialog(c,'p',{onCancel:()=>closed++,onSaved(){throw Error('Must not succeed');}}),form=nodes(d.dialog).find(n=>n.tagName==='FORM');nodes(form).find(n=>n.name==='reason').value='Actual comparison';form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();
  const escape=new Event('cancel',{cancelable:true});d.dialog.dispatchEvent(escape);assert.equal(closed,0);assert.equal(escape.defaultPrevented,true);assert.equal(d.dialog.attributes['aria-busy'],'true');
  reject(Error('lost reply'));await tick();assert.equal(nodes(form).find(n=>n.name==='reason').value,'Actual comparison');assert.equal(d.dialog.attributes['aria-busy'],'false');assert.equal(closed,0);
  assert.ok(Object.values(c.state.drafts).some(v=>v.command_id===sent[0].command_id));
  form.dispatchEvent(new Event('submit',{cancelable:true}));await until(()=>sent.length===2);assert.equal(sent[0].command_id,sent[1].command_id);reject(Error('still offline'));await tick();
 }finally{c.life.dispose();}
});

test('version conflict refreshes only modal data and preserves entered values for explicit retry',async()=>{
 const {createProductIdentityDialog}=await import('../../js/research-workbench/components/product-identity-dialog.mjs');
 const c=fixture(),sent=[];let saved=0;c.api.request=async(path,o={})=>{if(o.method==='POST'){sent.push(o.body);if(sent.length===1)throw Object.assign(Error('Version conflict'),{status:409});return {...c.state.project,version:6};}return {...c.state.project,version:5};};
 try{const d=createProductIdentityDialog(c,'p',{onCancel(){},onSaved:()=>saved++}),form=nodes(d.dialog).find(n=>n.tagName==='FORM');nodes(form).find(n=>n.name==='reason').value='Compared product specification';form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();await tick();assert.equal(saved,0);assert.equal(c.state.project.version,4);assert.equal(nodes(form).find(n=>n.name==='reason').value,'Compared product specification');
  form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();await tick();assert.equal(saved,1);assert.equal(sent[1].version,5);
 }finally{c.life.dispose();}
});

test('disposed modal ignores late success and retains the background project',async()=>{
 const {createProductIdentityDialog}=await import('../../js/research-workbench/components/product-identity-dialog.mjs');
 const c=fixture();let finish,saved=0;c.api.request=()=>new Promise(r=>finish=r);
 const d=createProductIdentityDialog(c,'p',{onCancel(){},onSaved(){saved++;}}),form=nodes(d.dialog).find(n=>n.tagName==='FORM');form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();d.close({restoreFocus:false});finish({...c.state.project,version:5});await tick();assert.equal(saved,0);assert.equal(c.state.project.version,4);c.life.dispose();
});

test('mismatch is an explicit saved outcome with false relevance and a correction path',async()=>{
 const {createProductIdentityDialog}=await import('../../js/research-workbench/components/product-identity-dialog.mjs');const c=fixture(),sent=[];c.api.request=async(path,o)=>{sent.push(o.body);return {...c.state.project,version:5};};
 try{const d=createProductIdentityDialog(c,'p',{onCancel(){},onSaved(){}}),form=nodes(d.dialog).find(n=>n.tagName==='FORM'),result=nodes(form).find(n=>n.name==='relevance_result');assert.ok(result);assert.deepEqual(result.children.map(n=>n.value),['unverified','matched','mismatch']);result.value='mismatch';result.dispatchEvent(new Event('change'));nodes(form).find(n=>n.name==='reason').value='商品外观不同';form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();await tick();assert.equal(sent[0].payload.relevance_confirmed,false);assert.equal(sent[0].payload.relevance_result,'mismatch');assert.equal(sent[0].payload.reason,'商品外观不同');}finally{c.life.dispose();}
});
