const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {EventEmitter}=require('node:events');
const path=require('node:path');

test('fresh customer starts from existing parent before opening browser storage',async()=>{
 const os=require('node:os'),{spawn}=require('node:child_process');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'customer-first-start-'));
 let created=false,started=false,errors=0;
 const app=new EventEmitter();app.setName=()=>{};app.getPath=()=>temp;app.setPath=()=>{};app.requestSingleInstanceLock=()=>true;app.whenReady=()=>Promise.resolve();app.quit=()=>{};
 class Window extends EventEmitter{
  constructor(){super();created=true;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
  async loadFile(){}async loadURL(){}
 }
 class Manager{
  async start(plan){
   assert.equal(created,false,'customer profile must remain unopened until bootstrap and backup complete');
   assert.equal(fs.existsSync(path.join(temp,'AI E-commerce Tools Customer/workspace')),false);
   await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/true',[],{cwd:plan.cwd});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('child failed')));});started=true;
  }
  async stop(){return true;}launch(){}
 }
 const electron={app,BrowserWindow:Window,Menu:{setApplicationMenu(){},buildFromTemplate:v=>v},dialog:{showErrorBox(){errors++;}},shell:{},session:{get defaultSession(){assert.equal(started,true);return {setPermissionRequestHandler(){},setPermissionCheckHandler(){}};}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),{__dirname:temp,process:{resourcesPath:temp},URL,require:name=>name==='electron'?electron:name==='./distribution.cjs'?require('../distribution.cjs'):name==='./package.json'?{distribution:'customer'}:name==='./process-manager.cjs'?{ServiceManager:Manager,makeRuntimePlan:()=>({cwd:path.join(temp,'AI E-commerce Tools Customer/workspace')}),safeExternalUrl:()=>false,allowPermission:()=>false}:require(name)});
 for(let i=0;i<50&&!created&&!errors;i++)await new Promise(resolve=>setTimeout(resolve,10));
 try{assert.equal(started,true);assert.equal(created,true);assert.equal(errors,0);}finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('failed workbench navigation stops owned services and never starts worker',async()=>{
 const app=new EventEmitter();app.setName=()=>{};app.getPath=()=>'/Fixture';app.setPath=()=>{};app.requestSingleInstanceLock=()=>true;app.whenReady=()=>Promise.resolve();app.quit=()=>{};
 let stops=0,workers=0,errors=0;
 class Window extends EventEmitter {
  constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
  async loadFile(){}
  async loadURL(){throw Error('fixture navigation failure');}
 }
 class Manager {async start(){}async stop(){stops++;return true;}launch(){workers++;}}
 const electron={app,BrowserWindow:Window,Menu:{setApplicationMenu(){},buildFromTemplate:v=>v},dialog:{showErrorBox(){errors++;}},shell:{},session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),{__dirname:'/Fixture/Desktop',process:{resourcesPath:'/Fixture/Resources'},require:name=>name==='electron'?electron:name==='./distribution.cjs'?require('../distribution.cjs'):name==='./package.json'?{distribution:'personal'}:name==='node:fs'?{mkdirSync(){}}:name==='./process-manager.cjs'?{ServiceManager:Manager,makeRuntimePlan:()=>({}),safeExternalUrl:()=>false,allowPermission:()=>false}:require(name)});
 await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(stops,1);assert.equal(workers,0);assert.equal(errors,1);
});

test('activation and second launch ignore a destroyed window',async()=>{
 const app=new EventEmitter();app.setName=()=>{};app.getPath=()=>'/Fixture';app.setPath=()=>{};app.requestSingleInstanceLock=()=>true;app.whenReady=()=>Promise.resolve();app.quit=()=>{};
 let instance;
 class Window extends EventEmitter {
  constructor(){super();instance=this;this.dead=false;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
  isDestroyed(){return this.dead;}
  show(){if(this.dead)throw Error('destroyed window');}
  focus(){if(this.dead)throw Error('destroyed window');}
  async loadFile(){}
  async loadURL(){}
 }
 class Manager{async start(){}async stop(){return true;}launch(){}}
 const electron={app,BrowserWindow:Window,Menu:{setApplicationMenu(){},buildFromTemplate:v=>v},dialog:{showErrorBox(){}},shell:{},session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),{__dirname:'/Fixture/Desktop',process:{resourcesPath:'/Fixture/Resources'},require:name=>name==='electron'?electron:name==='./distribution.cjs'?require('../distribution.cjs'):name==='./package.json'?{distribution:'personal'}:name==='node:fs'?{mkdirSync(){}}:name==='./process-manager.cjs'?{ServiceManager:Manager,makeRuntimePlan:()=>({}),safeExternalUrl:()=>false,allowPermission:()=>false}:require(name)});
 await new Promise(setImmediate);instance.dead=true;
 assert.doesNotThrow(()=>app.emit('activate'));
 assert.doesNotThrow(()=>app.emit('second-instance'));
});
