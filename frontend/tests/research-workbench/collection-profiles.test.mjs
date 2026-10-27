import test from 'node:test';import assert from 'node:assert/strict';
import {fixtureRoot} from './dom-fixture.mjs';import {createLifecycle} from '../../js/research-workbench/lifecycle.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const find=(r,t)=>r.find(n=>n.tagName==='BUTTON'&&n.textContent===t);
async function fixture({fail=false,running=false,detail,activate}={}){
 const {renderCollectionProfiles}=await import('../../js/research-workbench/components/collection-mode.mjs');const root=fixtureRoot(),life=createLifecycle(),calls=[];
 const config={active_profile_id:'default',active_version:4,version:4,profiles:[{id:'default',name:'主账户',configured:true},{id:'a'.repeat(32),name:'备用账户',configured:true},{id:'b'.repeat(32),name:'未填账户',configured:false}],fields:{api_key:true}};
 const c={root,life,state:{project:{id:'p',collection_modes:{meta:'api'}},keywordActions:running?{k:{status:'running',execution_mode:'api'}}:{}},context:{},api:{integration:async()=>config,integrationProfile:async(provider,path,o={})=>{calls.push({provider,path,...o});if(path==='activate'){if(activate)await activate();if(fail)throw Error('stale');return {...config,active_profile_id:'a'.repeat(32),active_version:5};}if(detail)await detail();return {profile_version:7};}}};root.append(renderCollectionProfiles(c,{id:'k',status:'blocked'}));await tick();return {root,life,c,calls};
}
test('multiple named API profiles are selectable but selection alone never activates or starts a task',async()=>{
 const f=await fixture();try{const s=f.root.find(n=>n.attributes?.['aria-label']==='Apify 共用 API 配置');assert.ok(s);assert.ok(s.find(n=>n.textContent.includes('备用账户')));assert.equal(s.find(n=>n.value==='b'.repeat(32)).disabled,true);s.value='a'.repeat(32);s.dispatchEvent(new Event('change'));await tick();assert.equal(f.calls.length,0);assert.ok(find(f.root,'确认切换共用配置'));assert.ok(f.root.find(n=>n.textContent.includes('所有项目')));
 }finally{f.life.dispose();}
});
test('explicit profile activation uses saved profile revision and current activation revision, without credentials',async()=>{
 const f=await fixture();try{const s=f.root.find(n=>n.attributes?.['aria-label']==='Apify 共用 API 配置');s.value='a'.repeat(32);s.dispatchEvent(new Event('change'));find(f.root,'确认切换共用配置').click();await tick();assert.equal(f.calls.length,2);assert.equal(f.calls[1].path,'activate');assert.deepEqual(f.calls[1].body,{profile_id:'a'.repeat(32),expected_version:4,profile_version:7});assert.equal(JSON.stringify(f.calls).includes('api_key'),false);assert.equal(f.c.state.writeBusy,false);assert.ok(f.root.find(n=>n.textContent.includes('备用账户')&&n.textContent.includes('当前使用')));
 }finally{f.life.dispose();}
});
test('failed activation restores last known active profile; unfinished API tasks lock the shortcut',async()=>{
 const f=await fixture({fail:true});try{const s=f.root.find(n=>n.attributes?.['aria-label']==='Apify 共用 API 配置');s.value='a'.repeat(32);s.dispatchEvent(new Event('change'));find(f.root,'确认切换共用配置').click();await tick();assert.equal(s.value,'default');assert.ok(f.root.find(n=>n.textContent.includes('未确认切换成功')));}finally{f.life.dispose();}
 const busy=await fixture({running:true});try{const s=busy.root.find(n=>n.attributes?.['aria-label']==='Apify 共用 API 配置');assert.equal(s.disabled,true);s.value='a'.repeat(32);s.dispatchEvent(new Event('change'));assert.equal(find(busy.root,'确认切换共用配置').parentElement.hidden,true);assert.equal(busy.calls.length,0);}finally{busy.life.dispose();}
});

test('leaving during account detail read prevents global activation',async()=>{
 let release;const f=await fixture({detail:()=>new Promise(r=>release=r)});const s=f.root.find(n=>n.attributes?.['aria-label']==='Apify 共用 API 配置');s.value='a'.repeat(32);s.dispatchEvent(new Event('change'));find(f.root,'确认切换共用配置').click();await tick();f.life.dispose();release();await tick();assert.equal(f.calls.some(c=>c.path==='activate'),false);assert.equal(f.c.state.writeBusy,false);
});
test('repeated confirmation during pending activation does not issue duplicate writes',async()=>{
 let release;const f=await fixture({activate:()=>new Promise(r=>release=r)});try{const s=f.root.find(n=>n.attributes?.['aria-label']==='Apify 共用 API 配置');s.value='a'.repeat(32);s.dispatchEvent(new Event('change'));const b=find(f.root,'确认切换共用配置');b.click();await tick();b.click();await tick();assert.equal(f.calls.filter(c=>c.path==='activate').length,1);release();await tick();assert.equal(f.c.state.writeBusy,false);}finally{release?.();f.life.dispose();}
});
