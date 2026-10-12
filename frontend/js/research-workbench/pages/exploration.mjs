import { el, button, panel, stateTag, typeNames, keywordSearchSummary } from '../components/elements.mjs';
import { render as focused } from './focused-exploration.mjs';
export function keywordControls(context,word) {
    const node=el(context,'div','rw-actions'),action=context.state.keywordActions?.[word.id];
    if(action&&['queued','ready','running'].includes(action.status)){node.append(stateTag(context,action.display_status||action.status),button(context,'停止本次搜索',()=>context.showQueue({keyword_id:word.id,action_id:action.id})));return node;}
    if(word.status==='archived'){node.append(button(context,'恢复并重新审核',()=>context.command('restore_keyword',{keyword_id:word.id})));return node;}
    if(!word.approved){
        node.append(button(context,'修改',()=>context.openForm({kind:'edit_keyword',keyword:word,parent:word.parent_id?context.state.project.keywords.find(k=>k.id===word.parent_id):null,product:context.state.project.products.find(p=>p.id===word.product_id)})));
        if(!word.needs_normalization&&!word.stale_source&&!word.legacy_source)node.append(button(context,'审核通过',()=>context.command('approve_keyword',{keyword_id:word.id,approved:true}),'rw-primary'));
    }else if(action?.status==='blocked'&&action.recovery_action==='manual')node.append(el(context,'p','rw-notice','提交状态不确定，先按任务标签 '+action.id+' 核对云端记录，避免重复收费。'));
    else if(action?.status==='blocked'||!['complete','queued','running'].includes(word.status))node.append(button(context,action?.recovery_action==='resume'?'继续查询结果':action?.recovery_action==='restart'?'重新搜索':action?.status==='blocked'?'重试搜索':'搜索这个词',()=>context.showQueue({kind:'scan',keyword_id:word.id}),'rw-primary'));
    if(!['queued','running'].includes(word.status))node.append(button(context,'不再采用',()=>context.command('archive_keyword',{keyword_id:word.id})));
    return node;
}
export function render(context) {
    const p=context.state.project,root=el(context,'section'),heading=el(context,'h1','',p.title);heading.tabIndex=-1;root.append(heading,el(context,'p','rw-muted',`${p.market} · ${p.direction||''}`));
    const tools=el(context,'div','rw-actions');tools.append(button(context,'← 全部项目',()=>context.navigate('projects')),button(context,'关键词路径',()=>context.navigate('paths')),button(context,'项目规则与预算',()=>context.openForm({kind:'configure_rules'})),button(context,'设置采集模式',()=>context.openForm({kind:'configure_collection'})),button(context,'动作队列',()=>context.showQueue()));root.append(tools,focused(context));
    const section=panel(context,'关键词批次','新词需审核后再扫描。自动采集不等于证据确认。');
    const actions=el(context,'div','rw-actions');actions.append(button(context,'＋ 添加关键词',()=>context.openForm({kind:'add_keyword'})),button(context,'AI 建议初始词',()=>context.showQueue({kind:'keywords'})),button(context,'扫描全部已审核词',()=>context.showQueue({kind:'scan_all'})));section.append(actions);
    const table=el(context,'table','rw-table'),head=el(context,'tr');for(const label of ['实际搜索词','类型 / 来源','状态','操作'])head.append(el(context,'th','',label));table.append(head);
    for(const word of p.keywords||[]){const row=el(context,'tr');row.dataset.rwKeyword=word.id;
        row.append(el(context,'td','',word.text),el(context,'td','',`${typeNames[word.type]||word.type||'未知'} · ${word.parent_id?'扩词第'+word.depth+'层':'初始词'}`));
        const status=el(context,'td');status.append(stateTag(context,word.status),el(context,'p','rw-muted',keywordSearchSummary(word,context.state.keywordActions)));
        if(word.message)status.append(el(context,'p','rw-muted',word.message));
        if(word.needs_normalization)status.append(el(context,'p','rw-notice',`格式需修正：${word.normalization_suggestion?'建议改为 '+word.normalization_suggestion:'当前内容无法形成有效精确词'}。修改后才能审核。`));
        if(word.parent_id&&word.source_quote)status.append(el(context,'p','rw-muted',`${word.source_kind||'旧版来源'}：${word.source_quote}`));
        if(word.stale_source||word.legacy_source)status.append(el(context,'p','rw-notice',word.stale_source?'来源已过期，请修改并重新选择当前来源。':'旧版引用粒度不足，批准前需补选具体来源。'));
        const cell=el(context,'td');cell.append(keywordControls(context,word),button(context,'查看探索入口',()=>{context.state.explorationKeyword=word.id;context.navigate('project');}));row.append(status,cell);table.append(row);
    }const wrap=el(context,'div','rw-table-wrap');wrap.append(table);section.append(wrap);root.append(section);
    const products=panel(context,'产品线索与档案','缺证据时保留待核验状态。');products.append(button(context,'＋ 添加已有商品',()=>context.openForm({kind:'add_product'})));
    for(const product of p.products||[]){const row=el(context,'div','rw-panel');const step=product.steps?.find(s=>!['passed','not_applicable'].includes(s.state));row.append(el(context,'h3','',product.name),el(context,'p','rw-muted',step?`${step.label}：${step.reason}`:'当前步骤状态待核对'),button(context,'打开产品档案 →',()=>context.selectProduct(product.id)));products.append(row);}root.append(products);return root;
}
export function renderPaths(context) {
    const root=el(context,'section'),heading=el(context,'h1','','关键词路径');heading.tabIndex=-1;root.append(heading,el(context,'p','rw-muted','父关键词 → 广告 / 产品 → 新词 → 下一轮研究。'),button(context,'← 全部项目',()=>context.navigate('projects')));
    for(const project of context.state.projects){const card=panel(context,project.title);
        for(const word of project.keywords||[]){const parent=project.keywords.find(k=>k.id===word.parent_id),row=el(context,'div','rw-panel',(parent?parent.text+' → ':'初始词 · ')+word.text);row.append(stateTag(context,word.status),el(context,'small','rw-muted',`深度 ${word.depth||0} · ${word.product_id?'有产品来源':'初始输入'}`));if(word.source_quote)row.append(el(context,'p','',word.source_quote));card.append(row);}card.append(button(context,'进入项目',()=>context.openProject(project.id)));root.append(card);
    }return root;
}
