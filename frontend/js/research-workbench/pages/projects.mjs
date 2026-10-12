import { el, button, panel, marketNames } from '../components/elements.mjs';
export function render(context) {
    const root=el(context,'section'),heading=el(context,'h1','','研究项目');heading.tabIndex=-1;root.append(heading,el(context,'p','rw-muted','从一个方向出发，沿着证据推进。'),button(context,'＋ 新建研究',()=>context.openForm({kind:'new_project'}),'rw-primary'));
    if(!context.state.projects.length)root.append(panel(context,'你的第一项研究，从这里开始','输入方向或已有商品。程序保存每一步，缺证据时准确停下，补齐后继续。'));
    const grid=el(context,'div','rw-cards');
    for(const project of context.state.projects){const card=panel(context,project.title||'未命名项目',project.direction);
        card.append(el(context,'p','rw-muted',`${marketNames[project.market]||project.market||'未知'} · ${project.keywords?.length||0} 个关键词 · ${project.products?.length||0} 个产品线索`),el(context,'p','rw-muted',`${project.summary?.pending_triage||0} 条待筛线索`),button(context,'继续选品',()=>context.openProject(project.id),'rw-primary'),button(context,'删除项目',()=>context.openProject(project.id,{kind:'delete_project'}),'rw-danger'));grid.append(card);
    }root.append(grid);return root;
}
