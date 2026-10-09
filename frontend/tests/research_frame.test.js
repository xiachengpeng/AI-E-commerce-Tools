const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('frame messages require exact origin/window and leaving view destroys workbench', async () => {
    const nodes = {}, events = {}, requests = [];
    let removed = 0;
    const node = id => nodes[id] ||= { dataset:{},value:'',classList:{toggle(){}},
        addEventListener(type, handler){events[type]=handler;},replaceChildren(){},querySelectorAll(){return [];} };
    const frame = {setAttribute(){},contentWindow:{postMessage(){}},remove(){removed++;}};
    const context = {URL,AbortSignal,Event,location:{protocol:'http:'},
        document:{getElementById:node,createElement(){return frame;}},
        addEventListener(type,handler){events['window:'+type]=handler;},
        fetch:async url => {requests.push(url);return {ok:true,json:async()=>url.endsWith('/session') ?
            {csrf_token:'test',enabled:true,embed_url:'http://127.0.0.1:19503/marketing-workbench'} : {projects:[],next_cursor:null}};}};
    context.window=context;
    vm.runInNewContext(fs.readFileSync(require.resolve('../js/research.js'),'utf8'),context);
    await context.ResearchPanel.init();
    events.click({target:{closest:()=>({id:'researchToggleWorkbench',dataset:{},hasAttribute(){return false;}})}});
    const count = requests.length;
    const data = {type:'research:select',version:1,project_id:'7ed7aafc-0e0e-4ec7-a55e-95dccad5f31a',product_id:'7ed7aafc-0e0e-4ec7-a55e-95dccad5f31b',source_version:1,identity_revision:1};
    await events['window:message']({origin:'http://evil.example',source:frame.contentWindow,data});
    await events['window:message']({origin:'http://127.0.0.1:19503',source:{},data});
    assert.equal(requests.length,count);
    context.ResearchPanel.suspend();
    assert.equal(removed,1);
    await events['window:message']({origin:'http://127.0.0.1:19503',source:frame.contentWindow,data});
    assert.equal(requests.length,count);
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
