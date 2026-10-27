/* Explicit portable business drafts only. No providers, sessions or command replay. */
(function(root){
    'use strict';
    const MAX_BYTES=8*1024*1024;
    const LABELS={ai_ecommerce_listing_draft_v1:'Listing 草稿',ai_ecommerce_ads_draft_v1:'广告文案草稿',dtc_saved_typography_templates:'自定义排版模板'};
    const FIELDS={
        ai_ecommerce_listing_draft_v1:['name','points','keywords','region','language','style'],
        ai_ecommerce_ads_draft_v1:['productName','sellingPoints','region','language','theme']
    };
    const ORIGINS=['http://127.0.0.1:9502','http://localhost:9502','null'];
    const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
    const bytes=v=>new TextEncoder().encode(v).length;
    const fail=()=>{throw Error('草稿格式不兼容，或包含不能跨浏览器迁移的临时媒体/内容。原数据未被覆盖。');};
    function tree(v,depth=0,counter={n:0}){
        if(depth>24||++counter.n>20000)fail();
        if(typeof v==='string'){
            if(v.length>MAX_BYTES||/(?:blob:|file:|javascript:)|<\/?[a-z][^>]*>/i.test(v))fail();
        }else if(v!==null&&typeof v==='object'){
            if(!Array.isArray(v)&&!plain(v))fail();
            for(const [k,x] of Object.entries(v)){
                if(/^(?:__proto__|constructor|prototype|api_?key|token|authorization|access_?key(?:_?secret|_?id)?|command_id|submittedHash|uncertain|digest)$/i.test(k))fail();
                tree(x,depth+1,counter);
            }
        }else if(!['number','boolean','object'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))fail();
    }
    function validateValue(key,value){
        if(!Object.hasOwn(LABELS,key)||!plain(value))fail();tree(value);
        if(key==='dtc_saved_typography_templates'){
            if(Object.keys(value).length>100)fail();
            const textFields=['name','id','templateId','fontFamily','titleFont'];
            const cssFields=['titleSize','titleWeight','titleSpacing','subtitleSize','subtitleWeight','bodySize','bodyWeight','bodyLineHeight'];
            for(const [id,config] of Object.entries(value)){
                if(!/^[a-z0-9_-]{1,160}$/i.test(id)||!plain(config))fail();
                for(const [field,val] of Object.entries(config)){
                    if(typeof val!=='string'||val.length>200||!textFields.includes(field)&&!cssFields.includes(field))fail();
                    if(cssFields.includes(field)&&! /^-?\d+(?:\.\d+)?(?:px|em|rem|%)?$/.test(val))fail();
                    if(['id','templateId','fontFamily','titleFont'].includes(field)&&!/^[a-z0-9_-]{1,160}$/i.test(val))fail();
                }
            }
        }else{
            if(Object.keys(value).some(k=>!FIELDS[key].includes(k)))fail();
            if(Object.values(value).some(v=>typeof v!=='string'))fail();
        }
    }
    function validate(input){
        if(typeof input==='string'){if(bytes(input)>MAX_BYTES)fail();input=JSON.parse(input);}
        if(!plain(input)||input.format!=='ai-ecommerce-local-drafts'||input.version!==1||!ORIGINS.includes(input.source_origin)||!plain(input.entries))fail();
        if(Object.keys(input).some(k=>!['format','version','source_origin','entries'].includes(k))||bytes(JSON.stringify(input))>MAX_BYTES)fail();
        for(const [key,value] of Object.entries(input.entries))validateValue(key,value);
        return input;
    }
    function collect(storage,keys=Object.keys(LABELS),sourceOrigin=root.location?.origin||'null'){
        const entries={};
        for(const key of keys){
            if(!Object.hasOwn(LABELS,key))fail();const raw=storage.getItem(key);
            if(raw!==null){if(bytes(raw)>MAX_BYTES)fail();entries[key]=JSON.parse(raw);}
        }
        return validate({format:'ai-ecommerce-local-drafts',version:1,source_origin:sourceOrigin,entries});
    }
    function changes(storage,bundle){
        validate(bundle);const rows=[];
        for(const [key,value] of Object.entries(bundle.entries)){
            const old=storage.getItem(key);let next=value,status='add',added=1,skipped=0;
            if(key==='dtc_saved_typography_templates'){
                const existing=old===null?{}:JSON.parse(old);validateValue(key,existing);
                next={...existing};added=0;
                const names=new Set(Object.values(existing).map(c=>c.name?.trim().toLowerCase()).filter(Boolean));
                for(const [id,config] of Object.entries(value)){
                    const name=config.name?.trim().toLowerCase();
                    if(Object.hasOwn(existing,id)||name&&names.has(name)){skipped++;continue;}
                    next[id]=config;added++;if(name)names.add(name);
                }
                validateValue(key,next);
                status=added?'merge':skipped?'conflict':'empty';
            }else if(old!==null){status=old===JSON.stringify(value)?'same':'conflict';added=0;skipped=1;}
            rows.push({key,label:LABELS[key],status,added,skipped,old,next:JSON.stringify(next)});
        }
        return rows;
    }
    function preview(storage,input){return changes(storage,validate(input)).map(({old,next,...row})=>row);}
    function apply(storage,input){
        // Re-read at click time: a draft typed after preview is never overwritten.
        const rows=changes(storage,validate(input)),written=[];
        try{
            for(const row of rows)if(row.added){storage.setItem(row.key,row.next);written.push(row);}
        }catch{
            for(const row of written.reverse()){
                if(row.old===null)storage.removeItem(row.key);else storage.setItem(row.key,row.old);
            }
            throw Error('本地空间不足或保存失败，已回退本次导入；原草稿保留。');
        }
        return {added:rows.reduce((n,row)=>n+row.added,0),skipped:rows.reduce((n,row)=>n+row.skipped,0)};
    }
    function mount(){
        const panel=root.document?.getElementById('localDraftTransfer');if(!panel)return;
        const status=panel.querySelector('[data-transfer-status]'),summary=panel.querySelector('[data-transfer-preview]');
        const file=panel.querySelector('input[type=file]'),applyButton=panel.querySelector('[data-transfer-apply]');
        let pending=null,reading=0;
        const message=text=>{status.textContent=text;};
        panel.querySelector('[data-transfer-export]').addEventListener('click',()=>{
            try{
                const keys=[...panel.querySelectorAll('input[data-transfer-key]:checked')].map(el=>el.dataset.transferKey);
                const bundle=collect(root.localStorage,keys,root.location.origin);
                if(!Object.keys(bundle.entries).length){message('所选类别没有已保存的草稿或模板。');return;}
                const link=root.document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}));
                link.href=url;link.download='AI-Ecommerce-Local-Drafts-'+Date.now()+'.json';link.click();
                root.setTimeout(()=>URL.revokeObjectURL(url),1000);message('已请求保存迁移文件。请在目标浏览器或客户端选择该文件并预览。');
            }catch{message('未导出：所选草稿可能含临时图片或不兼容内容。请取消该类别后导出其他项；原草稿保留。详情页也可单独导出项目JSON。');}
        });
        panel.querySelector('[data-transfer-select]').addEventListener('click',()=>file.click());
        file.addEventListener('change',async()=>{
            const generation=++reading;pending=null;applyButton.disabled=true;summary.replaceChildren();
            const selected=file.files?.[0];file.value='';if(!selected)return;
            try{
                if(selected.size>MAX_BYTES)fail();const bundle=validate(await selected.text());
                if(generation!==reading)return;
                const rows=preview(root.localStorage,bundle);
                for(const row of rows){
                    const item=root.document.createElement('p');item.textContent=row.label+'：'+({add:'可以导入',merge:'新增 '+row.added+' 个模板；已有同名模板保留',same:'内容相同，跳过',conflict:'已有内容，保留并跳过',empty:'空模板集合，无需导入'}[row.status]);summary.append(item);
                }
                pending=bundle;applyButton.disabled=!rows.some(row=>row.added);message('仅预览，尚未保存。确认后只添加缺少的内容，不自动运行任务。');
            }catch{if(generation===reading)message('文件无法导入：格式、大小或内容不兼容。没有修改当前草稿。');}
        });
        applyButton.addEventListener('click',()=>{
            if(!pending)return;
            try{
                const result=apply(root.localStorage,pending);pending=null;applyButton.disabled=true;
                message('已新增 '+result.added+' 项，跳过 '+result.skipped+' 项。当前页面输入不变；请先保存当前工作，再重新打开应用或页面以恢复导入的草稿。');
            }catch{message('保存失败，本次导入已回退。请检查本地空间；原草稿保留。');}
        });
    }
    const api={MAX_BYTES,LABELS,validate,collect,preview,apply};
    if(typeof module!=='undefined'&&module.exports)module.exports=api;
    if(root.document){if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
})(typeof globalThis!=='undefined'?globalThis:this);
