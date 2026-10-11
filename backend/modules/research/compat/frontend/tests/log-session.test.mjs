import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../services/log-session.js',import.meta.url),'utf8');
function create(options){const ctx=vm.createContext({});vm.runInContext(source,ctx);return ctx.createLogSession(options);}
function stream(){return {listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},close(){this.closed=true;}};}
test('stream closes on project change and late events cannot contaminate current logs',async()=>{
 const streams=[],rows=[];
 const session=create({openStream:()=>{const s=stream();streams.push(s);return s;},query:async()=>{},onRows:r=>rows.push(...r),onStatus:()=>{}});
 await session.tick('one');
 streams[0].listeners.logs({data:JSON.stringify({logs:[{id:2}],cursor:2})});
 await session.tick('two');
 assert.equal(streams[0].closed,true);
 streams[0].listeners.logs({data:JSON.stringify({logs:[{id:3}],cursor:3})});
 assert.deepEqual(rows.map(r=>r.id),[2]);
 session.stop();assert.equal(streams[1].closed,true);
});
test('disconnect queries from durable cursor then reconnects without replay',async()=>{
 const streams=[],queries=[],rows=[];let clock=100;
 const session=create({now:()=>clock,openStream:(id,cursor)=>{const s=stream();s.cursor=cursor;streams.push(s);return s;},query:async(id,cursor)=>{queries.push(cursor);return {logs:[{id:3}],cursor:3};},onRows:r=>rows.push(...r),onStatus:()=>{}});
 await session.tick('one');
 streams[0].listeners.logs({data:JSON.stringify({logs:[{id:2}],cursor:2})});
 streams[0].onerror();
 await session.tick('one');
 assert.deepEqual(queries,[2]);
 clock+=16000;await session.tick('one');
 assert.equal(streams[1].cursor,3);
 streams[1].listeners.logs({data:JSON.stringify({logs:[{id:3},{id:4}],cursor:4})});
 assert.deepEqual(rows.map(r=>r.id),[2,3,4]);
});
test('late fallback query from previous project is ignored',async()=>{
 let resolve;const rows=[];
 const session=create({query:()=>new Promise(r=>{resolve=r;}),onRows:r=>rows.push(...r),onStatus:()=>{}});
 const pending=session.tick('one');session.select('two');
 resolve({logs:[{id:1}],cursor:1});await pending;
 assert.equal(rows.length,0);
 session.stop();
});

test('connecting without an open event falls back after ten seconds',async()=>{
 let clock=100;const current=stream(),queries=[];
 const session=create({now:()=>clock,openStream:()=>current,query:async(id,cursor)=>{queries.push(cursor);return {logs:[],cursor};},onRows:()=>{},onStatus:()=>{}});
 await session.tick('one');clock+=10001;await session.tick('one');
 assert.equal(current.closed,true);assert.deepEqual(queries,[0]);
 session.stop();
});

test('closed connection cannot emit late logs or close its replacement',async()=>{
 let clock=100;const streams=[],rows=[];
 const session=create({now:()=>clock,openStream:()=>{const s=stream();streams.push(s);return s;},query:async(id,cursor)=>({logs:[],cursor}),onRows:r=>rows.push(...r),onStatus:()=>{}});
 await session.tick('one');streams[0].onerror();
 clock+=16000;await session.tick('one');
 streams[0].listeners.logs({data:JSON.stringify({logs:[{id:99}],cursor:99})});
 streams[0].onerror();
 assert.equal(rows.length,0);assert.ok(!streams[1].closed);
 session.stop();
});
