import {createLifecycle} from '../lifecycle.mjs';
import {isMismatch} from '../components/identity-result.mjs';
import {renderCollectionMode,renderCollectionProfiles} from '../components/collection-mode.mjs';
import { sourcePreview, adTextPanel } from '../components/ad-copy.mjs';
import {productPageStatus} from '../components/product-page-status.mjs';
import {productFacts} from '../components/product-facts.mjs';
import { renderVerification } from './verification.mjs';
import { el, button, panel, stateTag, link, keywordSearchSummary } from '../components/elements.mjs';
import { keywordControls } from './exploration.mjs';
import {renderCandidateList} from '../components/presentation.mjs';
export function render(context) {
    const project=context.state.project,words=project.keywords||[],products=project.products||[];
    const word=words.find(k=>k.id===context.state.explorationKeyword)||words.find(k=>k.status!=='archived')||words[0];
    const root=panel(context,'沿商品线索找机会','审核搜索词 → 找公开广告 → 核实商品 → 决定是否继续研究。需要更多机会时，再从可靠原文提取新词。');root.dataset.explorationPanel='true';
    if(!word){root.append(el(context,'p','rw-muted','先添加一个类目、痛点或场景词；审核后再搜索。'));return root;}
    const label=el(context,'label','','切换搜索词'),select=el(context,'select');select.setAttribute('aria-label','切换搜索词');
    for(const item of words){const meaning=typeof item.meaning==='string'?item.meaning.trim():'';const option=el(context,'option','',item.text+(meaning?' — '+meaning:''));option.value=item.id;select.append(option);}select.value=word.id;
    const meaning=typeof word.meaning==='string'?word.meaning.trim():'';
    context.life.listen(select,'change',()=>{context.state.explorationKeyword=select.value;context.navigate('project');});label.append(select,el(context,'span','rw-keyword-meaning',meaning?'中文释义：'+meaning:'中文释义待补充，可在“找线索”中修改补充。'));const toolbar=el(context,'div','rw-search-toolbar');const summary=el(context,'div','rw-collection-status');summary.append(el(context,'p','rw-muted',keywordSearchSummary(word,context.state.keywordActions)));
    if(context.state.keywordActions?.[word.id]||['blocked','running','queued','complete'].includes(word.status))summary.append(button(context,'查看采集日志',()=>context.showCollectionLogs?.(word.id),'rw-collection-log-trigger'));
    toolbar.append(label,renderCollectionMode(context,word),stateTag(context,word.status),summary,keywordControls(context,word),renderCollectionProfiles(context,word));root.append(toolbar);
    if(word.source_quote)root.append(el(context,'blockquote','',word.source_quote));
    const action=context.state.keywordActions?.[word.id];if(action?.recovery_action==='manual')root.append(el(context,'p','rw-notice','提交状态不确定，先按任务标签 '+action.id+' 核对云端记录。'));
    const verifyOptions=el(context,'details','rw-verification-options'),disclosureKey=project.id+':'+word.id;verifyOptions.dataset.verificationOptions='true';context.state.verificationExpanded||={};
    verifyOptions.append(el(context,'summary','','自动核对与筛选选项'),renderVerification(context,word));verifyOptions.open=!!context.state.verificationExpanded[disclosureKey]||['ready','queued','running','blocked'].includes(context.state.verificationActions?.[word.id]?.status);
    context.life.listen(verifyOptions,'toggle',()=>{context.state.verificationExpanded[disclosureKey]=verifyOptions.open;});root.append(verifyOptions);
    const matched=products.filter(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id)&&(!context.state.focusReviewOnly?.[word.id]||(!p.identification?.relevance_confirmed&&['pending','retained'].includes(p.triage?.state||'pending')&&['needs_review','mismatch'].includes(p.verification?.status))));
    const index=Math.min(context.state.focusIndices?.[word.id]||0,Math.max(0,matched.length-1));const product=matched[index];
    if(product){
        // Candidate selection is local view state: keep the page, list and toolbar mounted.
        const master=el(context,'div','rw-master-detail'),workspace=el(context,'div','rw-source-workspace');
        let selectedIndex=index,detailLife=createLifecycle();
        context.life.track(()=>detailLife.dispose());
        const list=renderCandidateList(context,matched,product.id,item=>selectCandidate(matched.findIndex(p=>p.id===item.id)));
        function selectCandidate(nextIndex){
            if(!context.life.active||nextIndex===selectedIndex||nextIndex<0||nextIndex>=matched.length)return;
            const positions=[];
            for(let node=master;node;node=node.parentElement)if(typeof node.scrollTop==='number')positions.push([node,node.scrollTop,node.scrollLeft]);
            // Keep a shorter result from shrinking the document and clamping its scroll position.
            const height=workspace.getBoundingClientRect?.().height;
            const previewHeight=workspace.querySelector('.rw-media-preview')?.getBoundingClientRect?.().height;
            if(height&&workspace.style){workspace.style.minHeight=height+'px';workspace.style.overflowAnchor='none';}
            detailLife.dispose();detailLife=createLifecycle();selectedIndex=nextIndex;
            context.state.focusIndices||={};context.state.focusIndices[word.id]=nextIndex;
            const detailContext={...context,life:detailLife};
            workspace.replaceChildren(...renderDetail(detailContext,matched[nextIndex],nextIndex));
            const preview=workspace.querySelector('.rw-media-preview');
            if(previewHeight&&preview?.style)preview.style.minHeight=previewHeight+'px';
            for(const row of list.children)if(row.dataset.candidateId)row.setAttribute('aria-pressed',String(row.dataset.candidateId===matched[nextIndex].id));
            for(const [node,top,left] of positions){node.scrollTop=top;node.scrollLeft=left;}
        }
        function renderDetail(context,product,index){
        const nav=el(context,'div','rw-actions rw-lead-pager');for(const [text,delta] of [['上一条线索',-1],['下一条线索',1]]){const b=button(context,text,()=>selectCandidate(index+delta));b.disabled=index+delta<0||index+delta>=matched.length;nav.append(b);}
        const mismatch=isMismatch(product),confirmed=product.identification?.relevance_confirmed===true,ai=confirmed&&product.identification?.confirmation_method==='ai',info=panel(context,product.name,confirmed?(ai?'AI 判断相关 · 待你人工核对；粗筛与渠道验证仍需分别完成':'人工已确认相关性 · 粗筛与渠道验证仍需分别核对'):mismatch?'人工核对不一致 · 已保留原因。可更正商品链接后重新核对，当前不能继续扩词。':'待核验 · 需确认与关键词相关、具体商品及原文来源，才能继续提取下层词。');
        const identity=()=>context.showProductIdentity?context.showProductIdentity(product.id):context.selectProduct(product.id);
        const next=button(context,confirmed&&!ai?'核实广告素材':mismatch?'重新核对商品与广告':'核对商品与广告',confirmed&&!ai?()=>context.openProduct?context.openProduct(project.id,product.id,'coarse'):context.selectProduct(product.id):identity);next.dataset.productIdentityTrigger=product.id;
        info.append(el(context,'p','rw-muted',`品牌：${product.identification?.brand||'未知'} · 商品相关性：${confirmed?(ai?'AI 已匹配，待人工核对':'人工已确认'):mismatch?'人工确认不一致':'待确认'}`),link(context,'查看商品来源',product.url));
        if(mismatch)info.append(el(context,'p','rw-notice','不一致原因：'+(product.identification.reason||'未记录')));
        if(product.verification){info.append(el(context,'p','',product.verification.reason||'疑点未记录'));for(const citation of product.verification.citations||[])info.append(el(context,'blockquote','',(citation.source_kind==='ad'?'广告原文：':'商品页原文：')+citation.source_quote));}
        const adIds=new Set((product.candidate_sources||[]).filter(binding=>binding.keyword_id===word.id).map(binding=>binding.ad_id));
        const boundAds=(word.ads||[]).filter(ad=>adIds.has(ad.id));
        const controls=el(context,'section','rw-focus-controls'),guide=el(context,'div','rw-lead-next-guide');guide.append(el(context,'strong','',confirmed&&!ai?'下一步：核实广告素材':'下一步：核对商品与广告'),el(context,'p','rw-muted',confirmed&&!ai?'检查广告投放时间、当前状态与独立素材，判断是否值得继续研究。':'打开核对窗口，对照商品页与广告，确认准确商品链接和相关性依据。'));next.classList.add('rw-primary');controls.append(guide,next);if(confirmed&&!ai)controls.append(button(context,'修改商品核对',identity));controls.append(nav);info.append(controls);
        const take=el(context,'section','rw-lead-triage');take.append(el(context,'h3','','这条线索怎么处理'),el(context,'p','rw-muted','只筛选值得投入的商品；不合适的可以直接记录原因，不必先填完后续资料。'));
        const disposition=product.triage?.state||'pending',triage=el(context,'div','rw-actions');
        take.append(el(context,'p','rw-muted','当前初筛：'+({pending:'尚未判断',retained:'保留深挖',observing:'暂存观察',rejected:'已淘汰'})[disposition]));
        const openTriage=value=>{if(context.openTriage)context.openTriage(product.id,value);else{context.state.product=product.id;context.state.triageIntent={productId:product.id,disposition:value};context.navigate('triage');}};
        for(const [value,title] of [['retained','保留并深挖'],['observing','暂存观察'],['rejected','淘汰这条线索']])if(value!==disposition)triage.append(button(context,title,()=>openTriage(value),value==='rejected'?'rw-danger':''));
        if(['observing','rejected'].includes(disposition))triage.append(button(context,'查看初筛与恢复',()=>openTriage(null)));
        take.append(triage);info.append(take);
        const checklist=el(context,'div','rw-focus-evidence');checklist.append(el(context,'h3','','还需核实'));
        for(const [name,status] of [['商品匹配',confirmed?(ai?'AI 已匹配，待人工核对':'人工已确认'):mismatch?'不一致':'待确认'],['需求与竞争',product.steps?.find(s=>s.key==='channels')?.state==='passed'?'已保存核对结果':'待核实'],['采购与物流',product.steps?.find(s=>s.key==='economics')?.state==='passed'?'已保存核对结果':'待填写']]){const row=el(context,'div','rw-focus-evidence-row');row.append(el(context,'strong','',name),el(context,'span','rw-tag',status));checklist.append(row);}info.append(checklist);
        const media=el(context,'section','rw-lead-media'),productPanel=el(context,'section','rw-lead-product-content'),adPanel=el(context,'section','rw-lead-ad-content');productPanel.dataset.leadContent='product';adPanel.dataset.leadContent='ad';const facts=productFacts(context,product);if(facts)productPanel.append(facts);productPanel.append(productPageStatus(context,product,{showFacts:false}));
        for(const ad of boundAds){const copy=el(context,'section','rw-source-ad-copy');copy.dataset.sourceAd=ad.id;copy.append(el(context,'h3','','广告原文与来源 · '+(ad.advertiser||'来源广告')),link(context,'查看原广告','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)),adTextPanel(context,word,ad));adPanel.append(copy);}
        const gallery=sourcePreview(context,word,product,boundAds,{onSelectionChange:({source,adId})=>{productPanel.hidden=source!=='product';adPanel.hidden=source!=='ad';for(const copy of adPanel.children)copy.hidden=copy.dataset.sourceAd!==adId;}});media.append(gallery,productPanel,adPanel);
        const expansion=el(context,'section','rw-lead-discovery'),expansionHead=el(context,'header','rw-discovery-heading'),expansionIcon=el(context,'i','ph ph-magnifying-glass');expansionIcon.setAttribute('aria-hidden','true');expansionHead.append(expansionIcon,el(context,'h3','','继续寻找相关机会'));expansion.append(expansionHead,el(context,'p','rw-muted','从当前商品的可靠原文提取下一层搜索词，发现更多相关线索。新词仍需审核。'));
        const children=words.filter(k=>k.parent_id===word.id&&k.product_id===product.id),rules=project.rules||project.limits||{};
        if(!confirmed){expansion.dataset.discoveryState='unconfirmed';expansion.append(el(context,'p','rw-discovery-prerequisite',mismatch?'当前已确认不一致，请先更正商品链接并重新核对。':'先确认广告与这个商品相关，再从已保存原文提取新词。'),button(context,'先核对商品与广告',identity));}
        else if(!(product.expansion_sources||[]).length){expansion.dataset.discoveryState='missing_source';expansion.append(el(context,'p','rw-discovery-prerequisite','还缺可引用原文：先读取商品页或补充关联广告。'),button(context,'补充原文来源',()=>context.selectProduct(product.id)));}
        else if((word.depth||0)>=(rules.max_depth??3)||children.length>=(rules.expansion_limit??5)){expansion.dataset.discoveryState='limit';expansion.append(el(context,'p','rw-discovery-prerequisite','已达当前扩词上限，可先处理已有建议或继续核实当前商品。'));}
        else{expansion.dataset.discoveryState='ready';const actions=el(context,'div','rw-discovery-actions');actions.append(button(context,'AI 提取搜索词',()=>context.showQueue({kind:'expand',product_id:product.id,keyword_id:word.id})),button(context,'手动添加',()=>context.openForm({kind:'add_keyword',parent:word,product})));expansion.append(actions,el(context,'p','rw-discovery-cost','AI 操作需确认，可能产生费用；不会自动开始搜索。'));}
        if(children.length){const suggestions=el(context,'details','rw-discovery-children');suggestions.append(el(context,'summary','','已提取建议（'+children.length+'）'));for(const child of children)suggestions.append(el(context,'p','',child.text),el(context,'p','rw-muted','提词依据：'+(child.source_quote||'旧记录未保存引用')),keywordControls(context,child));expansion.append(suggestions);}info.append(expansion);
        return [media,info];
        }
        workspace.append(...renderDetail({...context,life:detailLife},product,index));master.append(list,workspace);root.append(master);
    }else if(context.state.focusReviewOnly?.[word.id]&&products.some(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id))){
        const empty=panel(context,'当前没有需要人工确认的商品','筛选已隐藏其他商品。可以显示全部商品继续查看，不会改变已有核实结果。');empty.classList.add('rw-lead-empty');empty.dataset.leadEmpty='filter';empty.append(button(context,'显示全部商品',()=>{context.state.focusReviewOnly[word.id]=false;context.navigate('project');}));root.append(empty);
    }else{
        if(!(word.ads||[]).length){const empty=panel(context,'当前搜索词还没有商品线索','先审核并搜索当前词，或切换到已有结果的搜索词。这里只查看和准备，不会自动开始搜索。');empty.classList.add('rw-lead-empty');empty.dataset.leadEmpty='no_results';
          const existing=words.find(k=>k.id!==word.id&&products.some(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(k.id)));
          if(existing)empty.append(button(context,'查看已有线索：'+existing.text,()=>{context.state.explorationKeyword=existing.id;context.navigate('project');},'rw-primary'));
          else empty.append(button(context,'准备搜索词',()=>{context.state.projectSection='keywords';context.navigate('project');}));root.append(empty);}
        for(const ad of word.ads||[]){const card=panel(context,ad.advertiser||'公开广告','待核验 · 广告采集结果仍需确认具体商品与原文来源。');card.append(adTextPanel(context,word,ad),button(context,'添加具体商品',()=>context.openForm({kind:'add_product'})),link(context,'查看原广告','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));const workspace=el(context,'div','rw-source-workspace');workspace.append(sourcePreview(context,word,null,[ad]),card);root.append(workspace);}
        if(keywordSearchSummary(word,context.state.keywordActions).startsWith('本次采集 0 条'))root.append(el(context,'p','rw-notice','本次采集 0 条，不代表没有机会。核对地域和精准短语，尝试更短的词或换一个痛点、场景。'),button(context,'换一个搜索入口',()=>context.openForm({kind:'new_search_entry',type:word.type})));
    }
    return root;
}
