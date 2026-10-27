import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRoot } from './dom-fixture.mjs';
import { createLifecycle } from '../../js/research-workbench/lifecycle.mjs';
import { renderProduct, productSteps, nextProductStep } from '../../js/research-workbench/pages/product.mjs';
const keys=['identification','coarse','expansion','channels','funnel','economics','score','decision','test','review'];
const nodes=n=>[n,...n.children.flatMap(nodes)];
test('expired evidence on a backup decision returns to required work instead of directly to review',()=>{
 const product={decision:{pool:'backup',stale:false},steps:[{key:'economics',state:'needs_input'},{key:'score',state:'needs_input'},{key:'decision',state:'needs_input'},{key:'review',state:'passed'}]};
 assert.equal(nextProductStep(product),'economics');
 product.steps.find(s=>s.key==='decision').state='passed';assert.equal(nextProductStep(product),'review');
});
function context(step){const root=fixtureRoot(),life=createLifecycle();return {root,life,context:{},state:{step,product:'p',project:{id:'r',version:4,market:'US',keywords:[],products:[{id:'p',name:'Widget',revision:3,identity_revision:2,identification:{},steps:keys.map(key=>({key,label:key,state:'pending'}))}]},commands:{},drafts:{},actions:[]},navigate(){},openForm(){},selectProduct(){},showQueue(){},command(){},api:{request(){throw Error('unexpected network');}}};}

test('product presents four task groups and concrete missing-evidence navigation without submitting',async()=>{
 const c=context('score'),p=c.state.project.products[0];let writes=0,navigated;
 p.steps.find(s=>s.key==='coarse').state='needs_input';p.steps.find(s=>s.key==='coarse').reason='缺独立创意';
 c.command=()=>writes++;c.navigate=v=>navigated=v;
 const page=renderProduct(c);assert.equal(nodes(page).filter(n=>n.dataset.journeyGroup).length,4);
 const task=nodes(page).find(n=>n.dataset.taskStep==='coarse');assert.ok(task);task.click();await new Promise(r=>setTimeout(r,0));
 assert.equal(c.state.step,'coarse');assert.equal(navigated,'product');assert.equal(writes,0);c.life.dispose();
});
test('risk and certification start unknown; opening the form never invents confirmed facts',async()=>{
 const c=context('economics'),sent=[];c.api.request=async(path,options)=>{sent.push(options.body);return c.state.project;};
 const page=renderProduct(c);nodes(page).find(n=>n.textContent==='填写 / 更新订单测算').click();await new Promise(r=>setTimeout(r,0));
 for(const key of ['logistics_risk','compliance_risk','ip_risk','certification_required','certification_verified'])assert.equal(nodes(page).find(n=>n.name===key).value,'',key);
 nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));
 assert.equal(sent.length,1);for(const key of ['logistics_risk','compliance_risk','ip_risk','certification_required','certification_verified'])assert.equal(Object.hasOwn(sent[0].payload,key),false,key);c.life.dispose();
});
test('saved risk choices and explicit no-certification survive edits; suggested revenue does not overwrite AOV',async()=>{
 const c=context('economics'),sent=[];c.state.project.products[0].economics={logistics_risk:'medium',certification_required:false,certification_verified:false,aov:87};
 c.api.request=async(path,options)=>{sent.push(options.body);return c.state.project;};
 const page=renderProduct(c);nodes(page).find(n=>n.textContent==='填写 / 更新订单测算').click();await new Promise(r=>setTimeout(r,0));
 const field=key=>nodes(page).find(n=>n.name===key);
 assert.equal(field('logistics_risk').value,'medium');assert.equal(field('certification_required').value,'false');
 field('unit_price').value='20';field('quantity').value='2';field('quantity').dispatchEvent(new Event('input'));
 assert.equal(field('aov').value,'87');assert.match(nodes(page).find(n=>n.dataset.orderRevenuePreview).textContent,/40/);
 nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));
 assert.equal(sent[0].payload.certification_required,false);assert.equal(sent[0].payload.certification_verified,false);c.life.dispose();
});

test('coarse review prefills bound observed sources without inventing independent creatives',async()=>{
 const c=context('coarse'),p=c.state.project.products[0];
 p.candidate_sources=[{keyword_id:'w',ad_id:'bound'}];
 c.state.project.keywords=[{id:'w',ads:[{id:'other',start_date:'2020-01-01'},{id:'bound',start_date:'2026-07-09',observed_at:'2026-10-16T12:00:00Z',active:true}]}];
 const page=renderProduct(c);nodes(page).find(n=>n.textContent==='查看与补充广告证据').click();await new Promise(r=>setTimeout(r,0));
 const input=name=>nodes(page).find(n=>n.name===name);
 assert.equal(input('creative_1_id').value,'bound');assert.match(input('creative_1_url').value,/id=bound/);
 assert.equal(Number(input('active_days').value),99);assert.equal(input('creative_1_distinct').checked,false);
 assert.equal(input('creative_2_id'),undefined);c.life.dispose();
});

test('observation branch does not offer executable test forms',()=>{
 const c=context('test');c.state.project.products[0].steps.find(s=>s.key==='test').state='not_applicable';
 const page=renderProduct(c);assert.ok(nodes(page).filter(n=>['制定 / 批准测试计划','录入真实测试结果'].includes(n.textContent)).every(n=>n.disabled));c.life.dispose();
});

test('unknown observed values render readable labels instead of null',()=>{
 const c=context('funnel');c.state.project.products[0].landing_snapshot={funnel:{first_screen_hook:null,email_capture:null}};
 const page=renderProduct(c),texts=nodes(page).map(n=>n.textContent).join('\n');
 assert.doesNotMatch(texts,/first_screen_hook|email_capture|\bnull\b/);assert.match(texts,/未获取|未知/);c.life.dispose();
});
test('all ten source workflow stages are reachable and unknown economics stay unknown',()=>{assert.deepEqual(productSteps,keys);for(const key of keys){const c=context(key);const page=renderProduct(c);const all=nodes(page);assert.equal(all.filter(n=>n.tagName==='H1').length,1);assert.equal(all.filter(n=>n.dataset.productStep).length,10);if(key==='economics')assert.ok(all.some(n=>n.textContent.includes('未知')));c.life.dispose();}});
test('opening product never silently hands facts to marketing; explicit button sends IDs and fences only',async()=>{const c=context('identification'),received=[];c.onSelectProduct=data=>received.push(data);const page=renderProduct(c);assert.equal(received.length,0);const handoff=nodes(page).find(n=>Object.hasOwn(n.dataset,'productHandoff'));assert.ok(handoff);handoff.click();await new Promise(r=>setTimeout(r,0));assert.deepEqual(received,[{project_id:'r',product_id:'p',source_version:4,identity_revision:2}]);c.life.dispose();});
test('server score total is displayed without recomputing competitor marketing score',()=>{const c=context('score');c.state.project.products[0].scores=[{revision:3,total:19,status:'complete',dimensions:[]}];assert.ok(nodes(renderProduct(c)).some(n=>n.textContent==='19 / 25'));c.life.dispose();});

test('native source forms serialize array and datetime fields and optional costs stay omitted',async()=>{const c=context('funnel'),received=[];c.state.projects=[];c.api.request=async(path,options)=>{received.push(options.body);return c.state.project;};const page=renderProduct(c);nodes(page).find(n=>n.textContent==='补充漏斗拆解').click();await new Promise(r=>setTimeout(r,0));const inputs=nodes(page).filter(n=>n.name);inputs.find(n=>n.name==='creative_formats').value='video、static';inputs.find(n=>n.name==='confirmed').checked=true;nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.deepEqual(received[0].payload.creative_formats,['video','static']);assert.equal(received[0].payload.product_id,'p');c.life.dispose();});

test('triage exposes all original queues and reports keep unknown statistics',async()=>{const {renderTriage}=await import('../../js/research-workbench/pages/triage.mjs');const {renderReport}=await import('../../js/research-workbench/pages/reports.mjs');const c=context('review');c.state.projects=[c.state.project];c.state.project.queues={triage:[{product_id:'p',name:'Widget'}],observing:[{product_id:'p',name:'Widget'}]};c.state.product=null;assert.ok(nodes(renderTriage(c)).some(n=>n.textContent.includes('待快速筛选')));c.state.product='p';assert.ok(nodes(renderTriage(c)).some(n=>n.textContent==='保留并深挖'));assert.ok(nodes(renderReport(c)).some(n=>n.textContent==='下载完整研究报告 ↓'));c.life.dispose();});

for(const [step,label,action] of [['identification','确认具体商品','confirm_product'],['coarse','查看与补充广告证据','confirm_creatives'],['channels','＋ Meta 广告','evidence'],['economics','填写 / 更新订单测算','economics'],['decision','确认去向并填写理由','decide'],['test','制定 / 批准测试计划','test_plan'],['test','录入真实测试结果','test_result'],['review','记录复盘与下一轮建议','review']])test('source payload parity: '+action,async()=>{
 const c=context(step),sent=[];if(action==='confirm_creatives')c.state.project.products[0].identification.creatives=[{id:'saved',source_url:'https://example.invalid/creative',distinct:false,active:false}];c.state.projects=[];c.api.request=async(path,options)=>{sent.push({path,body:options.body});return c.state.project;};const page=renderProduct(c);nodes(page).find(n=>n.textContent===label).click();await new Promise(r=>setTimeout(r,0));const form=nodes(page).find(n=>n.tagName==='FORM');assert.ok(form);
 if(action==='confirm_creatives'){for(const n of nodes(form)){if(n.name?.endsWith('_id'))n.value='creative';if(n.name?.endsWith('_url'))n.value='https://example.invalid/creative';}}
 form.dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.equal(sent.length,1);assert.equal(sent[0].body.action,action);assert.equal(sent[0].body.payload.product_id,'p');assert.equal(sent[0].body.version,4);assert.match(sent[0].body.command_id,/^[0-9a-f-]{36}$/);
 if(action==='economics'){assert.equal(Object.hasOwn(sent[0].body.payload,'aov'),false);assert.equal(Object.hasOwn(sent[0].body.payload,'shipping'),false);assert.equal(Object.hasOwn(sent[0].body.payload,'fragile'),false);}
 if(action==='confirm_creatives'){assert.equal(sent[0].body.payload.identity_revision,2);assert.equal(sent[0].body.payload.creatives.length,1);assert.equal(sent[0].body.payload.creatives[0].active,false);assert.equal(Object.hasOwn(sent[0].body.payload,'creative_1_id'),false);}
 if(action==='evidence'){assert.equal(sent[0].body.payload.channel,'meta');assert.equal(sent[0].body.payload.market,'US');assert.equal(sent[0].body.payload.confirmed,false);}
 if(action==='review')assert.deepEqual(sent[0].body.payload.next_keywords,[]);
 c.life.dispose();
});

test('source economics server weights and scoped scenario estimates render verbatim including unknown product attribution',()=>{const c=context('economics');c.state.project.products[0].economics={actual_weight_kg:0.8,volumetric_weight_kg:1,chargeable_weight_kg:1,quote_freshness:{status:'expired',reason:'Expired'}};c.state.project.products[0].estimates=[{traffic_scope:'domain',monthly_visits_snapshot:1000,cvr_low:1,cvr_base:2,cvr_high:3,scenarios:{low:{monthly_orders:10,monthly_revenue:750},base:{monthly_orders:20,monthly_revenue:1500},high:{monthly_orders:30,monthly_revenue:2250},product_monthly_orders:null}}];const texts=nodes(renderProduct(c)).map(n=>n.textContent).join('\n');assert.match(texts,/体积重：1 kg/);assert.match(texts,/月营收 USD 1500/);assert.match(texts,/商品级订单\/营收：未知/);assert.match(texts,/已过期/);c.life.dispose();});

test('late product form response after navigation cannot replace project DTO',async()=>{const c=context('review');let finish;const original=c.state.project;c.api.request=()=>new Promise(resolve=>finish=resolve);const page=renderProduct(c);nodes(page).find(n=>n.textContent==='记录复盘与下一轮建议').click();await new Promise(r=>setTimeout(r,0));nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));while(!finish)await new Promise(r=>setTimeout(r,1));c.life.dispose();finish({...original,version:5});await new Promise(r=>setTimeout(r,0));assert.equal(c.state.project.version,4);});

test('retaining a lead separately saves focus and automatically opens product H1 without repeating triage',async()=>{const {renderTriage}=await import('../../js/research-workbench/pages/triage.mjs');const c=context('identification'),calls=[],opened=[];c.state.projects=[];c.state.project.queues={triage:[{product_id:'p'}]};c.api.request=async(path,options)=>{calls.push(options.body.action);return {...c.state.project,queues:{triage:[]}};};c.command=async(action,payload)=>{calls.push(action);c.state.project.focus_product_id=payload.product_id;};c.openProduct=(...ids)=>opened.push(ids);const page=renderTriage(c);nodes(page).find(n=>n.textContent==='保留并深挖').click();await new Promise(r=>setTimeout(r,0));nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.deepEqual(calls,['triage_product','focus_product']);assert.deepEqual(opened,[['r','p','identification']]);c.life.dispose();});

test('saved unchecked human-confirmation draft stays unchecked even when prior server record is confirmed',async()=>{const {createForm}=await import('../../js/research-workbench/components/forms.mjs');const c=context('funnel');c.state.drafts.confirm={values:{confirmed:false}};const form=createForm(c,{title:'Review',defs:[{key:'confirmed',label:'I checked source',type:'checkbox'}],key:'confirm',initial:{confirmed:true},submit(){}});assert.equal(form.inputs.get('confirmed').checked,false);c.life.dispose();});

test('legacy boolean drafts restore false in a new tri-state selector without losing pending submission identity',async()=>{
 const {createForm}=await import('../../js/research-workbench/components/forms.mjs');const c=context('economics');
 c.state.drafts.legacy={values:{certification_required:false},command_id:'12345678-1234-4234-8234-123456789012',submittedHash:'pending-hash',uncertain:true};
 const form=createForm(c,{title:'Risk review',defs:[{key:'certification_required',label:'Certification',type:'select',options:{'':'Unknown',true:'Yes',false:'No'}}],key:'legacy',initial:{certification_required:'true'},submit(){}});
 assert.equal(form.inputs.get('certification_required').value,'false');assert.equal(form.draft.submittedHash,'pending-hash');assert.equal(form.draft.uncertain,true);c.life.dispose();
});

test('failed report refresh preserves last successfully read report and its original project identity',async()=>{const {renderReport}=await import('../../js/research-workbench/pages/reports.mjs');const c=context('review');c.state.projects=[c.state.project];const previous={keywords:[],calibration:[],window:{},discovery_sources:[]};c.state.researchReview=previous;c.state.researchReviewId='previous';c.api.request=async()=>{throw Error('Offline');};const page=renderReport(c);nodes(page).find(n=>n.textContent==='查看研究复盘').click();await new Promise(r=>setTimeout(r,0));assert.equal(c.state.researchReview,previous);assert.equal(c.state.researchReviewId,'previous');c.life.dispose();});

test('triage exposes saved product images with controlled selectors, never source URLs',async()=>{const {renderTriage}=await import('../../js/research-workbench/pages/triage.mjs');const c=context('identification');c.state.project.keywords=[{id:'k',text:'packing',ads:[]}];c.state.project.products[0].source_keyword_ids=['k'];c.state.project.products[0].landing_snapshot={images:['https://outside.invalid/image']};const page=renderTriage(c);assert.ok(nodes(page).some(n=>n.dataset.sourcePreview==='true'));assert.equal(nodes(page).filter(n=>n.src==='https://outside.invalid/image').length,0);c.life.dispose();});

test('successful duplicate merge returns to the actual project page with surviving target',async()=>{
 const {createWorkbench}=await import('../../js/research-workbench/index.mjs');const root=fixtureRoot(),wb=createWorkbench();
 const project={id:'r',title:'Merge project',market:'US',version:4,keywords:[],products:[{id:'source',name:'Source',identity_key:'same',identity_revision:1,steps:[]},{id:'target',name:'Target',identity_key:'same',identity_revision:1,steps:[]}]};
 let submittedResolve;const submitted=new Promise(r=>submittedResolve=r);
 await wb.mount(root,{fetch:async(url,options)=>({ok:true,json:async()=>{
  if(url.endsWith('/session'))return {csrf_token:'fake'};
  if(options.method==='POST'){assert.equal(JSON.parse(options.body).action,'merge_products');submittedResolve();return {...project,version:5,products:[project.products[1]]};}
  return url.endsWith('/projects/r')?project:url.includes('/actions')?{actions:[]}:{projects:[project]};
 }})});root.querySelector('[data-rw-projects]').find(n=>n.dataset.rwProject==='r').click();await new Promise(r=>setImmediate(r));wb.openProduct('r','source');
 nodes(root).find(n=>n.textContent==='合并重复档案').click();nodes(root).find(n=>n.name==='reason').value='Confirmed same identity';nodes(root).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await submitted;await new Promise(r=>setImmediate(r));
 assert.equal(wb.state.view,'project');assert.equal(wb.state.product,null);assert.equal(root.querySelector('[data-rw-page]').querySelector('h1').textContent,'Merge project');assert.equal(nodes(root).some(n=>n.textContent==='产品不存在'),false);assert.ok(nodes(root).some(n=>n.textContent==='Target'));wb.unmount();
});

test('design direct editor opens the existing identity form without a request and cancellation returns to saved overview',async()=>{
 const c=context('identification');c.designDirectForms=true;let writes=0,view;c.api.request=()=>writes++;c.navigate=v=>view=v;
 const page=renderProduct(c);assert.ok(nodes(page).find(n=>n.tagName==='FORM'));assert.equal(writes,0);
 assert.ok(nodes(page).find(n=>n.className==='rw-saved-product-overview'),'saved facts and original secondary actions remain available');
 nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='取消').click();await new Promise(r=>setImmediate(r));assert.equal(view,'product');
 const overview=renderProduct(c);assert.equal(nodes(overview).some(n=>n.tagName==='FORM'),false);assert.equal(writes,0);c.life.dispose();
});

test('test history keeps section navigation available and returning to plan is read only',async()=>{
 const c=context('test');c.designDirectForms=true;c.state.testPane='history';c.state.productOverview='r:p:test';let navigated=0,writes=0;c.navigate=()=>navigated++;c.api.request=()=>writes++;
 const page=renderProduct(c),tabs=nodes(page).find(n=>n.className==='rw-test-section-tabs');assert.ok(tabs,'history must retain the same navigation');
 nodes(tabs).find(n=>n.textContent==='测试计划').click();await new Promise(r=>setImmediate(r));assert.equal(c.state.testPane,'plan');assert.equal(c.state.productOverview,undefined);assert.equal(navigated,1);assert.equal(writes,0);c.life.dispose();
});

test('design expansion first shows saved sources and opens the original cited editor only on request',()=>{
 const c=context('expansion');c.designDirectForms=true;const p=c.state.project.products[0];p.source_keyword_ids=['w'];p.expansion_sources=[{source_id:'landing:2',source_kind:'landing',identity_revision:2,text:'Exact saved source'}];c.state.project.keywords=[{id:'w',text:'parent'}];let writes=0;c.api.request=()=>writes++;
 const page=renderProduct(c);assert.equal(nodes(page).find(n=>n.tagName==='FORM'),undefined);assert.ok(nodes(page).find(n=>n.textContent==='Exact saved source'));nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ 手动添加搜索词').click();assert.ok(nodes(page).find(n=>n.tagName==='FORM'));for(const name of ['text','type','meaning','source_id','source_quote'])assert.ok(nodes(page).find(n=>n.name===name),name);assert.equal(writes,0);c.life.dispose();
});

test('channel evidence opens the original form beside saved evidence without replacing the research page',async()=>{
 const c=context('channels');c.designDirectForms=true;let writes=0;c.api.request=()=>writes++;const page=renderProduct(c);
 nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ Similarweb').click();await new Promise(r=>setImmediate(r));
 const inline=nodes(page).find(n=>n.className==='rw-channel-inline-editor');assert.ok(inline);assert.ok(nodes(inline).find(n=>n.tagName==='FORM'));assert.ok(nodes(page).find(n=>n.dataset.channelCard==='trends'));for(const name of ['traffic_scope','traffic_url','traffic_period','monthly_visits','confirmed','not_applicable','reason','review_due_at','valid_until'])assert.ok(nodes(inline).find(n=>n.name===name),name);assert.equal(writes,0);
 nodes(inline).find(n=>n.tagName==='BUTTON'&&n.textContent==='取消').click();await new Promise(r=>setImmediate(r));assert.equal(nodes(inline).some(n=>n.tagName==='FORM'),false);assert.equal(c.editing,false);assert.equal(writes,0);c.life.dispose();
});

test('switching inline evidence channels retains unsaved URL and inputs in this page without a request',async()=>{
 const c=context('channels');c.designDirectForms=true;let calls=0;c.api.request=()=>calls++;const page=renderProduct(c);try{
 nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ Similarweb').click();await new Promise(r=>setImmediate(r));let inline=nodes(page).find(n=>n.className==='rw-channel-inline-editor');const url=nodes(inline).find(n=>n.name==='source_url');url.value='https://example.com/original-source';
 nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ Meta 广告').click();await new Promise(r=>setImmediate(r));nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ Similarweb').click();await new Promise(r=>setImmediate(r));inline=nodes(page).find(n=>n.className==='rw-channel-inline-editor');assert.equal(nodes(inline).find(n=>n.name==='source_url'),url);assert.equal(url.value,'https://example.com/original-source');assert.equal(calls,0);nodes(inline).find(n=>n.tagName==='BUTTON'&&n.textContent==='放弃草稿').click();await new Promise(r=>setImmediate(r));nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ Meta 广告').click();await new Promise(r=>setImmediate(r));nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ Similarweb').click();await new Promise(r=>setImmediate(r));inline=nodes(page).find(n=>n.className==='rw-channel-inline-editor');assert.notEqual(nodes(inline).find(n=>n.name==='source_url'),url);assert.equal(nodes(inline).find(n=>n.name==='source_url').value,'');
 }finally{c.life.dispose();}
});

test('report review tabs switch saved statistics locally and preserve unknown sample counts',async()=>{
 const {renderReport}=await import('../../js/research-workbench/pages/reports.mjs');const c=context('review');c.designDirectForms=true;c.state.projects=[c.state.project];c.state.reportAutoReviewKey=c.state.project.id+':'+c.state.project.version;c.state.researchReviewId=c.state.project.id;c.state.researchReview={keywords:[{text:'saved keyword',scan_completed:0,ads_found:null,associated_products:2}],keyword_types:[],discovery_sources:[],calibration:[]};let reads=0;c.api.request=()=>reads++;
 try{const page=renderReport(c),source=nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='来源表现');assert.ok(source);source.click();assert.equal(c.state.reportReviewTab,'sources');assert.equal(nodes(page).find(n=>n.dataset.reviewPanel==='sources').hidden,false);assert.equal(nodes(page).find(n=>n.dataset.reviewPanel==='keywords').hidden,true);assert.equal(reads,0);assert.ok(nodes(page).find(n=>n.tagName==='TD'&&n.textContent==='0'));assert.ok(nodes(page).find(n=>n.tagName==='TD'&&n.textContent==='未知'));
 }finally{c.life.dispose();}
});

test('selected expansion word edits inline with its original quote and blocks switching uncertain submissions',()=>{
 const c=context('expansion');c.designDirectForms=true;const p=c.state.project.products[0];p.source_keyword_ids=['parent'];p.expansion_sources=[{source_id:'landing:1',source_kind:'landing',identity_revision:2,text:'Exact original quote'}];c.state.project.keywords=[{id:'parent',text:'parent'},{id:'child',parent_id:'parent',product_id:'p',text:'child',source_id:'landing:1',source_quote:'Exact original quote',type:'function',approved:false},{id:'second',parent_id:'parent',product_id:'p',text:'second',source_quote:'original',type:'pain',approved:false}];let calls=0;c.api.request=()=>calls++;
 try{const page=renderProduct(c);nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='child').click();const editor=nodes(page).find(n=>n.className==='rw-expansion-selected-editor');assert.ok(editor);const quote=nodes(editor).find(n=>n.name==='source_quote');assert.equal(quote.value,'Exact original quote');const key='rabbit-hole:draft:'+JSON.stringify(['r','','edit_keyword','child']);c.state.drafts[key].uncertain=true;nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='second').click();assert.equal(nodes(editor).find(n=>n.name==='source_quote'),quote);nodes(page).find(n=>n.tagName==='BUTTON'&&n.textContent==='＋ 手动添加搜索词').click();assert.equal(nodes(page).find(n=>n.className==='rw-expansion-selected-editor'),editor);assert.equal(calls,0);c.state.drafts[key].uncertain=false;nodes(editor).find(n=>n.tagName==='BUTTON'&&n.textContent==='取消').click();assert.equal(nodes(editor).some(n=>n.tagName==='FORM'),false);assert.ok(nodes(page).find(n=>n.textContent==='Exact original quote'));}finally{c.life.dispose();}
});


test('zero creatives shows automatic gap summary without empty invented creative fields',async()=>{const c=context('coarse');try{const page=renderProduct(c);nodes(page).find(n=>n.textContent==='查看与补充广告证据').click();await new Promise(r=>setImmediate(r));assert.equal(nodes(page).some(n=>n.name==='creative_1_id'),false);assert.ok(nodes(page).find(n=>n.dataset.creativeCheck!==undefined));assert.ok(nodes(page).some(n=>n.textContent.includes('尚未绑定广告素材')));assert.ok(nodes(page).find(n=>n.textContent==='添加一条素材证据'));}finally{c.life.dispose();}});

test('explicitly adding a creative keeps edits and only creates one new record',async()=>{const c=context('coarse');c.state.project.products[0].identification.creatives=[{id:'external',source_url:'https://example.invalid/source',distinct:false,active:false}];try{const page=renderProduct(c);nodes(page).find(n=>n.textContent==='查看与补充广告证据').click();await new Promise(r=>setImmediate(r));const active=nodes(page).find(n=>n.name==='creative_1_distinct');active.checked=true;active.dispatchEvent(new Event('change'));nodes(page).find(n=>n.textContent==='添加一条素材证据').click();await new Promise(r=>setImmediate(r));assert.equal(nodes(page).find(n=>n.name==='creative_1_id').value,'external');assert.equal(nodes(page).find(n=>n.name==='creative_1_distinct').checked,true);assert.ok(nodes(page).find(n=>n.name==='creative_2_id'));assert.equal(nodes(page).some(n=>n.name==='creative_3_id'),false);}finally{c.life.dispose();}});

test('automatic evidence recheck does not submit or tick uncertain creative boxes',async()=>{const c=context('coarse');let writes=0;c.api.request=()=>writes++;c.state.project.products[0].candidate_sources=[{keyword_id:'w',ad_id:'a'}];c.state.project.keywords=[{id:'w',ads:[{id:'a',start_date:'2026-09-01',observed_at:new Date().toISOString(),active:true,media:[{kind:'image',url:'https://example.invalid/a.jpg'}]}]}];try{const page=renderProduct(c);nodes(page).find(n=>n.textContent==='查看与补充广告证据').click();await new Promise(r=>setImmediate(r));nodes(page).find(n=>n.textContent==='重新检查已有证据').click();await new Promise(r=>setImmediate(r));assert.equal(writes,0);assert.equal(nodes(page).find(n=>n.name==='creative_1_distinct').checked,false);}finally{c.life.dispose();}});

test('zero-source review can explicitly add its first evidence row without a request',async()=>{const c=context('coarse');let writes=0;c.api.request=()=>writes++;try{const page=renderProduct(c);nodes(page).find(n=>n.textContent==='查看与补充广告证据').click();await new Promise(r=>setImmediate(r));nodes(page).find(n=>n.textContent==='添加一条素材证据').click();await new Promise(r=>setImmediate(r));assert.ok(nodes(page).find(n=>n.name==='creative_1_id'));assert.equal(nodes(page).some(n=>n.name==='creative_2_id'),false);assert.equal(writes,0);}finally{c.life.dispose();}});

test('adding evidence cannot change a form with an existing submission fingerprint',async()=>{const c=context('coarse');try{const page=renderProduct(c);nodes(page).find(n=>n.textContent==='查看与补充广告证据').click();await new Promise(r=>setImmediate(r));const key=Object.keys(c.state.drafts)[0];c.state.drafts[key].submittedHash='existing-submit';nodes(page).find(n=>n.textContent==='添加一条素材证据').click();await new Promise(r=>setImmediate(r));assert.equal(nodes(page).some(n=>n.name==='creative_1_id'),false);}finally{c.life.dispose();}});

function coarseSaveFixture(state='needs_input'){
 const c=context('coarse');c.designDirectForms=true;c.state.projects=[c.state.project];const p=c.state.project.products[0];p.identification={identity_revision:2,relevance_confirmed:true,active_days:13,ad_age_days:13,currently_active:true,distinct_active_creatives:0,creatives:[{id:'a',source_url:'https://www.facebook.com/ads/library/?id=a',active:true,distinct:false}]};p.steps.find(s=>s.key==='coarse').state=state;p.steps.find(s=>s.key==='coarse').reason='广告年龄不足30天，独立活跃创意不足3个';c.requests=[];c.navigation=[];c.navigate=v=>c.navigation.push(v);c.api.request=async(path,options)=>{c.requests.push(options.body);return {...c.state.project,version:5,products:[{...p,identification:{...p.identification}}]};};return c;
}
test('successful coarse save replaces the editor with an explicit saved result without page navigation',async()=>{const c=coarseSaveFixture();try{const page=renderProduct(c),form=nodes(page).find(n=>n.tagName==='FORM');form.dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.equal(c.requests.length,1);assert.equal(c.state.project.version,5);assert.deepEqual(c.navigation,[]);assert.ok(nodes(page).find(n=>n.dataset.creativeSavedResult!==undefined));assert.ok(nodes(page).some(n=>n.textContent==='已保存，广告证据尚未达标'));assert.ok(nodes(page).some(n=>n.textContent.includes('还差 17 天')));assert.equal(nodes(page).some(n=>n.tagName==='FORM'),false);assert.equal(Object.keys(c.state.drafts).length,0);assert.equal(c.state.step,'coarse');}finally{c.life.dispose();}});
test('saved incomplete evidence offers explicit edit and starts a fresh command only on the next save',async()=>{const c=coarseSaveFixture();try{const page=renderProduct(c);nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));nodes(page).find(n=>n.textContent==='继续补充广告证据').click();await new Promise(r=>setImmediate(r));assert.equal(c.requests.length,1);assert.ok(nodes(page).find(n=>n.tagName==='FORM'));nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.equal(c.requests.length,2);assert.notEqual(c.requests[0].command_id,c.requests[1].command_id);}finally{c.life.dispose();}});
test('passed coarse result offers a deliberate next step without automatic advancement',async()=>{const c=coarseSaveFixture('passed');try{const page=renderProduct(c);nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.ok(nodes(page).some(n=>n.textContent==='已保存，广告粗筛已通过'));assert.equal(nodes(page).some(n=>n.dataset.creativeCheck!==undefined),false);assert.equal(c.state.step,'coarse');assert.deepEqual(c.navigation,[]);nodes(page).find(n=>n.textContent==='继续核对需求与竞争').click();await new Promise(r=>setImmediate(r));assert.equal(c.state.step,'channels');assert.deepEqual(c.navigation,['product']);}finally{c.life.dispose();}});
test('failed coarse save keeps input, draft identity and editor instead of showing a success result',async()=>{const c=coarseSaveFixture();c.api.request=async()=>{throw Object.assign(Error('模拟保存失败'),{status:422});};try{const page=renderProduct(c);nodes(page).find(n=>n.tagName==='FORM').dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.ok(nodes(page).find(n=>n.tagName==='FORM'));assert.equal(nodes(page).some(n=>n.dataset.creativeSavedResult!==undefined),false);assert.deepEqual(c.navigation,[]);assert.equal(Object.keys(c.state.drafts).length,1);assert.equal(nodes(page).find(n=>n.name==='creative_1_id').value,'a');assert.ok(nodes(page).some(n=>n.textContent==='模拟保存失败'));}finally{c.life.dispose();}});
