import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){const end=Date.now()+1000;while(!fn()){assert.ok(Date.now()<end,'expected asynchronous state');await new Promise(r=>setTimeout(r,5));}}
const button=(r,t)=>r.find(n=>n.tagName==='BUTTON'&&n.textContent===t);
const select=r=>r.find(n=>n.tagName==='SELECT'&&n.attributes['aria-label']==='Trends 采集方式（本项目）');
async function fixture({save,modes={meta:'api',trends:'ui'},tasks=[]}={}){
 const root=fixtureRoot(),wb=createWorkbench(),calls=[],settings=[];let project={id:'p',version:7,title:'Merchant',market:'US',collection_modes:modes,keywords:[],products:[{id:'x',name:'Fixture shower',steps:[]}]};
 await wb.mount(root,{openMainSettings:tab=>settings.push(tab),fetch:async(url,options)=>{calls.push({url,...options});let data;
  if(options.method==='POST'){const body=JSON.parse(options.body);if(url.endsWith('/commands')){if(save)await save(body);project={...project,version:project.version+1,collection_modes:body.payload};data=structuredClone(project);}else data={id:'task',status:'ready'};}
  else if(url.endsWith('/session'))data={csrf_token:'fixture'};
  else if(url.endsWith('/projects/p'))data=structuredClone(project);
  else if(url.includes('/actions?'))data={actions:tasks};
  else data={projects:[structuredClone(project)]};
  return {ok:true,json:async()=>data};
 }});button(root,'Merchant').click();await tick();wb.openProduct('p','x','channels');await tick();return {root,wb,calls,settings};
}
test('demand page exposes UI and SerpApi modes with UI as the legacy default',async()=>{
 const f=await fixture({modes:null});try{const input=select(f.root);assert.ok(input,'visible Trends source selector');assert.equal(input.value,'ui');assert.deepEqual(input.children.map(n=>[n.value,n.textContent]),[['ui','浏览器 UI'],['api','API（SerpApi）']]);assert.equal(f.calls.some(c=>c.method==='POST'),false);button(f.root,'配置 SerpApi').click();assert.deepEqual(f.settings,['integrations']);}finally{f.wb.unmount();}
});
test('changing Trends mode saves a versioned project setting and preserves Meta, scroll and evidence',async()=>{
 const f=await fixture();try{f.root.scrollTop=280;const before=structuredClone(f.wb.state.project.products);const input=select(f.root);assert.ok(input);input.value='api';input.dispatchEvent(new Event('change'));await until(()=>f.wb.state.project.collection_modes.trends==='api');await tick();assert.equal(select(f.root).value,'api');assert.equal(f.root.scrollTop,280);assert.deepEqual(f.wb.state.project.products,before);const writes=f.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.ok(writes[0].url.endsWith('/commands'));const body=JSON.parse(writes[0].body);assert.equal(body.action,'configure_collection');assert.equal(body.version,7);assert.deepEqual(body.payload,{meta:'api',trends:'api'});assert.equal(f.calls.some(c=>c.method==='POST'&&c.url.endsWith('/actions')),false);await f.wb.refresh();assert.equal(select(f.root).value,'api');button(f.root,'自动查 Trends').click();await tick();const dialog=f.root.find(n=>n.tagName==='DIALOG');assert.ok(dialog);assert.ok(dialog.find(n=>n.textContent.includes('API（SerpApi）')));assert.ok(dialog.find(n=>n.textContent.includes('可能产生费用')));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}finally{f.wb.unmount();}
});
test('failed mode save restores the known mode and never starts a Trends request',async()=>{
 const f=await fixture({save:()=>{throw Error('fixture save failed');}});try{const input=select(f.root);assert.ok(input);input.value='api';input.dispatchEvent(new Event('change'));await until(()=>!input.disabled);await tick();assert.equal(select(f.root).value,'ui');assert.equal(f.wb.state.project.collection_modes.trends,'ui');assert.ok(f.root.find(n=>n.textContent.includes('未确认保存成功')));assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.calls.some(c=>c.method==='POST'&&c.url.endsWith('/actions')),false);}finally{f.wb.unmount();}
});
test('pending mode save blocks collection confirmation until the setting is saved',async()=>{
 let release;const f=await fixture({save:()=>new Promise(r=>release=r)});try{const input=select(f.root);assert.ok(input);input.value='api';input.dispatchEvent(new Event('change'));await until(()=>release);button(f.root,'自动查 Trends').click();await tick();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);release();await until(()=>f.wb.state.project.collection_modes.trends==='api');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}finally{release?.();f.wb.unmount();}
});
for(const status of ['ready','running'])test('an active project Trends task prevents source switching: '+status,async()=>{
 const f=await fixture({tasks:[{id:'running',kind:'trends',product_id:'another-product',status}]});try{const input=select(f.root);assert.ok(input);assert.equal(input.disabled,true);input.value='api';input.dispatchEvent(new Event('change'));await tick();assert.equal(f.calls.some(c=>c.method==='POST'),false);}finally{f.wb.unmount();}
});
