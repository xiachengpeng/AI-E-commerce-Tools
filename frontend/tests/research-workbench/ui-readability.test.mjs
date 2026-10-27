import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';
import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
import {renderVerification} from '../../js/research-workbench/pages/verification.mjs';
import {render as renderFocused} from '../../js/research-workbench/pages/focused-exploration.mjs';
import {createWorkbench} from '../../js/research-workbench/index.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){const word={id:'k',text:'pending word',status:'pending_review',approved:false,ads:[]};const root=fixtureRoot(),life=createLifecycle(),calls=[];return {root,life,context:{},state:{project:{id:'r',version:1,title:'Readability',keywords:[word],products:[]},keywordActions:{},verificationActions:{},explorationKeyword:'k',focusReviewOnly:{},commands:{}},navigate(view){calls.push(view);},showQueue(){throw Error('unexpected submission');},calls,word};}

test('a disabled verification action keeps its explanation in the control group and cost separate from filtering',()=>{
 const c=fixture();try{const page=renderVerification(c,c.word),start=page.find(n=>n.textContent==='自动核对当前词'),hint=page.find(n=>n.dataset.verificationHint==='true');
 assert.equal(start.disabled,true);assert.equal(start.attributes['aria-describedby'],hint.id);
 assert.equal(hint.parentElement.className,'rw-verification-controls');
 const footer=page.find(n=>n.className==='rw-verification-footer');assert.ok(footer);assert.ok(footer.find(n=>n.name==='verification_review_only'));assert.ok(footer.find(n=>n.textContent.includes('可能计费')));
 assert.ok(page.find(n=>n.className==='rw-verification-header'));
 }finally{c.life.dispose();}
});

test('review-only empty state offers show-all instead of displaying unrelated ad cards',async()=>{
 const c=fixture();c.word.ads=[{id:'ad',advertiser:'Ad source'}];c.state.project.products=[{id:'p',name:'Reviewed product',source_keyword_ids:['k'],identification:{relevance_confirmed:true}}];c.state.focusReviewOnly.k=true;
 try{const page=renderFocused(c),empty=page.find(n=>n.dataset.leadEmpty==='filter');assert.ok(empty);const all=empty.find(n=>n.tagName==='BUTTON'&&n.textContent==='显示全部商品');assert.ok(all);all.click();await tick();assert.equal(c.state.focusReviewOnly.k,false);assert.deepEqual(c.calls,['project']);
 }finally{c.life.dispose();}
});

test('a word without results offers an existing source word without approving or searching it',async()=>{
 const c=fixture();c.state.project.keywords.push({id:'old',text:'saved word',approved:false,status:'archived'});c.state.project.products=[{id:'p',name:'Saved source',source_keyword_ids:['old']}];
 try{const page=renderFocused(c),empty=page.find(n=>n.dataset.leadEmpty==='no_results');assert.ok(empty);const view=empty.find(n=>n.tagName==='BUTTON');assert.ok(view);view.click();await tick();assert.equal(c.state.explorationKeyword,'old');assert.equal(c.state.project.keywords[1].approved,false);assert.equal(c.state.project.keywords[1].status,'archived');assert.deepEqual(c.calls,['project']);
 }finally{c.life.dispose();}
});

test('verification disclosure stays expanded when its filter rerenders the mounted workbench',async()=>{
 const root=fixtureRoot(),w=createWorkbench(),project={id:'r',version:1,title:'UI fixture',market:'US',keywords:[{id:'k',text:'word',approved:true,status:'ready',ads:[]}],products:[]},methods=[];
 try{await w.mount(root,{fetch:async(url,o)=>{methods.push(o.method);return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/r')?structuredClone(project):url.includes('/actions?')?{actions:[]}:{projects:[structuredClone(project)]}};}});
 root.find(n=>n.tagName==='BUTTON'&&n.textContent==='UI fixture').click();await tick();let detail=root.find(n=>n.dataset.verificationOptions==='true');assert.ok(detail);detail.open=true;detail.dispatchEvent(new Event('toggle'));
 const filter=detail.find(n=>n.name==='verification_review_only');filter.checked=true;filter.dispatchEvent(new Event('change'));await tick();detail=root.find(n=>n.dataset.verificationOptions==='true');assert.equal(detail.open,true);assert.ok(methods.every(m=>m==='GET'));
 }finally{w.unmount();}
});
