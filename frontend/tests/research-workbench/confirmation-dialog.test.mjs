import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
async function until(check){const end=Date.now()+1000;while(!check()){assert.ok(Date.now()<end,'expected asynchronous state');await new Promise(r=>setTimeout(r,5));}}
const findButton=(root,label)=>root.find(n=>n.tagName==='BUTTON'&&n.textContent===label);
async function fixture(handler=()=>({id:'a',disposition:'created'}),config={}){
 const root=fixtureRoot(),wb=createWorkbench(),requests=[];let context;
 const project={id:'p',version:7,title:'Merchant',market:'US',direction:'Saved direction',keywords:[{id:'k',text:'saved term',approved:true,status:'ready',ads:[]}],products:[],...config.project};
 await wb.mount(root,{onSelectProject:(id,c)=>{context=c;},fetch:async(url,options)=>{requests.push({url,...options});let data;
  if(options.method==='POST')data=await handler(url,options);
  else if(url.endsWith('/session'))data={csrf_token:'fixture'};
  else if(url.endsWith('/projects/p'))data=config.readProject?await config.readProject(project):structuredClone(project);
  else if(url.includes('/actions?'))data=config.readActions?await config.readActions():{actions:[]};
  else data={projects:[structuredClone(project)]};
  return {ok:true,json:async()=>data};
 }});
 findButton(root,'Merchant').click();await tick();
 return {root,wb,requests,get context(){return context;}};
}

test('opening and cancelling research confirmation preserves the mounted page and scroll without writes',async()=>{
 const f=await fixture();try{const page=f.root.querySelector('[data-rw-page]'),original=page.children[0],trigger=findButton(page,'搜索这个词');trigger.focus();f.root.scrollTop=437;const trail=JSON.stringify(f.wb.state.navigationTrail);
 trigger.click();await tick();const dialog=f.root.find(n=>n.tagName==='DIALOG');assert.ok(dialog,'confirmation is a modal dialog');assert.equal(dialog.attributes['aria-modal'],'true');assert.equal(page.children[0],original);assert.equal(f.root.scrollTop,437);assert.equal(JSON.stringify(f.wb.state.navigationTrail),trail);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 findButton(dialog,'取消本次操作').click();await tick();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);assert.equal(page.children[0],original);assert.equal(f.root.scrollTop,437);assert.equal(f.root.ownerDocument.activeElement,trigger);assert.equal(f.wb.state.queueSelection,null);
 }finally{f.wb.unmount();}
});
test('Escape cancels without submitting and navigation or unmount removes pending confirmation',async()=>{
 const f=await fixture();try{f.context.showQueue({kind:'verify',keyword_id:'k',landing_mode:'firecrawl'});let d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);assert.ok(d.find(n=>n.textContent.includes('Firecrawl')));const cancel=new Event('cancel',{cancelable:true});d.dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,true);assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);
 f.context.showQueue({kind:'scan',keyword_id:'k'});f.wb.navigate('history');assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);assert.equal(f.wb.state.queueSelection,null);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 }finally{f.wb.unmount();}assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);
});
test('confirmation submits once with the original market and version, and cannot dismiss while submitting',async()=>{
 let release;const f=await fixture(()=>new Promise(r=>{release=r;}));try{f.context.showQueue({kind:'scan',keyword_id:'k'});const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);const submit=findButton(d,'确认提交：搜索这个词');submit.click();submit.click();await until(()=>release);assert.equal(f.requests.filter(r=>r.method==='POST').length,1);const body=JSON.parse(f.requests.find(r=>r.method==='POST').body);assert.equal(body.keyword_id,'k');assert.equal(body.version,7);assert.equal(body.kind,'scan');assert.equal(f.wb.state.project.market,'US');assert.equal(findButton(d,'取消本次操作').disabled,true);
 d.dispatchEvent(new Event('cancel',{cancelable:true}));assert.equal(f.root.find(n=>n.tagName==='DIALOG'),d);release({id:'a',disposition:'created'});await until(()=>!f.root.find(n=>n.tagName==='DIALOG'));assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);assert.equal(f.wb.state.view,'project');
 }finally{release?.({id:'a'});f.wb.unmount();}
});
test('failed confirmation keeps its error inside the dialog and preserves the underlying page',async()=>{
 const f=await fixture(()=>{throw Error('Network reply unavailable');});try{const page=f.root.querySelector('[data-rw-page]'),original=page.children[0];f.context.showQueue({kind:'scan',keyword_id:'k'});const d=f.root.find(n=>n.tagName==='DIALOG');assert.ok(d);findButton(d,'确认提交：搜索这个词').click();await until(()=>d.querySelector('[data-rw-status]').textContent);assert.equal(f.root.find(n=>n.tagName==='DIALOG'),d);assert.match(d.querySelector('[data-rw-status]').textContent,/Network reply unavailable/);assert.equal(findButton(d,'取消本次操作').disabled,false);assert.equal(page.children[0],original);
 }finally{f.wb.unmount();}
});
test('background refresh does not replace the open dialog or typed query, and unmount clears it',async()=>{
 const f=await fixture();try{const page=f.root.querySelector('[data-rw-page]'),original=page.children[0];f.context.showQueue({kind:'trends',product_id:'x'});const dialog=f.root.find(n=>n.tagName==='DIALOG'),input=dialog.find(n=>n.name==='initial_trends_query');input.value='explicit local query';input.dispatchEvent(new Event('input'));
 await f.wb.refresh();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),dialog);assert.equal(input.value,'explicit local query');assert.equal(page.children[0],original);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 f.wb.unmount();assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);await f.wb.mount(f.root,{fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:{projects:[]}})});assert.equal(f.wb.state.queueSelection,null);assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);
 }finally{f.wb.unmount();}
});

test('initial keyword confirmation displays full saved direction safely and never substitutes the project title',async()=>{
 const f=await fixture();try{
  const direction='租房专用、可移除的一盒整屋防风套装；退租修复包含补墙膏、去污擦、修补工具。'+ '核对租客使用场景。'.repeat(20);
  f.context.state.project.direction=direction;f.context.showQueue({kind:'keywords'});const d=f.root.find(n=>n.tagName==='DIALOG');
  assert.ok(d.find(n=>n.textContent==='研究方向与目标'));assert.ok(d.find(n=>n.textContent===direction));assert.ok(d.find(n=>n.textContent.includes('按以上方向')));assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
 }finally{f.wb.unmount();}
});
test('changed project direction after keyword confirmation requires a new confirmation without enqueuing',async()=>{
 const f=await fixture();try{f.context.showQueue({kind:'keywords'});f.context.state.project={...f.context.state.project,direction:'Updated scope',version:8};const d=f.root.find(n=>n.tagName==='DIALOG');findButton(d,'确认提交：AI 建议初始词').click();await tick();
 assert.equal(f.requests.filter(r=>r.method==='POST').length,0);assert.match(d.querySelector('[data-rw-status]').textContent,/研究方向.*更新|项目资料.*更新/);
 }finally{f.wb.unmount();}
});

test('search confirmation shows saved Chinese meaning without substituting it in the search request',async()=>{
 const f=await fixture();try{const word=f.context.state.project.keywords[0];word.text='"wall repair kit"';word.meaning='墙面修补套件';f.context.showQueue({kind:'scan',keyword_id:'k'});const dialog=f.root.find(n=>n.tagName==='DIALOG');assert.ok(dialog.find(n=>n.textContent==='中文释义：墙面修补套件'));assert.ok(dialog.find(n=>n.textContent==='搜索词："wall repair kit"'));assert.equal(f.requests.filter(r=>r.method==='POST').length,0);findButton(dialog,'确认提交：搜索这个词').click();await until(()=>f.requests.some(r=>r.method==='POST'));const payload=JSON.parse(f.requests.find(r=>r.method==='POST').body);assert.equal(payload.keyword_id,'k');assert.equal(payload.kind,'scan');assert.equal(payload.meaning,undefined);assert.equal(word.text,'"wall repair kit"');}finally{f.wb.unmount();}
});

test('Trends submission paints acknowledged progress immediately while the follow-up project read is pending',async()=>{
 let hold=false,release;const product={id:'x',name:'Fixture shower',identity_revision:1,steps:[]};
 const f=await fixture(()=>({id:'new-trends',status:'ready',disposition:'queued'}),{project:{products:[product]},readProject:p=>hold?new Promise(r=>{release=()=>r(structuredClone(p));}):structuredClone(p)});
 try{
  await tick();f.wb.openProduct('p','x','channels');await tick();hold=true;f.context.showQueue({kind:'trends',product_id:'x',query:'filtered shower head'});
  findButton(f.root.find(n=>n.tagName==='DIALOG'),'确认提交：采集 Trends').click();await until(()=>release);
  assert.equal(f.root.find(n=>n.tagName==='DIALOG'),null);
  const status=f.root.querySelector('[data-rw-page]').find(n=>n.dataset.trendsTaskStatus==='true');
  assert.ok(status,'closing confirmation immediately reveals the task at its work area');assert.match(status.textContent,/已提交|排队/);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,1);release();await tick();
 }finally{release?.();f.wb.unmount();}
});

test('acknowledged Trends submission remains visible when its follow-up read fails and is never resubmitted',async()=>{
 let fail=false;const product={id:'x',name:'Fixture shower',identity_revision:1,steps:[]};
 const f=await fixture(()=>({id:'new-trends',status:'ready',disposition:'queued'}),{project:{products:[product]},readProject:p=>{if(fail)throw Error('read unavailable');return structuredClone(p);}});
 try{
  await tick();f.wb.openProduct('p','x','channels');fail=true;f.context.showQueue({kind:'trends',product_id:'x',query:'filtered shower head'});
  findButton(f.root.find(n=>n.tagName==='DIALOG'),'确认提交：采集 Trends').click();await until(()=>!f.root.find(n=>n.tagName==='DIALOG'));await tick();
  assert.match(f.root.find(n=>n.dataset.trendsTaskStatus==='true').textContent,/已提交/);
  assert.ok(f.root.find(n=>n.tagName==='BUTTON'&&n.textContent==='采集已提交，等待状态更新').disabled);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
 }finally{f.wb.unmount();}
});

test('follow-up reads replace the queue receipt with the actual failed task beside the Trends chart',async()=>{
 let submitted=false;const product={id:'x',name:'Fixture shower',identity_revision:1,steps:[]};
 const f=await fixture(()=>{submitted=true;return {id:'new-trends',status:'ready',disposition:'queued'};},{project:{products:[product]},readActions:()=>({actions:submitted?[{id:'new-trends',kind:'trends',product_id:'x',status:'blocked',message:'来源读取未完成，请核对。',recovery_action:'retry'}]:[]})});
 try{
  await tick();f.wb.openProduct('p','x','channels');f.context.showQueue({kind:'trends',product_id:'x',query:'filtered shower head'});
  findButton(f.root.find(n=>n.tagName==='DIALOG'),'确认提交：采集 Trends').click();await until(()=>f.root.find(n=>n.dataset.trendsTaskStatus==='true')?.textContent==='本次采集未完成');
  assert.ok(f.root.find(n=>n.textContent==='来源读取未完成，请核对。'));assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
 }finally{f.wb.unmount();}
});
