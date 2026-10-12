import { submitMutation, restoreDraft } from './commands.mjs';
export const projectPath=id=>'/projects/'+encodeURIComponent(id);
export function retryEligible(a){return ['blocked','failed'].includes(a.status)&&['retry','resume','restart'].includes(a.recovery_action);}
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
   if(older||!expanded)state.actionCursor=page.next_cursor||null;if(older)expanded=true;state.keywordActions=page.keyword_actions||state.keywordActions;return page;
  }finally{fetching=false;}},
  async enqueue(selection){
   if(state.writeBusy)throw Error('上一项请求尚未完成，请稍后操作');state.writeBusy=true;
   try{
   const stableSelection={...selection};delete stableSelection.version;
   const key=JSON.stringify(['action',id,stableSelection]);state.commands||={};
   const storage=context.context?.storage||context.root?.ownerDocument.defaultView?.sessionStorage;
   let saved;try{saved=JSON.parse(storage?.getItem(key)||'null');}catch{}
   const draft=state.commands[key]||{...restoreDraft(saved||{}),version:Number.isInteger(saved?.version)?saved.version:state.project.version};state.commands[key]=draft;
   const persist=()=>{try{storage?.setItem(key,JSON.stringify({...draft,submitting:undefined}));}catch{}};
   let result;
   try{result=await submitMutation(api,projectPath(id)+'/actions',{...selection,version:draft.version},draft,persist);}
   catch(error){if(error.status===409&&valid()){try{const project=await api.request(projectPath(id),{signal:life.signal});if(valid()){state.project=project;draft.version=project.version;persist();}}catch{}}throw error;}
   if(valid()){delete state.commands[key];try{storage?.removeItem(key);}catch{}}return result;
   }finally{state.writeBusy=false;}
  },
  async retry(action){if(!retryEligible(action))throw Error('该任务不可重试，请先核对提交状态');return this.enqueue({kind:action.kind,...(action.keyword_id?{keyword_id:action.keyword_id}:{}),...(action.product_id?{product_id:action.product_id}:{}),...(action.landing_mode?{landing_mode:action.landing_mode}:{}),attempt:action.attempt,version:state.project.version});},
  async stop(action){const attempt=action.attempt,version=state.project.version;
   const result=await api.request(projectPath(id)+'/actions/'+encodeURIComponent(action.id)+'/stop',{method:'POST',body:{attempt,version},signal:life.signal});
   if(!valid())return;const current=state.actions.find(a=>a.id===action.id);if(current?.attempt!==attempt)return;
   // Stop responses vary across legacy versions; refresh owns the authoritative DTO.
   return result;
  }
 };
}
