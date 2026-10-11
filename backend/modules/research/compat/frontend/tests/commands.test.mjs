import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=await readFile(new URL('../services/commands.js',import.meta.url),'utf8');
function commands(secure=true){
  const crypto=secure?webcrypto:{getRandomValues:bytes=>webcrypto.getRandomValues(bytes)};
  const context=vm.createContext({crypto,TextEncoder,Uint8Array});
  vm.runInContext(source,context);
  return context;
}
for(const secure of [true,false]){
  test('command IDs remain unique and valid on '+(secure?'HTTPS':'LAN HTTP'),()=>{
    const c=commands(secure),ids=new Set(Array.from({length:100},()=>c.newCommandId()));
    assert.equal(ids.size,100);
    for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test('fingerprint detects edits without preserving form content on '+(secure?'HTTPS':'LAN HTTP'),async()=>{
    const c=commands(secure),input={text:'private research'};
    const one=await c.submissionFingerprint(input);
    assert.equal(one,await c.submissionFingerprint(input));
    assert.notEqual(one,await c.submissionFingerprint({text:'changed research'}));
    assert.ok(!one.includes(input.text));
  });
}
