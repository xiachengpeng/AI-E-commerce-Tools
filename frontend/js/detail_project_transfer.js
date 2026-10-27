/* Portable detail data, never a task/command importer. No external media fetches. */
(function(root){
    'use strict';
    const MAX_BYTES=64*1024*1024,IMAGE_BYTES=8*1024*1024;
    const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
    const bytes=s=>new TextEncoder().encode(s).length;
    function fail(message='项目格式或内容不兼容。原草稿和历史未被覆盖。'){throw Error(message);}
    function fields(obj,allowed){if(!plain(obj)||Object.keys(obj).some(k=>!allowed.includes(k)))fail();}
    function text(s){if(typeof s!=='string'||s.length>100000||/<\/?[a-z][^>]*>|(?:javascript|vbscript|file):|\bon[a-z]+\s*=/i.test(s))fail();return s;}
    function scan(v,depth=0,count={n:0}){
        if(v===undefined)return; // Internal snapshots contain optional unset properties; JSON omits them.
        if(depth>20||++count.n>25000)fail();
        if(typeof v==='string'){if(!v.startsWith('data:image/'))text(v);}
        else if(v!==null&&typeof v==='object'){
            if(!Array.isArray(v)&&!plain(v))fail();
            for(const [k,x] of Object.entries(v)){
                if(/^(?:__proto__|prototype|constructor|api_?key|token|authorization|password|secret|credentials|service_?account|private_?key|access_?token|access_?key(?:_?secret|_?id)?|commands?|command_?id|on[a-z]+|submittedHash)$/i.test(k))fail();scan(x,depth+1,count);
            }
        }else if(!['number','boolean','object'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))fail();
    }
    function identifier(v){if(typeof v!=='string'||!/^[a-z0-9_-]{1,160}$/i.test(v))fail();return v;}
    const uuid=()=>{if(!root.crypto?.randomUUID)fail('当前环境不支持安全项目标识，请从本地服务或客户端打开。');return root.crypto.randomUUID();};
    const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o[k]!==undefined).map(k=>[k,structuredClone(o[k])]));
    const PROJECT=['kind','version','transferProjectId','channel','productName','sellingPoints','productFacts','rawProductFacts','verifiedFacts','forbiddenClaims','config','layoutStyle','brandColor','customBrandColor','typography','trustBarEnabled','presentationMode','uploadedImages','modules','longImageOrder','finalImage'];
    const MODULE=['id','moduleId','title','subtitle','displayTitle','prompt','variant','totalVariants','includeText','status','error','repaintPrompt','imageSrc','originalImageSrc','seo','dtcCopy'];
    const CONFIG=['imageStyle','imageStyleLabel','imageStyleIsCustom','platform','platformLabel','region','regionLabel','marketTone','language','languageLabel','aspectRatio','marketingTheme','marketingThemeLabel','productType','productName','productFacts','rawProductFacts','verifiedFacts','forbiddenClaims','strictProductLock','targetChannel'];
    const FACTS=['productName','category','material','color','dimensions','weight','warranty','returnPolicy','rawUserText','rawUserTextSource','packageContents','confirmedFeatures','unsupportedClaims','hasInternalCadOrTeardown','verifiedReviews'];
    const FACT=['value','source','verified','confidence','length','width','height','unit'];
    const COPY=['tagline','headline','subheadline','fbr','steps','faqs','items','bundleComparison','packageIncludes','specifications','trustBadges'];
    function facts(v){
        fields(v,FACTS);
        for(const [k,x] of Object.entries(v)){
            if(['productName','category','material','color','dimensions','weight','warranty','returnPolicy'].includes(k)){
                fields(x,FACT);if(x.verified!==undefined&&typeof x.verified!=='boolean')fail();
                if(Object.values(x).some(a=>a!==null&&!['string','number','boolean'].includes(typeof a)))fail();
            }else if(['packageContents','confirmedFeatures','unsupportedClaims','verifiedReviews'].includes(k)){
                if(!Array.isArray(x)||x.length>200)fail();
                for(const item of x){if(typeof item==='string')text(item);else {fields(item,['value','source','verified','confidence','text','author','rating','name','count','desc']);if(item.verified!==undefined&&typeof item.verified!=='boolean')fail();if(Object.values(item).some(a=>a!==null&&!['string','number','boolean'].includes(typeof a)))fail();}}
            }else if(k==='hasInternalCadOrTeardown'){if(typeof x!=='boolean')fail();}else text(x);
        }
    }
    function copy(v){
        fields(v,COPY);
        for(const [k,x] of Object.entries(v)){
            if(['tagline','headline','subheadline'].includes(k)){text(x);continue;}
            if(k==='bundleComparison'){fields(x,['singleItemsTotal','bundlePrice','savingsText','perks']);for(const [a,b] of Object.entries(x)){if(a==='perks'){if(!Array.isArray(b))fail();b.forEach(text);}else text(b);}continue;}
            if(!Array.isArray(x)||x.length>100)fail();
            const allowed={fbr:['feature','benefit','result'],steps:['step','title','instruction'],faqs:['q','a'],items:['name','count','desc'],specifications:['label','value']};
            for(const item of x){if(allowed[k]){fields(item,allowed[k]);for(const [a,b] of Object.entries(item)){if(a==='step'){if(!Number.isInteger(b)||b<1||b>100)fail();}else text(b);}}else text(item);}
        }
    }
    function typography(v){
        const ids=['templateId','fontFamily','titleFont'],nums=['titleSize','titleWeight','titleSpacing','subtitleSize','subtitleWeight','bodySize','bodyWeight','bodyLineHeight'];fields(v,[...ids,...nums]);
        for(const [k,x] of Object.entries(v)){if(ids.includes(k))identifier(x);else if(typeof x!=='string'||! /^-?\d+(?:\.\d+)?(?:px|em|rem|%)?$/.test(x))fail();}
    }
    function imageBytes(value){
        const m=typeof value==='string'&&/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!m||m[2].length%4!==0||m[2].length>Math.ceil(IMAGE_BYTES/3)*4)fail('图片无效或超过 8 MiB；未改动原资料。');
        let raw;try{raw=root.atob(m[2]);}catch{fail();}if(raw.length>IMAGE_BYTES)fail();
        const a=Uint8Array.from(raw,c=>c.charCodeAt(0));
        const magic=m[1]==='png'?a.slice(0,8).join(',')==='137,80,78,71,13,10,26,10':m[1]==='jpeg'?a[0]===255&&a[1]===216&&a[2]===255:String.fromCharCode(...a.slice(0,4))==='RIFF'&&String.fromCharCode(...a.slice(8,12))==='WEBP';
        if(!magic)fail('图片内容与格式不符；未改动原资料。');return {data:a,type:'image/'+m[1]};
    }
    function mediaValues(p){return [p.finalImage,...p.uploadedImages.map(i=>i.base64),...p.modules.flatMap(m=>[m.imageSrc,m.originalImageSrc])].filter(Boolean);}
    async function decodeAll(p){
        if(typeof root.createImageBitmap!=='function')fail('当前环境无法校验图片，请在客户端或支持图片解码的浏览器操作。');
        for(const value of new Set(mediaValues(p))){
            const {data,type}=imageBytes(value);let bitmap;
            try{bitmap=await root.createImageBitmap(new Blob([data],{type}));if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>64000000)fail();}
            catch{fail('图片已失效、无法解码或尺寸过大；原资料未改动。');}finally{bitmap?.close();}
        }
    }
    function validatePortableDetailProject(input){
        if(typeof input==='string'){if(bytes(input)>MAX_BYTES)fail('项目文件超过 64 MiB。');input=JSON.parse(input);}
        if(bytes(JSON.stringify(input))>MAX_BYTES)fail('项目文件超过 64 MiB。');scan(input);
        fields(input,['kind','version','project','warnings']);if(input.kind!=='detail-page-transfer'||input.version!==1)fail();
        if(!Array.isArray(input.warnings)||input.warnings.length>100)fail();input.warnings.forEach(text);
        const p=input.project;fields(p,PROJECT);if(p.kind!=='detail-page-project'||p.version!==2)fail();identifier(p.transferProjectId);
        if(!Array.isArray(p.modules)||p.modules.length>100||!Array.isArray(p.uploadedImages)||p.uploadedImages.length>6||!Array.isArray(p.longImageOrder))fail();
        const ids=new Set();for(const m of p.modules){fields(m,MODULE);identifier(m.id);identifier(m.moduleId);if(ids.has(m.id))fail();ids.add(m.id);
            if(typeof m.includeText!=='boolean'||!['pending','success','partial_success','error','cancelled'].includes(m.status))fail();
            if(m.seo){fields(m.seo,['titleTarget','titleZh','altTarget','altZh','title','alt','seoTitle','altText']);for(const x of Object.values(m.seo)){if(plain(x)){fields(x,['target','zh']);Object.values(x).forEach(text);}else text(x);}}
            if(m.dtcCopy!==undefined&&m.dtcCopy!==null)copy(m.dtcCopy);
            for(const k of ['title','subtitle','displayTitle','prompt','error','repaintPrompt'])if(m[k]!==undefined)text(m[k]);
            for(const k of ['variant','totalVariants'])if(m[k]!==undefined&&(!Number.isInteger(m[k])||m[k]<0||m[k]>100))fail();
        }
        if(new Set(p.longImageOrder).size!==p.longImageOrder.length||p.longImageOrder.some(id=>!ids.has(id)))fail();
        for(const i of p.uploadedImages){fields(i,['id','name','base64','mimeType','isPrimary','role','semanticRole','isUserAssigned']);identifier(i.id);for(const k of ['name','mimeType','role','semanticRole'])if(i[k]!==undefined)text(i[k]);for(const k of ['isPrimary','isUserAssigned'])if(i[k]!==undefined&&typeof i[k]!=='boolean')fail();if(!i.base64)fail();}
        fields(p.config,CONFIG);if(p.config.verifiedFacts)facts(p.config.verifiedFacts);
        if(p.verifiedFacts)facts(p.verifiedFacts);
        if(p.productName && p.verifiedFacts?.productName?.value!==p.productName)fail('产品名称与事实来源不一致，请在源项目核对后导出。');
        if(p.typography)typography(p.typography);
        if(p.config.aspectRatio&&!/^\d{1,5}(?:\.\d+)?:\d{1,5}(?:\.\d+)?$/.test(p.config.aspectRatio))fail();
        if(p.customBrandColor&&!/^#[0-9a-f]{6}$/i.test(p.customBrandColor))fail();
        if(p.layoutStyle&&!['editorial','minimalist','bento','lookbook','technical'].includes(p.layoutStyle))fail();
        if(p.brandColor&&!['indigo','orange','emerald','rose','cyan','slate','amber','custom'].includes(p.brandColor))fail();
        if(p.presentationMode&&!['modules','hybrid','images','gallery'].includes(p.presentationMode))fail();
        if(p.channel&&!['shopify','amazon','social','generic','general','universal'].includes(p.channel))fail();
        if(p.trustBarEnabled!==undefined&&typeof p.trustBarEnabled!=='boolean')fail();
        for(const k of ['productName','sellingPoints','productFacts','rawProductFacts','forbiddenClaims'])if(p[k]!==undefined)text(p[k]);
        for(const [k,v] of Object.entries(p.config))if(k!=='verifiedFacts'&&!['string','boolean'].includes(typeof v))fail();
        mediaValues(p).forEach(imageBytes);return structuredClone(input);
    }
    async function defaultMediaReader(url){
        let resolved;
        if(url.startsWith('blob:')){if(!url.startsWith('blob:'+root.location?.origin+'/'))fail();resolved=url;}
        else {
            const base=root.location?.origin||'null';
            const relativeStatic=/^\/?static\//.test(url);
            const u=new URL(url,relativeStatic?'http://127.0.0.1:9503/':base==='null'?'http://127.0.0.1:9503':base);
            if(![base,'http://127.0.0.1:9503','http://localhost:9503'].includes(u.origin)||u.username||u.password||!/^\/static\/(?:outputs|uploads)\/[a-zA-Z0-9_.\/-]+$/.test(u.pathname)||u.search||u.hash||u.pathname.split('/').includes('..'))fail('存在非本地图片，未自动访问外部来源。请先在原项目中保存图片。');resolved=u.href;
        }
        const response=await root.fetch(resolved,{redirect:'error',credentials:'same-origin'});if(!response.ok)fail('原图片已失效，请保留源草稿并补齐图片后重试。');
        if(Number(response.headers.get('content-length'))>IMAGE_BYTES)fail();
        const reader=response.body.getReader(),chunks=[];let size=0;
        try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>IMAGE_BYTES)fail();chunks.push(value);}}finally{await reader.cancel();}
        const blob=new Blob(chunks,{type:response.headers.get('content-type')||''});
        return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob);});
    }
    function remap(p){
        const map=new Map();for(const m of p.modules){const old=m.id;m.id='section_'+uuid().replaceAll('-','');map.set(old,m.id);}
        p.longImageOrder=p.longImageOrder.map(id=>{if(!map.has(id))fail();return map.get(id);});p.transferProjectId=uuid();
        p.uploadedImages.forEach(i=>{i.id='asset_'+uuid().replaceAll('-','');});return p;
    }
    async function buildPortableDetailProject(source,mediaReader=defaultMediaReader){
        if(!plain(source)||bytes(JSON.stringify(source))>MAX_BYTES)fail();scan(source);
        const studio=source.kind===undefined;if(!studio&&(source.kind!=='detail-page-project'||source.version!==2))fail();
        fields(source,studio?['channel','layoutStyle','brandColor','customBrandColor','typography','productFacts','tasks','longImageOrder','productName','sellingPoints','language','savedAt','uploadedImages','config']:PROJECT);
        const warnings=[];const p=pick(source,PROJECT);p.kind='detail-page-project';p.version=2;p.config=pick(source.config||{},CONFIG);
        p.modules=[];p.uploadedImages=[];
        if(studio){if(!Array.isArray(source.tasks))fail();p.verifiedFacts=source.productFacts||{};delete p.productFacts;warnings.push('旧草稿的执行和上传状态不迁移，已有成果保留，未完成模块需手动继续。');}
        if(studio&&source.language&&!p.config.language)p.config.language=source.language;
        p.productName=p.productName||p.config.productName||'';p.verifiedFacts=p.verifiedFacts||{};
        if(p.productName&&!p.verifiedFacts.productName)p.verifiedFacts.productName={value:p.productName,source:'unknown',verified:false};
        if(p.config.verifiedFacts)p.config.verifiedFacts=structuredClone(p.verifiedFacts);
        if(studio&&!source.uploadedImages?.length)warnings.push('旧版草稿没有保存原图，仅迁移已记录的文字与模块成果；请保留源浏览器中的原图。');
        const modules=studio?source.tasks:source.modules;if(!Array.isArray(modules)||modules.length>100)fail();
        for(const mod of modules){
            const old=studio?(mod.uniqueId||mod.id):mod.id;identifier(old);
            const m=pick(mod,MODULE);m.id=old;m.moduleId=mod.moduleId||(studio?mod.id:old.split('_')[0]);identifier(m.moduleId);
            m.includeText=mod.includeText!==false;m.status=mod.imageSrc?'success':'pending';
            if(['error','failed','cancelled'].includes(mod.status))m.status=mod.status==='failed'?'error':mod.status;
            if(mod.remoteImageUrl||mod.remoteImageUrls)warnings.push('云端上传状态不迁移，本地成果图保留。');p.modules.push(m);
        }
        p.longImageOrder=source.longImageOrder?.length?[...source.longImageOrder]:p.modules.map(m=>m.id);
        for(const img of source.uploadedImages||[]){const i=pick(img,['id','name','base64','mimeType','isPrimary','role','semanticRole','isUserAssigned']);i.id=img.id||'asset_'+p.uploadedImages.length;i.base64=img.base64||img.imageSrc||'';p.uploadedImages.push(i);}
        const cache=new Map();async function embed(value){if(!value)return '';if(cache.has(value))return cache.get(value);let result;
            try{result=value.startsWith('data:')?value:await mediaReader(value);}catch{fail('原图片无法读取，未生成不完整迁移包；请保留源草稿并补齐图片后重试。');}
            imageBytes(result);cache.set(value,result);return result;
        }
        for(const i of p.uploadedImages)i.base64=await embed(i.base64);
        for(const m of p.modules){m.imageSrc=await embed(m.imageSrc);m.originalImageSrc=await embed(m.originalImageSrc);}
        p.finalImage=await embed(p.finalImage);remap(p);
        const result=validatePortableDetailProject({kind:'detail-page-transfer',version:1,project:p,warnings:[...new Set(warnings)]});await decodeAll(result.project);return result;
    }
    async function restorePortableDetailProject(input){
        const bundle=validatePortableDetailProject(input);await decodeAll(bundle.project);const p=remap(bundle.project);
        if(typeof root.saveToHistory!=='function')fail('历史服务尚未就绪，未导入。');
        const ok=await root.saveToHistory('render',{name:(p.productName||'详情页')+'（导入副本）',style:p.layoutStyle||'editorial',image:p.finalImage||p.modules.find(m=>m.imageSrc)?.imageSrc||p.uploadedImages[0]?.base64||'',metadata:p});
        if(!ok)fail('项目副本未保存成功，请重试；源文件和当前编辑内容保留。');
        return {projectId:p.transferProjectId,warnings:bundle.warnings};
    }
    function mount(){
        const panel=root.document?.getElementById('detailProjectTransfer');if(!panel)return;
        const file=panel.querySelector('input[type=file]'),status=panel.querySelector('[data-detail-status]'),apply=panel.querySelector('[data-detail-import]');let pending=null,serial=0,busy=false;
        panel.querySelector('[data-detail-export]').addEventListener('click',async()=>{if(busy)return;busy=true;
            try{const current=root.collectDetailTransferSource?.()||root.collectCurrentRenderProject?.('');const draft=current||JSON.parse(root.localStorage.getItem('dtc_studio_current_draft')||'null');if(!draft)fail('没有可导出的详情资料，请先上传图片或填写产品资料。');
                const bundle=await buildPortableDetailProject(draft),url=URL.createObjectURL(new Blob([JSON.stringify(bundle)],{type:'application/json'})),a=root.document.createElement('a');a.href=url;a.download='AI-Detail-Project-'+Date.now()+'.json';a.click();root.setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='已请求保存含图片的项目文件。'+bundle.warnings.join(' ');
            }catch(e){status.textContent=e.message;}finally{busy=false;}
        });
        panel.querySelector('[data-detail-select]').addEventListener('click',()=>{if(!busy)file.click();});
        file.addEventListener('change',async()=>{const seq=++serial;pending=null;apply.disabled=true;const selected=file.files?.[0];file.value='';if(!selected)return;
            try{if(selected.size>MAX_BYTES)fail('项目文件超过 64 MiB。');const raw=JSON.parse(await selected.text()),bundle=raw.kind==='detail-page-transfer'?validatePortableDetailProject(raw):await buildPortableDetailProject(raw);await decodeAll(bundle.project);if(seq!==serial)return;pending=bundle;status.textContent=`仅预览：${bundle.project.productName||'未命名项目'}，${bundle.project.uploadedImages.length} 张原图、${bundle.project.modules.length} 个模块。确认后另存历史，不覆盖当前编辑内容。${bundle.warnings.join(' ')}`;apply.disabled=false;
            }catch(e){if(seq===serial)status.textContent=e.message;}
        });
        apply.addEventListener('click',async()=>{if(!pending||busy)return;busy=true;apply.disabled=true;try{await restorePortableDetailProject(pending);pending=null;status.textContent='已另存详情页历史。可从历史记录打开副本；没有运行生成或上传。';}catch(e){status.textContent=e.message;apply.disabled=false;}finally{busy=false;}});
    }
    const api={buildPortableDetailProject,validatePortableDetailProject,restorePortableDetailProject};
    if(typeof module!=='undefined'&&module.exports)module.exports=api;Object.assign(root,api);
    if(root.document){if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',mount);else mount();}
})(typeof globalThis!=='undefined'?globalThis:this);
