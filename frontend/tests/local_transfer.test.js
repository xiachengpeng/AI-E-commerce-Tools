const test=require('node:test');
const assert=require('node:assert/strict');
const transfer=require('../js/local_transfer.js');
const listing='ai_ecommerce_listing_draft_v1',ads='ai_ecommerce_ads_draft_v1',templates='dtc_saved_typography_templates';
function storage(initial={}){const map=new Map(Object.entries(initial));return {map,getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}
function bundle(entries){return {format:'ai-ecommerce-local-drafts',version:1,source_origin:'http://127.0.0.1:9502',entries};}

test('export reads only selected business keys and never scans credentials or command identities',()=>{
 const s=storage({[listing]:JSON.stringify({name:'fixture',points:'verified text'}),api_key:'secret','rabbit-hole:command:old':'id'});
 const seen=[];const get=s.getItem;s.getItem=k=>{seen.push(k);return get(k);};
 const result=transfer.collect(s,[listing]);
 assert.deepEqual(Object.keys(result.entries),[listing]);assert.deepEqual(seen,[listing]);
 assert.ok(!JSON.stringify(result).includes('secret'));
});

test('preview and apply preserve an existing draft and merge new typography names',()=>{
 const s=storage({[listing]:'{"name":"keep"}',[templates]:JSON.stringify({old:{name:'original',titleSize:'28px'}})});
 const b=bundle({[listing]:{name:'incoming'},[ads]:{productName:'new'},[templates]:{old:{name:'clobber'},new:{name:'new',titleSize:'32px'}}});
 const before=[...s.map];const preview=transfer.preview(s,b);
 assert.deepEqual([...s.map],before);assert.equal(preview.find(r=>r.key===listing).status,'conflict');
 const result=transfer.apply(s,b);
 assert.equal(JSON.parse(s.getItem(listing)).name,'keep');assert.equal(JSON.parse(s.getItem(ads)).productName,'new');
 assert.equal(JSON.parse(s.getItem(templates)).old.name,'original');assert.equal(JSON.parse(s.getItem(templates)).new.titleSize,'32px');
 assert.equal(result.added,2);
});

test('quota failure rolls back prior writes and never purges unrelated local data',()=>{
 const s=storage({keep:'user data'});const put=s.setItem;s.setItem=(k,v)=>{if(k===ads)throw Error('quota');return put(k,v);};
 assert.throws(()=>transfer.apply(s,bundle({[listing]:{name:'first'},[ads]:{productName:'second'}})));
 assert.deepEqual([...s.map],[['keep','user data']]);
});

test('apply recomputes conflicts after preview so edits made meanwhile win',()=>{
 const s=storage();const b=bundle({[listing]:{name:'imported'}});transfer.preview(s,b);
 s.setItem(listing,'{"name":"typed meanwhile"}');transfer.apply(s,b);
 assert.equal(JSON.parse(s.getItem(listing)).name,'typed meanwhile');
});

test('unrelated keys, secret fields and command identifiers are rejected before writes',()=>{
 for(const entries of [{api_key:'secret'},{[listing]:{name:'ok',token:'secret'}},{'rabbit-hole:command:abc':{}},{[ads]:{command_id:'uuid'}}]){
  const s=storage();assert.throws(()=>transfer.apply(s,bundle(entries)));assert.equal(s.map.size,0);
 }
});

test('rejects executable typography, prototype keys and malformed envelopes',()=>{
 const examples=[bundle({[templates]:{x:{name:'x',titleSize:'28px; color:red'}}}),
  JSON.parse('{"format":"ai-ecommerce-local-drafts","version":1,"source_origin":"http://127.0.0.1:9502","entries":{"dtc_saved_typography_templates":{"__proto__":{"name":"bad"}}}}'),
  {...bundle({}),version:99},{...bundle({}),source_origin:'https://foreign.example'}];
 for(const input of examples)assert.throws(()=>transfer.validate(input));
});

test('unportable detail media is refused without silently discarding original draft',()=>{
 const key='dtc_studio_current_draft';const raw=JSON.stringify({productName:'source',tasks:[{imageUrl:'blob:http://localhost/fixture'}]});
 const s=storage({[key]:raw});assert.throws(()=>transfer.collect(s,[key]));assert.equal(s.getItem(key),raw);
});

test('studio tasks and injected inline handler identifiers never enter active storage',()=>{
 for(const uniqueId of ['legitimate-task',"x');alert(1);//"]){
  const key='dtc_studio_current_draft',s=storage();
  assert.throws(()=>transfer.apply(s,bundle({[key]:{tasks:[{uniqueId}]}})));
  assert.equal(s.getItem(key),null);
 }
});

test('empty and repeated imports are idempotent',()=>{
 const s=storage();assert.equal(transfer.apply(s,bundle({})).added,0);
 const b=bundle({[ads]:{productName:'once'}});assert.equal(transfer.apply(s,b).added,1);
 assert.equal(transfer.apply(s,b).added,0);
});

test('typography names remain unique even when source and target use different IDs',()=>{
 const s=storage({[templates]:JSON.stringify({target:{name:'My Brand',titleSize:'28px'}})});
 const result=transfer.apply(s,bundle({[templates]:{source:{name:'My Brand',titleSize:'48px'}}}));
 assert.equal(Object.keys(JSON.parse(s.getItem(templates))).length,1);
 assert.equal(result.added,0);assert.equal(result.skipped,1);
});

test('oversize, excessive nesting and invalid JSON refuse the complete import',()=>{
 assert.throws(()=>transfer.validate('invalid json'));
 assert.throws(()=>transfer.validate(' '.repeat(transfer.MAX_BYTES+1)));
 let nested={};for(let n=0;n<35;n++)nested={child:nested};
 assert.throws(()=>transfer.validate(bundle({'dtc_studio_current_draft':{productFacts:nested}})));
});
