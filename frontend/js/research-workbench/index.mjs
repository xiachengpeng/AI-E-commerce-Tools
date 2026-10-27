import {projectResume} from './services/journey.mjs';
import {renderWorkflowControls} from './components/workflow-controls.mjs';
import {createCollectionLogDialog} from './components/collection-logs.mjs';
import {createProductIdentityDialog} from './components/product-identity-dialog.mjs';
import {renderStageSelection} from './pages/stage-selection.mjs';
import {renderWorkbenchNavigation} from './components/navigation.mjs';
import {rememberRoute,restoreRoute} from './services/navigation.mjs';
import {createMediaCache} from './services/media-cache.mjs';
import {decoratePage,renderJourney,designPage,icon} from './components/presentation.mjs';
import { createActionDialog, publishTrackedActionFeedback } from './components/action-confirmation.mjs';
import { createSnapshotRefresher } from './services/snapshot.mjs';
import { renderSync } from './pages/sync.mjs';
import { renderSettings } from './settings.mjs';
import { renderHistory } from './history.mjs';
import { renderProduct, nextProductStep } from './pages/product.mjs';
import { renderTriage } from './pages/triage.mjs';
import { renderReport } from './pages/reports.mjs';
import { renderActions } from './pages/actions.mjs';
import { createState } from './state.mjs';
import { createApi } from './api.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { render as projectsPage } from './pages/projects.mjs';
import { render as projectPage, renderPaths,renderKeywordSection } from './pages/exploration.mjs';
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
    function closeProductIdentity(current,restoreFocus=true,redraw=true){
        const pending=current.productIdentity;if(!pending)return;current.productIdentity=null;pending.close({restoreFocus});if(redraw&&pending.needsPaint&&active(current))paint(current);
    }
    function showProductIdentity(current,id){
        if(!active(current)||current.confirmation||current.collectionLogs||current.productIdentity||current.state.writeBusy)return;
        current.productIdentity=createProductIdentityDialog({...current.pageContext,life:current.life},id,{
            onCancel:()=>closeProductIdentity(current),
            onSaved:(project,productId)=>{
                if(!active(current)||current.state.project?.id!==project.id)return;
                closeProductIdentity(current,false,false);
                if(project.version>=current.state.project.version)current.state.project=project;
                const index=current.state.projects.findIndex(p=>p.id===project.id);if(index>=0)current.state.projects[index]=current.state.project;
                current.state.product=productId;paint(current);
                const p=current.state.project.products.find(p=>p.id===productId),confirmed=p?.identification?.relevance_confirmed===true;
                notify(current,confirmed?'商品核对已保存。下一步：核实广告素材。':'商品资料已保存；相关性尚未确认，请继续对照广告与商品来源。');
                Array.from(current.root.querySelectorAll?.('[data-product-identity-trigger]')||[]).find(n=>n.dataset.productIdentityTrigger===productId)?.focus({preventScroll:true});
            }
        });
    }
    function closeConfirmation(current,restoreFocus=true,redraw=true){
        const pending=current.confirmation;if(!pending)return;
        current.confirmation=null;current.state.queueSelection=null;pending.close({restoreFocus});
        if(redraw&&pending.needsPaint&&active(current))paint(current);
    }
    function confirmAction(current,selection){
        if(!active(current)||!current.state.project||current.confirmation||current.collectionLogs||current.productIdentity)return;
        if(current.state.writeBusy){notify(current,'配置正在保存，请保存完成后再开始研究操作。');return;}
        const c=current.pageContext,projectId=current.state.project.id;current.state.queueSelection=selection;
        current.confirmation=createActionDialog({...c,life:current.life},selection,{
            onCancel:()=>closeConfirmation(current),
            onSubmitted:async()=>{
                closeConfirmation(current,true,false);
                try{await c.refreshProject?.(false);}catch{if(active(current)&&c.life.active&&selection.kind!=='keywords')notify(current,'执行请求已保存；结果暂未读到，请刷新核对，勿重复提交。');}
                if(active(current)&&c.life.active&&current.state.project?.id===projectId)paint(current);
            }
        });
        if(!current.confirmation)current.state.queueSelection=null;
    }
    function closeCollectionLogs(current,restoreFocus=true,redraw=true){
        const pending=current.collectionLogs;if(!pending)return;current.collectionLogs=null;pending.close({restoreFocus});
        if(redraw&&pending.needsPaint&&active(current))paint(current);
    }
    function showCollectionLogs(current,keywordId){
        if(!active(current)||current.confirmation||current.collectionLogs||current.productIdentity)return;
        const word=current.state.project?.keywords?.find(k=>k.id===keywordId);if(!word)return;
        current.collectionLogs=createCollectionLogDialog({...current.pageContext,life:current.life},word,()=>closeCollectionLogs(current));
    }
    function renderProjects(current) {
        current.navLife?.dispose(); const navLife=createLifecycle();current.navLife=navLife;
        const stop=current.life.track(()=>navLife.dispose());navLife.track(()=>stop());
        const navContext={...current,life:navLife};
        const list=current.root.querySelector('[data-rw-projects]');
        renderWorkbenchNavigation({...navContext,
            navigate:view=>navigate(current,view),openProject:id=>openProject(current,id),
            openForm:spec=>openForm(current,spec),goBack:()=>goBack(current)
        });
    }
    function pageContext(current,life) {
        const navigation=current.navigation;
        const origin={signal:life.signal,isCurrent:()=>active(current)&&life.active&&current.navigation===navigation&&current.pageLife===life};
        const result={...current,life,designDirectForms:true,
            navigate:view=>navigate(current,view), openProject:(id,form)=>openProject(current,id,form), openForm:spec=>openForm(current,spec),
            showCollectionLogs:keywordId=>showCollectionLogs(current,keywordId),
            showProductIdentity:id=>showProductIdentity(current,id),
            showQueue:selection=>{if(selection?.kind)confirmAction(current,selection);else{current.state.queueSelection=null;navigate(current,'actions');}},
            selectProduct:id=>openProduct(current,current.state.project?.id,id),
            openTriage:(id,disposition)=>{if(!current.state.project?.products?.some(p=>p.id===id&&!p.merged_into))return;current.state.product=id;current.state.triageIntent=disposition?{productId:id,disposition}:null;navigate(current,'triage');},
            openProduct:(projectId,productId,step)=>step==='identification'&&current.state.view==='project'&&current.state.project?.id===projectId?showProductIdentity(current,productId):openProduct(current,projectId,productId,step),
            openHistoryProduct:(projectId,productId)=>origin.isCurrent()?openHistoryProduct(current,projectId,productId):undefined,
            onSelectProduct:selection=>{if(origin.isCurrent())return current.context.onSelectProduct?.(selection,origin);},
            redraw:()=>{if(origin.isCurrent())paint(current);},
            command:(action,payload,options)=>command(current,action,payload,options),acceptProject:project=>{if(!active(current))return;current.state.project=project;navigate(current,'project');}
        };
        result.refreshProject=createSnapshotRefresher(result);return result;
    }
    function paint(current,focus=false) {
        if(!active(current))return;if(current.confirmation||current.collectionLogs||current.productIdentity){current.collectionLogs?.update(current.state.keywordActions?.[current.collectionLogs.keywordId]);(current.confirmation||current.collectionLogs||current.productIdentity).needsPaint=true;return;}current.pageLife?.dispose();const life=createLifecycle();current.pageLife=life;
        const stop=current.life.track(()=>life.dispose());life.track(()=>stop());const c=pageContext(current,life);current.pageContext=c;
        let page;
        if(current.state.view==='projects')page=projectsPage(c);
        else if(current.state.view==='actions'&&current.state.project)page=renderActions(c);
        else if(current.state.view==='sync'&&current.state.project)page=renderSync(c);
        else if(current.state.view==='product_selection'&&current.state.project)page=renderStageSelection(c);
        else if(current.state.view==='product'&&current.state.project)page=renderProduct(c);
        else if(current.state.view==='triage'&&current.state.project)page=renderTriage(c);
        else if(current.state.view==='settings')page=renderSettings(c);
        else if(current.state.view==='history')page=renderHistory(c);
        else if(current.state.view==='reports')page=renderReport(c);
        else if(current.state.view==='paths')page=renderPaths(c);
        else if(current.state.view==='form'){
            page=formPage(c);
            if(current.state.project&&!current.state.form?.parent&&['add_keyword','edit_keyword','new_search_entry'].includes(current.state.form?.kind)){
                const drawer=el(c,'section','rw-keyword-editor-layout'),list=el(c,'section','rw-keyword-editor-list');
                list.append(el(c,'h1','','先选好搜索词，再找广告'),el(c,'p','rw-muted','新词保存后仍需审核，审核后才搜索。'),renderKeywordSection(c,{readOnly:true}));
                page.classList.add('rw-keyword-editor-form');if(page.querySelectorAll){const title=page.querySelector('h1'),note=Array.from(page.children).find(n=>n.tagName==='P'),rule=el(c,'details','rw-form-business-rules');if(title)title.textContent=current.state.form?.kind==='edit_keyword'?'修改搜索词':'添加搜索词';if(note){rule.append(el(c,'summary','','关键词填写规则'),el(c,'p','rw-muted',note.textContent));note.textContent='新添加的搜索词不会自动通过审核，请补充信息后保存为待审核。';page.append(rule);}const close=button(c,'关闭关键词编辑',()=>navigate(current,'project'),'rw-drawer-close');close.append(el(c,'i','ph ph-x'));page.append(close);}drawer.append(list,page);page=drawer;
            }
        }
        else if(current.state.view==='project'&&current.state.project)page=projectPage(c);
        else page=projectsPage(c);
        decoratePage(c,page);
        rememberRoute(current.state);renderProjects(current);
        const design=designPage(current.state),stage=el(c,'div','rw-page-surface');
        if(design.journey)stage.append(renderJourney(c));if(current.state.view==='product'){const tasks=renderWorkflowControls(c);if(tasks)stage.append(tasks);}stage.append(page);
        current.root.querySelector('[data-rw-page]').replaceChildren(stage);
        publishTrackedActionFeedback(c);

        for(const node of current.root.querySelector('[data-rw-projects]').children){
            if(!node.dataset.rwView&&!node.dataset.rwProject)continue;
            const selected=node.dataset.rwView?node.dataset.rwView===current.state.view:node.dataset.rwProject===current.state.project?.id&&!['projects','settings','history','reports'].includes(current.state.view);
            node.setAttribute('aria-current',selected?'page':'false');
        }
        if(focus){current.root.scrollTop=0;const editor=page.querySelector('.rw-keyword-editor-form');(editor||page).querySelector('h1')?.focus({preventScroll:true});}
    }
    async function openHistoryProduct(current,projectId,productId) {
        if(!active(current))return;const generation=++current.navigation;
        try {
            const project=await current.api.request('/projects/'+encodeURIComponent(projectId));
            if(!active(current)||generation!==current.navigation)return;
            if(!project.products?.some(p=>p.id===productId&&!p.merged_into))throw Error('来源商品已更新或移除，请重新核对。');
            current.state.project=project;openProduct(current,projectId,productId);
        }catch(error){if(active(current)&&generation===current.navigation)notify(current,error.message);}
    }
    function openProduct(current,projectId,productId,step) {
        if(!active(current)||current.state.project?.id!==projectId||!current.state.project.products?.some(product=>product.id===productId&&!product.merged_into))return;
        delete current.state.productOverview;if(current.state.product!==productId)delete current.state.testPane;current.state.product=productId;current.state.step=step||nextProductStep(current.state.project.products.find(p=>p.id===productId));navigate(current,'product');
        current.context.onProductNavigate?.({projectId,productId});
    }
    function navigate(current,view) {
        if(!active(current))return;closeConfirmation(current,false,false);closeCollectionLogs(current,false,false);closeProductIdentity(current,false,false);if(current.state.view!==view)current.state.queueSelection=null;current.navigation++;current.state.view=view;paint(current,true);
        const page=current.pageContext;
        if(view==='project')void page.refreshProject().catch(error=>{
            if(active(current)&&page.life.active&&current.pageContext===page)notify(current,error.message+'。已加载资料保持显示。');
        });
    }
    async function goBack(current) {
        if(!active(current)||current.backBusy)return;
        closeConfirmation(current,false,false);closeCollectionLogs(current,false,false);
        const route=current.state.navigationTrail?.at(-1);
        if(!route){if(current.state.view!=='projects')navigate(current,'projects');return;}
        current.backBusy=true;const generation=++current.navigation;
        try{
            let project=current.state.project,actions;
            if(route.projectId&&project?.id!==route.projectId){
                project=await current.api.request('/projects/'+encodeURIComponent(route.projectId));
                actions=await current.api.request('/projects/'+encodeURIComponent(route.projectId)+'/actions?limit=20');
            }
            if(!active(current)||generation!==current.navigation)return;
            if(route.projectId)current.state.project=project;else current.state.project=null;
            if(actions){current.state.actions=actions.actions||[];current.state.actionCursor=actions.next_cursor||null;current.state.keywordActions=actions.keyword_actions||{};current.state.verificationActions=actions.verification_actions||{};current.state.productActions=actions.product_actions||{};}
            else if(!route.projectId){current.state.actions=[];current.state.keywordActions={};current.state.verificationActions={};current.state.productActions={};}
            current.state.navigationTrail.pop();restoreRoute(current.state,route);paint(current,true);
        }catch(error){if(active(current)&&generation===current.navigation)notify(current,error.message+'。当前资料和返回位置保留。');}
        finally{current.backBusy=false;}
    }
    function openForm(current,spec) {if(!active(current))return;current.state.form=structuredClone(spec);navigate(current,'form');}
    async function openProject(current,id,form) {
        closeConfirmation(current,false,false);closeCollectionLogs(current,false,false);
        const generation=++current.navigation;
        try{
            const project=await current.api.request('/projects/'+encodeURIComponent(id));
            const actions=await current.api.request('/projects/'+encodeURIComponent(id)+'/actions?limit=20');
            if(!active(current)||generation!==current.navigation)return;
            current.state.project=project;current.state.actions=actions.actions||[];current.state.actionCursor=actions.next_cursor||null;current.state.keywordActions=actions.keyword_actions||{};current.state.verificationActions=actions.verification_actions||{};current.state.productActions=actions.product_actions||{};current.state.product=null;current.state.queueSelection=null;
            if(form?.resume){const route=projectResume(project);Object.assign(current.state,route);delete current.state.productOverview;navigate(current,route.view);}else if(form)openForm(current,form);else navigate(current,'project');
            current.context.onSelectProject?.(id,{...current,...pageContext(current,current.pageLife)});
        }catch(error){if(active(current)&&generation===current.navigation)notify(current,error.message+'。已加载资料保持显示。');}
    }
    async function command(current,action,payload,options={}) {
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
            renderProjects(current);if(current.state.view!=='form')paint(current,!options.preservePosition);notify(current,options.savedMessage||'已保存。');
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
            current.state.projects=data.projects;current.state.project=project;if(actions){current.state.actions=actions.actions||[];current.state.actionCursor=actions.next_cursor||null;current.state.keywordActions=actions.keyword_actions||{};current.state.verificationActions=actions.verification_actions||{};current.state.productActions=actions.product_actions||{};}
            current.state.error='';renderProjects(current);if(view!=='form'&&!current.pageContext?.editing)paint(current);notify(current,'研究资料已更新');publishTrackedActionFeedback(current.pageContext||current);
        }catch(_){if(active(current)){current.state.error='研究资料暂时无法读取；已加载资料保持显示。';notify(current,current.state.error);}}
        finally{current.state.busy=false;}
    }
    function unmount() {
        if(instance)closeProductIdentity(instance,false,false);
        if(instance){closeConfirmation(instance,false,false);closeCollectionLogs(instance,false,false);}
        if(instance)snapshots.set(instance.root,snapshotState(instance.state));
        instance?.life.dispose();instance=null;
    }
    async function mount(root,context={}) {
        if(instance?.root===root)return instance.ready;unmount();
        const life=createLifecycle(),current={root,life,state:{...createState(),...(snapshots.has(root)?snapshotState(snapshots.get(root)):{})},context,api:createApi({...context,signal:life.signal}),navigation:0};current.mediaCache=createMediaCache({life,api:current.api,owner:context.objectURLs||globalThis.URL});instance=current;
        root.classList.add('rw-workflow-ui');
        root.innerHTML='<header class="rw-design-header"><span data-rw-breadcrumb>选品研究</span><span data-rw-status role="status" aria-live="polite">正在读取研究资料…</span><button type="button" data-rw-refresh title="重新读取已保存的研究资料，不重新采集"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i>刷新资料</button></header><nav class="rw-design-navigation" aria-label="研究项目" data-rw-projects></nav><main data-rw-page></main>';
        renderProjects(current);paint(current);life.listen(root,'click',event=>{if(event.target.closest?.('[data-rw-refresh]'))void refresh(current);});
        current.ready=(async()=>{try{await current.api.session();if(active(current))await refresh(current);}catch(_){if(active(current))notify(current,'研究会话暂时不可用，请刷新研究入口。');}})();return current.ready;
    }
    return {mount,unmount,refresh,navigate:(view,kind)=>{if(!active(instance)||!['settings','history','reports'].includes(view))return;if(kind)instance.state.historyKind=kind;navigate(instance,view);},openProduct:(projectId,productId,step)=>openProduct(instance,projectId,productId,step),get state(){return instance?.state||null;}};
}
const workbench=createWorkbench();export const mount=workbench.mount;export const unmount=workbench.unmount;export const openProduct=workbench.openProduct;

export const navigate=workbench.navigate;
