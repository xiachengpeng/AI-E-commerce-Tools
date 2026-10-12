import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionService, retryEligible, mergeActionPages, actionStatus, mediaPath } from '../../js/research-workbench/services/actions.mjs';
import { createApi } from '../../js/research-workbench/api.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
import { consumeEvents } from '../../js/research-workbench/components/live-logs.mjs';
const context=api=>({api,life:createLifecycle(),state:{project:{id:'p',version:7},actions:[],commands:{}}});
test('retry only explicit eligible failures and unknown never becomes empty',()=>{
 for(const status of ['complete','running','unknown'])assert.equal(retryEligible({status,recovery_action:'retry'}),false);
 assert.equal(retryEligible({status:'blocked',recovery_action:'manual'}),false);
 assert.equal(retryEligible({status:'blocked',recovery_action:'resume'}),true);
 assert.equal(actionStatus({status:'ready',display_status:'cloud_running'}),'云端处理中');
 assert.equal(actionStatus({status:'unknown'}),'未知 · 请核对');
});
test('stable pagination merges old records without losing newer attempts',()=>{
 const a={id:'a',attempt:2},b={id:'b',attempt:1};assert.deepEqual(mergeActionPages([a],[{id:'a',attempt:1},b]),[a,b]);
});
test('stop carries original attempt/version and ignores late responses',async()=>{
 let release,seen;const c=context({request:async(path,options)=>{seen=options.body;return new Promise(r=>release=r);}});
 c.state.actions=[{id:'a',attempt:2,status:'running'}];const service=createActionService(c);const waiting=service.stop(c.state.actions[0]);
 c.state.actions=[{id:'a',attempt:3,status:'running'}];release({id:'a',attempt:2,status:'blocked'});await waiting;
 assert.equal(seen.attempt,2);assert.equal(seen.version,7);assert.equal(c.state.actions[0].attempt,3);
});
test('media selector accepts IDs only, never arbitrary URL or signed private material',()=>{
 assert.match(mediaPath('p',{keyword_id:'k',ad_id:'a',source:'ad',index:0}),/media-download/);
 assert.throws(()=>mediaPath('p',{keyword_id:'k',source:'ad',index:0,url:'https://outside'}));
});
test('authorized blob/stream API uses token headers and same path guards',async()=>{
 const seen=[];const api=createApi({fetch:async(url,options)=>{seen.push([url,options]);return {ok:true,json:async()=>({csrf_token:'fixture'}),blob:async()=>new Blob(['image']),body:new ReadableStream({start(c){c.close();}})};}});
 await api.session();assert.equal((await api.blob('/projects/p/actions/a/screenshot')).size,5);
 const reader=(await api.stream('/projects/p/log-stream')).getReader();await reader.cancel();
 assert.equal(seen[1][1].headers['X-Research-Token'],'fixture');assert.equal(seen[2][1].headers['X-Research-Token'],'fixture');
 await assert.rejects(api.blob('//remote'),/path/);
});
test('fetch SSE parses split chunks and releases reader on disposal',async()=>{
 const encoder=new TextEncoder(),rows=[];const life=createLifecycle();let cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(encoder.encode('event: logs\ndata: {"logs":'));c.enqueue(encoder.encode('[{"id":2}],"cursor":2}\n\n'));},cancel(){cancelled=true;}});
 const pending=consumeEvents(stream,life,data=>{rows.push(...data.logs);life.dispose();});await pending;assert.equal(rows[0].id,2);assert.equal(cancelled,true);
});
import { fixtureRoot } from './dom-fixture.mjs';
import { renderActions } from '../../js/research-workbench/pages/actions.mjs';
import { ownedMedia, usableAdCopy } from '../../js/research-workbench/components/ad-copy.mjs';
import { createActionLogs } from '../../js/research-workbench/components/live-logs.mjs';
test('queue entry performs read-only queries, cloud/unknown UI stays truthful and success has no retry',async()=>{
 const calls=[],c=context({request:async(path,options)=>{calls.push([path,options]);return path==='/sources'?{sources:[{name:'Meta',status:'unconfigured',integration_message:'未配置'}]}:{actions:[{id:'c',status:'complete',attempt:1},{id:'u',status:'unknown',attempt:1},{id:'r',status:'running',display_status:'cloud_running',attempt:2}],next_cursor:null};}});
 c.root=fixtureRoot();c.navigate=()=>{};c.state.queueSelection={kind:'scan',keyword_id:'k'};const host=renderActions(c);await new Promise(r=>setImmediate(r));
 assert.ok(calls.every(([,o])=>!o?.method));assert.equal(host.find(n=>n.textContent==='云端处理中').textContent,'云端处理中');assert.ok(host.find(n=>n.textContent==='未知 · 请核对'));assert.equal(host.find(n=>n.textContent==='显式重试失败任务'),null);c.life.dispose();
});
test('failed queue refresh keeps authoritative old DTO and pagination cursor',async()=>{
 const c=context({request:async()=>{throw Error('offline');}});c.state.actions=[{id:'old',status:'complete'}];c.state.actionCursor='saved';const old=c.state.actions;await assert.rejects(createActionService(c).load());assert.equal(c.state.actions,old);assert.equal(c.state.actionCursor,'saved');c.life.dispose();
});
test('owned media revokes object URL on leaving page and ignores late blob',async()=>{
 let made=0,revoked=0;const c=context({blob:async()=>new Blob(['x'],{type:'image/png'})});c.context={objectURLs:{createObjectURL(){made++;return 'blob:owned';},revokeObjectURL(){revoked++;}}};
 assert.equal((await ownedMedia(c,'/projects/p/actions/a/screenshot')).url,'blob:owned');c.life.dispose();assert.equal(revoked,1);assert.equal(await ownedMedia(c,'/projects/p/actions/a/screenshot'),null);assert.equal(made,1);
});
test('live log session action filter, cursor, repeated open and dispose release readers',async()=>{
 let cancelled=0;const calls=[];const c=context({request:async(path)=>{calls.push(path);return {logs:[{id:4,action_id:'a',attempt:1,message:'saved'}],cursor:4};},stream:async(path)=>{calls.push(path);return new ReadableStream({cancel(){cancelled++;}});}});c.root=fixtureRoot();const logs=createActionLogs(c);
 const first=logs.openActionLogs('a');await new Promise(r=>setImmediate(r));const second=logs.openActionLogs('b');await new Promise(r=>setImmediate(r));assert.equal(cancelled,1);assert.match(calls[1],/after=4&action_id=a/);assert.match(calls[2],/action_id=b/);logs.closeActionLogs();await Promise.all([first,second]);assert.equal(cancelled,2);c.life.dispose();
});
test('dynamic template ad text cannot become translated copy',()=>{assert.equal(usableAdCopy('{{product.name}}'),false);assert.equal(usableAdCopy('Saved original'),true);});
test('pagination remains at older page cursor when head polling refreshes',async()=>{
 let n=0;const c=context({request:async()=>++n===1?{actions:[{id:'b'}],next_cursor:'older'}:{actions:[{id:'new'}],next_cursor:'head'}});c.state.actions=[{id:'a'}];c.state.actionCursor='initial';const service=createActionService(c);await service.load(true);await service.load();assert.equal(c.state.actionCursor,'older');assert.deepEqual(c.state.actions.map(a=>a.id),['new','a','b']);c.life.dispose();
});
test('lost enqueue reply never retries automatically and explicit resubmit preserves command identity',async()=>{
 const bodies=[];const c=context({request:async(path,options)=>{bodies.push(options.body);throw Error('lost reply');}});const service=createActionService(c);
 await assert.rejects(service.enqueue({kind:'scan',keyword_id:'k'}));assert.equal(bodies.length,1);
 await assert.rejects(service.enqueue({kind:'scan',keyword_id:'k'}));assert.equal(bodies.length,2);assert.equal(bodies[0].command_id,bodies[1].command_id);assert.equal(bodies[0].version,7);c.life.dispose();
});
test('media IDs cannot carry raw external URL values',()=>{assert.throws(()=>mediaPath('p',{keyword_id:'https://outside',source:'ad',index:0}));});
test('shared write guard prevents concurrent distinct paid action submissions',async()=>{
 let release,count=0,started;const submitted=new Promise(r=>started=r);const c=context({request:async()=>{count++;started();return count===1?new Promise(r=>release=r):{id:'unexpected'};}});const service=createActionService(c);const first=service.enqueue({kind:'keywords'});await submitted;await assert.rejects(service.enqueue({kind:'scan_all'}),/尚未完成/);assert.equal(count,1);release({id:'a'});await first;assert.equal(c.state.writeBusy,false);c.life.dispose();
});
test('uncertain retry preserves UUID and submitted version across project version refresh',async()=>{
 const bodies=[];const c=context({request:async(path,options)=>{bodies.push(options.body);throw Error('lost');}}),service=createActionService(c),action={id:'a',kind:'scan',keyword_id:'k',attempt:2,status:'blocked',recovery_action:'retry'};
 await assert.rejects(service.retry(action));c.state.project.version=8;await assert.rejects(service.retry(action));assert.equal(bodies[0].command_id,bodies[1].command_id);assert.equal(bodies[1].version,7);c.life.dispose();
});
test('409 refresh updates only version and explicit next click reuses UUID without automatic mutation',async()=>{
 const bodies=[];const c=context({request:async(path,options)=>{if(!options?.method)return {id:'p',version:8};bodies.push(options.body);if(bodies.length===1){const e=Error('conflict');e.status=409;throw e;}return {id:'queued'};}}),service=createActionService(c);
 await assert.rejects(service.enqueue({kind:'keywords'}));assert.equal(bodies.length,1);assert.equal(c.state.project.version,8);await service.enqueue({kind:'keywords'});assert.equal(bodies.length,2);assert.equal(bodies[1].command_id,bodies[0].command_id);assert.equal(bodies[1].version,8);c.life.dispose();
});
