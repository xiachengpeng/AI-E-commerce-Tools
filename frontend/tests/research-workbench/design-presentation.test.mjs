import test from 'node:test';
import assert from 'node:assert/strict';
import { designPage, formSection, renderCandidateList, productThumbnail, creativePreviewBinding } from '../../js/research-workbench/components/presentation.mjs';
import {renderPaths,renderKeywordSection} from '../../js/research-workbench/pages/exploration.mjs';
import { fixtureRoot } from './dom-fixture.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
import {formPreview} from '../../js/research-workbench/components/form-preview.mjs';
import {createForm,fields} from '../../js/research-workbench/components/forms.mjs';

test('UI order preview never converts missing cost to zero or reports partial profit',()=>{
 const base={aov:'29.90',goods_cost:'8',shipping:'5',packaging:'.5',payment_percent:'2.9',payment_fixed:'.3',reserve_percent:'3',tax:'',ad_cost:''};
 const result=formPreview('核算这笔订单是否值得做',base);
 assert.equal(result.complete,false);assert.equal(result.rows.find(r=>r[0]==='已填写成本合计')[1],'USD 15.56');
 assert.ok(result.missing.includes('税费'));assert.ok(result.missing.includes('广告成本'));assert.equal(result.rows.some(r=>/利润/.test(r[0])),false);
});
test('test metric preview distinguishes blank and explicit zero denominators without success claims',()=>{
 assert.deepEqual(formPreview('记录真实测试结果',{spend:'120',impressions:'10000',clicks:'200',orders:'6',revenue:'180'}).rows,[['CTR','2.00%'],['CPA','USD 20.00'],['ROAS','1.50']]);
 const r=formPreview('记录真实测试结果',{spend:'0',impressions:'0',clicks:'0',orders:'0',revenue:''});
 assert.ok(r.rows.every(row=>row[1]==='未知'));assert.equal(r.complete,false);
});

test('design screens map the existing ten product steps without adding business states',()=>{
 const expected={identification:'06',coarse:'07',expansion:'08',channels:'09',funnel:'10',economics:'11',score:'12',decision:'13',test:'14',review:'16'};
 for(const [step,number] of Object.entries(expected))assert.equal(designPage({view:'product',step}).number,number);
 for(const view of ['actions','paths','sync','history'])assert.equal(designPage({view}).journey,false);
 assert.equal(designPage({view:'form',form:{kind:'new_project'}}).number,'02');
 assert.equal(designPage({view:'project',projectSection:'keywords'}).number,'03');
});

test('cross-project source paths load the owning project before opening a product',async()=>{
 const life=createLifecycle(),calls=[],project={id:'other',title:'另一项目',keywords:[{id:'k',text:'actual'}],products:[{id:'p',name:'实际商品',source_keyword_ids:['k']}]};
 const c={root:fixtureRoot(),life,state:{project:{id:'current'},projects:[project]},openProject:async id=>{calls.push(['load',id]);c.state.project=project;},openProduct:(...args)=>calls.push(['open',...args])};
 const paths=renderPaths(c);paths.find(n=>n.textContent==='实际商品').click();await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls,[['load','other'],['open','other','p','identification']]);life.dispose();
});

test('a late thumbnail lease is released after its page is disposed',async()=>{
 const life=createLifecycle();let resolve,released=0;
 const c={root:fixtureRoot(),life,state:{project:{id:'project',keywords:[{id:'k'}]}},mediaCache:{acquire:()=>new Promise(r=>{resolve=r;})}};
 const host=productThumbnail(c,{id:'p',name:'商品',source_keyword_ids:['k'],landing_snapshot:{images:['actual'],observed_at:'now'}});
 life.dispose();resolve({url:'blob:test',release:()=>released++});await new Promise(r=>setImmediate(r));
 assert.equal(released,1);assert.equal(host.find(n=>n.tagName==='IMG'),null);
});

test('offscreen candidate thumbnails wait for visibility and stop observing on disposal',async()=>{
 const root=fixtureRoot(),life=createLifecycle();let callback,calls=0,disconnected=0;
 root.ownerDocument.defaultView={IntersectionObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnected++;}}};
 productThumbnail({root,life,state:{project:{id:'p',keywords:[{id:'k'}]}},mediaCache:{acquire:async()=>{calls++;return {url:'blob:actual',release(){}};}}},{id:'x',source_keyword_ids:['k'],landing_snapshot:{images:['actual']}});
 assert.equal(calls,0);callback([{isIntersecting:false}]);assert.equal(calls,0);callback([{isIntersecting:true}]);await new Promise(r=>setImmediate(r));assert.equal(calls,1);life.dispose();assert.ok(disconnected>=1);
});

test('creative previews match current form identity, never binding order or conflicting URLs',()=>{
 const project={keywords:[{id:'k',ads:[{id:'A'},{id:'B'},{id:'C'}]}]},product={candidate_sources:['A','B','C'].map(ad_id=>({keyword_id:'k',ad_id}))};
 assert.equal(creativePreviewBinding(project,product,'B','https://www.facebook.com/ads/library/?id=B').ad.id,'B');
 assert.equal(creativePreviewBinding(project,product,'A','').ad.id,'A');
 assert.equal(creativePreviewBinding(project,product,'B','https://www.facebook.com/ads/library/?id=A'),null);
 assert.equal(creativePreviewBinding(project,product,'unbound',''),null);
 assert.equal(creativePreviewBinding(project,product,'','https://www.facebook.com/ads/library/?id=C').ad.id,'C');
});

test('decision cards keep the existing pool payload and do not submit on selection',()=>{
 const life=createLifecycle();let submitted=0;const c={root:fixtureRoot(),life,context:{storage:{getItem:()=>null,setItem(){}}},state:{drafts:{},project:{id:'p',version:1}}};
 const f=createForm(c,{title:'做出人工决策',defs:fields([['pool','最终去向','select',true,{observe:'观察',test:'测试池',backup:'备选池',reject:'淘汰'}]]),key:'test-decision',initial:{pool:'observe'},submit:()=>submitted++});
 const radio=f.host.find(n=>n.type==='radio'&&n.value==='backup');assert.ok(radio);radio.checked=true;radio.dispatchEvent(new Event('change'));
 assert.equal(f.inputs.get('pool').value,'backup');assert.equal(submitted,0);life.dispose();
});

test('cost section switching preserves values and exposes the first invalid required field',()=>{
 const life=createLifecycle(),c={root:fixtureRoot(),life,context:{storage:{getItem:()=>null,setItem(){}}},state:{drafts:{},project:{id:'p',version:1}}};
 const defs=fields([['goods_cost','货值','number'],['quote_source','报价来源'],['logistics_risk','物流风险','select',true,{unknown:'待核实',low:'低'}]]);
 const f=createForm(c,{title:'核算这笔订单是否值得做',defs,key:'cost-tabs',initial:{goods_cost:8},submit(){}});
 const quote=f.host.find(n=>n.textContent==='报价来源'&&n.tagName==='BUTTON');assert.ok(quote);quote.click();
 assert.equal(f.inputs.get('goods_cost').value,'8');assert.equal(f.inputs.get('quote_source').parentElement.parentElement.hidden,false);
 f.inputs.get('goods_cost').dispatchEvent(new Event('invalid'));
 assert.equal(f.inputs.get('goods_cost').parentElement.parentElement.hidden,false);assert.equal(f.inputs.get('quote_source').parentElement.parentElement.hidden,true);
 let reports=0;f.inputs.get('goods_cost').validity={valid:false};f.inputs.get('goods_cost').reportValidity=()=>reports++;quote.click();f.form.dispatchEvent(new Event('submit',{cancelable:true}));
 assert.equal(reports,1);assert.equal(f.inputs.get('goods_cost').parentElement.parentElement.hidden,false);life.dispose();
});
test('field grouping keeps unknown fields and separates real result inputs from projections',()=>{
 assert.equal(formSection({key:'goods_cost'},'核算这笔订单是否值得做'),'成本与费用');
 assert.equal(formSection({key:'quote_source'},'核算这笔订单是否值得做'),'报价来源与时效');
 assert.equal(formSection({key:'spend'},'记录真实测试结果'),'费用与转化');
 assert.equal(formSection({key:'future_field'},'未知表单'),'');
 assert.equal(formSection({key:'x',group:'原有分组'},'any'),'原有分组');
});
test('candidate navigation uses only actual product IDs, shows missing sources and never writes',()=>{
 const life=createLifecycle(),selected=[],c={root:fixtureRoot(),life,state:{},api:{request:()=>{throw Error('unexpected request');}},context:{}};
 const list=renderCandidateList(c,[{id:'a',name:'实际商品'},{id:'b',name:'另一件',identification:{relevance_confirmed:true}}],'a',p=>selected.push(p.id));
 assert.ok(list.find(n=>n.textContent==='实际商品'));
 assert.ok(list.find(n=>n.textContent==='待确认匹配'));
 list.find(n=>n.dataset.candidateId==='b').click();
 assert.deepEqual(selected,['b']);life.dispose();
});

test('keyword edit drawer provides a read-only comparison without stale mutation handlers',()=>{
 const life=createLifecycle(),c={root:fixtureRoot(),life,state:{project:{keywords:[{id:'k',text:'actual',type:'category',meaning:'实际含义',status:'pending_review'}]}}};
 const table=renderKeywordSection(c,{readOnly:true});assert.ok(table.find(n=>n.textContent==='实际含义'));assert.equal(table.find(n=>n.tagName==='BUTTON'),null);assert.ok(table.find(n=>n.textContent.includes('先保存或取消右侧编辑')));life.dispose();
});

test('project progress counts actual confirmed products and excludes merged archives',async()=>{
 const {projectResearchProgress}=await import('../../js/research-workbench/pages/projects.mjs');
 assert.deepEqual(projectResearchProgress({products:[{identification:{relevance_confirmed:true}},{identification:{}},{merged_into:'another',identification:{relevance_confirmed:true}}]}),{verified:1,total:2,pending:1});
 assert.deepEqual(projectResearchProgress({}),{verified:0,total:0,pending:0});
});

test('queue category tabs reveal existing groups without mutating any product',async()=>{
 const {renderTriage}=await import('../../js/research-workbench/pages/triage.mjs');let commands=0;
 const life=createLifecycle(),c={root:fixtureRoot(),life,state:{project:{id:'p',keywords:[],products:[],summary:{},queues:{triage:[{product_id:'a',name:'A'}],observing:[{product_id:'b',name:'B'}]}}},navigate(){},command(){commands++;}};
 const host=renderTriage(c),tab=host.find(n=>n.tagName==='BUTTON'&&n.textContent==='观察中（1）');assert.ok(tab);tab.click();await new Promise(r=>setImmediate(r));
 assert.equal(commands,0);assert.equal(tab.attributes['aria-selected'],'true');assert.equal(host.find(n=>n.dataset.queueCategory==='observing').hidden,false);assert.equal(host.find(n=>n.dataset.queueCategory==='triage').hidden,true);life.dispose();
});

test('source path inspection shows exact child provenance without changing approvals or submitting',()=>{
 const life=createLifecycle(),project={id:'r',title:'路径',keywords:[{id:'parent',text:'parent',status:'complete',ads:[]},{id:'child',text:'child',parent_id:'parent',source_quote:'Exact quote',status:'pending_review'}],products:[]};let writes=0;
 const c={root:fixtureRoot(),life,state:{project,projects:[project]},api:{request:()=>writes++},navigate(){},openProject(){}};
 const page=renderPaths(c);const inspect=page.find(n=>n.dataset.inspectKeyword==='child');assert.ok(inspect);inspect.click();
 assert.ok(page.find(n=>n.className==='rw-path-inspector').find(n=>n.textContent==='Exact quote'));assert.equal(writes,0);assert.equal(project.keywords[1].status,'pending_review');life.dispose();
});

test('creative review progress counts only identified distinct active entries and never counts duplicate IDs twice',async()=>{
 const {creativeReviewProgress}=await import('../../js/research-workbench/components/presentation.mjs');
 assert.deepEqual(creativeReviewProgress({creative_1_id:'a',creative_1_distinct:true,creative_1_active:true,creative_2_id:'a',creative_2_distinct:true,creative_2_active:true,creative_3_distinct:true,creative_3_active:true},3),{identified:1,distinct:1,active:1,distinctActive:1});
});

test('score evidence rows do not invent a dimension score or pass from incomplete evidence',async()=>{
 const {scoreEvidenceGroups}=await import('../../js/research-workbench/components/presentation.mjs');
 const rows=scoreEvidenceGroups({revision:2,requirement_statuses:[{key:'trends_5y',status:'missing',blocks_scoring:true}],scores:[{revision:1,status:'complete',dimensions:[{key:'demand_trend',score:5}]}]});assert.equal(rows.length,5);assert.equal(rows[0].score,null);assert.equal(rows[0].status,'待补证');assert.equal(rows[1].status,'待评估');
});

test('design report loads local review statistics once per project version without repeated selection requests',async()=>{
 const {renderReport}=await import('../../js/research-workbench/pages/reports.mjs'),life=createLifecycle(),project={id:'r',title:'Research',version:1,products:[]},calls=[];
 const c={root:fixtureRoot(),life,designDirectForms:true,state:{project,projects:[project]},navigate(){},api:{request:async path=>{calls.push(path);return {window:{},keywords:[]};}}};renderReport(c);await new Promise(r=>setImmediate(r));renderReport(c);await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['/projects/r/intelligence']);project.version=2;renderReport(c);await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);life.dispose();
});

test('decision option availability reflects necessary current score gates without inventing a passed score',async()=>{
 const {decisionOptionAvailability}=await import('../../js/research-workbench/components/presentation.mjs');const rules={test_score:18,backup_score:15};let p={revision:2,scores:[]};assert.equal(decisionOptionAvailability(p,rules).test,false);p.scores=[{revision:1,status:'complete',total:25}];assert.equal(decisionOptionAvailability(p,rules).backup,false);p.scores=[{revision:2,status:'complete',total:16,hard_failures:[]}];assert.equal(decisionOptionAvailability(p,rules).test,false);assert.equal(decisionOptionAvailability(p,rules).backup,true);p.requirement_statuses=[{blocks_scoring:true,status:'missing',applies:true}];assert.equal(decisionOptionAvailability(p,rules).backup,false);p.requirement_statuses=[];p.scores[0].total=19;assert.equal(decisionOptionAvailability(p,rules).test,true);
});

test('nested rule inputs reveal their original tab and closed disclosure before native validation',()=>{
 const life=createLifecycle(),c={root:fixtureRoot(),life,context:{},state:{drafts:{},project:{id:'p',version:1}}};const f=createForm(c,{title:'项目规则与预算',defs:[{key:'min_aov',label:'最低',type:'number',group:'选品标准'},{key:'daily_scan_budget',label:'预算',type:'number',group:'采集与预算'}],key:'nested-rules',submit(){}});
 try{const input=f.inputs.get('min_aov'),group=input.parentElement.parentElement,details=c.root.ownerDocument.createElement('details'),nested=c.root.ownerDocument.createElement('div');input.parentElement.remove();nested.append(input.parentElement);details.append(nested);group.append(details);details.open=false;const budget=f.host.find(n=>n.tagName==='BUTTON'&&n.textContent==='采集与预算');budget.click();input.validity={valid:false};let reported=0;input.reportValidity=()=>reported++;f.form.dispatchEvent(new Event('submit',{cancelable:true}));assert.equal(group.hidden,false);assert.equal(details.open,true);assert.equal(reported,1);assert.equal(c.root.ownerDocument.activeElement,input);}finally{life.dispose();}
});
