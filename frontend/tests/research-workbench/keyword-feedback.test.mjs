import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {renderKeywordSection} from '../../js/research-workbench/pages/exploration.mjs';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const find=(root,text)=>root.find(n=>n.tagName==='BUTTON'&&n.textContent===text);
function fixture(){const root=fixtureRoot(),life=createLifecycle(),visits=[];return {root,life,state:{view:'project',projectSection:'keywords',project:{id:'p',version:1,title:'Scope',market:'US',keywords:[],products:[]},actions:[]},navigate:view=>visits.push(view),showQueue(){},visits};}

test('keyword actions share an explicit header; the empty message occupies its own content row',()=>{
 const c=fixture();try{const page=renderKeywordSection(c),header=page.find(n=>n.className==='rw-keyword-section-header');assert.ok(header);assert.ok(header.find(n=>n.textContent==='关键词批次'));assert.ok(find(header,'AI 建议初始词'));assert.ok(find(header,'＋ 添加关键词'));const empty=page.find(n=>n.className.includes('rw-keyword-empty'));assert.equal(empty.parentElement,page);assert.notEqual(empty.parentElement,header);}finally{c.life.dispose();}
});
test('inline keyword feedback follows real state changes, preserves failure reasons and never submits',async()=>{
 const c=fixture();try{const page=renderKeywordSection(c),host=page.find(n=>n.dataset.keywordProgress!==undefined);assert.ok(host);assert.equal(host.hidden,true);
 c.state.actions=[{id:'a',project_id:'p',kind:'keywords',status:'running'}];c.keywordProgress.update();assert.equal(host.hidden,false);assert.equal(find(page,'AI 建议初始词').disabled,true);assert.ok(host.find(n=>n.textContent.includes('正在根据研究方向')));
 c.state.actions[0]={...c.state.actions[0],status:'complete',result:{suggestions:4}};c.keywordProgress.update();assert.ok(host.find(n=>n.textContent.includes('新增 4 个待审核关键词')));assert.equal(find(page,'AI 建议初始词').disabled,false);
 c.state.actions[0]={...c.state.actions[0],status:'blocked',message:'文字模型未配置',diagnostic:'请在设置选择文字模型。',recovery_action:'retry'};c.keywordProgress.update();assert.ok(host.find(n=>n.textContent.includes('文字模型未配置')));assert.ok(host.find(n=>n.textContent.includes('请在设置选择文字模型')));find(host,'查看任务详情').click();await tick();assert.deepEqual(c.visits,['actions']);assert.equal(c.state.selectedResearchAction,'a');
 }finally{c.life.dispose();}
});
test('a saved keyword receipt without a returned status remains visible and cannot create another request',()=>{
 const c=fixture();try{c.state.lastResearchAction={id:'pending',projectId:'p',kind:'keywords'};const page=renderKeywordSection(c),host=page.find(n=>n.dataset.keywordProgress!==undefined);assert.ok(host);assert.ok(host.find(n=>n.textContent.includes('正在核对执行状态')));assert.equal(find(page,'AI 建议初始词').disabled,true);c.state.project={...c.state.project,id:'other'};c.keywordProgress.update();assert.equal(host.hidden,true);}finally{c.life.dispose();}
});
test('AI keyword submit, refresh and completion report beside its button rather than in the global header',async()=>{
 const root=fixtureRoot(),wb=createWorkbench(),writes=[];let c,status='ready',suggestions=0;
 const project={id:'p',version:1,title:'Inline test',direction:'Tenant-safe removable draft kits',market:'US',keywords:[],products:[]};
 const actions=()=>({actions:writes.length?[{id:'seed',project_id:'p',kind:'keywords',status,result:status==='complete'?{suggestions}:undefined}]:[]});
 try{await wb.mount(root,{onSelectProject:(_,context)=>c=context,fetch:async(url,o)=>{if(o.method==='POST'){writes.push(o);return {ok:true,json:async()=>({id:'seed',status:'ready'})};}return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?structuredClone(project):url.includes('/actions?')?actions():{projects:[structuredClone(project)]}};}});
 find(root,'Inline test').click();await tick();c.state.projectSection='keywords';c.navigate('project');find(root,'AI 建议初始词').click();await tick();find(root,'确认提交：AI 建议初始词').click();await new Promise(r=>setTimeout(r,20));
 assert.equal(writes.length,1);let host=root.find(n=>n.dataset.keywordProgress!==undefined);assert.ok(host&&!host.hidden);assert.doesNotMatch(root.querySelector('[data-rw-status]').textContent,/准备初始搜索词|可留在当前页/);
 status='complete';suggestions=3;await wb.refresh();host=root.find(n=>n.dataset.keywordProgress!==undefined);assert.ok(host.find(n=>n.textContent.includes('新增 3 个待审核关键词')));assert.doesNotMatch(root.querySelector('[data-rw-status]').textContent,/新增 3|准备初始搜索词/);assert.equal(writes.length,1);
 }finally{wb.unmount();}
});
test('a keyword enqueue followed by a failed status read keeps its receipt local without sending again',async()=>{
 const root=fixtureRoot(),wb=createWorkbench();let c,writes=0;const project={id:'p',version:1,title:'Read failure',direction:'Removable rental kits',market:'US',keywords:[],products:[]};
 try{await wb.mount(root,{onSelectProject:(_,context)=>c=context,fetch:async(url,o)=>{if(o.method==='POST'){writes++;return {ok:true,json:async()=>({id:'receipt'})};}if(writes&&url.endsWith('/projects/p'))throw Error('unavailable');return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/p')?structuredClone(project):url.includes('/actions?')?{actions:[]}:{projects:[project]}};}});
 find(root,'Read failure').click();await tick();c.state.projectSection='keywords';c.navigate('project');find(root,'AI 建议初始词').click();await tick();find(root,'确认提交：AI 建议初始词').click();await new Promise(r=>setTimeout(r,20));
 const host=root.find(n=>n.dataset.keywordProgress!==undefined);assert.ok(host.find(n=>n.textContent.includes('请求已保存，正在核对执行状态')));assert.doesNotMatch(root.querySelector('[data-rw-status]').textContent,/执行请求已保存|准备初始搜索词/);assert.equal(writes,1);
 }finally{wb.unmount();}
});
