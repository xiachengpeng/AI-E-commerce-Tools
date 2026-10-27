import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
import {renderJourney,designPage} from '../../js/research-workbench/components/presentation.mjs';
import {createForm} from '../../js/research-workbench/components/forms.mjs';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function journeyContext(){return {root:fixtureRoot(),life:createLifecycle(),state:{view:'project',projectSection:'leads',project:{id:'r'},product:null},navigate(view){this.state.view=view;}};}

test('find clues switches from product verification to keyword preparation and marks step one',async()=>{
 const c=journeyContext();try{const nav=renderJourney(c);nav.children[0].click();await tick();
 assert.equal(c.state.projectSection,'keywords');assert.equal(c.state.view,'project');
 const restored=renderJourney(c);assert.equal(restored.children[0].attributes['aria-current'],'step');
 assert.equal(designPage(c.state).number,'03');
 }finally{c.life.dispose();}
});
test('verification explicitly returns to source leads without silently retaining keywords',async()=>{
 const c=journeyContext();c.state.projectSection='keywords';try{renderJourney(c).children[1].click();await tick();assert.equal(c.state.projectSection,'leads');assert.equal(c.state.view,'project');}finally{c.life.dispose();}
});
test('later stages without a selected product open an explicit product selection page even after old lifecycle disposal',async()=>{
 for(const [index,target] of [[2,'channels'],[3,'economics'],[4,'decision']]){
  const c=journeyContext();c.navigate=function(view){this.state.view=view;this.life.dispose();};
  renderJourney(c).children[index].click();await tick();
  assert.equal(c.state.view,'product_selection');assert.equal(c.state.stageTarget,target);
  const life=createLifecycle();try{const nav=renderJourney({...c,life});assert.equal(nav.children[index].attributes['aria-current'],'step');}finally{life.dispose();}
 }
});
test('two secondary research entries are flat actions and back visits prior pages without replaying requests',async()=>{
 const host=fixtureRoot(),w=createWorkbench(),requests=[];
 try{await w.mount(host,{fetch:async(url,options)=>{requests.push([url,options.method]);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.includes('/history')?{entries:[]}:{projects:[]}};}});
 const nav=()=>host.querySelector('[data-rw-projects]');
 assert.ok(nav().children.some(n=>n.tagName==='BUTTON'&&n.textContent==='研究工具与日志'));
 assert.ok(nav().children.some(n=>n.tagName==='BUTTON'&&n.textContent==='研究历史'));
 assert.equal(nav().find(n=>n.tagName==='SUMMARY'&&n.textContent==='更多'),null);
 w.navigate('history');await tick();w.navigate('reports');await tick();
 const back=host.find(n=>n.tagName==='BUTTON'&&n.attributes['aria-label']==='返回上一页');assert.ok(back);back.click();await tick();assert.equal(w.state.view,'history');
 await w.refresh();const again=host.find(n=>n.tagName==='BUTTON'&&n.attributes['aria-label']==='返回上一页');again.click();await tick();assert.equal(w.state.view,'projects');
 assert.ok(requests.every(([,method])=>!method||method==='GET'));
 }finally{w.unmount();}
});
function reasonForm(initial=''){
 const c={root:fixtureRoot(),life:createLifecycle(),context:{storage:{getItem:()=>null,setItem(){},removeItem(){}}},state:{drafts:{},project:{id:'r',version:1}}};let sent;
 const f=createForm(c,{title:'确认具体商品',defs:[{key:'reason',label:'广告与商品相关性依据',type:'textarea',required:true,suggestions:['广告落地页直接指向该商品详情页','广告展示的品牌、型号或 SKU 与商品页一致']},{key:'relevance_confirmed',label:'我已核对广告与此商品相关',type:'checkbox',required:false}],initial:{reason:initial},key:'reason-fixture',submit:async data=>{sent=data;},successView:'product'});c.navigate=()=>{};
 return {c,f,sent:()=>sent};
}
test('common relevance choice keeps the string payload and never checks or submits confirmation automatically',async()=>{
 const {c,f,sent}=reasonForm();try{const choices=f.host.find(n=>n.tagName==='SELECT'&&n.attributes['aria-label']==='选择广告与商品相关性依据');assert.ok(choices);
 assert.equal(choices.value,'');assert.equal(f.inputs.get('relevance_confirmed').checked,false);
 choices.value='广告落地页直接指向该商品详情页';choices.dispatchEvent(new Event('change'));
 assert.equal(sent(),undefined);assert.equal(f.inputs.get('reason').value,'广告落地页直接指向该商品详情页');assert.equal(f.inputs.get('relevance_confirmed').checked,false);
 f.form.dispatchEvent(new Event('submit',{cancelable:true}));await tick();assert.equal(sent().reason,'广告落地页直接指向该商品详情页');assert.equal(sent().relevance_confirmed,false);
 }finally{c.life.dispose();}
});
test('legacy free text and custom draft survive choosing a preset and switching back to other',()=>{
 const {c,f}=reasonForm('实拍包装的型号和广告对应，已逐项核对');try{const choices=f.host.find(n=>n.tagName==='SELECT');assert.ok(choices);assert.equal(choices.value,'__other__');assert.equal(f.inputs.get('reason').hidden,false);
 choices.value='广告落地页直接指向该商品详情页';choices.dispatchEvent(new Event('change'));assert.equal(f.inputs.get('reason').hidden,true);
 choices.value='__other__';choices.dispatchEvent(new Event('change'));assert.equal(f.inputs.get('reason').value,'实拍包装的型号和广告对应，已逐项核对');assert.equal(f.inputs.get('reason').hidden,false);
 f.inputs.get('reason').value='其他实际观察';f.inputs.get('reason').dispatchEvent(new Event('input'));assert.equal(c.state.drafts['reason-fixture'].values.reason,'其他实际观察');
 }finally{c.life.dispose();}
});

test('route history ignores refresh, stays bounded and restores positions using latest project facts',async()=>{
 const {rememberRoute,restoreRoute}=await import('../../js/research-workbench/services/navigation.mjs');
 const state={view:'project',project:{id:'r',version:1,products:[{id:'p',name:'Old'}]},product:'p',projectSection:'keywords'};
 rememberRoute(state);rememberRoute(state);assert.equal(state.navigationTrail,undefined);
 state.projectSection='leads';rememberRoute(state);const previous=state.navigationTrail.pop();state.project={id:'r',version:8,products:[{id:'p',name:'Latest'}]};restoreRoute(state,previous);
 assert.equal(state.project.version,8);assert.equal(state.project.products[0].name,'Latest');assert.equal(state.projectSection,'keywords');
 for(let n=0;n<45;n++){state.view=n%2?'reports':'history';rememberRoute(state);}assert.equal(state.navigationTrail.length,40);
 const route={...state.renderedRoute,view:'product',product:'gone',form:null};restoreRoute(state,route);assert.equal(state.view,'project');assert.equal(state.product,null);
 assert.throws(()=>restoreRoute(state,{...route,projectId:'other'}),/尚未读取/);
});

test('a restored custom relevance draft reopens other without losing arbitrary saved text',()=>{
 const {c,f}=reasonForm('');try{const key='reason-fixture';c.state.drafts[key]={values:{reason:'已核对配件接口和盒身型号'},version:1};
 const restored=createForm(c,{title:'确认具体商品',defs:[{key:'reason',label:'广告与商品相关性依据',type:'textarea',required:true,suggestions:['广告落地页直接指向该商品详情页']}],key,submit(){}});
 assert.equal(restored.host.find(n=>n.tagName==='SELECT').value,'__other__');assert.equal(restored.inputs.get('reason').value,'已核对配件接口和盒身型号');
 }finally{c.life.dispose();}
});

test('returning to a keyword editor resolves current objects instead of offering stale values with a new version',async()=>{
 const {rememberRoute,restoreRoute}=await import('../../js/research-workbench/services/navigation.mjs');
 const old={id:'k',text:'old word'},state={view:'form',project:{id:'r',version:1,keywords:[old],products:[]},form:{kind:'edit_keyword',keyword:old}};
 rememberRoute(state);const route=structuredClone(state.renderedRoute);
 state.project={id:'r',version:9,keywords:[{id:'k',text:'current corrected word'}],products:[]};restoreRoute(state,route);
 assert.equal(state.form.keyword.text,'current corrected word');assert.equal(state.project.version,9);
 state.project.keywords=[];restoreRoute(state,route);assert.equal(state.view,'project');assert.equal(state.form,null);
});

test('queue auto-selection is part of its final location so refresh does not make Back appear stuck',async()=>{
 const project={id:'r',title:'Queue fixture',version:1,market:'US',keywords:[],products:[{id:'p',name:'Actual product'}],queues:{triage:[{product_id:'p',name:'Actual product'}]}};
 const host=fixtureRoot(),w=createWorkbench();try{
 await w.mount(host,{fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/r')?structuredClone(project):url.includes('/actions?')?{actions:[]}:{projects:[structuredClone(project)]}})});
 host.find(n=>n.tagName==='BUTTON'&&n.textContent==='Queue fixture').click();await tick();host.find(n=>n.tagName==='BUTTON'&&n.textContent==='选品队列').click();await tick();
 assert.equal(w.state.view,'triage');assert.equal(w.state.product,'p');const count=w.state.navigationTrail.length;
 await w.refresh();assert.equal(w.state.navigationTrail.length,count);
 host.find(n=>n.tagName==='BUTTON'&&n.attributes['aria-label']==='返回上一页').click();await tick();assert.equal(w.state.view,'project');
 }finally{w.unmount();}
});

test('Back across projects reloads authoritative data and failed reads retain the current location for retry',async()=>{
 const a={id:'a',title:'Alpha',version:1,market:'US',keywords:[],products:[]},b={...a,id:'b',title:'Beta'};let latest=1,fail=false;
 const host=fixtureRoot(),w=createWorkbench(),methods=[];
 try{await w.mount(host,{fetch:async(url,o)=>{methods.push(o.method);if(fail&&url.endsWith('/projects/a'))throw Error('offline');return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/a')?{...a,version:latest}:url.endsWith('/projects/b')?b:url.includes('/actions?')?{actions:[]}:{projects:[a,b]}};}});
 host.find(n=>n.tagName==='BUTTON'&&n.textContent==='Alpha').click();await tick();host.find(n=>n.tagName==='BUTTON'&&n.textContent==='Beta').click();await tick();assert.equal(w.state.project.id,'b');
 const trail=w.state.navigationTrail.length;fail=true;host.find(n=>n.attributes['aria-label']==='返回上一页').click();await tick();assert.equal(w.state.project.id,'b');assert.equal(w.state.navigationTrail.length,trail);
 fail=false;latest=9;host.find(n=>n.attributes['aria-label']==='返回上一页').click();await tick();assert.equal(w.state.project.id,'a');assert.equal(w.state.project.version,9);assert.ok(methods.every(m=>m==='GET'));
 }finally{w.unmount();}
});


test('real workbench opens each later stage through product selection with no mutations or automatic candidate choice',async()=>{
 for(const [index,target] of [[2,'channels'],[3,'economics'],[4,'decision']]){
  const project={id:'r',title:'Stage project',version:1,market:'US',keywords:[],products:[{id:'p',name:'Actual candidate',identification:{}}]};
  const host=fixtureRoot(),w=createWorkbench(),methods=[];
  try{await w.mount(host,{fetch:async(url,o)=>{methods.push(o.method);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/r')?structuredClone(project):url.includes('/actions?')?{actions:[]}:{projects:[structuredClone(project)]}};}});
   host.find(n=>n.tagName==='BUTTON'&&n.textContent==='Stage project').click();await tick();
   const journey=host.find(n=>n.attributes['aria-label']==='研究进度');journey.children[index].click();await tick();
   assert.equal(w.state.view,'product_selection');assert.equal(w.state.stageTarget,target);
   const select=host.find(n=>n.tagName==='SELECT'&&n.attributes['aria-label']==='选择研究商品');assert.ok(select);assert.equal(select.value,'');assert.equal(w.state.product,null);
   const proceed=host.find(n=>n.dataset.stageContinue==='true');assert.ok(proceed);assert.equal(proceed.disabled,true);
   select.value='p';select.dispatchEvent(new Event('change'));assert.equal(proceed.disabled,false);proceed.click();await tick();
   assert.equal(w.state.view,'product');assert.equal(w.state.product,'p');assert.equal(w.state.step,target);assert.ok(methods.every(m=>m==='GET'));
  }finally{w.unmount();}
 }
});

test('stage selection has a real empty state and never offers merged-away product identities',async()=>{
 const {renderStageSelection}=await import('../../js/research-workbench/pages/stage-selection.mjs'),c=journeyContext();c.state.stageTarget='decision';c.state.project.products=[{id:'gone',name:'Merged',merged_into:'another'}];c.openForm=()=>{};
 try{const page=renderStageSelection(c);assert.ok(page.find(n=>n.textContent==='当前项目还没有商品'));assert.equal(page.find(n=>n.tagName==='SELECT'),null);const back=page.find(n=>n.tagName==='BUTTON'&&n.textContent==='去核实商品');back.click();await tick();assert.equal(c.state.view,'project');assert.equal(c.state.projectSection,'leads');}finally{c.life.dispose();}
});
test('a valid selected product goes straight to the requested stage while a stale identity opens the picker',async()=>{
 const c=journeyContext(),calls=[];c.state.project.products=[{id:'p',name:'Current'}];c.state.product='p';c.openProduct=(...args)=>calls.push(args);
 try{renderJourney(c).children[4].click();await tick();assert.deepEqual(calls,[['r','p','decision']]);c.state.product='missing';renderJourney(c).children[2].click();await tick();assert.equal(c.state.view,'product_selection');assert.equal(c.state.stageTarget,'channels');}finally{c.life.dispose();}
});
