import { createState } from './state.mjs';
import { createApi } from './api.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { render as projectsPage } from './pages/projects.mjs';
import { render as projectPage, renderPaths } from './pages/exploration.mjs';
import { render as formPage } from './pages/project-forms.mjs';
import { el, button, notify } from './components/elements.mjs';
import { newCommandId, submitCommand, submissionFingerprint, restoreDraft } from './services/commands.mjs';

/** Submission locks belong to the live promise, never to a restored DTO. */
function snapshotState(state) {
    const snapshot=structuredClone({...state,busy:false,writeBusy:false,error:''});
    for(const draft of [...Object.values(snapshot.commands||{}),...Object.values(snapshot.drafts||{})]) {
        if(draft.submitting)draft.uncertain=true;
        delete draft.submitting;
    }
    return snapshot;
}

export function createWorkbench() {
    let instance=null;
    const snapshots=new WeakMap();
    const active=current=>current?.life.active&&current===instance;
    function renderProjects(current) {
        current.navLife?.dispose(); const navLife=createLifecycle();current.navLife=navLife;
        const stop=current.life.track(()=>navLife.dispose());navLife.track(()=>stop());
        const navContext={...current,life:navLife};
        const list=current.root.querySelector('[data-rw-projects]');
        const nodes=current.state.projects.map(project=>{
            const node=button(navContext,project.title||'未命名项目',()=>openProject(current,project.id));node.dataset.rwProject=project.id;return node;
        });list.replaceChildren(button(navContext,'全部项目',()=>navigate(current,'projects')),button(navContext,'＋ 新建研究',()=>openForm(current,{kind:'new_project'})),...nodes);
    }
    function pageContext(current,life) {
        return {...current,life,
            navigate:view=>navigate(current,view), openProject:(id,form)=>openProject(current,id,form), openForm:spec=>openForm(current,spec),
            showQueue:selection=>{current.state.queueSelection=selection||null;navigate(current,'actions');},
            selectProduct:id=>{if(!active(current)||!current.state.project?.products?.some(product=>product.id===id))return;const projectId=current.state.project.id;current.state.product=id;navigate(current,'product');current.context.onSelectProduct?.({projectId,productId:id},current);},
            command:(action,payload)=>command(current,action,payload),acceptProject:project=>{if(!active(current))return;current.state.project=project;navigate(current,'project');}
        };
    }
    function paint(current,focus=false) {
        if(!active(current))return;current.pageLife?.dispose();const life=createLifecycle();current.pageLife=life;
        const stop=current.life.track(()=>life.dispose());life.track(()=>stop());const c=pageContext(current,life);current.pageContext=c;
        let page;
        if(current.state.view==='projects')page=projectsPage(c);
        else if(current.state.view==='paths')page=renderPaths(c);
        else if(current.state.view==='form')page=formPage(c);
        else if(current.state.view==='project'&&current.state.project)page=projectPage(c);
        else {
            page=el(c,'section');const heading=el(c,'h1','',current.state.view==='product'?'产品档案':'动作队列');heading.tabIndex=-1;
            page.append(heading,el(c,'p','rw-muted',current.state.view==='product'?'产品档案页面将在后续迁入步骤接入；已保存事实和待核验状态保留。':'队列执行与媒体页面尚未接入。当前只显示已保存任务，不提交或自动重放采集。'),button(c,'返回探索',()=>navigate(current,'project')));
            if(current.state.view==='actions'){
                const selection=current.state.queueSelection;
                if(selection){const kinds={scan:'搜索入口词',keywords:'AI建议初始词',scan_all:'扫描已审核词',expand:'提取下一层建议'};const keyword=current.state.project?.keywords?.find(word=>word.id===selection.keyword_id);page.append(el(c,'p','',`待接入操作：${kinds[selection.kind]||'核对已保存任务'}${keyword?' · '+keyword.text:''}`));}
                for(const action of current.state.actions||[])page.append(el(c,'p','',`${action.label||action.kind} · ${action.display_status||action.status} · ${action.message||''}`));
            }
        }
        current.root.querySelector('[data-rw-page]').replaceChildren(page);
        if(focus)page.querySelector('h1')?.focus({preventScroll:true});
    }
    function navigate(current,view) {if(!active(current))return;current.navigation++;current.state.view=view;paint(current,true);}
    function openForm(current,spec) {if(!active(current))return;current.state.form=structuredClone(spec);navigate(current,'form');}
    async function openProject(current,id,form) {
        const generation=++current.navigation;
        try{
            const project=await current.api.request('/projects/'+encodeURIComponent(id));
            const actions=await current.api.request('/projects/'+encodeURIComponent(id)+'/actions?limit=20');
            if(!active(current)||generation!==current.navigation)return;
            current.state.project=project;current.state.actions=actions.actions||[];current.state.keywordActions=actions.keyword_actions||{};current.state.product=null;
            if(form)openForm(current,form);else navigate(current,'project');
            current.context.onSelectProject?.(id,{...current,...pageContext(current,current.pageLife)});
        }catch(error){if(active(current)&&generation===current.navigation)notify(current,error.message+'。已加载资料保持显示。');}
    }
    async function command(current,action,payload) {
        if(!active(current)||current.state.writeBusy)return;current.state.writeBusy=true;
        const project=current.state.project;
        let storageKey,draft;
        const storage=current.context.storage||current.root.ownerDocument.defaultView?.sessionStorage;
        try{
            const key=await submissionFingerprint({action,payload});storageKey='rabbit-hole:command:'+project.id+':'+key;
            if(!active(current))return;
            let saved;try{saved=JSON.parse(storage?.getItem(storageKey)||'null');}catch{}
            draft=current.state.commands[key]||{...restoreDraft(saved||{}),version:project.version};current.state.commands[key]=draft;
            const persist=()=>{if(!active(current))return;try{storage?.setItem(storageKey,JSON.stringify({command_id:draft.command_id,submittedHash:draft.submittedHash,uncertain:draft.uncertain}));}catch{notify(current,'浏览器草稿存储不可用，请保持本页核对提交状态。');}};
            const result=await submitCommand(current.api,{project_id:project.id,version:draft.version,action,payload,draft},persist);
            if(!active(current)||current.state.project?.id!==project.id)return;
            current.navigation++;current.state.project=result;delete current.state.commands[key];try{storage?.removeItem(storageKey);}catch{}const index=current.state.projects.findIndex(item=>item.id===result.id);if(index>=0)current.state.projects[index]=result;
            renderProjects(current);if(current.state.view!=='form')paint(current,true);notify(current,'已保存。');
        }catch(error){
            if(!active(current))return;notify(current,error.message+'。草稿及提交身份保留，请刷新核对。');
            if(error.status===409){try{const result=await current.api.request('/projects/'+encodeURIComponent(project.id));if(active(current)&&current.state.project?.id===project.id){current.navigation++;current.state.project=result;if(draft)draft.version=result.version;if(current.state.view!=='form')paint(current);}}catch{}}
        }finally{current.state.writeBusy=false;}
    }
    async function refresh(current=instance) {
        if(!active(current)||current.state.busy)return;current.state.busy=true;
        const projectId=current.state.project?.id,view=current.state.view,navigation=current.navigation;
        try{
            const data=await current.api.request('/projects');if(!Array.isArray(data.projects))throw Error('Invalid projects');
            let project=current.state.project,actions;
            if(projectId){project=await current.api.request('/projects/'+encodeURIComponent(projectId));actions=await current.api.request('/projects/'+encodeURIComponent(projectId)+'/actions?limit=20');}
            if(!active(current)||navigation!==current.navigation)return;
            current.state.projects=data.projects;current.state.project=project;if(actions){current.state.actions=actions.actions||[];current.state.keywordActions=actions.keyword_actions||{};}
            current.state.error='';renderProjects(current);if(view!=='form')paint(current);notify(current,'研究资料已更新');
        }catch(_){if(active(current)){current.state.error='研究资料暂时无法读取；已加载资料保持显示。';notify(current,current.state.error);}}
        finally{current.state.busy=false;}
    }
    function unmount() {
        if(instance)snapshots.set(instance.root,snapshotState(instance.state));
        instance?.life.dispose();instance=null;
    }
    async function mount(root,context={}) {
        if(instance?.root===root)return instance.ready;unmount();
        const life=createLifecycle(),current={root,life,state:{...createState(),...(snapshots.has(root)?snapshotState(snapshots.get(root)):{})},context,api:createApi({...context,signal:life.signal}),navigation:0};instance=current;
        root.innerHTML='<div class="rw-header"><h2>选品研究工作台</h2><button type="button" data-rw-refresh>刷新研究资料</button></div><p data-rw-status role="status" aria-live="polite">正在读取研究资料…</p><div class="rw-layout"><nav aria-label="研究项目" data-rw-projects></nav><section data-rw-page></section></div>';
        renderProjects(current);paint(current);life.listen(root,'click',event=>{if(event.target.closest?.('[data-rw-refresh]'))void refresh(current);});
        current.ready=(async()=>{try{await current.api.session();if(active(current))await refresh(current);}catch(_){if(active(current))notify(current,'研究会话暂时不可用，请刷新研究入口。');}})();return current.ready;
    }
    return {mount,unmount,refresh,get state(){return instance?.state||null;}};
}
const workbench=createWorkbench();export const mount=workbench.mount;export const unmount=workbench.unmount;
