import { el, button, notify } from './elements.mjs';
import { restoreDraft, safeDraft } from '../services/commands.mjs';
export function fields(entries) { return entries.map(([key,label,type='text',required=true,options])=>({key,label,type,required,options})); }
export function keywordPreview(value) {
    const phrase=String(value||'').replace(/[“”"]/g,' ').replace(/\s+/g,' ').trim();return phrase?`实际搜索："${phrase}"`:'实际搜索：待输入';
}
/** Forms own only DTO drafts; callbacks and DOM stay in this page's closure. */
export function createForm(context, { title, help, defs, initial = {}, key, submit, projectId = context.state.project?.id, version = context.state.project?.version, returnView, successView, onDiscard }) {
    const host=el(context,'section','rw-form-page'),heading=el(context,'h1','',title);heading.tabIndex=-1;
    host.append(heading,el(context,'p','rw-muted',help));
    const form=el(context,'form','rw-form'),error=el(context,'p','rw-error'),note=el(context,'p','rw-muted');error.setAttribute('role','alert');note.setAttribute('role','status');
    const storage=context.context.storage || context.root.ownerDocument.defaultView?.sessionStorage;
    let stored=context.state.drafts[key];
    if(!stored&&storage){try{stored=JSON.parse(storage.getItem(key)||'null');}catch{/* Storage can be unavailable. */}}
    const draft={...restoreDraft(stored||{}),version:Number.isInteger(stored?.version)?stored.version:version},inputs=new Map();context.state.drafts[key]=draft;
    const values=()=>Object.fromEntries([...inputs].map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.value]));
    const persist=()=>{
        if(!context.life.active)return;
        const safe=safeDraft(values(),defs,draft);context.state.drafts[key]={...safe,version:draft.version};
        try{const encoded=JSON.stringify({...safe,version:draft.version});if(new TextEncoder().encode(encoded).length>65536){note.textContent='内容超过草稿上限，当前输入未全部备份；请先保存或复制。';return;}storage?.setItem(key,encoded);}catch{note.textContent='浏览器草稿存储不可用，请先保存或复制输入。';}
    };
    for(const def of defs){
        const wrap=el(context,'label','',def.label),input=el(context,['select','choice'].includes(def.type)?'select':def.type==='textarea'?'textarea':'input');
        input.name=def.key;input.setAttribute('aria-label',def.label);if(input.tagName==='INPUT')input.type=def.type==='array'?'text':def.type==='datetime'?'datetime-local':def.type;input.required=def.required&&def.type!=='checkbox';
        if(['select','choice'].includes(def.type))for(const [value,label] of Object.entries(def.options||{})){const option=el(context,'option','',label);option.value=value;input.append(option);}
        const saved=draft.values[def.key];let value=initial[def.key]??(['select','choice'].includes(def.type)?Object.keys(def.options||{})[0]:'');
        if(!['url','file'].includes(def.type)&&typeof saved==='string'&&saved.length<=10000&&!/https?:\/\//i.test(saved))value=saved;
        if(def.type==='checkbox')input.checked=typeof saved==='boolean'?saved:initial[def.key]===true;else if(def.type==='datetime')input.value=value?new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';else input.value=Array.isArray(value)?value.join('、'):String(value??'');
        if(def.type==='number'){input.min='0';input.step='any';}
        inputs.set(def.key,input);context.life.listen(input,'input',persist);context.life.listen(input,'change',persist);wrap.append(input);form.append(wrap);
    }
    if(inputs.has('text')){const preview=el(context,'p','rw-muted');const update=()=>preview.textContent=keywordPreview(inputs.get('text').value);context.life.listen(inputs.get('text'),'input',update);update();form.append(preview);}
    const save=el(context,'button','rw-primary','保存并继续');save.type='submit';
    const cancel=button(context,'取消',()=>context.navigate(returnView||(context.state.project?'project':'projects')));
    const discard=button(context,'放弃草稿',()=>{
        if(draft.uncertain){error.textContent='保存状态未确认，请先保持原输入重试或刷新核对，不能放弃提交身份。';return;}
        try{storage?.removeItem(key);}catch{}delete context.state.drafts[key];if(onDiscard)onDiscard();else context.openForm({ ...context.state.form, discard:true });
    });
    note.textContent=stored?'已恢复本标签页中未保存的内容；链接和文件需重新填写。':'草稿仅在本标签页保留；不保存链接、文件或含链接的文本。';
    form.append(note,error,save,cancel,discard);host.append(form);
    context.life.listen(form,'submit',async event=>{
        event.preventDefault();if(save.disabled)return;save.disabled=true;cancel.disabled=true;discard.disabled=true;
        try{
            const data={};for(const def of defs){const input=inputs.get(def.key);if(def.type==='checkbox')data[def.key]=input.checked;else if(def.type==='number'){if(input.value!=='')data[def.key]=Number(input.value);}else if(def.type==='array')data[def.key]=input.value.split(/[,，、\n]/).map(x=>x.trim()).filter(Boolean);else if(def.type==='datetime')data[def.key]=input.value?new Date(input.value).toISOString():null;else if(def.type==='file')data[def.key]=input.files?.[0]?await input.files[0].text():'';else if(input.value!==''||def.required)data[def.key]=input.value.trim();}
            persist();await submit(data,draft,persist);
            if(!context.life.active)return;
            try{storage?.removeItem(key);}catch{}delete context.state.drafts[key];notify(context,'已保存。');context.navigate(successView||returnView||(context.state.project?'project':'projects'));
        }catch(err){
            if(!context.life.active)return;error.textContent=err.message;
            if(err.status===409&&projectId){
                try{const project=await context.api.request('/projects/'+encodeURIComponent(projectId),{signal:context.life.signal});
                    if(!context.life.active)return;context.state.project=project;draft.version=project.version;persist();error.textContent+='。背景数据已刷新，草稿仍保留；请核对后再次保存。';
                }catch{if(context.life.active)error.textContent+='。草稿仍保留，但背景刷新未完成。';}
            }else if(!err.status)error.textContent+='。保存状态可能未确认，草稿已保留；请保持原输入重试或刷新核对。';
        }finally{if(context.life.active){save.disabled=false;cancel.disabled=false;discard.disabled=false;}}
    });
    return {host,form,inputs,draft,persist,error};
}
