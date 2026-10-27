import {createKeywordProgress} from '../components/keyword-progress.mjs';
import { bindProgressRefresh } from '../services/snapshot.mjs';
import { el, button, panel, stateTag, typeNames, keywordSearchSummary } from '../components/elements.mjs';
import { render as focused } from './focused-exploration.mjs';
import {icon,productThumbnail,adThumbnail} from '../components/presentation.mjs';
import {scanCandidates} from '../services/journey.mjs';
export function keywordControls(context,word) {
    const node=el(context,'div','rw-actions'),action=context.state.keywordActions?.[word.id];
    if(action&&['queued','ready','running'].includes(action.status)){node.append(stateTag(context,action.display_status||action.status),button(context,'停止本次搜索',()=>context.showQueue({keyword_id:word.id,action_id:action.id})));return node;}
    if(word.status==='archived'){node.append(button(context,'恢复并重新审核',()=>context.command('restore_keyword',{keyword_id:word.id})));return node;}
    if(!word.approved){
        node.append(button(context,'修改',()=>context.openForm({kind:'edit_keyword',keyword:word,parent:word.parent_id?context.state.project.keywords.find(k=>k.id===word.parent_id):null,product:context.state.project.products.find(p=>p.id===word.product_id)})));
        if(!word.needs_normalization&&!word.stale_source&&!word.legacy_source)node.append(button(context,'审核通过',()=>context.command('approve_keyword',{keyword_id:word.id,approved:true})),button(context,'审核并搜索',async()=>{await context.command('approve_keyword',{keyword_id:word.id,approved:true});if(context.state.project?.keywords?.find(k=>k.id===word.id)?.approved)context.showQueue({kind:'scan',keyword_id:word.id});},'rw-primary'));
    }else if(action?.status==='blocked'&&action.recovery_action==='manual')node.append(el(context,'p','rw-notice','提交状态不确定，先按任务标签 '+action.id+' 核对云端记录，避免重复收费。'));
    else if(action?.status==='blocked'||!['complete','queued','running'].includes(word.status))node.append(button(context,action?.recovery_action==='resume'?'继续查询结果':action?.recovery_action==='restart'?'重新搜索':action?.status==='blocked'?'重试搜索':'搜索这个词',()=>context.showQueue({kind:'scan',keyword_id:word.id,...(action?.rescan_of?{rescan_of:action.rescan_of,retry_action_id:action.id}:{})}),'rw-primary'));
    else if(word.status==='complete'&&action?.status==='complete'&&action.id)node.append(button(context,'重新搜索并补充',()=>context.showQueue({kind:'scan',keyword_id:word.id,rescan_of:action.id}),'rw-primary'));
    if(!['queued','running'].includes(word.status))node.append(button(context,'不再采用',()=>context.command('archive_keyword',{keyword_id:word.id})));
    return node;
}
export function render(context) {
    bindProgressRefresh(context);
    const p=context.state.project,root=el(context,'section','rw-exploration-page'),heading=el(context,'h1','',p.title);heading.tabIndex=-1;root.dataset.projectSection=context.state.projectSection||'leads';root.append(heading,el(context,'p','rw-project-direction',`${p.market} · ${p.direction||''}`));
    const tools=el(context,'div','rw-actions rw-exploration-tools');tools.append(button(context,'← 全部项目',()=>context.navigate('projects')),button(context,'研究任务',()=>context.showQueue()),button(context,'选品队列',()=>{context.state.product=null;context.navigate('triage');}),button(context,'结论与复盘',()=>context.navigate('reports')));
    const advanced=el(context,'details','rw-stage-details'),more=el(context,'div','rw-actions');advanced.append(el(context,'summary','','更多：搜索路径、规则、采集方式与同步'));
    more.append(button(context,'关键词路径',()=>context.navigate('paths')),button(context,'项目规则与预算',()=>context.openForm({kind:'configure_rules'})),button(context,'设置采集模式',()=>context.openForm({kind:'configure_collection'})),button(context,'飞书同步与状态',()=>{context.state.view='sync';context.navigate('sync');}));advanced.append(more);root.append(tools,advanced);
    // Each journey stop owns a different task, including before any results exist.
    if(context.state.projectSection==='keywords'){root.append(renderKeywordSection(context));return root;}
    if(!(p.keywords||[]).length&&!(p.products||[]).length){
        const start=panel(context,'还没有可核实的商品线索','先到“找线索”准备并审核搜索词，再搜索公开广告；如果已有商品，可以直接添加链接。'),actions=el(context,'div','rw-actions rw-project-start-actions');
        actions.append(button(context,'去找线索',()=>{context.state.projectSection='keywords';context.navigate('project');},'rw-primary'),button(context,'添加已有商品',()=>context.openForm({kind:'add_product'})));start.append(actions);root.append(start);return root;
    }
    root.append(focused(context));
    const products=panel(context,'产品线索与档案','缺证据时保留待核验状态。');products.classList.add('rw-product-index');products.append(button(context,'＋ 添加已有商品',()=>context.openForm({kind:'add_product'})));
    for(const product of p.products||[]){const row=el(context,'div','rw-panel');const step=product.steps?.find(s=>!['passed','not_applicable'].includes(s.state));row.append(el(context,'h3','',product.name),el(context,'p','rw-muted',step?`${step.label}：${step.reason}`:'当前步骤状态待核对'),button(context,'打开产品档案 →',()=>context.selectProduct(product.id)));products.append(row);}if((p.keywords||[]).length||(p.products||[]).length){const allProducts=el(context,'details','rw-all-products');allProducts.append(el(context,'summary','','全部商品档案（'+(p.products?.length||0)+'）'),products);root.append(allProducts);}return root;
}
export function renderPaths(context) {
    const root=el(context,'section','rw-paths-page'),heading=el(context,'h1','','关键词路径');heading.tabIndex=-1;
    root.append(heading,el(context,'p','rw-muted','在这里查看关键词的来源路径，了解它来自哪条广告、关联哪个商品，以及可能的下一层搜索词。'));
    const workspace=el(context,'div','rw-path-workspace'),main=el(context,'div','rw-path-map'),inspector=el(context,'aside','rw-path-inspector');workspace.append(main,inspector);root.append(workspace);
    const note=el(context,'div','rw-path-readonly');note.append(icon(context,'info'),el(context,'span','','此处只查看路径，不自动扫描、不自动访问。'),button(context,'查看完整检查清单',()=>context.navigate('reports')));main.append(note);
    const open=async(project,product)=>{if(context.state.project?.id!==project.id)await context.openProject(project.id);if(context.state.project?.id===project.id)context.openProduct(project.id,product.id,'identification');};
    const inspect=(project,word)=>{
        context.state.pathKeyword=project.id+':'+word.id;inspector.replaceChildren(el(context,'h2','','关键词详情'));
        inspector.append(el(context,'small','rw-muted','当前关键词'),el(context,'h3','',word.text),stateTag(context,word.status));
        const parent=(project.keywords||[]).find(k=>k.id===word.parent_id);if(parent)inspector.append(el(context,'h4','','父关键词'),el(context,'p','',parent.text),stateTag(context,parent.status));
        const products=(project.products||[]).filter(p=>!p.merged_into&&((p.source_keyword_ids||[]).includes(word.id)||p.id===word.product_id));
        const boundIds=new Set(products.flatMap(p=>(p.candidate_sources||[]).filter(b=>b.keyword_id===(word.source_keyword_id||parent?.id||word.id)).map(b=>b.ad_id)));
        const sourceWord=project.keywords.find(k=>k.id===(word.source_keyword_id||parent?.id||word.id)),ads=(sourceWord?.ads||[]).filter(a=>word.source_ad_id?a.id===word.source_ad_id:boundIds.has(a.id));
        inspector.append(el(context,'h4','','绑定广告'));if(!ads.length)inspector.append(el(context,'p','rw-muted','未记录可核对的具体广告绑定'));for(const ad of ads)inspector.append(el(context,'p','',ad.advertiser||'来源广告'),el(context,'small','rw-muted','广告 '+ad.id));
        inspector.append(el(context,'h4','','商品身份（当前）'));for(const product of products)inspector.append(productThumbnail({...context,state:{...context.state,project}},product),button(context,product.name,()=>open(project,product)));if(!products.length)inspector.append(el(context,'p','rw-muted','未关联具体商品'));
        if(word.source_quote)inspector.append(el(context,'h4','','引用原文'),el(context,'blockquote','',word.source_quote));
        if(word.source_url){const link=el(context,'a','',word.source_url);try{const u=new URL(word.source_url);if(['http:','https:'].includes(u.protocol)){link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';inspector.append(el(context,'h4','','引用来源'),link);}}catch{/* Invalid legacy URL stays omitted. */}}
        inspector.append(button(context,'回到词审核',async()=>{if(context.state.project?.id!==project.id)await context.openProject(project.id);if(context.state.project?.id===project.id){context.state.projectSection='keywords';context.navigate('project');}},'rw-primary'));
    };
    let first=null;
    for(const project of context.state.projects){const card=panel(context,project.title),header=el(context,'div','rw-path-header');
        for(const name of ['搜索词','来源广告','具体商品','下一层搜索词'])header.append(el(context,'strong','',name));card.append(header);
        const roots=(project.keywords||[]).filter(word=>!word.parent_id||!project.keywords.some(k=>k.id===word.parent_id)||(word.ads||[]).length||(project.products||[]).some(p=>(p.source_keyword_ids||[]).includes(word.id)));
        const keywordNode=word=>{const item=button(context,'',()=>inspect(project,word),'rw-path-keyword');item.dataset.inspectKeyword=word.id;item.append(el(context,'strong','',word.text),stateTag(context,word.status),icon(context,'caret-right'));return item;};
        for(const word of roots){
            const row=el(context,'div','rw-path-lineage'),origin=el(context,'div','rw-path-node'),adCell=el(context,'div','rw-path-node'),productCell=el(context,'div','rw-path-node'),children=el(context,'div','rw-path-node');origin.append(keywordNode(word));
            const products=(project.products||[]).filter(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id)),ids=new Set(products.flatMap(p=>(p.candidate_sources||[]).filter(b=>b.keyword_id===word.id).map(b=>b.ad_id))),ads=(word.ads||[]).filter(a=>ids.has(a.id));
            for(const ad of ads){const item=el(context,'div','rw-path-ad');item.append(adThumbnail({...context,state:{...context.state,project}},word,ad),el(context,'strong','',ad.advertiser||'来源广告'),el(context,'small','rw-muted','广告 '+ad.id));adCell.append(item);}
            if(!ads.length)adCell.append(icon(context,'megaphone'),el(context,'p','rw-muted','未绑定具体广告'));
            for(const [index,product] of products.entries()){const item=el(context,'div','rw-path-product');item.append(productThumbnail({...context,state:{...context.state,project}},product),button(context,product.name,()=>open(project,product)));if(index===0)productCell.append(item);else{let more=productCell.children[1];if(!more){more=el(context,'details','rw-path-more-products');more.append(el(context,'summary','','另 '+(products.length-1)+' 个关联商品'));productCell.append(more);}more.append(item);}}
            if(!products.length)productCell.append(icon(context,'package'),el(context,'p','rw-muted','未关联具体商品'));
            const next=(project.keywords||[]).filter(k=>k.parent_id===word.id);for(const child of next)children.append(keywordNode(child));if(!next.length)children.append(icon(context,'magnifying-glass'),el(context,'p','rw-muted','暂无下一层搜索词'));
            if(!first)first=[project,next[0]||word];for(const node of [origin,adCell,productCell]){const connector=icon(context,'arrow-right');connector.classList.add('rw-path-connector');node.append(connector);}row.append(origin,adCell,productCell,children);card.append(row);
        }card.append(button(context,'进入项目',()=>context.openProject(project.id)));main.append(card);
    }
    const saved=context.state.projects.flatMap(project=>(project.keywords||[]).map(word=>[project,word])).find(([project,word])=>context.state.pathKeyword===project.id+':'+word.id);if(saved||first)inspect(...(saved||first));else inspector.append(el(context,'p','rw-muted','尚无可查看的关键词路径。'));
    return root;
}

/** Shared keyword table and handlers for the list and its edit drawer. */
export function renderKeywordSection(context,{readOnly=false}={}){
    const p=context.state.project;
    const section=panel(context,'关键词批次','新词需审核后再扫描。自动采集不等于证据确认。');section.classList.add('rw-keyword-section');if(!readOnly)section.classList.add('rw-keyword-editable');
    const header=el(context,'header','rw-keyword-section-header'),heading=el(context,'div','rw-keyword-heading'),title=section.querySelector('h2'),note=section.querySelector('p');title.remove();note.remove();heading.append(title,note);header.append(heading);section.append(header);
    if(!readOnly){const actions=el(context,'div','rw-actions'),scan=button(context,'扫描全部已审核词',()=>context.showQueue({kind:'scan_all'})),suggest=button(context,'AI 建议初始词',()=>context.showQueue({kind:'keywords'}));actions.append(button(context,'＋ 添加关键词',()=>context.openForm({kind:'add_keyword'})),suggest,scan);scan.disabled=scanCandidates(p).length===0;if(scan.disabled)scan.title='先添加并审核搜索词，再批量扫描';header.append(actions);const progress=createKeywordProgress(context,{onBusy:busy=>{suggest.disabled=busy;section.dataset.keywordBusy=String(busy);}});context.keywordProgress=progress;section.append(progress.host);}
    else section.append(el(context,'p','rw-keyword-edit-hint','先保存或取消右侧编辑，再审核或搜索。复选标记表示已保存的审核状态。'));
    if(!(p.keywords||[]).length){section.append(el(context,'p','rw-muted rw-keyword-empty','还没有搜索词，先添加关键词或让 AI 根据研究方向提供建议。'));return section;}
    const table=el(context,'table','rw-table'),head=el(context,'tr');for(const label of ['审核','实际搜索词','类型 / 来源','中文解释','状态',...(readOnly?[]:['操作'])])head.append(el(context,'th','',label));table.append(head);
    for(const word of p.keywords||[]){const row=el(context,'tr');row.dataset.rwKeyword=word.id;
        const reviewed=el(context,'td'),check=el(context,'input');check.type='checkbox';check.checked=word.approved===true;check.disabled=true;check.setAttribute('aria-label',word.text+' · 已审核状态');reviewed.append(check);const type=el(context,'td');type.append(el(context,'span','rw-keyword-type',typeNames[word.type]||word.type||'未知'),el(context,'small','rw-keyword-origin',word.parent_id?'扩词第'+word.depth+'层':'初始词'));row.append(reviewed,el(context,'td','',word.text),type,el(context,'td','',word.meaning||'待补充'));
        const status=el(context,'td','rw-keyword-status');status.append(stateTag(context,word.status),el(context,'p','rw-muted',keywordSearchSummary(word,context.state.keywordActions)));
        if(word.message)status.append(el(context,'p','rw-muted',word.message));
        if(word.needs_normalization)status.append(el(context,'p','rw-notice',`格式需修正：${word.normalization_suggestion?'建议改为 '+word.normalization_suggestion:'当前内容无法形成有效精确词'}。修改后才能审核。`));
        if(word.parent_id&&word.source_quote){const quote=el(context,'details','rw-keyword-citation');quote.append(el(context,'summary','','查看引用来源'),el(context,'p','rw-muted',`${word.source_kind||'旧版来源'}：${word.source_quote}`));status.append(quote);}
        if(word.stale_source||word.legacy_source)status.append(el(context,'p','rw-notice',word.stale_source?'来源已过期，请修改并重新选择当前来源。':'旧版引用粒度不足，批准前需补选具体来源。'));
        row.append(status);if(!readOnly){const cell=el(context,'td','rw-keyword-actions-cell'),controls=keywordControls(context,word),primary=controls.querySelector?.('.rw-primary');controls.classList.add('rw-keyword-row-actions');if(primary)controls.insertBefore(primary,controls.firstChild);cell.append(controls,button(context,'查看探索入口',()=>{context.state.explorationKeyword=word.id;context.state.projectSection='leads';context.navigate('project');},'rw-keyword-open'));row.append(cell);}table.append(row);
    }const wrap=el(context,'div','rw-table-wrap');wrap.append(table);section.append(wrap);return section;
}
