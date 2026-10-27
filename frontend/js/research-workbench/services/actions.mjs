import { submitMutation, restoreDraft } from './commands.mjs';
export const projectPath=id=>'/projects/'+encodeURIComponent(id);
export const actionNames={keywords:'准备初始搜索词',expand:'从来源提取新词',scan:'搜索公开广告',scan_all:'批量搜索公开广告',verify:'核对商品相关性',landing:'读取商品页',trends:'核对需求趋势'};
export function actionResultSummary(action){
 const r=action.result||{};
 if(Number.isInteger(r.ads))return '本次采集 '+r.ads+' 条（限定样本）';
 if(['keywords','expand'].includes(action.kind)&&Number.isInteger(r.suggestions))return '新增 '+r.suggestions+' 个待审核关键词';
 if(action.kind==='verify'&&[r.matched,r.needs_review,r.mismatch].every(Number.isInteger))return `匹配 ${r.matched} 个 · 待确认 ${r.needs_review} 个 · 可能不相关 ${r.mismatch} 个`;
 if(action.kind==='landing'&&r.title)return '已读取商品页：'+r.title+' · 尚需人工核对';
 return '本次条数未记录；不推断为零。';
}
export function retryEligible(a){return ['blocked','failed'].includes(a.status)&&['retry','resume','restart'].includes(a.recovery_action);}
export function trendsQuery(action){return typeof action.query==='string'?action.query.trim():typeof action.payload?.query==='string'?action.payload.query.trim():'';}
export function actionStatus(a){return ({cloud_running:'云端处理中',queued:'排队中',ready:'排队中',running:'处理中',manual_check:'待人工核对 · 提交结果不确定',unknown:'未知 · 请核对',blocked:'等待来源',failed:'失败',retryable:'失败 · 可显式恢复',stopped:'已停止',complete:'已完成'})[a.display_status||a.status]||'未知 · 请核对';}
export function mergeActionPages(current,older){const ids=new Set(current.map(a=>a.id));return [...current,...older.filter(a=>!ids.has(a.id))];}
export function mediaPath(projectId,selector){
 const allowed=['keyword_id','product_id','ad_id','source','index'];
 if(Object.entries(selector).some(([k,v])=>!allowed.includes(k)||(k.endsWith('_id')&&typeof v==='string'&&/[\/:?#]/.test(v)))||!selector.keyword_id||!['ad','product'].includes(selector.source)||!Number.isInteger(selector.index)||selector.index<0)throw Error('媒体选择无效');
 return projectPath(projectId)+'/media-download?'+new URLSearchParams(selector);
}
export function createActionService(context){
 const {state,api,life}=context,id=state.project.id;let fetching=false,expanded=false;
 const valid=()=>life.active&&state.project?.id===id;
 return {
  async load(older=false){if(fetching||!valid())return;fetching=true;try{
   const cursor=older?state.actionCursor:null;
   const page=await api.request(projectPath(id)+'/actions?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{signal:life.signal});
   if(!valid())return;state.actions=older?mergeActionPages(state.actions||[],page.actions||[]):mergeActionPages(page.actions||[],state.actions||[]);
   if(older||!expanded)state.actionCursor=page.next_cursor||null;if(older)expanded=true;state.keywordActions=page.keyword_actions||state.keywordActions;state.verificationActions=page.verification_actions||state.verificationActions;state.productActions=page.product_actions||state.productActions;return page;
  }finally{fetching=false;}},
  async enqueue(selection){
   if(selection.kind==='trends'&&(typeof selection.query!=='string'||!selection.query.trim()||selection.query.trim().length>200))throw Error('请输入1到200字的当地常用产品查询词');
   if(state.writeBusy)throw Error('上一项请求尚未完成，请稍后操作');state.writeBusy=true;
   try{
   const stableSelection={...selection};delete stableSelection.version;if(selection.kind==='trends')delete stableSelection.query;
   const key=JSON.stringify(['action',id,stableSelection]);state.commands||={};
   const storage=context.context?.storage||context.root?.ownerDocument.defaultView?.sessionStorage;
   let saved;try{saved=JSON.parse(storage?.getItem(key)||'null');}catch{}
   const draft=state.commands[key]||{...restoreDraft(saved||{}),version:Number.isInteger(saved?.version)?saved.version:state.project.version};state.commands[key]=draft;
   const persist=()=>{try{storage?.setItem(key,JSON.stringify({...draft,submitting:undefined}));}catch{}};
   let result;
   try{result=await submitMutation(api,projectPath(id)+'/actions',{...selection,version:draft.version},draft,persist);}
   catch(error){if(error.status===409&&valid()){try{const project=await api.request(projectPath(id),{signal:life.signal});if(valid()){state.project=project;draft.version=project.version;persist();}}catch{}}throw error;}
   if(valid()){if(result.id)state.lastResearchAction={id:result.id,projectId:id,kind:selection.kind};delete state.commands[key];try{storage?.removeItem(key);}catch{}}return result;
   }finally{state.writeBusy=false;}
  },
  async retry(action,input={}){if(!retryEligible(action))throw Error('该任务不可重试，请先核对提交状态');const query=Object.hasOwn(input,'query')?input.query:trendsQuery(action);return this.enqueue({kind:action.kind,...(action.kind==='trends'?{query:typeof query==='string'?query.trim():query}:{}),...(action.keyword_id?{keyword_id:action.keyword_id}:{}),...(action.product_id?{product_id:action.product_id}:{}),...(action.landing_mode?{landing_mode:action.landing_mode}:{}),...(action.retry_review===true?{retry_review:true}:{}),...(action.rescan_of?{rescan_of:action.rescan_of,retry_action_id:action.id}:{}),attempt:action.attempt,version:state.project.version});},
  async stop(action){const attempt=action.attempt,version=state.project.version;
   const result=await api.request(projectPath(id)+'/actions/'+encodeURIComponent(action.id)+'/stop',{method:'POST',body:{attempt,version},signal:life.signal});
   if(!valid())return;const current=[...(state.actions||[]),...Object.values(state.verificationActions||{}),...Object.values(state.productActions||{})].find(a=>a.id===action.id);if(current?.attempt!==attempt)return;
   // Stop responses vary across legacy versions; refresh owns the authoritative DTO.
   return result;
  }
 };
}

/** Task completion is a saved collection result, never a human research verdict. */
export function actionProgress(action){
 const complete=action.status==='complete',running=action.status==='running',blocked=['blocked','failed','cancelled','stopped'].includes(action.status);
 return [{label:'任务已记录',state:action.id?'done':'pending'},{label:'执行采集 / 处理',state:complete?'done':running?'current':blocked?'blocked':'pending'},{label:'保存本次结果',state:complete?'done':'pending'},{label:'人工核对研究',state:'pending'}];
}
