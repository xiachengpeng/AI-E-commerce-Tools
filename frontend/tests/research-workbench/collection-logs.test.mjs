import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const button=(r,label)=>r.find(n=>n.tagName==='BUTTON'&&(n.textContent===label||n.attributes?.['aria-label']===label));
const text=(r,value)=>r.textContent?.includes(value)||r.children?.some(n=>text(n,value));
async function fixture({action=true,read}={}){
 const root=fixtureRoot(),wb=createWorkbench(),calls=[];let streams=0,cancelled=0;
 const project={id:'p',version:7,title:'Merchant',market:'US',keywords:[{id:'k',text:'saved term',approved:true,status:'blocked',ads:[]}],products:[]};
 const task={id:'scan-a',keyword_id:'k',kind:'scan',attempt:2,status:'blocked',recovery_action:'restart',failure_stage:'read',message:'采集来源暂不可用',diagnostic:'等待响应或页面元素超时'};
 await wb.mount(root,{fetch:async(url,options)=>{calls.push({url,...options});if(url.includes('/log-stream')){streams++;return {ok:true,body:new ReadableStream({cancel(){cancelled++;}})};}let data;
 if(url.includes('/live-logs'))data=await (read?read():{logs:[{id:1,action_id:'scan-a',attempt:1,message:'OLD ATTEMPT'},{id:2,action_id:'other',attempt:2,message:'OTHER WORD'},{id:3,action_id:'scan-a',attempt:2,stage:'failed',message:'本次等待页面超时'}]});
 else if(url.endsWith('/session'))data={csrf_token:'fixture'};
 else if(url.endsWith('/projects/p'))data=structuredClone(project);
 else if(url.includes('/actions?'))data={actions:[],keyword_actions:action?{k:task}:{}};
 else data={projects:[structuredClone(project)]};
 return {ok:true,json:async()=>data};
 }});button(root,'Merchant').click();await tick();return {root,wb,calls,task,get streams(){return streams;},get cancelled(){return cancelled;}};
}
test('keyword collection log opens in place, uses latest keyword projection and filters attempt without writes',async()=>{
 const f=await fixture();try{const page=f.root.querySelector('[data-rw-page]'),original=page.children[0],trigger=button(f.root,'查看采集日志');assert.ok(trigger);trigger.focus();f.root.scrollTop=230;trigger.click();await tick();
 const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);assert.equal(page.children[0],original);assert.equal(f.root.scrollTop,230);assert.ok(text(d,'等待响应或页面元素超时'));assert.ok(text(d,'本次等待页面超时'));assert.equal(text(d,'OTHER WORD'),false);assert.equal(text(d,'OLD ATTEMPT'),false);assert.ok(f.calls.filter(c=>c.url.includes('/live-logs')||c.url.includes('/log-stream')).every(c=>c.url.includes('/projects/p/')&&c.url.includes('action_id=scan-a')));assert.equal(f.calls.some(c=>c.method==='POST'),false);
 button(d,'关闭日志窗口').click();await tick();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);assert.equal(f.root.ownerDocument.activeElement,trigger);assert.equal(f.cancelled,1);
 }finally{f.wb.unmount();}
});
test('missing action never reads unfiltered project logs or invents a failure reason',async()=>{
 const f=await fixture({action:false});try{assert.ok(button(f.root,'查看采集日志'));button(f.root,'查看采集日志').click();await tick();const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);assert.ok(text(d,'未找到本次采集的任务记录'));assert.equal(f.calls.some(c=>c.url.includes('live-logs')||c.url.includes('log-stream')),false);d.dispatchEvent(new Event('cancel',{cancelable:true}));assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);
 }finally{f.wb.unmount();}
});
test('read failure keeps recorded reason, refresh does not replace dialog and leaving releases stream',async()=>{
 const f=await fixture({read:()=>{throw Error('offline');}});try{button(f.root,'查看采集日志').click();await tick();const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);assert.ok(text(d,'等待响应或页面元素超时'));assert.ok(text(d,'日志暂不可读'));await f.wb.refresh();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),d);f.wb.navigate('history');await tick();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);assert.equal(f.cancelled,1);assert.equal(f.calls.some(c=>c.method==='POST'),false);
 }finally{f.wb.unmount();}
});
test('late log response cannot resurrect a dismissed window',async()=>{
 let release;const f=await fixture({read:()=>new Promise(r=>release=r)});try{button(f.root,'查看采集日志').click();await tick();const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);button(d,'关闭日志窗口').click();release({logs:[{id:1,action_id:'scan-a',attempt:2,message:'late'}]});await tick();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);assert.equal(f.streams,0);
 }finally{f.wb.unmount();}
});

test('queued task starts its first attempt and updates the open window without losing first execution logs',async()=>{
 const f=await fixture({read:()=>({logs:[{id:1,action_id:'scan-a',attempt:0,stage:'queued',message:'等待启动'},{id:2,action_id:'scan-a',attempt:1,stage:'browser',message:'浏览器已经启动'}]})});
 try{Object.assign(f.task,{status:'ready',attempt:0,diagnostic:null,message:null,failure_stage:null});await f.wb.refresh();button(f.root,'查看采集日志').click();await tick();const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);assert.ok(text(d,'等待启动'));assert.equal(text(d,'浏览器已经启动'),false);
 Object.assign(f.task,{status:'running',attempt:1});await f.wb.refresh();await tick();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),d);assert.ok(text(d,'浏览器已经启动'));assert.equal(text(d,'等待启动'),false);assert.ok(text(d,'第 1 次尝试'));assert.ok(f.cancelled>=1);
 Object.assign(f.task,{status:'blocked',diagnostic:'页面访问受限',failure_stage:'filters'});await f.wb.refresh();assert.ok(text(d,'页面访问受限'));assert.ok(text(d,'打开来源并设置筛选'));assert.equal(f.calls.some(c=>c.method==='POST'),false);
 }finally{f.wb.unmount();}
});

test('collection log timestamps use local readable time and keep unavailable time unknown',async()=>{
 const {formatLogTime}=await import('../../js/research-workbench/components/live-logs.mjs');
 assert.equal(formatLogTime('not-a-time'),'时间未记录');assert.equal(formatLogTime(null),'时间未记录');
 const value=formatLogTime('2026-10-24T12:51:24.893534+00:00');assert.match(value,/2026/);assert.doesNotMatch(value,/T|893534|\+00:00/);
});
