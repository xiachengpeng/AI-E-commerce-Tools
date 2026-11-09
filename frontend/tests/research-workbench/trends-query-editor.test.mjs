import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {renderActionConfirmation,createActionDialog} from '../../js/research-workbench/components/action-confirmation.mjs';
const tick=()=>new Promise(r=>setTimeout(r,20));
const suggestion={query:'filtered shower head',meaning:'过滤花洒',source_id:'title',source_quote:'Filtered Shower Head'};
const result=(candidates=[suggestion])=>({text:JSON.stringify({candidates})});
function fixture(){
 const root=fixtureRoot();root.innerHTML='<p data-rw-status></p>';const calls=[];
 const product={id:'x',identity_revision:2,name:'FixtureBrand',url:'https://example.test/shower',identification:{relevance_confirmed:true,identity_revision:2},landing_snapshot:{title:'Filtered Shower Head',body_text:'A filtered shower head.',identity_revision:2}};
 const c={root,life:createLifecycle(),state:{project:{id:'p',title:'Fixture',version:7,market:'US',products:[product]},product:'x',actions:[]},context:{callAI:async()=>result()},api:{request:async(path,options)=>{calls.push({path,...options});return {id:'task'};}}};
 return {c,product,calls};
}
const submit=host=>host.find(n=>n.dataset.actionSubmit==='true');
const input=host=>host.find(n=>n.name==='initial_trends_query');

test('confirmation prepares a query with Chinese meaning and basis but queues only on explicit confirmation',async t=>{
 const {c,calls}=fixture();t.after(()=>c.life.dispose());c.context.callAI=async()=>result([suggestion,{...suggestion,query:'shower head filter',meaning:'花洒过滤器'}]);const host=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});
 await tick();assert.equal(input(host).value,'filtered shower head');assert.ok(host.find(n=>n.textContent.includes('过滤花洒')));assert.ok(host.find(n=>n.textContent.includes('Filtered Shower Head')));const alternative=host.find(n=>n.textContent==='shower head filter · 花洒过滤器');assert.equal(alternative.parentElement.hidden,true,'alternatives are not presented as equally recommended by default');assert.equal(calls.length,0);
 const choices=alternative.parentElement,details=choices.parentElement;details.open=true;details.dispatchEvent(new Event('toggle'));assert.equal(choices.hidden,false);
 submit(host).click();await tick();assert.equal(calls.length,1);assert.equal(calls[0].body.query,'filtered shower head');assert.equal(calls[0].body.product_id,'x');assert.equal(calls[0].body.meaning,undefined);
});

test('failed Trends retry keeps the original saved query visible and needs no blank input',async t=>{
 const {c,calls}=fixture();t.after(()=>c.life.dispose());const product=c.state.project.products[0];c.state.actions=[{id:'old-task',kind:'trends',product_id:product.id,query:'filtered shower head',status:'blocked',recovery_action:'retry',attempt:1}];
 const {renderActions}=await import('../../js/research-workbench/pages/actions.mjs');c.root=fixtureRoot();c.root.innerHTML='<p data-rw-status></p>';c.navigate=()=>{};
 c.showQueue=selection=>{c.state.queueSelection=selection;};const host=renderActions(c);await new Promise(r=>setImmediate(r));const input=host.find(n=>n.name==='trends_query');assert.equal(input,null);assert.ok(host.find(n=>n.textContent.includes('原查询词：filtered shower head')));
 host.find(n=>n.textContent==='使用其他查询词').click();assert.deepEqual(c.state.queueSelection,{kind:'trends',product_id:product.id,refresh_query:true});assert.equal(calls.some(call=>call.path.endsWith('/actions')&&call.method==='POST'),false,'opening the editor must not enqueue a collection task');
});

test('a late AI response never overwrites a query the user already typed',async t=>{
 const {c,calls}=fixture();t.after(()=>c.life.dispose());let finish;c.context.callAI=async()=>new Promise(r=>finish=r);
 const host=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});input(host).value='shower filter';input(host).dispatchEvent(new Event('input'));finish(result());await tick();
 assert.equal(input(host).value,'shower filter');submit(host).click();await tick();assert.equal(calls[0].body.query,'shower filter');
});

test('reopening after successful confirmation reuses the query and meaning without another AI call',async t=>{
 const {c}=fixture();t.after(()=>c.life.dispose());let generated=0;c.context.callAI=async()=>{generated++;return result();};
 const first=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});await tick();submit(first).click();await tick();
 const second=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});await tick();assert.equal(input(second).value,'filtered shower head');assert.ok(second.find(n=>n.textContent.includes('过滤花洒')));assert.equal(generated,1);
});

test('manual edits do not retain the translation of a different suggested term',async t=>{
 const {c}=fixture();t.after(()=>c.life.dispose());const host=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});await tick();
 input(host).value='water filter';input(host).dispatchEvent(new Event('input'));const meaning=host.find(n=>n.dataset.trendsMeaning==='true');assert.doesNotMatch(meaning.textContent,/过滤花洒/);submit(host).click();await tick();
 const second=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});await tick();assert.equal(input(second).value,'water filter');assert.doesNotMatch(second.find(n=>n.dataset.trendsMeaning==='true').textContent,/过滤花洒/);
});

test('missing product facts offer a working path back to product review and still allow manual query input',async t=>{
 const {c,product,calls}=fixture();t.after(()=>c.life.dispose());product.landing_snapshot=null;let opened;c.openProduct=(...args)=>opened=args;
 const host=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});await tick();assert.ok(host.find(n=>n.textContent.includes('先读取并核对')));
 assert.equal(host.find(n=>n.tagName==='DETAILS')?.hidden,true,'an empty editor must not show a change-query control with no alternatives');
 host.find(n=>n.tagName==='BUTTON'&&n.textContent==='补充商品资料').click();await tick();assert.deepEqual(opened,['p','x','identification']);assert.equal(calls.length,0);
});

test('choosing an alternative in the native dialog does not move the wrong button to its action bar',async t=>{
 const {c}=fixture();t.after(()=>c.life.dispose());c.context.callAI=async()=>result([suggestion,{...suggestion,query:'shower filter',meaning:'花洒过滤器'}]);
 const dialog=createActionDialog(c,{kind:'trends',product_id:'x'},{onSubmitted:()=>{},onCancel:()=>{}});await tick();const host=dialog.dialog;
 const primary=submit(host);assert.ok(primary);assert.equal(primary.parentElement.className,'rw-action-dialog-actions');
 const alternative=host.find(n=>n.tagName==='BUTTON'&&n.textContent.includes('shower filter'));assert.ok(alternative);alternative.click();await tick();assert.equal(input(host).value,'shower filter');assert.equal(primary.parentElement.className,'rw-action-dialog-actions');
});

test('a changed product identity, market or source blocks submitting a stale suggestion',async t=>{
 for(const change of [c=>{c.state.project.market='DE';},c=>{c.state.project.products[0].identity_revision=3;},c=>{c.state.project.products[0].landing_snapshot.title='Other product';}]){
  const {c,calls}=fixture();t.after(()=>c.life.dispose());const host=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});await tick();change(c);submit(host).click();await tick();assert.equal(calls.length,0);assert.match(c.root.querySelector('[data-rw-status]').textContent,/变化|重新/);
 }
});

test('uncertain collection never remembers an unacknowledged query or resubmits changed input',async t=>{
 const {c,calls}=fixture();t.after(()=>c.life.dispose());c.api.request=async(path,options)=>{calls.push({path,...options});throw Error('lost reply');};
 const host=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>{});await tick();submit(host).click();await tick();assert.equal(calls.length,1);assert.equal(c.state.trendsQueryPreferences,undefined);
 input(host).value='different';input(host).dispatchEvent(new Event('input'));submit(host).click();await tick();assert.equal(calls.length,1);
});

test('closing a query dialog before AI finishes cancels its work without changing the underlying page',async t=>{
 const {c}=fixture();t.after(()=>c.life.dispose());let finish;c.context.callAI=async()=>new Promise(r=>finish=r);
 const dialog=createActionDialog(c,{kind:'trends',product_id:'x'},{onSubmitted:()=>{},onCancel:()=>{}}),host=dialog.dialog;
 dialog.close();finish(result());await tick();assert.equal(input(host).value,'');assert.equal(c.state.trendsQueryPreferences,undefined);
});

test('an acknowledged collection remains acknowledged if product data changes while its response is pending',async t=>{
 const {c}=fixture();t.after(()=>c.life.dispose());let finish,acknowledged=0;c.api.request=async()=>new Promise(r=>finish=r);
 const host=renderActionConfirmation(c,{kind:'trends',product_id:'x'},()=>acknowledged++);await tick();submit(host).click();await tick();c.state.project.products[0].identity_revision=3;finish({id:'task'});await tick();
 assert.equal(acknowledged,1);assert.equal(c.state.trendsQueryPreferences,undefined);
});
