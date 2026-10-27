import test from 'node:test';
import assert from 'node:assert/strict';
import * as journey from '../../js/research-workbench/services/journey.mjs';
import {keywordControls,renderKeywordSection} from '../../js/research-workbench/pages/exploration.mjs';
import {creativeResult} from '../../js/research-workbench/components/creative-result.mjs';
import {renderActionConfirmation} from '../../js/research-workbench/components/action-confirmation.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {renderWorkflowControls} from '../../js/research-workbench/components/workflow-controls.mjs';
import {renderTriage} from '../../js/research-workbench/pages/triage.mjs';
const nodes=n=>[n,...n.children.flatMap(nodes)];
function fixture(){const root=fixtureRoot(),life=createLifecycle(),calls=[];return {root,life,context:{},state:{project:{id:'p',version:1,title:'P',market:'US',rules:{scan_batch_limit:2},keywords:[],products:[]},keywordActions:{},commands:{}},calls,showQueue:s=>calls.push(s),openForm(){},openTriage:(...args)=>calls.push(args),navigate(){},api:{request(){throw Error('unexpected request');}}};}
test('batch preview selects only server-eligible reviewed ready/blocked words and respects the limit',()=>{
 assert.equal(typeof journey.scanCandidates,'function');
 const p={rules:{scan_batch_limit:2},keywords:[{id:'a',approved:true,status:'complete'},{id:'b',approved:true,status:'ready'},{id:'c',approved:false,status:'ready'},{id:'d',approved:true,status:'blocked'},{id:'e',approved:true,status:'ready'}]};
 assert.deepEqual(journey.scanCandidates(p).map(w=>w.id),['b','d']);
});
test('resume prioritizes current focus and otherwise a recent completed source, never an unsearched first word',()=>{
 assert.equal(typeof journey.projectResume,'function');
 const p={id:'p',keywords:[{id:'empty',status:'pending_review'},{id:'done',status:'complete',ads:[{id:'ad'}],updated_at:'2026-10-26'}],products:[{id:'x',triage:{state:'retained'},steps:[{key:'coarse',state:'needs_input'}]}],focus_product_id:'x'};
 assert.deepEqual(journey.projectResume(p),{view:'product',product:'x',step:'coarse'});
 delete p.focus_product_id;assert.deepEqual(journey.projectResume(p),{view:'project',product:null,projectSection:'leads',explorationKeyword:'done'});
});
test('resuming a focused product respects a saved valid observation or rejection and opens review',()=>{
 for(const pool of ['observe','reject','backup']){
 const p={focus_product_id:'x',products:[{id:'x',triage:{state:'retained'},decision:{pool,stale:false},steps:[{key:'coarse',state:'needs_input'},{key:'decision',state:'passed'}]}]};
 assert.equal(journey.projectResume(p).step,'review');
 p.products[0].decision.stale=true;assert.equal(journey.projectResume(p).step,'coarse');
 }
});
test('completed search exposes a deliberate fresh observation bound to the exact completed task',async()=>{
 const c=fixture(),word={id:'w',approved:true,status:'complete'};c.state.project.keywords=[word];c.state.keywordActions.w={id:'old',status:'complete'};
 try{const page=keywordControls(c,word),b=nodes(page).find(n=>n.textContent==='重新搜索并补充');assert.ok(b);assert.equal(c.calls.length,0);b.click();await new Promise(r=>setImmediate(r));assert.deepEqual(c.calls,[{kind:'scan',keyword_id:'w',rescan_of:'old'}]);}finally{c.life.dispose();}
});
test('empty batch cannot submit even when a completed word is approved',()=>{
 const c=fixture();c.state.project.keywords=[{id:'w',text:'kit',approved:true,status:'complete'}];try{
 const page=renderKeywordSection(c);assert.equal(nodes(page).find(n=>n.textContent==='扫描全部已审核词').disabled,true);
 const confirm=renderActionConfirmation(c,{kind:'scan_all'},()=>{});assert.equal(nodes(confirm).find(n=>n.tagName==='BUTTON').disabled,true);
 }finally{c.life.dispose();}
});
test('incomplete saved screening offers observation and rejection without implying success or making a write',async()=>{
 const c=fixture();try{const page=creativeResult(c,{id:'x',name:'X',identification:{ad_age_days:13},steps:[{key:'coarse',state:'needs_input'}]},{onEdit(){},onBack(){},onNext(){},onTriage:d=>c.calls.push(d)});
 assert.ok(nodes(page).find(n=>n.textContent==='暂存观察'));assert.ok(nodes(page).find(n=>n.textContent==='不再研究这条线索'));assert.equal(c.calls.length,0);
 nodes(page).find(n=>n.textContent==='暂存观察').click();await new Promise(r=>setImmediate(r));assert.deepEqual(c.calls,['observing']);
 assert.equal(nodes(page).some(n=>n.textContent==='继续核对需求与竞争'),false);
 }finally{c.life.dispose();}
});
test('required funnel and score tasks are visible next to their business stages without writing',async()=>{
 const c=fixture(),opened=[];c.state.product='x';c.openProduct=(...a)=>opened.push(a);c.state.project.products=[{id:'x',steps:[]}];try{
 c.state.step='channels';const demand=renderWorkflowControls(c);assert.ok(nodes(demand).find(n=>n.dataset.workflowStep==='funnel'));nodes(demand).find(n=>n.dataset.workflowStep==='funnel').click();await new Promise(r=>setImmediate(r));assert.deepEqual(opened,[['p','x','funnel']]);
 c.state.step='economics';assert.ok(nodes(renderWorkflowControls(c)).find(n=>n.dataset.workflowStep==='score'));assert.equal(c.calls.length,0);
 }finally{c.life.dispose();}
});
test('quick observation opens the existing reason form with observation selected and no automatic save',()=>{
 const c=fixture();c.designDirectForms=true;c.state.product='x';c.state.drafts={};c.state.triageIntent={productId:'x',disposition:'observing'};c.state.project.products=[{id:'x',name:'X',identification:{},source_keyword_ids:[],steps:[]}];try{
 const page=renderTriage(c);assert.equal(nodes(page).find(n=>n.name==='rw-triage-disposition'&&n.value==='observing').checked,true);
 assert.ok(nodes(page).find(n=>n.textContent==='暂时观察这条线索'));assert.equal(c.calls.length,0);
 }finally{c.life.dispose();}
});
test('a recorded failed coarse gate is distinguished from unknown evidence without changing the server state',()=>{
 const step={key:'coarse',state:'needs_input'},p={gates:{coarse_screen:{status:'fail'}}};
 assert.equal(journey.stepStatusLabel(step,p),'当前未达标');assert.equal(step.state,'needs_input');
 p.gates.coarse_screen.status='unknown';assert.equal(journey.stepStatusLabel(step,p),'待补充');
});
test('a retained product never offers an identical triage save as its primary workflow shortcut',()=>{
 const c=fixture();c.state.product='x';c.state.step='coarse';c.state.project.products=[{id:'x',triage:{state:'retained'}}];try{
 const page=renderWorkflowControls(c);assert.equal(nodes(page).some(n=>n.textContent==='保留并深挖'),false);assert.ok(nodes(page).some(n=>n.textContent==='暂存观察'));
 }finally{c.life.dispose();}
});
