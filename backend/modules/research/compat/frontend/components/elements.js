function el(tag,cls='',content){const n=document.createElement(tag);if(cls)n.className=cls;if(content!==undefined)n.textContent=content;return n;}
function button(label,fn,cls=''){const n=el('button',cls,label);n.type='button';n.onclick=async()=>{if(n.disabled)return;n.disabled=true;try{await fn();}finally{n.disabled=false;}};return n;}
function link(label,url){try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error();const a=el('a','',label);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return el('span','muted','来源链接待补充');}}
function box(title,note){const n=el('section','panel');n.append(el('h2','',title));if(note)n.append(el('p','',note));return n;}
function empty(title,note,btn){const n=el('div','empty');n.append(el('h2','',title),el('p','',note));if(btn)n.append(btn);return n;}
function warn(message,role=/^已(?:保存|保留|将|淘汰|撤销)/.test(message)?'status':'alert',action=null){S.feedback=message;const notice=$('alert');notice.replaceChildren(document.createTextNode(message));if(action){const undo=button(action.label,action.run,'notice-action');notice.append(undo);}notice.setAttribute('role',role);notice.classList.toggle('hidden',!message);}

function keywordSearchSummary(word) {
 const action=S.keywordActions[word.id],count=word.ads?.length||0;
 if(action&&['ready','queued','running'].includes(action.status))return '搜索进行中 · 尚未取得本次结果'+(count?' · 保留 '+count+' 条历史广告':'');
 if(action?.status==='blocked'||word.status==='blocked')return (action?.display_status==='stopped'?'本次已停止':'本次采集未完成')+' · 不算零结果'+(count?' · 保留 '+count+' 条历史广告':'');
 if(action?.status==='complete'){
  const observed=Number.isInteger(action.result?.ads)?action.result.ads:action.result?.empty===true?0:null;
  if(observed!==null)return '本次采集 '+observed+' 条（限定样本）'+(count>observed?' · 累计保留 '+count+' 条广告':'');
  return count?count+' 条已保存广告 · 本次条数未记录':'已完成 · 本次条数未记录';
 }
 if(word.status==='complete')return count?count+' 条已保存广告（限定样本）':'本次采集 0 条（限定样本）';
 if(count)return count+' 条历史广告 · 当前结果需核对';
 if(word.status==='queued'||word.status==='running')return '搜索进行中 · 尚未取得本次结果';
 if(word.scan_counted)return '尚未取得可确认的搜索结果';
 return '尚未搜索';
}
function keywordEntryHint(word) {
 if(word.parent_id)return '来自来源原文的下一轮入口；组合词仍需审核，不保证能找到广告。';
 return '先用常见入口找广告，再沿原文深挖；可尝试单词或常用短语，不必拼成长描述。';
}

function keywordFeedbackNode(focused=false){const n=el('div','keyword-feedback');if(focused)n.dataset.entryFeedback='true';else n.dataset.keywordFeedback='true';n.setAttribute('role','status');n.setAttribute('aria-live','polite');const feedback=S.keywordFeedback;if(!feedback||feedback.projectId!==S.project?.id){n.classList.add('hidden');return n;}let message=feedback.message,error=feedback.phase==='error';if(feedback.actionId){const action=S.actions.find(item=>item.id===feedback.actionId);if(action){if(action.status==='running')message='AI 正在生成初始词。完成后请审核新词，再开始搜索。';else if(action.status==='complete')message=focused?'AI 建议已处理。点击「切换搜索词」核对新词，审核后再搜索；如无新增，展开「任务与日志」查看。':'AI 建议已处理。请在下方核对新词并审核；如无新增，请查看自动处理记录。';else if(action.status==='blocked'||action.status==='failed'){message='AI 建议未完成：'+(action.message||'请查看自动处理记录并重试。');error=true;}}}if(focused&&message.startsWith('关键词已添加。'))message='入口词已添加。点击「切换搜索词」找到新词，审核后再搜索。';n.classList.toggle('keyword-feedback-error',error);n.textContent=message;return n;}
function setKeywordFeedback(phase,message,actionId=null){S.focusFeedbackPending=true;S.keywordFeedback={projectId:S.project?.id,phase,message,actionId};for(const current of document.querySelectorAll('[data-keyword-feedback], [data-entry-feedback]'))current.replaceWith(keywordFeedbackNode(current.hasAttribute('data-entry-feedback')));}
