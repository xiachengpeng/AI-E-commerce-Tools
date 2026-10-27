import { el, button, notify } from './elements.mjs';
import { restoreDraft, safeDraft } from '../services/commands.mjs';
import {formSection,icon} from './presentation.mjs';
import {formPreview} from './form-preview.mjs';
export function fields(entries) { return entries.map(([key,label,type='text',required=true,options])=>({key,label,type,required,options})); }
export function keywordPreview(value) {
    const phrase=String(value||'').replace(/[“”"]/g,' ').replace(/\s+/g,' ').trim();return phrase?`实际搜索："${phrase}"`:'实际搜索：待输入';
}
/** Forms own only DTO drafts; callbacks and DOM stay in this page's closure. */
export function createForm(context, { title, help, defs, initial = {}, key, submit, projectId = context.state.project?.id, version = context.state.project?.version, returnView, successView, onDiscard, onCancel, onSaved }) {
    const host=el(context,'section','rw-form-page'),heading=el(context,'h1','',title);heading.tabIndex=-1;
    host.dataset.formTitle=title;
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
    if(defs.length>=8)form.classList.add('rw-form-grid');
    const groups=new Map();let validateSections=null;
    for(const def of defs){
        let parent=form;
        const section=formSection(def,title);
        if(section){if(!groups.has(section)){const group=el(context,'fieldset','rw-field-group');group.dataset.formGroup=section;group.append(el(context,'legend','',section));groups.set(section,group);form.append(group);}parent=groups.get(section);}
        const decisionChoices=def.key==='pool'&&title==='做出人工决策';
        const wrap=el(context,decisionChoices?'fieldset':'label',def.type==='checkbox'?'rw-check-field':def.type==='textarea'?'rw-field-wide':'',decisionChoices?'选择本次决定':def.label),input=el(context,['select','choice'].includes(def.type)?'select':def.type==='textarea'?'textarea':'input');
        input.name=def.key;wrap.dataset.field=def.key;input.setAttribute('aria-label',def.label);if(input.tagName==='INPUT')input.type=def.type==='array'?'text':def.type==='datetime'?'datetime-local':def.type;input.required=def.required&&def.type!=='checkbox';
        if(['select','choice'].includes(def.type))for(const [value,label] of Object.entries(def.options||{})){const option=el(context,'option','',label);option.value=value;input.append(option);}
        const saved=draft.values[def.key];let value=initial[def.key]??(['select','choice'].includes(def.type)?Object.keys(def.options||{})[0]:'');
        if(!['url','file'].includes(def.type)&&typeof saved==='string'&&saved.length<=10000&&!/https?:\/\//i.test(saved))value=saved;
        if(['select','choice'].includes(def.type)&&typeof saved==='boolean'&&Object.hasOwn(def.options||{},String(saved)))value=String(saved);
        if(def.type==='checkbox')input.checked=typeof saved==='boolean'?saved:initial[def.key]===true;else if(def.type==='datetime')input.value=value?new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';else input.value=Array.isArray(value)?value.join('、'):String(value??'');
        if(def.type==='number'){input.min='0';input.step='any';}
        inputs.set(def.key,input);context.life.listen(input,'input',persist);context.life.listen(input,'change',persist);wrap.append(input);parent.append(wrap);
        if(def.suggestions?.length){
            const choices=el(context,'select','rw-reason-choices');choices.setAttribute('aria-label','选择'+def.label);
            for(const [value,label] of [['','请选择已实际核对的依据'],...def.suggestions.map(value=>[value,value]),['__other__','其他依据（自行填写）']]){const option=el(context,'option','',label);option.value=value;choices.append(option);}
            let custom=input.value&&!def.suggestions.includes(input.value)?input.value:'';
            choices.value=def.suggestions.includes(input.value)?input.value:input.value?'__other__':'';
            const sync=()=>{input.hidden=choices.value!=='__other__';input.required=def.required&&choices.value==='__other__';choices.required=Boolean(def.required);};
            wrap.classList.add('rw-suggested-reason');wrap.append(choices);wrap.append(input);
            input.setAttribute('aria-label','其他'+def.label);input.placeholder='请填写实际看到的关联依据，不确定时不要勾选确认。';
            context.life.listen(choices,'change',()=>{input.value=choices.value==='__other__'?custom:choices.value;sync();persist();if(choices.value==='__other__')input.focus();});
            context.life.listen(input,'input',()=>{if(choices.value==='__other__')custom=input.value;});sync();
            wrap.append(el(context,'small','rw-muted',def.suggestionHelp||'选择仅记录依据；仍需对照来源，单独勾选相关性确认。'));
        }
        if(decisionChoices){
            wrap.classList.add('rw-decision-choices');wrap.setAttribute('aria-label',def.label);input.hidden=true;
            const radios=[];
            for(const [value,label] of ['test','backup','observe','reject'].filter(value=>Object.hasOwn(def.options||{},value)).map(value=>[value,({test:'测试候选',backup:'备选'})[value]||def.options[value]])){
                const option=el(context,'label','rw-decision-choice'),radio=el(context,'input');radio.type='radio';radio.name='ui-decision-pool';radio.value=value;radio.checked=input.value===value;
                const copy=el(context,'span','rw-decision-choice-copy');copy.append(el(context,'strong','',label),el(context,'small','',({test:'证据达标后制定受控测试计划；保存决定不会自动投放。',backup:'保留为备选，暂不进入测试。',observe:'先补充关键证据，再重新评估。',reject:'保留来源与淘汰依据，避免重复投入。'})[value]||''));option.append(radio,copy);wrap.append(option);radios.push(radio);
                context.life.listen(radio,'change',()=>{if(radio.checked){input.value=value;input.dispatchEvent(new Event('change'));}});
            }
            const sync=()=>{for(const radio of radios)radio.checked=radio.value===input.value;};context.life.listen(input,'change',sync);context.life.listen(input,'input',sync);
        }
    }
    if(/核算|项目规则与预算/.test(title)&&groups.size>1){
        const rules=/项目规则与预算/.test(title),definitions=rules?[['选品标准',/选品/],['采集与预算',/采集/],['扩词与 AI',/扩词/]]:[['售价与订单',/售价/],['成本费用',/成本|费用/],['包装物流',/包装|重量|物流/],['报价来源',/报价/],['风险认证',/风险|认证/]];
        const tabs=el(context,'nav','rw-form-section-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',rules?'项目规则分组':'订单测算分组');
        const entries=definitions.map(([label,pattern])=>({label,groups:[...groups].filter(([name])=>pattern.test(name)).map(([,group])=>group)})).filter(e=>e.groups.length);if(!rules&&entries[1])entries[1].groups.unshift(...[...groups].filter(([name])=>/售价/.test(name)).map(([,group])=>group));
        const selectedKey=key+':sections';context.state.formSections||={};
        let selected=Math.min(context.state.formSections[selectedKey]??(rules?0:1),entries.length-1),invalidSeen=false;
        const activate=(index,reveal=true)=>{selected=index;context.state.formSections[selectedKey]=index;entries.forEach((entry,n)=>{entry.button.setAttribute('aria-selected',String(n===index));entry.button.tabIndex=n===index?0:-1;});const visible=new Set(entries[index].groups);for(const group of groups.values())group.hidden=!visible.has(group);if(reveal)entries[index].button.scrollIntoView?.({block:'nearest',inline:'nearest'});};
        entries.forEach((entry,index)=>{
            const choose=button(context,entry.label,()=>activate(index));choose.setAttribute('role','tab');entry.button=choose;tabs.append(choose);
            context.life.listen(choose,'keydown',event=>{const next=event.key==='ArrowRight'?(selected+1)%entries.length:event.key==='ArrowLeft'?(selected+entries.length-1)%entries.length:event.key==='Home'?0:event.key==='End'?entries.length-1:null;if(next!==null){event.preventDefault();activate(next);entries[next].button.focus();}});
        });
        const inputEntry=input=>{for(let node=input.parentElement;node&&node!==form;node=node.parentElement){const index=entries.findIndex(entry=>entry.groups.includes(node));if(index>=0)return index;}return -1;};
        const revealInput=input=>{for(let node=input.parentElement;node&&node!==form;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;};
        for(const input of inputs.values())context.life.listen(input,'invalid',()=>{if(invalidSeen)return;const index=inputEntry(input);revealInput(input);if(index>=0){invalidSeen=true;activate(index);queueMicrotask(()=>{invalidSeen=false;});}});
        // Native form validation visits every hidden invalid field before focusing.
        // Reveal and report only the first invalid control, with identical validity rules.
        form.noValidate=true;validateSections=()=>{const input=[...inputs.values()].find(input=>input.validity&&!input.validity.valid);if(!input)return true;const index=inputEntry(input);revealInput(input);if(index>=0)activate(index);input.reportValidity?.();input.focus?.();return false;};
        // Existing controls stay in the same form and inputs map, including hidden sections.
        if(rules)tabs.append(button(context,'采集方式',()=>context.openForm({kind:'configure_collection'})));form.replaceChildren(tabs,...Array.from(form.children));activate(selected,false);
    }
    if(inputs.has('text')){const preview=el(context,'p','rw-muted');const update=()=>preview.textContent=keywordPreview(inputs.get('text').value);context.life.listen(inputs.get('text'),'input',update);update();form.append(preview);}
    const save=el(context,'button','rw-primary',({'广告与漏斗拆解':'保存拆解资料','确认粗筛素材':'保存素材核实','做出人工决策':'保存人工决定','确认测试计划':'保存测试计划','记录真实测试结果':'保存测试结果','修订测试结果':'保存修订结果','记录复盘，回流下一轮关键词':'保存复盘'})[title]||'保存并继续');save.type='submit';
    const cancel=button(context,'取消',()=>onCancel?onCancel():context.navigate(returnView||(context.state.project?'project':'projects')));
    const discard=button(context,'放弃草稿',()=>{
        if(draft.uncertain){error.textContent='保存状态未确认，请先保持原输入重试或刷新核对，不能放弃提交身份。';return;}
        try{storage?.removeItem(key);}catch{}delete context.state.drafts[key];if(onDiscard)onDiscard();else context.openForm({ ...context.state.form, discard:true });
    });
    note.textContent=stored?'已恢复本标签页中未保存的内容；链接和文件需重新填写。':'草稿仅在本标签页保留；不保存链接、文件或含链接的文本。';
    const footer=el(context,'div','rw-form-footer');footer.append(save,cancel,discard);form.append(note,error,footer);
    const workspace=el(context,'div','rw-form-workspace'),aside=el(context,'aside','rw-form-assistance');aside.append(icon(context,'info'),el(context,'h2','','保存前请核对'));
    const reminders=/新研究/.test(title)?['每个研究项目对应一个目标市场。','有方向：创建后准备搜索词。','有商品：创建后添加准确商品链接。','创建研究不会自动采集或投放。']:/测试结果/.test(title)?['只填写实际统计区间内的结果。','核实报表来源与统计口径。','草稿与已确认结果分别保留。','修订保留原版本，作废不删除历史。']:/测试计划/.test(title)?['先明确预算、观察周期与停止线。','批准计划不代表自动创建广告。','真实结果需要在执行后单独录入。']:/核算|订单/.test(title)?['费用按整笔订单统一折算为 USD。','未知费用留空，不要填写 0。','报价须核对规格、数量与有效期。','情景估算不是实际销量或利润。']:/粗筛/.test(title)?['广告年龄不等于连续投放天数。','独立创意与当前活跃状态需分别确认。','保存观察不代表通过全部筛选。']:['请核对来源和当前商品是否一致。','不确定的信息保留未知。','保存失败会保留本标签页草稿。'];
    for(const reminder of reminders)aside.append(el(context,'p','',reminder));
    const live=el(context,'div','rw-live-preview');
    const updatePreview=()=>{const preview=formPreview(title,values());if(!preview)return;const costs=/核算|订单测算/.test(title),status=el(context,'section',costs?'rw-cost-status':'rw-preview-status');status.append(el(context,'h2','',preview.title),el(context,'p','rw-muted',preview.note));if(preview.missing.length)status.append(el(context,'p','rw-notice','仍待填写：'+preview.missing.join('、')));live.replaceChildren(status);const totals=el(context,'section',costs?'rw-cost-totals':'rw-preview-totals');for(const [name,value] of preview.rows){const row=el(context,'div','rw-preview-metric');if(/测试计划/.test(title))row.append(icon(context,({'计划总预算':'coins','观察天数':'calendar','目标 CPA':'target','停止线':'warning-circle'})[name]||'info'));row.append(el(context,'span','',name),el(context,'strong','',value));totals.append(row);}live.append(totals);};
    if(formPreview(title,values())){aside.replaceChildren(live);updatePreview();for(const input of inputs.values()){context.life.listen(input,'input',updatePreview);context.life.listen(input,'change',updatePreview);}}
    workspace.append(form,aside);host.append(workspace);
    context.life.listen(form,'submit',async event=>{
        event.preventDefault();if(save.disabled||validateSections&&!validateSections())return;save.disabled=true;cancel.disabled=true;discard.disabled=true;context.onFormSubmitting?.(true);
        try{
            const data={};for(const def of defs){const input=inputs.get(def.key);if(def.type==='checkbox')data[def.key]=input.checked;else if(def.type==='number'){if(input.value!=='')data[def.key]=Number(input.value);}else if(def.type==='array')data[def.key]=input.value.split(/[,，、\n]/).map(x=>x.trim()).filter(Boolean);else if(def.type==='datetime')data[def.key]=input.value?new Date(input.value).toISOString():null;else if(def.type==='file')data[def.key]=input.files?.[0]?await input.files[0].text():'';else if(input.value!==''||def.required)data[def.key]=input.value.trim();}
            persist();await submit(data,draft,persist);
            if(!context.life.active)return;
            try{storage?.removeItem(key);}catch{}delete context.state.drafts[key];context.onFormSaved?.();
            if(onSaved)onSaved();else{notify(context,'已保存。');context.navigate(successView||returnView||(context.state.project?'project':'projects'));}
        }catch(err){
            if(!context.life.active)return;error.textContent=/failed to fetch|load failed|networkerror/i.test(err.message)?'未能连接本机服务，请确认应用仍在运行。':err.message;
            if(err.status===409&&projectId){
                try{const project=await context.api.request('/projects/'+encodeURIComponent(projectId),{signal:context.life.signal});
                    if(!context.life.active)return;context.state.project=project;draft.version=project.version;persist();error.textContent+='。背景数据已刷新，草稿仍保留；请核对后再次保存。';
                }catch{if(context.life.active)error.textContent+='。草稿仍保留，但背景刷新未完成。';}
            }else if(!err.status)error.textContent+='。保存状态可能未确认，草稿已保留；请保持原输入重试或刷新核对。';
        }finally{if(context.life.active){save.disabled=false;cancel.disabled=false;discard.disabled=false;context.onFormSubmitting?.(false);}}
    });
    return {host,form,inputs,draft,persist,error};
}
