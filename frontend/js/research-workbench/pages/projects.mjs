import { el, button, panel, marketNames } from '../components/elements.mjs';
import {icon,productThumbnail} from '../components/presentation.mjs';
export function projectResearchProgress(project){const products=(project.products||[]).filter(p=>!p.merged_into),verified=products.filter(p=>p.identification?.relevance_confirmed===true).length;return {verified,total:products.length,pending:products.length-verified};}
export function render(context) {
    const root=el(context,'section','rw-projects-page');
    const header=el(context,'div','rw-page-heading'),intro=el(context,'div');
    const heading=el(context,'h1','','研究项目');heading.tabIndex=-1;
    intro.append(el(context,'p','rw-eyebrow','RESEARCH WORKSPACE'),heading,el(context,'p','rw-page-description','从一个方向或已有商品开始，逐步核实是否值得测试。'));
    header.append(intro,button(context,'＋ 新建研究',()=>context.openForm({kind:'new_project'}),'rw-primary'));root.append(header);
    const guide=panel(context,'开始新的选品研究');
    guide.classList.add('rw-start-guide');
    const starts=el(context,'div','rw-start-options');
    for(const [title,note,symbol] of [['有方向 → 准备搜索词','输入品类、场景或关键词，发现潜力商品。','magnifying-glass'],['有商品 → 添加商品链接','创建研究后添加商品链接，收集信息并核实。','link']]){const entry=button(context,'',()=>context.openForm({kind:'new_project'}),'rw-start-option');const copy=el(context,'span');copy.append(el(context,'strong','',title),el(context,'small','rw-muted',note));entry.append(icon(context,symbol),copy,icon(context,'arrow-right'));starts.append(entry);}guide.append(starts);
    root.append(guide);
    const sectionHeading=el(context,'div','rw-section-heading');
    sectionHeading.append(el(context,'h2','','我的项目（'+context.state.projects.length+'）'));root.append(sectionHeading);
    if(!context.state.projects.length){const empty=panel(context,'你的第一项研究，从这里开始','输入方向或已有商品。程序保存每一步，缺证据时准确停下，补齐后继续。');empty.classList.add('rw-empty');root.append(empty);}
    const grid=el(context,'div','rw-cards');grid.append(sectionHeading);
    for(const project of context.state.projects){
        const card=el(context,'article','rw-project-card');
        const progress=projectResearchProgress(project),top=el(context,'div','rw-card-top'),mark=project.products?.[0]?productThumbnail({...context,state:{...context.state,project}},project.products[0]):icon(context,'folder-open');mark.setAttribute('aria-hidden','true');top.append(mark);
        const title=el(context,'h2','rw-project-title',project.title||'未命名项目'),copy=el(context,'div','rw-project-card-copy');
        const market=el(context,'p','rw-project-market');market.append(icon(context,'globe-hemisphere-west'),el(context,'span','', (marketNames[project.market]||project.market||'市场待确认')+'市场'));
        const timestamp=project.updated_at||project.created_at,date=timestamp?new Date(timestamp):null;
        copy.append(title,market,el(context,'p','rw-project-updated',date&&!Number.isNaN(date.valueOf())?'最近更新：'+date.toLocaleDateString('zh-CN'):'更新时间未记录'));
        copy.title=project.direction||'';
        const metrics=el(context,'div','rw-project-metrics');metrics.append(el(context,'span','rw-muted','商品核实进度'),el(context,'strong','',progress.pending+' 个商品待核实'));
        const meter=el(context,'div','rw-project-progress'),bar=el(context,'progress');bar.max=progress.total||1;bar.value=progress.verified;bar.setAttribute('aria-label','已人工核实商品比例');meter.append(bar,el(context,'span','rw-muted',progress.verified+' / '+progress.total));metrics.append(meter);
        const footer=el(context,'div','rw-card-footer'),more=el(context,'details','rw-project-more'),summary=el(context,'summary');summary.setAttribute('aria-label','项目更多操作');summary.append(icon(context,'dots-three-vertical'));more.append(summary,button(context,'删除项目',()=>context.openProject(project.id,{kind:'delete_project'}),'rw-danger rw-text-button'));footer.append(button(context,'继续选品',()=>context.openProject(project.id,{resume:true}),'rw-primary'),more);
        card.append(top,copy,metrics,footer);grid.append(card);
    }
    const layout=el(context,'div','rw-project-overview'),todo=el(context,'aside','rw-project-todos');todo.append(el(context,'h2','','本周待继续'));
    for(const [index,project] of context.state.projects.slice(0,3).entries()){const row=button(context,'',()=>context.openProject(project.id,{resume:true}),'rw-project-todo');row.append(el(context,'span','rw-todo-number',index+1),el(context,'strong','',project.title||'未命名项目'),el(context,'span','rw-muted',project.summary?.pending_triage==null?'查看资料与下一步':project.summary.pending_triage+' 个商品待筛选'),icon(context,'caret-right'));todo.append(row);}
    if(!context.state.projects.length)todo.append(el(context,'p','rw-muted','创建研究后，待处理事项会显示在这里。'));
    const checklist=button(context,'查看完整检查清单',()=>context.navigate('reports'),'rw-checklist-link');checklist.append(icon(context,'arrow-right'));todo.append(checklist,el(context,'p','rw-muted','包含找线索、核实商品、需求与竞争、算清利润、做决定等10个步骤。仅辅助研究，不会自动投放。'));layout.append(grid,todo);root.append(layout);return root;
}
