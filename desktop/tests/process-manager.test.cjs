const {test} = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {EventEmitter} = require('node:events');
const {portsAvailable,makeRuntimePlan,ServiceManager,safeExternalUrl} = require('../process-manager.cjs');

test('occupied port is refused without touching its owner',async()=>{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {await assert.rejects(portsAvailable([server.address().port]),/PORT_IN_USE/);assert.equal(server.listening,true);}
 finally {await new Promise(r=>server.close(r));}
});
test('packaged executable uses explicit modes, isolated state and no source credentials',()=>{
 const p=makeRuntimePlan({packaged:true,resources:'/App Resources',data:'/User Data',source:'/Source',env:{HOME:'/Users/test',GEMINI_API_KEY:'must-not-pass',SQLITE_DB_PATH:'/live.db'}});
 assert.equal(p.command,'/App Resources/backend/ai-ecommerce-backend');
 assert.deepEqual(p.args('api'),['--mode','api','--data-dir','/User Data','--resources-dir','/App Resources']);
 assert.equal(p.env.GEMINI_API_KEY,undefined);assert.equal(p.env.SQLITE_DB_PATH,undefined);
 assert.throws(()=>p.args('shell'),/mode/i);
});
test('external navigation allows web URLs only and rejects credentials/local hosts',()=>{
 assert.equal(safeExternalUrl('https://example.com/product'),true);
 for(const u of ['javascript:alert(1)','file:///etc/passwd','https://a:b@example.com','http://127.0.0.1:22','https://localhost/a','https://[::1]/'])assert.equal(safeExternalUrl(u),false,u);
});
test('shutdown is owned, graceful and never escalates unknown worker outcome',async()=>{
 let kills=[];const child=new EventEmitter();child.exitCode=null;child.kill=s=>{kills.push(s);};
 const mgr=new ServiceManager({stopTimeoutMs:5});mgr.children.set('worker',child);
 assert.equal(await mgr.stop(),false);assert.deepEqual(kills,['SIGTERM']);assert.equal(mgr.children.size,1);
 child.exitCode=0;child.emit('exit',0);assert.equal(await mgr.stop(),true);
});
test('startup failure cleans up already launched children',async()=>{
 const child=new EventEmitter();child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
 let count=0;
 const mgr=new ServiceManager({portCheck:async()=>{},waitReady:async()=>{throw Error('not ready');},spawn:()=>{count++;return child;}});
 await assert.rejects(mgr.start({command:'fixture',args:m=>[m],env:{},cwd:'/tmp'}),/not ready/);
 assert.equal(count,1);assert.equal(mgr.children.size,0);
});
test('clipboard permissions are limited to current workbench sanitized writes',()=>{
 const {allowPermission}=require('../process-manager.cjs');
 assert.equal(allowPermission('clipboard-sanitized-write','http://127.0.0.1:9502/index.html'),true);
 for(const p of ['clipboard-read','camera','microphone','geolocation'])assert.equal(allowPermission(p,'http://127.0.0.1:9502/index.html'),false);
 for(const u of ['http://evil.example','http://127.0.0.1:9503','file:///tmp/a','http://127.0.0.1:9502.evil.example'])assert.equal(allowPermission('clipboard-sanitized-write',u),false);
});
test('spawn failure is reported without waiting for a health timeout',async()=>{
 const {waitReady}=require('../process-manager.cjs');
 const child={exitCode:null,spawnError:true};
 await assert.rejects(waitReady(child,1,'/config',100),/SERVICE_START_FAILED/);
});
test('disabled worker exit is quiet but a crashed worker is reported',()=>{
 let failures=[];let next;
 const manager=new ServiceManager({spawn:()=>next,onFailure:mode=>failures.push(mode)});
 next=new EventEmitter();next.exitCode=null;manager.launch({command:'fixture',args:()=>[],env:{},cwd:'/tmp'},'worker');next.emit('exit',0);
 assert.deepEqual(failures,[]);
 next=new EventEmitter();next.exitCode=null;manager.launch({command:'fixture',args:()=>[],env:{},cwd:'/tmp'},'worker');next.emit('exit',1);
 assert.deepEqual(failures,['worker']);
});
test('quit during startup cannot create a later service or worker',async()=>{
 let release,entered;const blocked=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);let modes=[];
 const manager=new ServiceManager({portCheck:async()=>{},waitReady:async()=>{entered();await blocked;},spawn:(_c,args)=>{modes.push(args[0]);const child=new EventEmitter();child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0);};return child;}});
 const starting=manager.start({command:'fixture',args:m=>[m],env:{},cwd:'/tmp'});
 await waiting;assert.equal(await manager.stop(),true);release();
 await assert.rejects(starting,/START_CANCELLED/);
 assert.deepEqual(modes,['api']);assert.equal(manager.children.size,0);
 assert.throws(()=>manager.launch({command:'fixture',args:m=>[m]},'worker'),/START_CANCELLED/);
});
