const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function fixture({delayed=false,failRead=false}={}){
 const doc={activeElement:null};
 class Node extends EventTarget{
  constructor(tag){super();this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.value='';this.disabled=false;this.hidden=false;this.dataset={};this.classList={add(){},remove(){},contains(){return false;}};this.scrollTop=0;}
  append(...items){for(const n of items){n.remove();n.parentElement=this;this.children.push(n);}}
  appendChild(n){this.append(n);return n;}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}}
  insertBefore(n,next){n.remove();n.parentElement=this;const index=this.children.indexOf(next);this.children.splice(index<0?this.children.length:index,0,n);}
  setAttribute(k,v){this.attributes[k]=v;}
  get nextSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1]||null;}
  find(fn){if(fn(this))return this;for(const child of this.children){const n=child.find(fn);if(n)return n;}return null;}
  querySelector(s){return this.find(n=>n.tagName===s.toUpperCase());}
  focus(){doc.activeElement=this;}
  showModal(){this.open=true;}
  close(){this.open=false;this.dispatchEvent(new Event('close'));}
 }
 doc.createElement=t=>new Node(t);doc.body=new Node('body');doc.getElementById=id=>doc.body.find(n=>n.id===id);doc.querySelectorAll=()=>[];
 const add=(parent,id,tag='div')=>{const n=new Node(tag);n.id=id;parent.append(n);return n;};
 const analysis=add(doc.body,'analysisView'),url=add(analysis,'xp-url-input','textarea'),trigger=add(analysis,'xp-btnOpenCrawlerSettings','button');url.value='https://example.test/product';analysis.scrollTop=240;trigger.focus();
 const card=add(doc.body,'settingsCrawlerCard'),header=add(card,'header'),badge=add(header,'settingsCrawlerStatusBadge'),body=add(card,'settingsCrawlerCompetitorBody');
 const key=add(body,'settingsFirecrawlApiKey','input'),apiUrl=add(body,'settingsFirecrawlApiUrl','input');key.type='password';
 add(body,'settingsCrawlerTestMsg');const save=add(body,'settingsSaveCrawlerBtn','button'),check=add(body,'settingsTestCrawlerBtn','button'),eye=add(body,'settingsToggleFirecrawlKeyBtn','button');
 const calls=[],navigations=[],toasts=[];let resolve;
 const response={has_api_key:true,api_key_masked:'fc-••••abc',api_url:'https://api.firecrawl.dev/v1/scrape',last_test_status:'success',last_test_message:'连接成功'};
 const sandbox={document:doc,API_BASE:'http://127.0.0.1:9503',AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console,showToast:(...a)=>toasts.push(a),switchMainTab:v=>navigations.push(v),fetch:async(u,o)=>{calls.push({u,o});if(failRead)throw Error('offline');if(delayed)return new Promise(r=>{resolve=()=>r({ok:true,json:async()=>response});});return {ok:true,json:async()=>response};}};
 sandbox.window=sandbox;vm.createContext(sandbox);
 for(const name of ['settings.js','analysis.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',name),'utf8'),sandbox);
 return {doc,analysis,url,trigger,card,header,badge,body,key,apiUrl,save,check,eye,calls,navigations,toasts,sandbox,resolve:()=>resolve()};
}
test('competitor shortcut opens the sole shared crawler form in a dialog without changing the analysis page',async()=>{
 const f=fixture();await f.sandbox.xp_openCrawlerSettings();
 const dialog=f.doc.body.find(n=>n.tagName==='DIALOG');assert.ok(dialog?.open);assert.equal(dialog.find(n=>n.id==='settingsCrawlerCompetitorBody'),f.body);
 assert.equal(f.body.parentElement===f.card,false);assert.equal(f.badge.parentElement===f.header,false);assert.deepEqual(f.navigations,[]);
 assert.equal(f.url.value,'https://example.test/product');assert.equal(f.analysis.scrollTop,240);assert.equal(f.key.value,'');assert.equal(f.calls.length,1);assert.equal(f.calls[0].o?.method,undefined);
 await f.sandbox.xp_openCrawlerSettings();assert.equal(f.calls.length,1);
 f.sandbox.closeCrawlerSettingsDialog();assert.equal(f.body.parentElement,f.card);assert.equal(f.badge.parentElement,f.header);assert.equal(f.doc.activeElement,f.trigger);assert.equal(f.doc.body.find(n=>n.tagName==='DIALOG'),null);
});
test('escape cannot dismiss a shared save or connection test in progress',async()=>{
 const f=fixture();await f.sandbox.xp_openCrawlerSettings();const dialog=f.doc.body.find(n=>n.tagName==='DIALOG');
 f.check.disabled=true;dialog.dispatchEvent(new Event('cancel',{cancelable:true}));assert.equal(dialog.open,true);
 f.check.disabled=false;f.save.disabled=true;f.sandbox.closeCrawlerSettingsDialog();assert.equal(dialog.open,true);
 f.save.disabled=false;f.eye.disabled=true;f.sandbox.closeCrawlerSettingsDialog();assert.equal(dialog.open,true);
 f.eye.disabled=false;dialog.dispatchEvent(new Event('cancel',{cancelable:true}));assert.equal(f.doc.body.find(n=>n.tagName==='DIALOG'),null);
});
test('a failed initial read blocks accidental save/test but leaves close and retry available',async()=>{
 const f=fixture({failRead:true});await f.sandbox.xp_openCrawlerSettings();assert.equal(f.save.disabled,true);assert.equal(f.check.disabled,true);
 f.sandbox.closeCrawlerSettingsDialog();assert.equal(f.doc.body.find(n=>n.tagName==='DIALOG'),null);assert.equal(f.save.disabled,false);assert.equal(f.body.parentElement,f.card);
});
test('closing during initial read restores shared nodes and ignores the late response',async()=>{
 const f=fixture({delayed:true}),opening=f.sandbox.xp_openCrawlerSettings();
 const dialog=f.doc.body.find(n=>n.tagName==='DIALOG');assert.ok(dialog?.open);f.sandbox.closeCrawlerSettingsDialog();f.resolve();await opening;
 assert.equal(f.body.parentElement,f.card);assert.equal(f.key.value,'');assert.equal(f.apiUrl.value,'');assert.equal(f.doc.body.find(n=>n.tagName==='DIALOG'),null);assert.deepEqual(f.navigations,[]);
});
