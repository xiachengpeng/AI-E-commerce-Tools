const test = require('node:test');
const assert = require('node:assert/strict');

test('handoff keeps existing edits and undo never erases later edits', () => {
    const { applyDraft, undoDraft } = require('../js/research.js');
    const elements = {
        productNameInput: { value: 'Merchant name', dispatchEvent() {} },
        productFactsText: { value: 'My facts', dispatchEvent() {} }
    };
    global.document = { getElementById: id => elements[id] };
    const preview = { fields: [
        { key: 'product_name', target: 'productNameInput', value: 'Research name' },
        { key: 'material', target: 'productFactsText', value: '材质: Cotton' }
    ] };
    const result = applyDraft(preview, ['product_name', 'material'], 'details');
    assert.equal(elements.productNameInput.value, 'Merchant name');
    assert.equal(elements.productFactsText.value, 'My facts\n材质: Cotton');
    elements.productFactsText.value += '\nLater edit';
    undoDraft(result);
    assert.equal(elements.productFactsText.value, 'My facts\n材质: Cotton\nLater edit');
    delete global.document;
});

test('only accepted fields are inserted into chosen module', () => {
    const { applyDraft } = require('../js/research.js');
    const elements = { listingName: { value: '', dispatchEvent() {} }, listingPoints: { value: '', dispatchEvent() {} } };
    global.document = { getElementById: id => elements[id] };
    applyDraft({ fields: [
        { key: 'product_name', target: 'productNameInput', value: 'Pouch' },
        { key: 'material', target: 'productFactsText', value: '材质: Cotton' }
    ] }, ['product_name'], 'listing');
    assert.equal(elements.listingName.value, 'Pouch');
    assert.equal(elements.listingPoints.value, '');
    delete global.document;
});

test('display escaping cannot execute research source markup', () => {
    const { escapeHtml } = require('../js/research.js');
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});


const vm = require('node:vm');
const fs = require('node:fs');
async function panelFixture() {
    const nodes = {}, handlers = {};
    const node = id => nodes[id] ||= { value: '', innerHTML: '', textContent: '', hidden: true, dataset: {},
        classList: { toggle() {} }, addEventListener(type, fn) { handlers[type] = fn; },
        querySelectorAll() { return [{ dataset: { researchField: 'material' } }]; } };
    let resolvePreview, resolveConfirmation;
    const product = { source_ref: { project_id: 'p', product_id: 'one', source_version: 1, identity_revision: 1 }, market: 'US', name: 'Pouch', facts: [], steps: [] };
    const context = { document: { getElementById: node }, AbortSignal, URL, Event, crypto: require('node:crypto'),
        fetch: async url => ({ ok: true, json: async () => {
            if (url.endsWith('/session')) return { csrf_token: 'test', enabled: true };
            if (url.endsWith('/projects')) return { projects: [], next_cursor: 'cursor' };
            if (url.endsWith('/preview')) return new Promise(resolve => { resolvePreview = resolve; });
            if (url.endsWith('/confirm-fact')) return new Promise(resolve => { resolveConfirmation = resolve; });
            return { id: 'p', title: 'Travel', market: 'US', products: [product, { ...product, source_ref: { ...product.source_ref, product_id: 'two' } }] };
        } }) };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(require.resolve('../js/research.js'), 'utf8'), context);
    const click = data => handlers.click({ target: { closest: () => ({ id: data.buttonId, dataset: data, hasAttribute: key => key === 'data-research-preview' && data.preview }) } });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    await context.ResearchPanel.init(); click({ researchProject: 'p' }); await settle(); click({ researchProduct: 'one' });
    return { context, node, click, settle, resolve: value => resolvePreview(value),
        resolveConfirmation: value => resolveConfirmation(value), submit: form => handlers.submit({ preventDefault() {}, target: form }) };
}

test('late handoff response cannot fill a different selected product', async () => {
    const f = await panelFixture();
    f.click({ researchApply: 'details' }); await f.settle();
    f.click({ researchProduct: 'two' });
    f.resolve({ fields: [{ key: 'material', target: 'productFactsText', value: 'First product cotton' }] });
    await f.settle();
    assert.equal(f.node('productFactsText').value, '');
});

test('late preview response cannot render after leaving research view', async () => {
    const f = await panelFixture();
    f.click({ preview: true }); await f.settle();
    f.context.ResearchPanel.suspend();
    f.resolve({ fields: [{ key: 'material', target: 'productFactsText', label: 'Material', value: 'Cotton' }], blocked_count: 0 });
    await f.settle();
    assert.equal(f.node('researchPreview').innerHTML, '');
});

test('late confirmation cannot reset a newly edited form after reselection', async () => {
    const f = await panelFixture();
    f.submit({ id: 'researchConfirmForm', elements: { own_product: { checked: true }, key: { value: 'material' },
        value: { value: 'Cotton' }, source_url: { value: 'https://example.com/p' } }, querySelector() { return { disabled: false }; } });
    await f.settle();
    f.click({ researchProduct: 'two' }); f.click({ researchProduct: 'one' });
    f.node('researchProductDetail').innerHTML = 'New form with user edits';
    f.resolveConfirmation({}); await f.settle();
    assert.equal(f.node('researchProductDetail').innerHTML, 'New form with user edits');
});

test('double clicking pagination issues only one request for the current cursor', async () => {
    const f = await panelFixture(); let count = 0;
    f.context.fetch = async () => { count++; return { ok: true, json: () => new Promise(() => {}) }; };
    f.click({ buttonId: 'researchMoreProjects' }); f.click({ buttonId: 'researchMoreProjects' });
    await f.settle(); assert.equal(count, 1);
});

test('native selection re-reads server DTO and checks version identity and merged fences without trusting browser facts',async()=>{
 const nodes={},calls=[];let version=7,identity=3,merged=false,truncated=false;
 const id='11111111-1111-4111-8111-111111111111',pid='22222222-2222-4222-8222-222222222222';
 const node=id=>nodes[id]||=( {value:'',hidden:false,innerHTML:'',textContent:'',dataset:{},classList:{toggle(){}},addEventListener(){},scrollIntoView(){}} );
 const context={URL,AbortSignal,Event,crypto:require('node:crypto'),document:{getElementById:node},fetch:async(url,options)=>{calls.push({url,body:options.body&&JSON.parse(options.body)});return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fake',enabled:true}:url.endsWith('/preview')?{fields:[],blocked_count:2}:url.includes('/products/')?{name:'Widget',market:'US',merged,source_ref:{project_id:id,product_id:pid,source_version:version,identity_revision:identity},facts:[],steps:[]}:{id,title:'Fake',market:'US',source_version:version,products:truncated?[]:[{name:'Widget',market:'US',merged,source_ref:{project_id:id,product_id:pid,source_version:version,identity_revision:identity},facts:[],steps:[]}]}};}};context.window=context;
 vm.runInNewContext(fs.readFileSync(require.resolve('../js/research.js'),'utf8'),context);
 assert.equal(typeof context.ResearchPanel.selectSource,'function');
 const selection={project_id:id,product_id:pid,source_version:7,identity_revision:3,material:'Forged cotton'};
 await context.ResearchPanel.selectSource(selection);assert.equal(calls.filter(c=>c.url.endsWith('/preview')).length,1);assert.ok(calls.filter(c=>c.body).every(c=>!('material' in c.body)));
 truncated=true;await context.ResearchPanel.selectSource(selection);assert.equal(calls.filter(c=>c.url.endsWith('/preview')).length,2);version=8;await context.ResearchPanel.selectSource(selection);assert.equal(calls.filter(c=>c.url.endsWith('/preview')).length,2);assert.match(node('researchStatus').textContent,/更新/);
 version=7;identity=4;await context.ResearchPanel.selectSource(selection);assert.equal(calls.filter(c=>c.url.endsWith('/preview')).length,2);
 identity=3;merged=true;await context.ResearchPanel.selectSource(selection);assert.equal(calls.filter(c=>c.url.endsWith('/preview')).length,2);
 await context.ResearchPanel.selectSource({...selection,product_id:'not-a-member'});assert.equal(calls.filter(c=>c.url.endsWith('/preview')).length,2);
});

for (const boundary of ['product navigation during direct read','product navigation during preview','unmount during direct read']) test('native handoff origin fence: '+boundary,async()=>{
 const {createWorkbench}=await import('../js/research-workbench/index.mjs');
 const {fixtureRoot}=await import('./research-workbench/dom-fixture.mjs');
 const native=fixtureRoot(),nodes={},calls=[];native.hidden=false;
 const projectId='11111111-1111-4111-8111-111111111111',a='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333';
 const product=id=>({id,name:id===a?'A':'B',identity_revision:1,steps:[],identification:{}});
 const project={id:projectId,title:'Origin',market:'US',version:7,keywords:[],products:[product(a),product(b)]};
 const snapshot=id=>({name:id===a?'A':'B',market:'US',merged:false,source_ref:{project_id:projectId,product_id:id,source_version:7,identity_revision:1},facts:[],steps:[]});
 const node=id=>nodes[id]||={value:'',hidden:true,innerHTML:'',textContent:'',dataset:{},classList:{toggle(){}},addEventListener(){},scrollIntoView(){}};
 let release,startedResolve,finishedResolve;const started=new Promise(r=>startedResolve=r),finished=new Promise(r=>finishedResolve=r);
 const context={URL,AbortSignal,Event,crypto:require('node:crypto'),document:{getElementById:id=>id==='researchNativeRoot'?native:node(id)},fetch:async url=>{calls.push(url);return {ok:true,json:async()=>{
  if(url.endsWith('/session'))return {csrf_token:'fixture',enabled:true};
  const preview=url.endsWith('/preview');
  if((boundary.includes('preview')&&preview)||(!boundary.includes('preview')&&url.endsWith('/products/'+a))){startedResolve();return new Promise(r=>release=r);}
  if(preview)return {fields:[{key:'material',label:'Material',target:'productFactsText',value:'A facts'}],blocked_count:0};
  if(url.includes('/products/'))return snapshot(a);
  return {...project,source_version:7,products:project.products.map(p=>snapshot(p.id))};
 }}}};context.window=context;
 vm.runInNewContext(fs.readFileSync(require.resolve('../js/research.js'),'utf8'),context);
 const wb=createWorkbench();await wb.mount(native,{fetch:async url=>({ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'fixture'}:url.endsWith('/projects/'+projectId)?project:url.includes('/actions')?{actions:[]}:{projects:[project]}}),onSelectProduct:(selection,origin)=>{assert.deepEqual(Object.keys(selection).sort(),['identity_revision','product_id','project_id','source_version']);return context.ResearchPanel.selectSource(selection,origin).finally(finishedResolve);}});
 native.querySelector('[data-rw-projects]').find(n=>n.dataset.rwProject===projectId).click();await new Promise(r=>setImmediate(r));wb.openProduct(projectId,a);
 native.querySelector('[data-product-handoff]').click();await started;
 if(boundary.startsWith('unmount'))wb.unmount();else wb.openProduct(projectId,b);
 release(boundary.includes('preview')?{fields:[{key:'material',label:'Material',target:'productFactsText',value:'A facts'}],blocked_count:0}:snapshot(a));await finished;
 if(!boundary.startsWith('unmount'))assert.equal(wb.state.product,b);
 assert.equal(native.hidden,false);assert.equal(node('researchView').hidden,true);assert.equal(node('researchPreview').innerHTML,'');assert.equal(node('productFactsText').value,'');
 if(!boundary.includes('preview'))assert.equal(calls.filter(url=>url.endsWith('/preview')).length,0);
 wb.unmount();
});
