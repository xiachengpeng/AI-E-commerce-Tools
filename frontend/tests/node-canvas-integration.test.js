const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..','infinite-image-canvas');
test('reference canvas is present with preserved upstream MIT attribution',()=>{
  assert.ok(fs.existsSync(path.join(root,'LICENSE')));
  const license=fs.readFileSync(path.join(root,'LICENSE'),'utf8');
  assert.match(license,/MIT License/);assert.match(license,/basketikun/);
  assert.ok(fs.existsSync(path.join(root,'web','src','components','canvas','infinite-canvas.tsx')));
});

test('node adapter submits frozen ordered references once to the local API',async()=>{
  const {createNodeCanvasTransport}=await import('../infinite-image-canvas/web/src/integration/local-api.mjs');
  const sent=[];
  const transport=createNodeCanvasTransport('http://127.0.0.1:9503',async(url,options)=>{sent.push({url,options});return {ok:true,json:async()=>({status:'submitted'})};});
  const request={operation_key:'op-1',operation:'generate',prompt:'image',reference_ids:['a','b'],mask_id:null,expected_provider:{id:1},node_context:{node_id:'n',project_revision:2,node_revision:'v',connections:[{from:'a',to:'n'},{from:'b',to:'n'}]}};
  const result=await transport.submit('project-one',request);
  assert.equal(result.status,'submitted');assert.equal(sent.length,1);
  assert.equal(sent[0].url,'http://127.0.0.1:9503/api/canvas/projects/project-one/tasks');
  assert.deepEqual(JSON.parse(sent[0].options.body),request);
});

test('node adapter propagates uncertain network error without replay',async()=>{
  const {createNodeCanvasTransport}=await import('../infinite-image-canvas/web/src/integration/local-api.mjs');let calls=0;
  const t=createNodeCanvasTransport('http://127.0.0.1:9503',async()=>{calls++;throw Error('offline');});
  await assert.rejects(t.submit('p',{}),/offline/);assert.equal(calls,1);
});

test('project persistence serializes writes and advances revisions without losing newer edits',async()=>{
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');
  let revision=0;const saves=[];let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const api={list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',format:'node-v1',revision:0,document:{id:'p',nodes:[],connections:[]}}),
    save:async(id,rev,doc)=>{saves.push({id,rev,doc});if(saves.length===1)await blocked;assert.equal(rev,revision++);return {revision};}};
  const repository=createNodeProjectRepository(api);await repository.load();
  const first=repository.save({id:'p',nodes:[{id:'one'}],connections:[]});
  const second=repository.save({id:'p',nodes:[{id:'two'}],connections:[]});release();
  await Promise.all([first,second]);assert.equal(saves.length,2);
  assert.equal(saves[1].rev,1);assert.equal(saves[1].doc.nodes[0].id,'two');
});

test('project persistence blocks newer writes after a failed save and exposes unsaved draft',async()=>{
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');
  let calls=0;const api={list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',format:'node-v1',revision:0,document:{id:'p',nodes:[],connections:[]}}),save:async()=>{calls++;throw Error('disk full');}};
  const repository=createNodeProjectRepository(api);await repository.load();
  await assert.rejects(repository.save({id:'p',nodes:[{id:'one'}]}),/disk full/);
  await assert.rejects(repository.save({id:'p',nodes:[{id:'two'}]}),/disk full/);
  assert.equal(calls,1);assert.equal(repository.getUnsaved('p').nodes[0].id,'two');
});

test('explicit retry persists the latest retained project draft after a temporary failure',async()=>{
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');
  let calls=0;const api={list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',format:'node-v1',revision:0,document:{id:'p',nodes:[],connections:[]}}),save:async(_id,revision,document)=>{calls++;if(calls===1)throw Error('disk full');return {revision:revision+1,document};}};
  const repository=createNodeProjectRepository(api);await repository.load();
  await assert.rejects(repository.save({id:'p',nodes:[{id:'first'}]}),/disk full/);
  await assert.rejects(repository.save({id:'p',nodes:[{id:'latest'}]}),/disk full/);
  const saved=await repository.retry('p');assert.equal(saved.document.nodes[0].id,'latest');assert.equal(repository.getUnsaved('p'),null);
});

test('canvas persistence hydrates from backend and persists changed projects independently',async()=>{
  const {createCanvasPersistence}=await import('../infinite-image-canvas/web/src/integration/canvas-persistence.mjs');
  const calls=[];const repo={load:async()=>[{id:'p',title:'P',nodes:[],connections:[]}],save:async(project)=>{calls.push(structuredClone(project));}};
  const storage=createCanvasPersistence(repo);const initial=await storage.getItem('canvas');assert.equal(initial.state.projects[0].id,'p');
  await storage.setItem('canvas',{state:{projects:[{id:'p',title:'P',nodes:[{id:'a'}],connections:[]}],deletedProjects:[]}});
  assert.equal(calls.length,1);assert.equal(calls[0].nodes[0].id,'a');
});

test('canvas persistence exposes storage errors and keeps an actionable unsaved draft',async()=>{
  const {createCanvasPersistence}=await import('../infinite-image-canvas/web/src/integration/canvas-persistence.mjs');
  let draft=null;const repo={load:async()=>[],save:async(p)=>{draft=p;throw Error('disk full');},getUnsaved:()=>draft};
  const storage=createCanvasPersistence(repo);await storage.getItem('canvas');
  await assert.rejects(storage.setItem('canvas',{state:{projects:[{id:'p',nodes:[{id:'n'}]}],deletedProjects:[]}}),/disk full/);
  assert.equal(storage.status().kind,'error');assert.equal(storage.status().projectId,'p');assert.equal(repo.getUnsaved().nodes[0].id,'n');
});

test('explicit node project deletion archives it only after earlier writes finish',async()=>{
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');
  const order=[];let release;const gate=new Promise(resolve=>{release=resolve});
  const api={list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',format:'node-v1',revision:0,document:{id:'p',nodes:[],connections:[]}}),save:async()=>{order.push('save-start');await gate;order.push('save-end');return {revision:1}},archive:async()=>{order.push('archive');}};
  const repo=createNodeProjectRepository(api);await repo.load();const write=repo.save({id:'p',nodes:[]});const archive=repo.archive('p');release();await Promise.all([write,archive]);
  assert.deepEqual(order,['save-start','save-end','archive']);
});

test('canvas persistence archives only explicitly deleted projects once',async()=>{
 const {createCanvasPersistence}=await import('../infinite-image-canvas/web/src/integration/canvas-persistence.mjs');const archived=[];
 const repo={load:async()=>[{id:'p',title:'P'}],save:async()=>{},archive:async(id)=>archived.push(id)};
 const storage=createCanvasPersistence(repo);await storage.getItem('canvas');
 const value={state:{projects:[],deletedProjects:[{id:'p',deletedAt:'today'}]}};
 await storage.setItem('canvas',value);await storage.setItem('canvas',value);assert.deepEqual(archived,['p']);
});

test('node image asset key retains its source project across canvas switches',async()=>{
  const {createNodeAssetRepository}=await import('../infinite-image-canvas/web/src/integration/asset-repository.mjs');
  let active='first';const calls=[];
  const api={upload:async(project,data,mime)=>{calls.push({project,data,mime});return {id:'a'.repeat(32),width:2,height:3}},assetUrl:(p,id)=>`/assets/${p}/${id}`};
  const repo=createNodeAssetRepository(api,()=>active,async()=>{});
  const asset=await repo.upload('aGVsbG8=','image/png');active='second';
  assert.equal(asset.storageKey,'image:first:'+ 'a'.repeat(32));assert.equal(repo.url(asset.storageKey),'/assets/first/'+'a'.repeat(32));assert.equal(calls[0].project,'first');
});

test('saving a node project binds all image references to that project',async()=>{
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');let saved;
  const api={list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',format:'node-v1',revision:0,document:{id:'p',nodes:[],connections:[]}}),save:async(_id,rev,doc)=>{saved=doc;return {revision:rev+1}}};
  const repo=createNodeProjectRepository(api);await repo.load();
  await repo.save({id:'p',nodes:[{metadata:{storageKey:'image:p:'+ 'b'.repeat(32)}}]});
  assert.deepEqual(saved.assets,[{asset_id:'b'.repeat(32)}]);
  await assert.rejects(repo.save({id:'p',nodes:[{metadata:{storageKey:'image:other:'+ 'b'.repeat(32)}}]}),/图片/);
});

test('asset upload waits for the project creation already in flight',async()=>{
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');
  let resolveCreate;const createGate=new Promise(resolve=>{resolveCreate=resolve});let saves=0;
  const api={list:async()=>({projects:[]}),create:async()=>{await createGate;return {revision:0}},save:async(_id,rev)=>{saves++;return {revision:rev+1}}};
  const repo=createNodeProjectRepository(api);await repo.load();const p={id:'p',nodes:[]};const first=repo.save(p);const ready=repo.ensure(p);resolveCreate();await Promise.all([first,ready]);assert.equal(saves,1);
});

test('image-only build blocks dynamic canvas plugins and does not expose other media routes',()=>{
 const root=path.join(__dirname,'..','infinite-image-canvas','web','src');
 const loader=fs.readFileSync(path.join(root,'lib/canvas/plugin-loader.ts'),'utf8');
 const router=fs.readFileSync(path.join(root,'router.tsx'),'utf8');
 assert.doesNotMatch(loader,/import\(\/\* @vite-ignore/);assert.doesNotMatch(loader,/fetch\(url\)/);
 assert.doesNotMatch(router,/pages\/video|pages\/config|AnalyticsTracker/);
});

test('node generation and image assets never invoke upstream direct-provider or remote-fetch paths',()=>{
 const root=path.join(__dirname,'..','infinite-image-canvas','web','src');
 const project=fs.readFileSync(path.join(root,'pages/canvas/project.tsx'),'utf8');
 const storage=fs.readFileSync(path.join(root,'services/image-storage.ts'),'utf8');
 assert.doesNotMatch(project,/from ["']@\/services\/api\/image["']/);
 assert.doesNotMatch(storage,/fetch\(withLocalProxy\(url\)/);
 assert.match(project,/integration\/node-generation-adapter/);
});

test('batch preflight confirms count and reserves distinct project-bound task identities',async()=>{
 const {createNodeGenerationAdapter}=await import('../infinite-image-canvas/web/src/integration/node-generation-adapter.mjs');
 const calls=[],ids=['one','two'];let confirmed;
 const api={preflight:async(op,n,mask)=>({supported:true,provider:{id:1,name:'mock',model:'m'},operation:op,n,mask}),reserve:async(id,body)=>{calls.push({id,body});return {status:'prepared'}}};
 const repository={save:async()=>({revision:4})};
 const adapter=createNodeGenerationAdapter({api,repository,confirm:details=>{confirmed=details;return true;},newId:()=>ids.shift()});
 const project={id:'p',nodes:[{id:'n'}],connections:[{fromNodeId:'a',toNodeId:'n'}]};
 const run=await adapter.prepare({project,nodeId:'n',prompt:'draw',referenceKeys:[],count:2});
 assert.equal(confirmed.count,2);assert.equal(run.requests.length,2);assert.equal(calls.length,2);
 assert.deepEqual(calls.map(x=>x.body.operation_key),['one','two']);assert.equal(calls[0].body.node_context.project_revision,4);
 assert.deepEqual(calls[0].body.node_context.connections,project.connections);
});

test('batch rejection before confirmation never reserves or submits a task',async()=>{
 const {createNodeGenerationAdapter}=await import('../infinite-image-canvas/web/src/integration/node-generation-adapter.mjs');let calls=0;
 const adapter=createNodeGenerationAdapter({api:{preflight:async()=>({supported:false,reason:'不支持'}),reserve:async()=>calls++},repository:{save:async()=>({revision:1})},confirm:()=>true,newId:()=>"x"});
 await assert.rejects(adapter.prepare({project:{id:'p',nodes:[{id:'n'}],connections:[]},nodeId:'n',prompt:'x',referenceKeys:[],count:1}),/不支持/);assert.equal(calls,0);
});

test('uncertain node task is checked once and never replayed',async()=>{
 const {createNodeGenerationAdapter}=await import('../infinite-image-canvas/web/src/integration/node-generation-adapter.mjs');let posts=0,checks=0;
 const api={submit:async()=>{posts++;throw Error('offline')},status:async()=>{checks++;return {status:'unknown'}}};
 const adapter=createNodeGenerationAdapter({api,repository:{},confirm:()=>true});
 await assert.rejects(adapter.execute({projectId:'p',requests:[{operation_key:'op'}]},0),/服务商尚未返回最终结果/);
 assert.equal(posts,1);assert.equal(checks,1);
});

test('late image result is not attached to a changed or deleted source node',async()=>{
 const {canAttachNodeResults}=await import('../infinite-image-canvas/web/src/integration/node-result.mjs');
 const run={projectId:'p',sourceNode:{id:'n',metadata:{text:'before'}},connections:[{fromNodeId:'a',toNodeId:'n'}]};
 assert.equal(canAttachNodeResults(run,'p',[{id:'n',metadata:{text:'before'}}],run.connections),true);
 assert.equal(canAttachNodeResults(run,'p',[{id:'n',metadata:{text:'after'}}],run.connections),false);
 assert.equal(canAttachNodeResults(run,'p',[],run.connections),false);
 assert.equal(canAttachNodeResults(run,'other',[run.sourceNode],run.connections),false);
 assert.equal(canAttachNodeResults(run,'p',[run.sourceNode],[]),false);
});

test('late node results are kept for recovery when an upstream reference changes',async()=>{
 const {canAttachNodeResults}=await import('../infinite-image-canvas/web/src/integration/node-result.mjs');
 const run={projectId:'p',sourceNode:{id:'n'},connections:[{fromNodeId:'a',toNodeId:'n'}],referenceNodes:[{id:'a',metadata:{version:1}}]};
 assert.equal(canAttachNodeResults(run,'p',[{id:'n'},{id:'a',metadata:{version:1}}],run.connections),true);
 assert.equal(canAttachNodeResults(run,'p',[{id:'n'},{id:'a',metadata:{version:2}}],run.connections),false);
});

test('mask conversion uses stroke alpha to mark only the edited pixels',async()=>{
 const {maskAlphaToRgba}=await import('../infinite-image-canvas/web/src/integration/mask-pixels.mjs');
 assert.deepEqual([...maskAlphaToRgba(new Uint8ClampedArray([5,10,20,0,5,10,20,255,5,10,20,128]))],[0,0,0,255,255,255,255,255,128,128,128,255]);
});

test('task recovery distinguishes unseen completed images and unresolved outcomes',async()=>{
 const {taskRecoveryAction}=await import('../infinite-image-canvas/web/src/integration/task-recovery.mjs');
 assert.equal(taskRecoveryAction({id:'a',status:'complete',result_asset_id:'asset'},new Set()),'restore');
 assert.equal(taskRecoveryAction({id:'a',status:'complete',result_asset_id:'asset'},new Set(['a'])),'already-added');
 assert.equal(taskRecoveryAction({status:'unknown',reviewed:false},new Set()),'review');
 assert.equal(taskRecoveryAction({status:'submitted'},new Set()),'wait');
});

test('project save validates reference-list keys as well as image metadata',async()=>{
 const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');let saved;
 const api={list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',format:'node-v1',revision:0,document:{id:'p',nodes:[],connections:[]}}),save:async(_id,rev,doc)=>{saved=doc;return {revision:rev+1}}};
 const repo=createNodeProjectRepository(api);await repo.load();
 await repo.save({id:'p',nodes:[{metadata:{references:['image:p:'+ 'a'.repeat(32)]}}]});
 assert.deepEqual(saved.assets,[{asset_id:'a'.repeat(32)}]);
});

test('generated result asset identifiers are valid project-bound image references',async()=>{
 const {createNodeAssetRepository}=await import('../infinite-image-canvas/web/src/integration/asset-repository.mjs');
 const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');let saved;
 const assetId='result-'+ 'f'.repeat(32),key='image:p:'+assetId;
 const api={list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',format:'node-v1',revision:0,document:{id:'p',nodes:[],connections:[]}}),save:async(_id,rev,doc)=>{saved=doc;return {revision:rev+1}},assetUrl:(p,id)=>`/${p}/${id}`};
 const assets=createNodeAssetRepository(api,()=> 'p',async()=>{});assert.equal(assets.url(key),'/p/'+assetId);
 const repo=createNodeProjectRepository(api);await repo.load();await repo.save({id:'p',nodes:[{metadata:{storageKey:key}}]});assert.deepEqual(saved.assets,[{asset_id:assetId}]);
});

test('a successful save cannot hide a different project save failure', async () => {
  const {createCanvasPersistence}=await import('../infinite-image-canvas/web/src/integration/canvas-persistence.mjs');
  const storage=createCanvasPersistence({load:async()=>[],save:async p=>{if(p.id==='bad')throw Error('磁盘不可用');},retry:async()=>{}});
  await storage.getItem('canvas');
  await assert.rejects(storage.setItem('canvas',{state:{projects:[{id:'bad'}]}}));
  await storage.setItem('canvas',{state:{projects:[{id:'bad'},{id:'good'}]}});
  assert.equal(storage.status().kind,'error');
  assert.equal(storage.status().projectId,'bad');
  await storage.retry('bad');
  assert.equal(storage.status().kind,'saved');
});

test('late result stays recoverable after any captured graph input changes', async () => {
  const {canAttachNodeResults}=await import('../infinite-image-canvas/web/src/integration/node-result.mjs');
  const nodes=[{id:'source'}, {id:'text',value:'original'}], links=[{fromNodeId:'text',toNodeId:'source'}];
  const run={projectId:'p',sourceNode:nodes[0],allNodes:nodes,connections:links};
  assert.equal(canAttachNodeResults(run,'p',nodes,links),true);
  assert.equal(canAttachNodeResults(run,'p',[nodes[0],{id:'text',value:'changed'}],links),false);
});

test('interrupted first save restores a safe empty project with its original identity', async () => {
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');
  const repo=createNodeProjectRepository({list:async()=>({projects:[{id:'p'}]}),get:async()=>({id:'p',title:'草稿',revision:0,format:'node-v1',document:{}})});
  const [project]=await repo.load();
  assert.equal(project.id,'p');assert.equal(project.title,'草稿');assert.deepEqual(project.nodes,[]);assert.deepEqual(project.connections,[]);
});

test('asset uploads retain the explicitly captured project even after navigation', async () => {
  const {createNodeAssetRepository}=await import('../infinite-image-canvas/web/src/integration/asset-repository.mjs');
  let current='B', owner;
  const repo=createNodeAssetRepository({upload:async id=>{owner=id;return {id:'a'.repeat(32)};}},()=>current,async()=>{});
  const result=await repo.upload('image','image/png','A');
  assert.equal(owner,'A');assert.equal(result.storageKey,`image:A:${'a'.repeat(32)}`);
});

test('project routes remount on identity change and cancel stale hydration', async () => {
  const fs=await import('node:fs/promises');
  const router=await fs.readFile(require('node:path').join(__dirname,'../infinite-image-canvas/web/src/router.tsx'),'utf8');
  const page=await fs.readFile(require('node:path').join(__dirname,'../infinite-image-canvas/web/src/pages/canvas/project.tsx'),'utf8');
  assert.match(router,/CanvasProjectPage key=\{id\}/);assert.match(page,/if \(cancelled\) return/);assert.match(page,/cancelled = true/);
});

test('lost create response recovers only its unchanged empty project and preserves draft', async () => {
  const {createNodeProjectRepository}=await import('../infinite-image-canvas/web/src/integration/project-repository.mjs');
  let document;
  const api={create:async()=>{throw Error('connection lost')},get:async()=>({id:'p',title:'草稿',format:'node-v1',revision:0,document:{}}),save:async(_id,revision,doc)=>{document=doc;return {revision:revision+1}}};
  const repository=createNodeProjectRepository(api);
  await repository.save({id:'p',title:'草稿',nodes:[{id:'kept'}],connections:[]});
  assert.equal(document.nodes[0].id,'kept');
  api.get=async()=>({id:'p',title:'another',format:'node-v1',revision:0,document:{}});
  await assert.rejects(createNodeProjectRepository(api).save({id:'p',title:'草稿',nodes:[],connections:[]}),/connection lost/);
});

test('selected channel and model remain bound to every canvas operation',async()=>{
 const {createNodeGenerationAdapter}=await import('../infinite-image-canvas/web/src/integration/node-generation-adapter.mjs');
 const preflights=[],reserved=[];const provider={id:7,name:'渠道 B',model:'custom-image',incarnation_id:'inc',config_version:1};
 const api={preflight:async(...args)=>{preflights.push(args);return {supported:true,provider}},reserve:async(_id,body)=>{reserved.push(body);return {status:'prepared'}}};
 const repo={save:async()=>({revision:2})};
 const adapter=createNodeGenerationAdapter({api,repository:repo,confirm:async()=>true,newId:()=> 'unique'});
 await adapter.prepare({project:{id:'p',nodes:[{id:'n'}],connections:[]},nodeId:'n',prompt:'a',referenceKeys:[],count:1,providerId:7,model:'custom-image'});
 assert.deepEqual(preflights[0],['generate',0,false,7,'custom-image']);assert.equal(reserved[0].provider_id,7);assert.equal(reserved[0].model,'custom-image');assert.equal(reserved[0].node_context.selected_model,'custom-image');
});

test('image composer reuses original model picker, image settings and prompt library', async () => {
 const fs=require('node:fs/promises'), path=require('node:path');
 const source=await fs.readFile(path.join(__dirname,'../infinite-image-canvas/web/src/components/canvas/canvas-node-prompt-panel.tsx'),'utf8');
 assert.match(source,/<ModelPicker\s+config=\{imagePickerConfig\}/);
 assert.match(source,/<CanvasImageSettingsPopover/);
 assert.match(source,/<CanvasPromptLibrary\s+onSelect=\{updatePrompt\}/);
});

test('inserting an asset from another canvas makes a project-owned copy',async()=>{
 const {prepareCanvasAsset}=await import('../infinite-image-canvas/web/src/integration/asset-repository.mjs');
 const blob=new Blob(['image'],{type:'image/png'}),calls=[];
 const image={dataUrl:'blob:stale',storageKey:'image:first:'+'a'.repeat(32)};
 const stored=await prepareCanvasAsset(image,'second',async key=>{calls.push(key);return blob},async data=>{assert.equal(data,blob);return {storageKey:'image:second:'+'b'.repeat(32)}});
 assert.equal(stored.storageKey,'image:second:'+'b'.repeat(32));assert.deepEqual(calls,[image.storageKey]);
});

test('original image canvas uses the empty node for grouped generation results',async()=>{
 const {groupCanvasResults}=await import('../infinite-image-canvas/web/src/integration/node-result.mjs');
 const source={id:'node',type:'image',title:'图片',position:{x:10,y:20},width:200,height:200,metadata:{}};
 const results=[{dataUrl:'/one',task:{id:'t1',result_asset_id:'a'.repeat(32)}},{dataUrl:'/two',task:{id:'t2',result_asset_id:'b'.repeat(32)}}];
 const group=groupCanvasResults(source,'project',results,'hello');
 assert.equal(group.reuse,true);assert.equal(group.metadata.images.length,2);assert.equal(group.metadata.primaryImageId,'t1');assert.equal(group.metadata.images[1].nodeCanvasTaskId,'t2');
 assert.equal(group.metadata.storageKey,'image:project:'+'a'.repeat(32));
 assert.equal(groupCanvasResults({...source,metadata:{content:'/prior'}},'project',results,'hello').reuse,false);
});

test('imported canvas rewrites original asset keys and drops old task identities',async()=>{
 const {rewriteImportedProject}=await import('../infinite-image-canvas/web/src/integration/canvas-import.mjs');
 const source={id:'old',title:'P',nodes:[{id:'n',type:'image',metadata:{storageKey:'image:old-key',content:'blob:stale',nodeCanvasTaskId:'old-task',references:['image:old-key']}}],connections:[]};
 const keys=new Map([['image:old-key',{storageKey:'image:new:asset',url:'/new-asset'}]]);
 const result=rewriteImportedProject(source,'new',keys);
 assert.equal(result.id,'new');assert.equal(result.nodes[0].metadata.content,'/new-asset');assert.equal(result.nodes[0].metadata.storageKey,'image:new:asset');assert.deepEqual(result.nodes[0].metadata.references,['image:new:asset']);assert.equal(result.nodes[0].metadata.nodeCanvasTaskId,undefined);assert.equal(source.id,'old');
 assert.throws(()=>rewriteImportedProject(source,'new',new Map()),/缺少图片/);
});

test('same-project asset insertion resolves stored image when cached data URL is empty',async()=>{
 const {prepareCanvasAsset}=await import('../infinite-image-canvas/web/src/integration/asset-repository.mjs');
 const image={dataUrl:'',storageKey:'image:project:'+'a'.repeat(32)};
 const stored=await prepareCanvasAsset(image,'project',async()=>{throw Error('should not copy')},async()=>{throw Error('should not upload')},async key=>'/asset/'+key);
 assert.equal(stored.url,'/asset/'+image.storageKey);
});

test('stopping an image task aborts the pending browser request without replay',async()=>{
 const {createNodeGenerationAdapter}=await import('../infinite-image-canvas/web/src/integration/node-generation-adapter.mjs');
 const controller=new AbortController();let submits=0,status=0,receivedSignal;
 const api={submit:async(_id,_request,signal)=>{submits++;receivedSignal=signal;throw Object.assign(Error('aborted'),{name:'AbortError'})},status:async()=>{status++;return {status:'submitted'}}};
 const adapter=createNodeGenerationAdapter({api,repository:{},confirm:()=>true});
 await assert.rejects(adapter.execute({projectId:'p',requests:[{operation_key:'a'}]},0,controller.signal),/服务商尚未返回最终结果/);
 assert.equal(submits,1);assert.equal(status,1);assert.equal(receivedSignal,controller.signal);
});

test('text canvas reserves one frozen task per result and never retries a lost submission',async()=>{
 const {createNodeTextAdapter}=await import('../infinite-image-canvas/web/src/integration/node-text-adapter.mjs');
 const calls=[];let key=0;const provider={id:2,name:'test',model:'text-model'};
 const api={textPreflight:async()=>({provider}),reserveText:async(_id,body)=>{calls.push(body);return {status:'prepared'}},submitText:async()=>{throw Error('connection lost')},status:async()=>({status:'unknown'})};
 const adapter=createNodeTextAdapter({api,repository:{save:async()=>({revision:4})},confirm:async()=>true,newId:()=>`key${++key}`});
 const run=await adapter.prepare({project:{id:'p',nodes:[{id:'n'}],connections:[]},nodeId:'n',prompt:'hello',referenceKeys:[],count:2,providerId:2,model:'text-model'});
 assert.equal(calls.length,2);assert.equal(calls[0].node_context.batch_id,calls[1].node_context.batch_id);
 await assert.rejects(adapter.execute(run,0),/服务商尚未返回最终结果/);
});

test('image generation accepts connected text as its prompt but rejects empty text sources',async()=>{
 const {hasGenerationPrompt}=await import('../infinite-image-canvas/web/src/integration/generation-prompt.mjs');
 assert.equal(hasGenerationPrompt('',[{type:'text',metadata:{content:'  Product hero image  '}}]),true);
 assert.equal(hasGenerationPrompt('  ',[{type:'text',metadata:{content:'',prompt:'Create a product hero'}}]),true);
 assert.equal(hasGenerationPrompt('',[{type:'text',metadata:{content:'  '}}]),false);
 assert.equal(hasGenerationPrompt('',[{type:'image',metadata:{content:'image data'}}]),false);
 assert.equal(hasGenerationPrompt('Local prompt',[]),true);
});

test('canvas confirmation works in a sandboxed iframe and resolves both choices',async()=>{
 const {confirmCanvasAction}=await import('../infinite-image-canvas/web/src/integration/confirm-action.mjs');
 let config;const modal={confirm:options=>{config=options}};
 const first=confirmCanvasAction(modal,'确认一次');assert.equal(config.content,'确认一次');config.onOk();assert.equal(await first,true);
 const second=confirmCanvasAction(modal,'再次确认');config.onCancel();assert.equal(await second,false);
});

test('generated image frame fits its natural aspect ratio and keeps its centre',async()=>{
 const {fitImageNodeFrame}=await import('../infinite-image-canvas/web/src/integration/node-result.mjs');
 const frame=fitImageNodeFrame({position:{x:100,y:200},width:400,height:300},{width:1000,height:1000},400,300);
 assert.deepEqual(frame,{position:{x:150,y:200},width:300,height:300});
 const portrait=fitImageNodeFrame({position:{x:100,y:200},width:400,height:300},{width:600,height:1200},400,300);
 assert.deepEqual(portrait,{position:{x:225,y:200},width:150,height:300});
});

test('legacy generated frames are repaired without changing manually resized or non-generated nodes',async()=>{
 const {repairGeneratedImageFrame}=await import('../infinite-image-canvas/web/src/integration/node-result.mjs');
 const node={type:'image',position:{x:0,y:0},width:400,height:300,metadata:{nodeCanvasTaskId:'old',naturalWidth:1000,naturalHeight:1000}};
 const repaired=repairGeneratedImageFrame(node,400,300);assert.equal(repaired.width,300);assert.equal(repaired.height,300);
 assert.equal(repairGeneratedImageFrame({...node,metadata:{...node.metadata,freeResize:true}},400,300).width,400);
 assert.equal(repairGeneratedImageFrame({...node,metadata:{naturalWidth:1000,naturalHeight:1000}},400,300).width,400);
 assert.equal(repairGeneratedImageFrame({...node,width:500,height:375},400,300).width,500);
});

test('legacy canvas defaults migrate from three images to one without resetting chosen node counts',async()=>{
 const {migrateCanvasDefaults}=await import('../infinite-image-canvas/web/src/integration/canvas-defaults.mjs');
 const old={config:{canvasImageCount:'3',size:'1:1'},webdav:{url:'test'}};
 const updated=migrateCanvasDefaults(old,0);
 assert.equal(updated.config.canvasImageCount,'1');assert.equal(updated.config.size,'1:1');assert.equal(updated.webdav.url,'test');
 assert.equal(migrateCanvasDefaults({config:{canvasImageCount:'4'}},1).config.canvasImageCount,'4');
});
