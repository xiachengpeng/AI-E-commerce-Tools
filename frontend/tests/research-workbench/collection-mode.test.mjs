import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){const end=Date.now()+1000;while(!fn()){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5));}}
const btn=(r,t)=>r.find(n=>n.tagName==='BUTTON'&&n.textContent===t);
const sel=r=>r.find(n=>n.tagName==='SELECT'&&n.attributes['aria-label']==='广告采集方式（本项目）');
const text=(r,t)=>r.textContent?.includes(t)||r.children?.some(n=>text(n,t));
async function fixture({save,task,wordStatus='blocked'}={}){
 const root=fixtureRoot(),wb=createWorkbench(),calls=[];let project={id:'p',version:7,title:'Merchant',market:'US',collection_modes:{meta:'ui',trends:'api'},keywords:[{id:'k',text:'term',approved:true,status:wordStatus,ads:[]}],products:[]};
 await wb.mount(root,{fetch:async(url,options)=>{calls.push({url,...options});let data;
 if(options.method==='POST'){
  const body=JSON.parse(options.body);
  if(url.endsWith('/commands')){if(save)await save(body);project={...project,version:8,collection_modes:body.payload};data=structuredClone(project);}
  else data={id:'a',disposition:'created'};
 }else if(url.endsWith('/session'))data={csrf_token:'fixture'};
 else if(url.endsWith('/projects/p'))data=structuredClone(project);
 else if(url.includes('/actions?'))data={actions:[],keyword_actions:task?{k:task}:{}};
 else data={projects:[structuredClone(project)]};
 return {ok:true,json:async()=>data};
 }});btn(root,'Merchant').click();await tick();return {root,wb,calls};
}
test('switching collection mode saves only project Meta mode, preserving Trends and scroll, then search requires confirmation',async()=>{
 const f=await fixture();try{const input=sel(f.root);assert.ok(input);assert.equal(input.value,'ui');f.root.scrollTop=250;input.value='api';input.dispatchEvent(new Event('change'));await until(()=>f.wb.state.project.collection_modes.meta==='api');await tick();assert.equal(f.root.scrollTop,250);assert.equal(sel(f.root).value,'api');const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.ok(writes[0].url.endsWith('/commands'));const body=JSON.parse(writes[0].body);assert.equal(body.action,'configure_collection');assert.equal(body.version,7);assert.deepEqual(body.payload,{meta:'api',trends:'api'});assert.equal(f.wb.state.project.keywords[0].status,'blocked');btn(f.root,'搜索这个词').click();await tick();const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);assert.ok(text(d,'API（Apify）'));assert.ok(text(d,'可能产生费用'));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 }finally{f.wb.unmount();}
});
test('failed mode save restores authoritative selection and never starts collection',async()=>{
 const f=await fixture({save:()=>{throw Error('保存失败');}});try{const input=sel(f.root);assert.ok(input);input.value='api';input.dispatchEvent(new Event('change'));await until(()=>!f.wb.state.writeBusy);await tick();assert.equal(sel(f.root).value,'ui');assert.equal(f.wb.state.project.collection_modes.meta,'ui');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.some(c=>c.method==='POST'&&c.url.endsWith('/actions')),false);
 }finally{f.wb.unmount();}
});
test('current running search prevents switching its collection mode',async()=>{
 const f=await fixture({task:{id:'a',kind:'scan',keyword_id:'k',attempt:1,status:'running',execution_mode:'ui'}});try{const input=sel(f.root);assert.ok(input);assert.equal(input.disabled,true);input.value='api';input.dispatchEvent(new Event('change'));await tick();assert.equal(f.calls.some(c=>c.method==='POST'),false);assert.ok(text(f.root,'正在采集'));
 }finally{f.wb.unmount();}
});
test('search confirmation cannot open before a pending mode save finishes',async()=>{
 let release;const f=await fixture({save:()=>new Promise(r=>release=r)});try{const input=sel(f.root);assert.ok(input);input.value='api';input.dispatchEvent(new Event('change'));await until(()=>release);btn(f.root,'搜索这个词').click();await tick();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);release();await until(()=>f.wb.state.project.collection_modes.meta==='api');
 }finally{release?.();f.wb.unmount();}
});
test('mode change after confirmation opens blocks submission until the user checks it again',async()=>{
 const f=await fixture();try{btn(f.root,'搜索这个词').click();await tick();const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);assert.ok(text(d,'浏览器采集'));f.wb.state.project={...f.wb.state.project,collection_modes:{meta:'api',trends:'api'}};btn(d,'确认提交：搜索这个词').click();await tick();assert.ok(text(d,'采集方式已变化'));assert.equal(f.calls.some(c=>c.method==='POST'),false);
 }finally{f.wb.unmount();}
});

test('queued keyword stays locked when its action projection has not arrived',async()=>{
 const f=await fixture({wordStatus:'queued'});try{const input=sel(f.root);assert.ok(input);assert.equal(input.disabled,true);input.value='api';input.dispatchEvent(new Event('change'));await tick();assert.equal(f.calls.some(c=>c.method==='POST'),false);}finally{f.wb.unmount();}
});
