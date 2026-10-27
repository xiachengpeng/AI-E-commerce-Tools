import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {createApi} from '../../js/research-workbench/api.mjs';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
import {renderReport} from '../../js/research-workbench/pages/reports.mjs';
import {render as focused} from '../../js/research-workbench/pages/focused-exploration.mjs';
import {renderProduct} from '../../js/research-workbench/pages/product.mjs';
const text=n=>n.textContent+' '+n.children.map(text).join(' ');
const tick=()=>new Promise(r=>setImmediate(r));
const project=()=>({id:'p',title:'Fixture',market:'US',version:1,keywords:[{id:'k',text:'gap tool',approved:true,status:'ready'}],products:[{id:'x',name:'Gap tool',source_keyword_ids:['k'],identification:{relevance_confirmed:true,confirmation_method:'ai'},steps:[]}]});
const lives=[];test.afterEach(()=>{for(const life of lives.splice(0))life.dispose();});
const context=p=>({root:fixtureRoot(),life:(()=>{const life=createLifecycle();lives.push(life);return life;})(),context:{},state:{project:p,projects:[p],actions:[],step:'score',product:'x',commands:{},drafts:{},keywordActions:{}},navigate(){},showQueue(){},command(){},selectProduct(){},api:{request:async()=>({actions:[]})}});

test('local UI research requests stay on its same origin without weakening auth or replaying writes',async()=>{
 const seen=[],api=createApi({pageOrigin:'http://127.0.0.1:9502',fetch:async(url,options)=>{seen.push([url,options]);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:{}};}});
 await api.session();await api.request('/projects',{method:'POST',body:{command_id:'stable'}});
 assert.equal(seen[1][0],'http://127.0.0.1:9502/api/research/workbench/v1/projects');assert.equal(seen[1][1].headers['X-Research-Token'],'fixture');assert.equal(seen[1][1].redirect,'error');assert.equal(seen.length,2);
});
test('AI matched product is never presented as human confirmed in exploration',()=>{
 const c=context(project());const body=text(focused(c));assert.match(body,/AI.*待.*人工/);assert.doesNotMatch(body,/相关性已确认|商品相关性：已确认/);c.life.dispose();
});
test('all report actions and loaded review follow the selected project',()=>{
 const p=project(),c=context(p);c.state.projects.push({...p,id:'other',title:'Other',products:[]});c.state.researchReviewId='other';c.state.researchReview={keywords:[]};
 const page=renderReport(c);assert.equal(page.children.filter(n=>n.children?.some(x=>x.textContent==='下载完整研究报告 ↓')).length,1);assert.doesNotMatch(text(page),/研究复盘 · Other/);c.life.dispose();
});
test('blocked scoring uses business labels and audit fields stay collapsed',()=>{
 const p=project();p.products[0].scores=[{revision:1,total:null,status:'incomplete',missing:['coarse_screen','economics'],recommendation:'证据不足：coarse_screen, economics'}];
 const c=context(p),page=renderProduct(c),body=text(page);assert.match(body,/广告粗筛/);assert.match(body,/成本与风险/);
 const score=page.find(n=>n.className.includes('score-card'));assert.doesNotMatch(score.children.filter(n=>n.tagName!=='DETAILS'&& !n.className.includes('score-breakdown')).map(text).join(' '),/coarse_screen|economics|workbench-score/);c.life.dispose();
});
test('demand group leads with evidence and keeps raw expansion sources collapsed',()=>{
 const p=project();p.products[0].steps=['expansion','channels','funnel'].map(key=>({key,state:'pending'}));p.products[0].expansion_sources=[{source_kind:'landing',text:'Raw navigation and checkout text'}];
 const c=context(p);c.state.step='expansion';const page=renderProduct(c);assert.ok(page.find(n=>n.textContent==='需求与竞争：先看证据，再决定投入'));
 const raw=page.find(n=>n.textContent==='Raw navigation and checkout text');assert.equal(raw.parentElement.tagName,'DETAILS');assert.ok(!raw.parentElement.open);
 page.find(n=>n.dataset.journeyGroup==='demand').click();assert.equal(c.state.step,'channels');c.life.dispose();
});
test('coarse summary separates collected ads from manual verification without claiming independence',()=>{
 const p=project();p.keywords[0].ads=[{id:'ad',ad_age_days:101,currently_active:true}];p.products[0].candidate_sources=[{keyword_id:'k',ad_id:'ad'}];const c=context(p);c.state.step='coarse';
 const body=text(renderProduct(c));assert.match(body,/采集观察：1 条绑定广告/);assert.match(body,/首次投放距今：未知/);assert.match(body,/不能证明创意独立/);assert.match(body,/先记录决定/);assert.equal(p.products[0].identification.creatives,undefined);c.life.dispose();
});
test('search confirms in project context and completion replaces the queued receipt',async()=>{
 const p=project(),root=fixtureRoot(),wb=createWorkbench(),writes=[];let completed=false;
 await wb.mount(root,{fetch:async(url,o)=>{if(o.method==='POST'){writes.push(o.body);return {ok:true,json:async()=>({id:'a',status:'ready'})};}return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects')?{projects:[p]}:url.includes('/actions?')?{actions:completed?[{id:'a',kind:'scan',status:'complete',result:{ads:3}}]:[{id:'a',kind:'scan',status:'ready'}]}:p};}});
 try { root.querySelector('[data-rw-projects]').find(n=>n.textContent==='Fixture').click();await tick();
 root.querySelector('[data-rw-page]').find(n=>n.textContent==='搜索这个词').click();await tick();
 assert.equal(wb.state.view,'project');assert.equal(writes.length,0);let page=root.find(n=>n.tagName==='DIALOG');assert.ok(page);assert.match(text(page),/目标市场：美国/);assert.match(text(page),/gap tool/);
 page.find(n=>n.textContent==='确认提交：搜索这个词').click();await new Promise(r=>setTimeout(r,30));assert.equal(writes.length,1);assert.equal(wb.state.view,'project');
 completed=true;await wb.refresh();assert.match(root.querySelector('[data-rw-status]').textContent,/完成.*3 条/);} finally {wb.unmount();}
});
