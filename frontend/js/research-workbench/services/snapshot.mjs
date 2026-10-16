import { mergeActionPages,projectPath } from './actions.mjs';
/** Atomically apply authoritative project + all action projections, scoped to this page. */
export function createSnapshotRefresher(context){
 const {state,api,life}=context,id=state.project?.id;let pending=false;
 const valid=()=>life.active&&!!id&&state.project?.id===id;
 return async function refresh(redraw=true){
  if(pending||state.writeBusy||!valid())return;pending=true;
  try{
   const project=await api.request(projectPath(id),{signal:life.signal});if(!valid())return;
   const actions=await api.request(projectPath(id)+'/actions?limit=20',{signal:life.signal});
   if(!valid()||project.id!==id||project.version<state.project.version)return;
   const changed=JSON.stringify([state.project,state.actions,state.keywordActions,state.verificationActions,state.productActions])!==JSON.stringify([project,actions.actions||[],actions.keyword_actions||{},actions.verification_actions||{},actions.product_actions||{}]);
   state.project=project;state.actions=state.view==='actions'?mergeActionPages(actions.actions||[],state.actions||[]):actions.actions||[];if(state.view!=='actions')state.actionCursor=actions.next_cursor||null;state.keywordActions=actions.keyword_actions||{};state.verificationActions=actions.verification_actions||{};state.productActions=actions.product_actions||{};
   // Inline forms hold their original draft/version; never replace their DOM.
   if(redraw&&changed&&!context.editing)context.redraw?.();return project;
  }finally{pending=false;}
 };
}
export function bindProgressRefresh(context){
 let pending=false;
 context.life.poll(async()=>{if(pending)return;pending=true;try{await context.refreshProject?.();}catch{/* Preserve the last successful view on a read failure. */}finally{pending=false;}},5000);
}
