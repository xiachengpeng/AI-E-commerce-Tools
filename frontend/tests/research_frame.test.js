const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('native entry is unconditional and never installs a remote message bridge', async () => {
    const nodes = {}, events = {};
    const node = id => nodes[id] ||= { dataset:{}, value:'', classList:{toggle(){}},
        addEventListener(type, fn){events[type]=fn;}, querySelectorAll(){return [];} };
    const path='/projects/7ed7aafc-0e0e-4ec7-a55e-95dccad5f31a/products/7ed7aafc-0e0e-4ec7-a55e-95dccad5f31b/imports';
    const body={name:'Pending'};
    const pending={path,signature:JSON.stringify([path,body]),body:{...body,import_id:'7ed7aafc-0e0e-4ec7-a55e-95dccad5f31c'}};
    const context = {URL, AbortSignal, Event, localStorage:{getItem(){return '0';}},
        sessionStorage:{getItem(){return JSON.stringify(pending);}},
        document:{getElementById:node, createElement(){assert.fail('remote frame created');}},
        addEventListener(type){assert.notEqual(type, 'message');},
        fetch:async()=>assert.fail('mount must use native module, not remote session')};
    context.window=context;
    const source=fs.readFileSync(require.resolve('../js/research.js'),'utf8');
    vm.runInNewContext(source,context);
    // VM has no import callback, so the native loading error is rendered locally.
    await context.ResearchPanel.mount();
    assert.equal(nodes.researchNativeRoot.hidden,false);
    assert.equal(nodes.researchView.hidden,true);
    assert.equal(nodes.researchResolveImport?.hidden,false);
    assert.equal(nodes.researchRetryImport?.hidden,false);
    assert.equal(nodes.researchPendingImportEntry?.hidden,false);
    assert.equal(typeof context.ResearchPanel.openPendingImport,'function');
    assert.match(nodes.researchNativeRoot.textContent,/原生研究/);
    context.ResearchPanel.suspend();
    assert.equal(nodes.researchNativeRoot.hidden,true);
    assert.doesNotMatch(source,/postMessage|createElement\(['"]iframe|research_native_workbench/);
    assert.equal(/id="researchWorkbenchLink"|id="researchToggleWorkbench"|id="researchWorkbenchHost"/.test(fs.readFileSync(require.resolve('../index.html'),'utf8')),false);
});

test('uncommitted import survives reload and can retry original body after source changes', async () => {
    const projectId='7ed7aafc-0e0e-4ec7-a55e-95dccad5f31a',productId='7ed7aafc-0e0e-4ec7-a55e-95dccad5f31b';
    const originalId='7ed7aafc-0e0e-4ec7-a55e-95dccad5f31c';
    const path=`/projects/${projectId}/products/${productId}/imports`;
    const original={expected_source_version:1,expected_identity_revision:1,expected_market:'US',name:'Pouch',selected_fields:['material']};
    const pending={path,signature:JSON.stringify([path,original]),body:{...original,import_id:originalId}};
    const storage=new Map([['research_pending_import',JSON.stringify(pending)]]);
    const nodes={},handlers={},posts=[];
    const node=id=>nodes[id] ||= {dataset:{},value:'',classList:{toggle(){}},addEventListener(type,fn){handlers[type]=fn;},querySelectorAll(){return [{dataset:{researchField:'material'}}];}};
    const product={name:'Pouch',market:'US',facts:[],steps:[],source_ref:{project_id:projectId,product_id:productId,source_version:2,identity_revision:1}};
    const context={URL,AbortSignal,Event,crypto:require('node:crypto'),document:{getElementById:node},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
        fetch:async(url,options)=>{
            if(options.method==='POST'){
                const body=JSON.parse(options.body);posts.push(body);
                return {ok:body.expected_source_version!==1,status:body.expected_source_version===1?409:200,json:async()=>body.expected_source_version===1?{detail:'source advanced'}:{import_id:body.import_id}};
            }
            if(url.endsWith('/imports/'+originalId))return {ok:false,status:404,json:async()=>({detail:'not observed'})};
            return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'test',enabled:true}:url.endsWith('/projects')?{projects:[],next_cursor:null}:url.endsWith('/imports')?{imports:[],next_cursor:null}:{id:projectId,title:'Travel',market:'US',products:[product]}};
        }};
    context.window=context;
    vm.runInNewContext(fs.readFileSync(require.resolve('../js/research.js'),'utf8'),context);
    const click=(id,dataset={})=>handlers.click({target:{closest:()=>({id,dataset,hasAttribute(){return false;}})}});
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    await context.ResearchPanel.init();
    click('researchResolveImport');await settle();assert.equal(storage.has('research_pending_import'),true);
    click('researchRetryImport');await settle();
    assert.equal(posts[0].import_id,originalId);assert.equal(posts[0].expected_source_version,1);
    assert.equal(storage.has('research_pending_import'),false);
    click('',{researchProject:projectId});await settle();click('',{researchProduct:productId});
    click('researchSaveImport');await settle();
    assert.equal(posts[1].expected_source_version,2);assert.notEqual(posts[1].import_id,originalId);
});
