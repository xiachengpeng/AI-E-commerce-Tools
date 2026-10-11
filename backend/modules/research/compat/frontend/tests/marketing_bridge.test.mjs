import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('embedded bridge sends IDs only after trusted parent handshake',()=>{
  let listener,button;
  const sent=[];
  const parent={postMessage:(data,origin)=>sent.push({data,origin})};
  const context={location:{pathname:'/marketing-workbench'},parent,
    S:{project:{id:'project',version:3,market:'GB',products:[{id:'product',identity_revision:2}]},product:'product'},
    document:{createElement:()=>({}),querySelector:()=>({append:b=>{button=b;}})},setInterval(){}};
  context.window={addEventListener:(_,fn)=>{listener=fn;}};
  vm.runInNewContext(readFileSync(new URL('../services/marketing_bridge.js',import.meta.url),'utf8'),context);
  button.onclick(); assert.equal(sent.length,0);
  listener({source:parent,origin:'http://evil.example',data:{type:'marketing:hello',version:1}});
  button.onclick(); assert.equal(sent.length,0);
  listener({source:parent,origin:'http://127.0.0.1:9502',data:{type:'marketing:hello',version:1}});
  button.onclick(); assert.equal(sent.length,2);
  assert.equal(sent[1].data.product_id,'product');
  assert.equal(sent[1].data.source_version,3);
  assert.equal('facts' in sent[1].data,false);
  assert.equal('token' in sent[1].data,false);
});
