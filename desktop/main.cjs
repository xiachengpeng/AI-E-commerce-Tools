'use strict';
const {app,BrowserWindow,Menu,dialog,shell,session} = require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {ServiceManager,makeRuntimePlan,safeExternalUrl,allowPermission}=require('./process-manager.cjs');
const {distributionPaths}=require('./distribution.cjs');
const distribution=require('./package.json').distribution||'personal';
app.setName(distribution==='customer'?'AI 电商工具箱 · 客户版':'AI 电商工具箱');
const locations=distributionPaths(app.getPath('appData'),distribution);
const data=locations.data;
fs.mkdirSync(locations.root,{recursive:true,mode:0o700});
app.setPath('userData',locations.profile);
const ownsLock=app.requestSingleInstanceLock();
let win,manager,quitting=false,stopping=false,ready=false;
if(!ownsLock){app.quit();}
else {
 const focusWindow=()=>{if(quitting||stopping||!win||win.isDestroyed())return;win.show();win.focus();};
 app.on('second-instance',focusWindow);
 app.on('window-all-closed',()=>{});
 app.on('activate',focusWindow);
 app.on('before-quit',event=>{
  if(quitting)return;event.preventDefault();if(stopping)return;stopping=true;
  void (async()=>{
   if(ready){const choice=await dialog.showMessageBox(win,{type:'question',buttons:['取消','退出应用'],defaultId:0,cancelId:0,message:'退出本地工作台？',detail:'本地任务会随应用停止。正在提交的操作可能尚未返回结果，重新打开后请先核对任务状态，不要重复提交。'});if(choice.response!==1){stopping=false;return;}}
   const stopped=await manager?.stop();
   if(stopped===false){dialog.showErrorBox('任务仍在结束中','应用未强制终止任务。请稍后再次退出，并在重新运行前核对任务状态。');stopping=false;return;}
   quitting=true;app.quit();
  })();
 });
 app.whenReady().then(async()=>{
  if(stopping||quitting)return;
  manager=new ServiceManager({onFailure:mode=>{if(ready&&!quitting&&!stopping){win.show();if(mode==='worker')dialog.showErrorBox('后台任务未能运行','工作台仍可查看。请核对任务配置和状态，不要重复提交采集或同步。');else{ready=false;dialog.showErrorBox('本地服务已停止','已有数据保留。请退出后重新打开；重新提交前先核对任务状态。');}}}});
  const resources=app.isPackaged?process.resourcesPath:path.dirname(__dirname);
  const plan=makeRuntimePlan({packaged:app.isPackaged,resources,data,source:path.dirname(__dirname)});
  if(distribution==='customer')plan.cwd=locations.root;
  try {
   // Prepare/backup before defaultSession opens the customer browser storage.
   if(distribution==='customer')await manager.start(plan);
   if(stopping||quitting)return;
  session.defaultSession.setPermissionRequestHandler((wc,permission,callback)=>callback(wc===win?.webContents&&allowPermission(permission,wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc,permission,origin)=>wc===win?.webContents&&allowPermission(permission,origin));
  win=new BrowserWindow({width:1440,height:1000,minWidth:900,minHeight:640,backgroundColor:'#f7f9ff',title:'AI 电商工具箱',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});
  win.on('closed',()=>{win=null;ready=false;});
  win.webContents.setWindowOpenHandler(({url})=>{if(safeExternalUrl(url))void shell.openExternal(url);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!=='http://127.0.0.1:9502'){event.preventDefault();if(safeExternalUrl(url))void shell.openExternal(url);}});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:app.name,submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{label:'显示工作台',click:()=>win.show()}]}]));
   await win.loadFile(path.join(__dirname,'startup.html'));
   if(stopping||quitting)return;
   if(distribution!=='customer')await manager.start(plan);
   if(stopping||quitting)return;
   await win.loadURL('http://127.0.0.1:9502/index.html');
   if(stopping||quitting)return;
   ready=true;
   // Disabled/unconfigured workers exit without touching external queues.
   manager.launch(plan,'worker');
  } catch(error){
   await manager.stop();
   if(stopping||quitting)return;
   const detail=error.message==='PORT_IN_USE'?'9502或9503端口已被其他程序使用。请先正常停止原浏览器版服务，再重新打开客户端。客户端不会结束其他程序。':'本地服务未能就绪。请核对安装资源和用户数据目录；现有数据未被自动迁移或覆盖。';
   dialog.showErrorBox('工作台暂时无法启动',detail);
  }
 });
}
