export const marketNames = { US:'美国', GB:'英国', CA:'加拿大', AU:'澳大利亚', DE:'德国', FR:'法国', JP:'日本' };
export const typeNames = { category:'类目', function:'功能', audience:'人群', pain:'痛点', scenario:'场景 / 节日', brand:'品牌 / 产品', pain_scenario:'痛点 + 场景', scenario_audience:'场景 + 人群' };
export const labels = { pending_review:'待审核', ready:'可开始', queued:'排队中', running:'处理中', complete:'已完成', blocked:'等待来源', archived:'不再采用', manual_check:'需人工核对', unknown:'未知', stopped:'已停止', needs_review:'待人工确认', mismatch:'可能不相关', confirmed:'已确认', pending:'未开始' };
export function el(context, tag, className = '', text) {
    const node = context.root.ownerDocument.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text); return node;
}
export function button(context, label, callback, className = '') {
    const node = el(context,'button',className,label); node.type = 'button';
    context.life.listen(node,'click',async () => {
        if (node.disabled || !context.life.active) return; node.disabled = true;
        try { await callback(); } catch (error) { if (context.life.active) notify(context, error.message); }
        finally { if (context.life.active) node.disabled = false; }
    }); return node;
}
export function notify(context, message) {
    if (!context.life.active) return; const node = context.root.querySelector('[data-rw-status]'); if (node) node.textContent = message;
}
export function panel(context, title, note) {
    const node = el(context,'section','rw-panel');node.append(el(context,'h2','',title));if(note)node.append(el(context,'p','rw-muted',note));return node;
}
export function stateTag(context, value) { return el(context,'span','rw-tag',labels[value] || value || '未知'); }
export function link(context, label, value) {
    try { const url = new URL(value);if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error();
        const node = el(context,'a','',label);node.href=url.href;node.target='_blank';node.rel='noopener noreferrer';return node;
    } catch { return el(context,'span','rw-muted','来源链接待补充'); }
}
export function keywordSearchSummary(word, keywordActions = {}) {
    const action=keywordActions[word.id],count=word.ads?.length||0;
    if(action&&['ready','queued','running'].includes(action.status))return '搜索进行中 · 尚未取得本次结果'+(count?' · 保留 '+count+' 条历史广告':'');
    if(action?.status==='blocked'||word.status==='blocked')return (action?.display_status==='stopped'?'本次已停止':'本次采集未完成')+' · 不算零结果'+(count?' · 保留 '+count+' 条历史广告':'');
    if(action?.status==='complete') {
        const observed=Number.isInteger(action.result?.ads)?action.result.ads:action.result?.empty===true?0:null;
        if(observed!==null)return '本次采集 '+observed+' 条（限定样本）'+(count>observed?' · 累计保留 '+count+' 条广告':'');
        return count?count+' 条已保存广告 · 本次条数未记录':'已完成 · 本次条数未记录';
    }
    if(word.status==='complete')return count?count+' 条已保存广告（限定样本）':'本次采集 0 条（限定样本）';
    if(count)return count+' 条历史广告 · 当前结果需核对';
    if(['queued','running'].includes(word.status))return '搜索进行中 · 尚未取得本次结果';
    return word.scan_counted?'尚未取得可确认的搜索结果':'尚未搜索';
}
