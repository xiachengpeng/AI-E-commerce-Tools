import test from 'node:test';
import assert from 'node:assert/strict';
import * as service from '../../js/research-workbench/services/actions.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {renderReport} from '../../js/research-workbench/pages/reports.mjs';
import {render as renderProjects} from '../../js/research-workbench/pages/projects.mjs';
import {createWorkbench} from '../../js/research-workbench/index.mjs';

test('entry explains the research deliverable and gives both direction and existing-product starting points',()=>{
 const root=fixtureRoot(),life=createLifecycle(),opened=[];
 const page=renderProjects({root,life,state:{projects:[]},openForm:spec=>opened.push(spec)});
 const text=treeText(page);assert.match(text,/是否值得测试/);assert.match(text,/已有商品/);assert.match(text,/不会自动投放/);
 page.find(n=>n.textContent==='＋ 新建研究').click();assert.equal(opened[0].kind,'new_project');life.dispose();
});
const treeText=node=>node.textContent+' '+node.children.map(treeText).join(' ');
test('results immediately show per-product decisions and evidence limits without report download',async()=>{
 const root=fixtureRoot(),life=createLifecycle(),opened=[];
 const product={id:'one',name:'Research widget',revision:3,decision:{pool:'observe',reason:'缺真实报价'},steps:[{key:'economics',state:'needs_input',label:'成本',reason:'需供应商报价'}],scores:[{revision:2,total:24,status:'complete'}]};
 const c={root,life,state:{projects:[{id:'p',title:'Saved',products:[product]}]},openHistoryProduct:(...args)=>opened.push(args)};
 const page=renderReport(c),text=treeText(page);
 assert.match(text,/Research widget/);assert.match(text,/观察/);assert.match(text,/缺真实报价/);assert.doesNotMatch(text,/24 \/ 25/);
 page.find(n=>n.dataset.resultProduct==='one').click();await new Promise(r=>setImmediate(r));assert.deepEqual(opened[0].slice(0,2),['p','one']);life.dispose();
});
test('decision view defaults to the current project instead of mixing all project products',()=>{
 const root=fixtureRoot(),life=createLifecycle(),projects=[{id:'a',title:'A',products:[{id:'one',name:'Wrong project widget'}]},{id:'b',title:'B',products:[{id:'two',name:'Current widget'}]}];
 const page=renderReport({root,life,state:{projects,project:projects[1]},navigate(){}}),text=treeText(page);
 assert.match(text,/Current widget/);assert.doesNotMatch(text,/Wrong project widget/);life.dispose();
});
test('a result from another project opens its authoritative product without a mutation',async()=>{
 const root=fixtureRoot(),wb=createWorkbench(),calls=[];
 const projects=[{id:'a',title:'A',products:[]},{id:'b',title:'B',version:2,market:'US',keywords:[],products:[{id:'two',name:'Current widget',steps:[]}]}];
 await wb.mount(root,{fetch:async(url,options)=>{calls.push([url,options.method]);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/b')?projects[1]:{projects}};}});
 wb.navigate('reports');let page=root.querySelector('[data-rw-page]');const select=page.find(n=>n.attributes['aria-label']==='结论所属项目');select.value='b';select.dispatchEvent(new Event('change'));
 page=root.querySelector('[data-rw-page]');page.find(n=>n.dataset.resultProduct==='two').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(wb.state.project?.id,'b');assert.equal(wb.state.product,'two');assert.ok(root.querySelector('[data-rw-page]').find(n=>n.tagName==='H1'&&n.textContent==='Current widget'),'the authoritative product remains in saved overview beside the direct editor');
 assert.equal(calls.some(([,method])=>method==='POST'),false);wb.unmount();
});

test('task summaries use the actual result shape for each kind, including unknown results',()=>{
 assert.equal(typeof service.actionResultSummary,'function','task output formatter is available');
 assert.equal(service.actionResultSummary({kind:'keywords',result:{suggestions:20}}),'新增 20 个待审核关键词');
 assert.equal(service.actionResultSummary({kind:'expand',result:{suggestions:5}}),'新增 5 个待审核关键词');
 assert.equal(service.actionResultSummary({kind:'verify',result:{matched:1,needs_review:1,mismatch:0}}),'匹配 1 个 · 待确认 1 个 · 可能不相关 0 个');
 assert.match(service.actionResultSummary({kind:'landing',result:{title:'Widget'}}),/Widget/);
 assert.match(service.actionResultSummary({kind:'scan',result:{ads:0}}),/0 条/);
 assert.match(service.actionResultSummary({kind:'keywords',result:{}}),/未记录/);
});

test('report download keeps a named save link and visible ready feedback',async()=>{
 const root=fixtureRoot(),life=createLifecycle();let revoke=0;
 const c={root,life,state:{projects:[{id:'p',title:'验收研究',products:[]}]},context:{objectURLs:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:()=>revoke++}},api:{blob:async()=>new Blob(['report'])}};
 const page=renderReport(c);page.find(n=>n.tagName==='BUTTON'&&n.textContent==='下载完整研究报告 ↓').click();await new Promise(r=>setImmediate(r));
 const save=page.find(n=>n.tagName==='A'&&n.download);assert.ok(save);assert.match(save.download,/验收研究/);
 assert.ok(page.find(n=>n.textContent.includes('报告已准备好')));life.dispose();assert.equal(revoke,1);
});
