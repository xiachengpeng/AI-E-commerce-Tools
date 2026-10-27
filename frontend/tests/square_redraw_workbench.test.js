const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/square_redraw.js'), 'utf8');
function element(data = {}) {
    const classes = new Set();
    return { dataset: data, disabled: false, textContent: '', innerHTML: '', value: '', attrs: {},
        setAttribute(k,v) { this.attrs[k] = v; },
        classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); }, toggle(c,on) { on ? classes.add(c) : classes.delete(c); } } };
}
function setup() {
    const elements = new Proxy({}, { get(o,k) { return o[k] ||= element(); } });
    const counts = ['all','pending','success','failed','skipped'].map(k=>element({srCount:k}));
    const filters = counts.map(e=>element({srFilter:e.dataset.srCount}));
    const ratios = ['1:1','4:5','3:4','16:9'].map(k=>element({srRatio:k}));
    const requests = [], toasts = [];
    const ctx = vm.createContext({ console, window: {}, API_BASE:'', CONCURRENCY_LIMIT:2, STAGGER_DELAY:0, setTimeout,
        document: { getElementById: id=>elements[id], querySelectorAll: sel=>sel.includes('sr-count')?counts:sel.includes('sr-filter')?filters:ratios },
        showToast:(...args)=>toasts.push(args),
        fetch:async (url,opts={})=>{ requests.push({url,...opts}); return {json:async()=>({status:'success',data:{id:7,target_aspect_ratio:'4:5',items:[{id:1,filename:'a.jpg',status:'done',output_url:'/static/a.png',width:1200,height:1000}]}})}; }
    });
    vm.runInContext(source, ctx);
    return {ctx,elements,counts,filters,ratios,requests,toasts,run:code=>vm.runInContext(code,ctx)};
}
test('workbench exposes real counts, active filter and filtered empty reset',()=>{
    const {ctx,elements,counts,filters} = setup();
    ctx.window.setSquareRedrawImages([{id:'a',filename:'a.jpg',status:'done',output_url:'/static/a.png'},{id:'b',filename:'b.jpg',status:'skipped_square'}]);
    ctx.setSquareRedrawFilter('failed');
    assert.deepEqual(counts.map(e=>String(e.textContent)),['2','0','1','0','1']);
    assert.equal(filters[3].attrs['aria-pressed'],'true');
    assert.match(elements.squareRedrawList.innerHTML,/没有失败的图片/);
    assert.match(elements.squareRedrawList.innerHTML,/setSquareRedrawFilter\('all'\)/);
    assert.equal(elements.squareRedrawFooter.classList.contains('hidden'),false);
});
test('persisted ratio disables editing and preview uses actual ratio',()=>{
    const {ctx,elements,ratios}=setup();
    ctx.applySquareRedrawBatch({id:7,target_aspect_ratio:'4:5',items:[{id:1,filename:'a',status:'done',output_url:'/static/a.png'}]});
    assert.equal(elements.squareRedrawAspectSelect.disabled,true);
    assert.equal(ratios[1].attrs['aria-pressed'],'true');
    assert.equal(ratios.every(e=>e.disabled),true);
    ctx.openSquareRedrawPreview('server_1');
    assert.equal(elements.squareRedrawPreviewResultLabel.textContent,'目标比例 · 4:5');
});
test('completed batch cannot create a duplicate; local matching images can create ZIP batch', async()=>{
    const {ctx,elements,requests}=setup();
    ctx.window.setSquareRedrawImages([{id:'local',filename:'a',status:'skipped_square'}]);
    ctx.updateSquareRedrawActions();
    assert.equal(elements.squareRedrawStartBtn.disabled,false);
    ctx.applySquareRedrawBatch({id:7,items:[{id:1,filename:'a',status:'done',output_url:'/static/a.png'}]});
    ctx.updateSquareRedrawActions();
    assert.equal(elements.squareRedrawStartBtn.disabled,true);
    await ctx.startSquareRedrawBatch();
    assert.equal(requests.filter(r=>r.method==='POST').length,0);
});
test('queued history recovery processes existing items without recreating or reprocessing successes',async()=>{
    const {ctx,requests}=setup();
    ctx.applySquareRedrawBatch({id:7,items:[{id:1,filename:'a',status:'queued'},{id:2,filename:'b',status:'done',output_url:'/static/b.png'}]});
    await ctx.startSquareRedrawBatch();
    assert.deepEqual(requests.filter(r=>r.method==='POST').map(r=>r.url),['/api/square-redraw/batches/7/items/1/process']);
});
test('active work rejects file replacement and retains current batch',async()=>{
    const {ctx,run,toasts}=setup();
    ctx.window.setSquareRedrawImages([{id:'existing',filename:'keep.jpg',status:'running'}]);
    run('squareRedrawRunning = true; squareRedrawBatchId = 7;');
    await ctx.loadSquareRedrawFiles([{name:'replace.jpg'}]);
    assert.equal(ctx.window.getSquareRedrawImages()[0].id,'existing');
    assert.equal(run('squareRedrawBatchId'),7);
    assert.match(toasts[0][0],/处理中/);
});
test('a failed file read preserves the previous successful list and batch',async()=>{
    const {ctx,run}=setup();
    ctx.window.setSquareRedrawImages([{id:'existing',filename:'keep.jpg',status:'done'}]);
    run('squareRedrawBatchId = 7;');
    ctx.FileReader=class { readAsDataURL() { this.onerror(); } };
    await ctx.loadSquareRedrawFiles([{name:'broken.jpg'}]);
    assert.equal(ctx.window.getSquareRedrawImages()[0].id,'existing');
    assert.equal(run('squareRedrawBatchId'),7);
});
test('submission failure unlocks controls and keeps the local images retryable',async()=>{
    const {ctx,run,elements,toasts}=setup();
    ctx.window.setSquareRedrawImages([{id:'local',filename:'a',status:'ready'}]);
    ctx.fetch=async()=>{throw new Error('offline');};
    await ctx.startSquareRedrawBatch();
    assert.equal(run('squareRedrawRunning'),false);
    assert.equal(elements.squareRedrawStartBtn.disabled,false);
    assert.equal(ctx.window.getSquareRedrawImages().length,1);
    assert.match(toasts.at(-1)[0],/创建|连接|offline/);
});
test('a second start click cannot submit another batch while creation is pending',async()=>{
    const {ctx,requests}=setup(); let resolve;
    ctx.window.setSquareRedrawImages([{id:'local',filename:'a',status:'ready'}]);
    const original=ctx.fetch;ctx.fetch=(url,opts)=>new Promise(r=>{resolve=()=>original(url,opts).then(r);});
    const first=ctx.startSquareRedrawBatch(); await ctx.startSquareRedrawBatch();
    resolve();await first;
    assert.equal(requests.length,1);
});
test('fresh all-matching images create only a batch for ZIP, save history, never request generation',async()=>{
    const {ctx,requests,elements}=setup();let saved=0;
    ctx.saveToHistory=()=>saved++;
    ctx.window.setSquareRedrawImages([{id:'local',filename:'square.jpg',status:'skipped_square',width:100,height:100}]);
    const original=ctx.fetch;ctx.fetch=async(url,opts)=>{const r=await original(url,opts);return {...r,json:async()=>({status:'success',data:{id:7,target_aspect_ratio:'1:1',items:[{id:1,filename:'square.jpg',status:'skipped_square',width:100,height:100}]}})};};
    await ctx.startSquareRedrawBatch();
    assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/square-redraw/batches');
    assert.equal(saved,1);assert.equal(elements.squareRedrawDownloadBtn.disabled,false);
});
test('a failed result refresh preserves completed items and releases operation lock',async()=>{
    const {ctx,run,elements,toasts}=setup();const original=ctx.fetch;
    ctx.applySquareRedrawBatch({id:7,items:[{id:1,filename:'a',status:'queued'}]});
    ctx.fetch=(url,opts)=>opts?.method==='POST'?original(url,opts):Promise.reject(new Error('offline'));
    await ctx.startSquareRedrawBatch();
    assert.equal(run('squareRedrawRunning'),false);
    assert.equal(ctx.window.getSquareRedrawImages()[0].status,'done');
    assert.equal(elements.squareRedrawDownloadBtn.disabled,false);
    assert.ok(toasts.some(t=>/刷新失败/.test(t[0])));
});
test('row deletion unlocks after completion even if the batch signature is unchanged',()=>{
    const {ctx,run,elements}=setup();const button=element({srStatus:'done'});
    elements.squareRedrawList.querySelectorAll=()=>[button];
    run('squareRedrawRunning=true');ctx.updateSquareRedrawActions();assert.equal(button.disabled,true);
    run('squareRedrawRunning=false');ctx.updateSquareRedrawActions();assert.equal(button.disabled,false);
    button.dataset.srStatus='running';ctx.updateSquareRedrawActions();assert.equal(button.disabled,true);
});

test('ZIP download saves a blob without navigating and reports server errors',async()=>{
    const {ctx,run,elements,toasts}=setup();const downloads=[];let removed=0;
    ctx.window.location={href:'http://127.0.0.1:9502/index.html'};
    ctx.document.body={appendChild(){}};
    ctx.document.createElement=()=>({click(){downloads.push(this.download);},remove(){removed++;}});
    ctx.URL={createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}};
    ctx.setTimeout=(fn)=>fn();
    ctx.window.setSquareRedrawImages([{id:'existing',status:'done',output_url:'/static/a.png'}]);
    run('squareRedrawBatchId=7');
    ctx.fetch=async()=>({ok:true,headers:{get:()=> 'application/zip'},blob:async()=>({size:50})});
    await ctx.downloadSquareRedrawZip();
    assert.deepEqual(downloads,['square-redraw-7.zip']);
    assert.equal(ctx.window.location.href,'http://127.0.0.1:9502/index.html');assert.equal(removed,1);
    ctx.fetch=async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>({status:'error',message:'internal path'})});
    await ctx.downloadSquareRedrawZip();
    assert.equal(downloads.length,1);assert.match(toasts.at(-1)[0],/下载|打包/);
    assert.equal(elements.squareRedrawDownloadBtn.disabled,false);
});
