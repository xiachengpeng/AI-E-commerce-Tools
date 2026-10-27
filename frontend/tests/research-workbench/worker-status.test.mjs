import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {renderWorkerStatus} from '../../js/research-workbench/components/worker-status.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const dto={contract_version:1,worker_state:'paused',observed_at:'2026-10-21T01:00:00Z',reason_codes:[],queues:{queued:0,running:0,needs_attention:9},polling:{state:'disabled',mode:'observe'}};
test('status uses business language, reads only and does not turn unknown counts into zero',async()=>{
 const root=fixtureRoot(),life=createLifecycle(),calls=[];
 const context={root,life,api:{request:async(path,options)=>{calls.push([path,options]);return dto;}}};
 const node=renderWorkerStatus(context);root.append(node);await tick();
 assert.equal(node.find(n=>n.dataset.workerState!==undefined).textContent,'后台已暂停');
 assert.ok(node.find(n=>n.dataset.workerQueue!==undefined).textContent.includes('9'));
 assert.equal(calls[0][0],'/runtime-status');assert.equal(calls[0][1].method,'GET');life.dispose();
});
test('late status cannot render after settings teardown',async()=>{
 const root=fixtureRoot(),life=createLifecycle();let release;
 const node=renderWorkerStatus({root,life,api:{request:()=>new Promise(resolve=>release=resolve)}});
 const before=node.find(n=>n.dataset.workerState!==undefined).textContent;
 life.dispose();release({...dto,worker_state:'running'});await tick();
 assert.equal(node.find(n=>n.dataset.workerState!==undefined).textContent,before);
});
test('compact worker status keeps details collapsed and refreshes without losing expanded state',async()=>{
 const root=fixtureRoot(),life=createLifecycle(),calls=[];
 const node=renderWorkerStatus({root,life,api:{request:async(path,options)=>{calls.push({path,...options});return {...dto,worker_state:'running',queues:{queued:2,running:1,needs_attention:9}};}}});root.append(node);await tick();
 try{const details=node.find(n=>n.tagName==='DETAILS');assert.ok(details,'timestamps and budgets belong to one optional detail disclosure');assert.equal(!!details.open,false);assert.ok(details.find(n=>n.textContent.includes('后台调用授权')));assert.equal(node.find(n=>n.tagName==='H2'),null);assert.ok(node.find(n=>n.dataset.workerQueue!==undefined).textContent.includes('9'));details.open=true;node.find(n=>n.tagName==='BUTTON'&&n.textContent==='刷新后台状态').click();await tick();assert.equal(details.open,true);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.method==='GET'));
 }finally{life.dispose();}
});
test('worker warnings remain visible outside collapsed details and unknown counts are not rendered as zero',async()=>{
 const root=fixtureRoot(),life=createLifecycle();const node=renderWorkerStatus({root,life,api:{request:async()=>({...dto,worker_state:'degraded',queues:{},reason_codes:['heartbeat_stale']})}});await tick();
 try{const warning=node.find(n=>n.dataset.workerAlert!==undefined);assert.ok(warning);assert.equal(warning.hidden,false);assert.ok(warning.textContent.includes('避免重复提交'));const details=node.find(n=>n.tagName==='DETAILS');assert.equal(details.find(n=>n===warning),null);assert.ok(node.find(n=>n.dataset.workerQueue!==undefined).textContent.includes('未知'));}finally{life.dispose();}
});
