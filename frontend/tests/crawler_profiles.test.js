const test=require('node:test'), assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 const ids=['settingsCrawlerProfileSelect','settingsCrawlerProfileHint','settingsCrawlerNewProfileBtn','settingsCrawlerActivateBtn','settingsFirecrawlApiKey','settingsFirecrawlApiUrl','settingsTestCrawlerBtn','settingsSaveCrawlerBtn','settingsToggleFirecrawlKeyBtn','settingsCrawlerTestMsg','settingsCrawlerStatusBadge'];
 const els=Object.fromEntries(ids.map(id=>[id,{value:'',textContent:'',innerHTML:'',type:'password',dataset:{},setAttribute(){},disabled:false,hidden:false,replaceChildren(...c){this.children=c;},appendChild(c){(this.children??=[]).push(c);}}]));
 const a={profile_id:'default',name:'主账号',version:1,active_profile_id:'default',active_version:2,profiles:[{id:'default',name:'主账号',has_api_key:true},{id:'b',name:'备用',has_api_key:true}],api_url:'https://api.firecrawl.dev/v1/scrape',has_api_key:true,api_key_masked:'fc-••••aaa'};
 a.active_config={has_api_key:true,api_url:a.api_url};
 const b={...a,profile_id:'b',name:'备用',api_key_masked:'fc-••••bbb'};const requests=[],toasts=[];
 const sandbox={window:{confirm:()=>false},document:{getElementById:id=>els[id]||null,createElement:()=>({})},API_BASE:'http://localhost:9503',console,showToast:(...x)=>toasts.push(x),fetch:async(url,o={})=>{requests.push({url,o});return {ok:true,json:async()=>url.endsWith('/session')?{csrf_token:'test-csrf'}:url.endsWith('/test')?{status:'success',message:'连接成功',duration_ms:1,persisted:true}:url.endsWith('/b')?b:a};}};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/settings.js'),'utf8'),sandbox);sandbox.a=a;
 vm.runInContext('settingsState.crawler=a; renderCrawlerSettings(a)',sandbox);
 return {sandbox,els,requests,toasts,a,b,run:s=>vm.runInContext(s,sandbox)};
}
test('selecting a saved account only reads it and does not activate; badge remains active account',async()=>{
 const f=fixture();await f.run("selectCrawlerProfile('b')");assert.equal(f.run('crawlerSelected().name'),'备用');assert.equal(f.els.settingsFirecrawlApiKey.value,'');assert.equal(f.requests.filter(x=>x.o.method==='POST').length,0);assert.match(f.els.settingsCrawlerProfileHint.textContent,/主账号/);assert.equal(f.els.settingsCrawlerActivateBtn.hidden,false);
});
test('dirty edit blocks selection and new account does not inherit existing secret',async()=>{
 const f=fixture();f.els.settingsFirecrawlApiKey.value='fake-draft';await f.run("selectCrawlerProfile('b')");assert.equal(f.requests.length,0);assert.equal(f.els.settingsFirecrawlApiKey.value,'fake-draft');f.sandbox.window.confirm=()=>true;f.run('newCrawlerProfile()');assert.equal(f.els.settingsFirecrawlApiKey.value,'');assert.equal(f.run('crawlerSelected().name'),'账号 1');assert.equal(f.els.settingsCrawlerActivateBtn.disabled,true);
});
test('saving new account uses collection endpoint and does not call activate',async()=>{
 const f=fixture();f.run('newCrawlerProfile()');f.els.settingsFirecrawlApiKey.value='fake-new';await f.run('saveCrawlerSettings()');const req=f.requests.find(x=>x.o.method==='POST'&&x.url.endsWith('/profiles'));assert.ok(req);assert.equal(JSON.parse(req.o.body).name,'账号 1');assert.equal(f.requests.some(x=>x.url.endsWith('/activate')),false);
});
test('inactive account test is version bound and cannot alter active status',async()=>{
 const f=fixture();await f.run("selectCrawlerProfile('b')");await f.run('testCrawlerConnection()');const req=f.requests.find(x=>x.url.endsWith('/test'));assert.equal(JSON.parse(req.o.body).profile_id,'b');assert.equal(JSON.parse(req.o.body).expected_version,1);assert.equal(f.run('settingsState.crawler.last_test_status'),undefined);
});
test('busy operations block account changes and duplicate submissions',async()=>{
 const f=fixture();f.run('crawlerProfilesBusy=true');await f.run("selectCrawlerProfile('b')");await f.run('saveCrawlerSettings()');f.run('newCrawlerProfile()');assert.equal(f.requests.length,0);assert.equal(f.run('crawlerSelected().name'),'主账号');
});
test('compact account controls omit repeated name field and new accounts get a unique name',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 assert.equal(html.includes('id="settingsCrawlerProfileName"'),false);
 const f=fixture();delete f.els.settingsCrawlerProfileName;
 f.run('newCrawlerProfile()');f.els.settingsFirecrawlApiKey.value='fake-second';await f.run('saveCrawlerSettings()');
 const req=f.requests.find(x=>x.o.method==='POST'&&x.url.endsWith('/profiles'));assert.ok(req);assert.match(JSON.parse(req.o.body).name,/^账号 \d+$/);
});
