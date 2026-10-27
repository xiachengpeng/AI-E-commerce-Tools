'use strict';
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');

async function portsAvailable(ports=[9502,9503]) {
 for (const port of ports) await new Promise((resolve,reject)=>{
  const server=net.createServer();server.once('error',()=>reject(new Error('PORT_IN_USE')));
  server.listen({port,host:'127.0.0.1',exclusive:true},()=>server.close(resolve));
 });
}
function safeExternalUrl(value) {
 try {const u=new URL(value);const host=u.hostname.toLowerCase();return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!['localhost','[::1]','::1','0.0.0.0'].includes(host)&&!host.startsWith('127.')&&!host.endsWith('.localhost');}
 catch {return false;}
}
function allowPermission(permission,value) {
 try {return permission==='clipboard-sanitized-write'&&new URL(value).origin==='http://127.0.0.1:9502';}
 catch {return false;}
}
function makeRuntimePlan({packaged,resources,data,source,env=process.env}) {
 if (![resources,data,source].every(v=>path.isAbsolute(v))) throw Error('Runtime paths must be absolute');
 const clean={};for(const key of ['HOME','TMPDIR','LANG','LC_ALL','PATH','SSL_CERT_FILE','SSL_CERT_DIR'])if(env[key])clean[key]=env[key];
 const command=packaged?path.join(resources,'backend','ai-ecommerce-backend'):path.join(source,'.venv','bin','python');
 return {command,cwd:data,env:clean,args(mode){
  if(!['api','frontend','worker'].includes(mode))throw Error('Invalid runtime mode');
  return [...(packaged?[]:[path.join(source,'backend','desktop_entry.py')]),'--mode',mode,'--data-dir',data,'--resources-dir',resources];
 }};
}
async function waitReady(child,port,route,timeout=45000) {
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(child.spawnError)throw Error('SERVICE_START_FAILED');
  if(child.exitCode!==null||child.signalCode)throw Error('SERVICE_EXITED');
  const ok=await new Promise(resolve=>{
   const req=http.get({hostname:'127.0.0.1',port,path:route,timeout:800},res=>{res.resume();resolve(res.statusCode===200);});
   req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());
  });
  if(ok)return;
  await new Promise(r=>setTimeout(r,150));
 }
 throw Error('SERVICE_TIMEOUT');
}
class ServiceManager {
 constructor(options={}){this.children=new Map();this.spawn=options.spawn||spawn;this.portCheck=options.portCheck||portsAvailable;this.waitReady=options.waitReady||waitReady;this.stopTimeoutMs=options.stopTimeoutMs??12000;this.onFailure=options.onFailure||(()=>{});this.stopping=false;}
 launch(plan,mode){
  if(this.stopping)throw Error('START_CANCELLED');
  const child=this.spawn(plan.command,plan.args(mode),{cwd:plan.cwd,env:plan.env,stdio:'ignore',shell:false});
  this.children.set(mode,child);
  child.once('error',()=>{child.spawnError=true;this.children.delete(mode);this.onFailure(mode);});
  child.once('exit',code=>{this.children.delete(mode);if(!this.stopping&&(mode!=='worker'||code!==0))this.onFailure(mode);});
  return child;
 }
 async start(plan){
  if(this.stopping)throw Error('START_CANCELLED');
  await this.portCheck();
  if(this.stopping)throw Error('START_CANCELLED');
  try {
   await this.waitReady(this.launch(plan,'api'),9503,'/config');
   if(this.stopping)throw Error('START_CANCELLED');
   await this.waitReady(this.launch(plan,'frontend'),9502,'/index.html');
   if(this.stopping)throw Error('START_CANCELLED');
  } catch(error){if(!this.stopping)await this.stop();throw error;}
 }
 async stop(){
  this.stopping=true;
  for(const [mode,child] of [...this.children].reverse()){
   if(child.exitCode!==null){this.children.delete(mode);continue;}
   const exited=new Promise(resolve=>{const done=()=>{clearTimeout(timer);child.removeListener('exit',done);resolve(true);};const timer=setTimeout(()=>{child.removeListener('exit',done);resolve(false);},this.stopTimeoutMs);child.once('exit',done);});
   child.kill('SIGTERM');if(await exited)this.children.delete(mode);else return false;
  }
  return true;
 }
}
module.exports={portsAvailable,makeRuntimePlan,ServiceManager,safeExternalUrl,waitReady,allowPermission};
