const test=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
global.crypto ||= webcrypto;
const transfer=require('../js/detail_project_transfer.js');
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ioAAAAASUVORK5CYII=';
// Browser decode is exercised separately in native acceptance. Unit fake rejects damaged bytes.
global.createImageBitmap=async blob=>{if(blob.size<50)throw Error('decode');return {width:1,height:1,close(){}};};
const source=()=>({kind:'detail-page-project',version:2,productName:'Glass cup',uploadedImages:[{id:'a',name:'cup.png',base64:PNG,isPrimary:true}],modules:[{id:'m1_0',moduleId:'m1',title:'Cup',includeText:false,imageSrc:PNG,dtcCopy:{headline:'Glass cup'},seo:{titleTarget:'Cup'}}],longImageOrder:['m1_0'],verifiedFacts:{material:{value:'glass',source:'ai',verified:false,confidence:0.7}},config:{language:'English',aspectRatio:'1:1'},layoutStyle:'bento',typography:{fontFamily:'inter',titleSize:'28px'},channel:'shopify'});
test('portable snapshot embeds all media, preserves evidence/copy/layout and remaps independent IDs',async()=>{
 const s=source(),before=JSON.stringify(s),p=await transfer.buildPortableDetailProject(s);
 assert.equal(p.kind,'detail-page-transfer');assert.equal(p.version,1);assert.equal(JSON.stringify(s),before);
 assert.equal(p.project.modules[0].includeText,false);assert.equal(p.project.verifiedFacts.material.verified,false);
 assert.equal(p.project.layoutStyle,'bento');assert.equal(p.project.typography.titleSize,'28px');
 assert.equal(p.project.modules[0].moduleId,'m1');assert.notEqual(p.project.modules[0].id,'m1_0');
 assert.deepEqual(p.project.longImageOrder,[p.project.modules[0].id]);assert.equal(p.project.uploadedImages[0].base64,PNG);
 assert.deepEqual(transfer.validatePortableDetailProject(JSON.stringify(p)),p);
});
test('unfinished studio tasks convert to inert results, not executable job identities',async()=>{
 const p=await transfer.buildPortableDetailProject({channel:'shopify',language:'Thai',productName:'Draft',productFacts:{category:{value:'cup',source:'ai',verified:false}},tasks:[{id:'m1',uniqueId:'m1_0',title:'Hero',status:'running',includeText:false,runId:'old',remoteImageUrl:'https://old.example/x'}],longImageOrder:['m1_0']});
 assert.equal(p.project.config.language,'Thai');
 assert.equal(p.project.modules[0].status,'pending');assert.equal(p.project.modules[0].moduleId,'m1');
 assert.equal(p.project.verifiedFacts.category.verified,false);assert.ok(!JSON.stringify(p).includes('old.example'));
 assert.ok(!JSON.stringify(p).includes('runId'));assert.ok(p.warnings.length);
});
test('invalid IDs, HTML, executable URLs, secrets and unknown imported fields fail closed',async()=>{
 for(const mutate of [s=>s.modules[0].id="x');alert(1);//",s=>s.modules[0].title='<img onerror=alert(1)>',s=>s.modules[0].imageSrc='javascript:alert(1)',s=>s.config.token='secret',s=>s.modules[0].onerror='alert(1)',s=>s.config.credentials={password:'secret'},s=>s.unknownCommandPayload={run:true}]){
  const s=source();mutate(s);await assert.rejects(transfer.buildPortableDetailProject(s));
 }
 const p=await transfer.buildPortableDetailProject(source());p.project.modules[0].command_id='old';assert.throws(()=>transfer.validatePortableDetailProject(p));
 const q=await transfer.buildPortableDetailProject(source());q.project.config.aspectRatio='1; background:url(https://evil)';assert.throws(()=>transfer.validatePortableDetailProject(q));
 const r=await transfer.buildPortableDetailProject(source());r.project.typography.titleSize='1px;}body{display:none}';assert.throws(()=>transfer.validatePortableDetailProject(r));
});
test('blob conversion is explicit and expired blobs abort without changing source',async()=>{
 const s=source();s.modules[0].imageSrc='blob:http://localhost/valid';
 const p=await transfer.buildPortableDetailProject(s,async url=>{assert.equal(url,s.modules[0].imageSrc);return PNG;});assert.equal(p.project.modules[0].imageSrc,PNG);
 const before=JSON.stringify(s);await assert.rejects(transfer.buildPortableDetailProject(s,async()=>{throw Error('expired');}));assert.equal(JSON.stringify(s),before);
});
test('fake images and single-image or total oversize packages are rejected',async()=>{
 const s=source();s.modules[0].imageSrc='data:image/png;base64,aGVsbG8=';await assert.rejects(transfer.buildPortableDetailProject(s));
 const large=source();large.finalImage='data:image/png;base64,'+'A'.repeat(12*1024*1024);await assert.rejects(transfer.buildPortableDetailProject(large));
 assert.throws(()=>transfer.validatePortableDetailProject(' '.repeat(64*1024*1024+1)));
});
test('restore validates and decodes before saving independent history; never activates the current editor',async()=>{
 const p=await transfer.buildPortableDetailProject(source()),saved=[];
 global.saveToHistory=async(module,data)=>{saved.push({module,data});return true;};
 global.renderRestoredDetailProject=()=>{throw Error('must not change existing editor');};
 const a=await transfer.restorePortableDetailProject(p),b=await transfer.restorePortableDetailProject(p);
 assert.notEqual(a.projectId,b.projectId);assert.equal(saved.length,2);assert.equal(saved[0].module,'render');
 assert.equal(saved[0].data.metadata.transferProjectId,a.projectId);assert.equal(saved[0].data.metadata.verifiedFacts.material.verified,false);
 assert.notEqual(saved[0].data.metadata.modules[0].id,saved[1].data.metadata.modules[0].id);
 global.saveToHistory=async()=>false;await assert.rejects(transfer.restorePortableDetailProject(p));
});
test('unknown media origins do not cause automatic remote fetches',async()=>{
 const s=source();s.modules[0].imageSrc='https://example.org/private';let called=0;
 global.fetch=async()=>{called++;throw Error('unexpected');};await assert.rejects(transfer.buildPortableDetailProject(s));assert.equal(called,0);
});
test('real snapshot optional undefined fields do not make an ordinary draft unexportable',async()=>{
 const s=source();s.modules[0].subtitle=undefined;s.uploadedImages[0].semanticRole=undefined;
 const p=await transfer.buildPortableDetailProject(s);assert.equal(p.project.modules[0].title,'Cup');
});
test('unrecognised project commands and prototype-bearing values are rejected',async()=>{
 const s=source();s.commandId='old';await assert.rejects(transfer.buildPortableDetailProject(s));
 const p=await transfer.buildPortableDetailProject(source());p.project.unexpectedCommand={run:true};assert.throws(()=>transfer.validatePortableDetailProject(p));
});
test('legacy product name remains unconfirmed when no fact provenance was saved',async()=>{
 const p=await transfer.buildPortableDetailProject({productName:'AI draft name',tasks:[],productFacts:{}});
 assert.deepEqual(p.project.verifiedFacts.productName,{value:'AI draft name',source:'unknown',verified:false});
});
test('conflicting name and provenance is rejected rather than silently confirmed by restored DOM',async()=>{
 const s=source();s.verifiedFacts.productName={value:'A different name',source:'ai',verified:false};await assert.rejects(transfer.buildPortableDetailProject(s));
});
test('saved relative static paths read from the fixed backend media origin',async()=>{
 const s=source();s.modules[0].imageSrc='/static/outputs/saved.png';const requested=[];
 const oldLocation=global.location,oldReader=global.FileReader;
 global.location={origin:'http://127.0.0.1:9502'};
 global.FileReader=class {readAsDataURL(blob){blob.arrayBuffer().then(data=>{this.result='data:'+blob.type+';base64,'+Buffer.from(data).toString('base64');this.onload();});}};
 global.fetch=async(url,options)=>{requested.push(url);assert.equal(options.redirect,'error');return new Response(Buffer.from(PNG.split(',')[1],'base64'),{headers:{'Content-Type':'image/png'}});};
 try{await transfer.buildPortableDetailProject(s);assert.deepEqual(requested,['http://127.0.0.1:9503/static/outputs/saved.png']);}
 finally{global.location=oldLocation;global.FileReader=oldReader;}
});
