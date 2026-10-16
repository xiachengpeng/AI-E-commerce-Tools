import { renderVerification } from './verification.mjs';
import { el, button, panel, stateTag, link, keywordSearchSummary } from '../components/elements.mjs';
import { keywordControls } from './exploration.mjs';
export function render(context) {
    const project=context.state.project,words=project.keywords||[],products=project.products||[];
    const word=words.find(k=>k.id===context.state.explorationKeyword)||words.find(k=>k.status!=='archived')||words[0];
    const root=panel(context,'兔子洞探索','搜索入口 → 看广告和商品 → 提取下一层词 → 审核再搜索。');root.dataset.explorationPanel='true';
    if(!word){root.append(el(context,'p','rw-muted','先添加一个类目、痛点或场景词；审核后再搜索。'));return root;}
    const label=el(context,'label','','切换搜索词'),select=el(context,'select');select.setAttribute('aria-label','切换搜索词');
    for(const item of words){const option=el(context,'option','',item.text);option.value=item.id;select.append(option);}select.value=word.id;
    context.life.listen(select,'change',()=>{context.state.explorationKeyword=select.value;context.navigate('project');});label.append(select);root.append(label,stateTag(context,word.status),el(context,'p','rw-muted',keywordSearchSummary(word,context.state.keywordActions)),keywordControls(context,word));
    if(word.source_quote)root.append(el(context,'blockquote','',word.source_quote));
    const action=context.state.keywordActions?.[word.id];if(action?.recovery_action==='manual')root.append(el(context,'p','rw-notice','提交状态不确定，先按任务标签 '+action.id+' 核对云端记录。'));
    root.append(renderVerification(context,word));
    const matched=products.filter(p=>!p.merged_into&&(p.source_keyword_ids||[]).includes(word.id)&&(!context.state.focusReviewOnly?.[word.id]||(!p.identification?.relevance_confirmed&&['pending','retained'].includes(p.triage?.state||'pending')&&['needs_review','mismatch'].includes(p.verification?.status))));
    const index=Math.min(context.state.focusIndices?.[word.id]||0,Math.max(0,matched.length-1));const product=matched[index];
    if(product){
        const nav=el(context,'div','rw-actions');for(const [text,delta] of [['上一条线索',-1],['下一条线索',1]]){const b=button(context,text,()=>{context.state.focusIndices||={};context.state.focusIndices[word.id]=index+delta;context.navigate('project');});b.disabled=index+delta<0||index+delta>=matched.length;nav.append(b);}root.append(nav);
        const confirmed=product.identification?.relevance_confirmed===true,info=panel(context,product.name,confirmed?'相关性已确认 · 粗筛与渠道验证仍需分别核对':'待核验 · 需确认与关键词相关、具体商品及原文来源，才能继续提取下层词。');
        info.append(el(context,'p','rw-muted',`品牌：${product.identification?.brand||'未知'} · 商品相关性：${confirmed?'已确认':'待确认'}`),link(context,'查看商品来源',product.url),button(context,confirmed?'验证这个商品':'确认具体商品',()=>context.selectProduct(product.id)));
        if(product.verification){info.append(el(context,'p','',product.verification.reason||'疑点未记录'));for(const citation of product.verification.citations||[])info.append(el(context,'blockquote','',(citation.source_kind==='ad'?'广告原文：':'商品页原文：')+citation.source_quote));}
        const adIds=new Set((product.candidate_sources||[]).filter(binding=>binding.keyword_id===word.id).map(binding=>binding.ad_id));
        const boundAds=(word.ads||[]).filter(ad=>adIds.has(ad.id));for(const ad of boundAds)info.append(el(context,'blockquote','',ad.primary_text||'尚无可核对的广告原文。'));
        root.append(info);
        const expansion=panel(context,'从这个线索继续挖','先确认商品相关性和可引用原文，再提取下一层词；新词仍需审核。');
        const children=words.filter(k=>k.parent_id===word.id&&k.product_id===product.id),rules=project.rules||project.limits||{};
        if(!confirmed){const disabled=button(context,'提取下一层词',()=>{});disabled.disabled=true;expansion.append(disabled);}
        else if(!(product.expansion_sources||[]).length)expansion.append(el(context,'p','rw-muted','先读取商品页或补充关联广告，取得原文后再提词。'),button(context,'补充来源',()=>context.selectProduct(product.id)));
        else if((word.depth||0)>=(rules.max_depth??3)||children.length>=(rules.expansion_limit??5))expansion.append(el(context,'p','rw-muted','已达当前扩词上限；可处理已有新词，或继续验证商品。'));
        else expansion.append(button(context,'提取下一层建议',()=>context.showQueue({kind:'expand',product_id:product.id,keyword_id:word.id})),button(context,'手动提取新词',()=>context.openForm({kind:'add_keyword',parent:word,product})));
        for(const child of children)expansion.append(el(context,'p','',child.text),el(context,'p','rw-muted','提词依据：'+(child.source_quote||'旧记录未保存引用')),keywordControls(context,child));root.append(expansion);
    }else{
        for(const ad of word.ads||[]){const card=panel(context,ad.advertiser||'公开广告','待核验 · 广告采集结果仍需确认具体商品与原文来源。');card.append(el(context,'blockquote','',ad.primary_text||'尚无可核对的广告原文。'),button(context,'添加具体商品',()=>context.openForm({kind:'add_product'})),link(context,'查看原广告','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));root.append(card);}
        if(keywordSearchSummary(word,context.state.keywordActions).startsWith('本次采集 0 条'))root.append(el(context,'p','rw-notice','本次采集 0 条，不代表没有机会。核对地域和精准短语，尝试更短的词或换一个痛点、场景。'),button(context,'换一个搜索入口',()=>context.openForm({kind:'new_search_entry',type:word.type})));
    }
    return root;
}
