/** Page locations only: returning never restores stale project DTOs or replays commands. */
const fields=['view','product','step','projectSection','explorationKeyword','testPane','productOverview','queueCategory','historyKind','stageTarget'];
export function routeLocation(state){
 const route={projectId:state.project?.id||null};
 for(const key of fields)route[key]=state[key]??null;
 route.projectSection||='leads';
 route.form=state.view==='form'?structuredClone(state.form||null):null;
 if(route.form)for(const key of ['keyword','parent','product'])if(route.form[key]?.id)route.form[key]={id:route.form[key].id};
 return route;
}
export function rememberRoute(state){
 const next=routeLocation(state),previous=state.renderedRoute;
 if(previous&&JSON.stringify(previous)!==JSON.stringify(next)){
  state.navigationTrail||=[];state.navigationTrail.push(previous);
  if(state.navigationTrail.length>40)state.navigationTrail.shift();
 }
 state.renderedRoute=next;
}
export function restoreRoute(state,route){
 if(route.projectId&&state.project?.id!==route.projectId)throw Error('返回位置的项目尚未读取，请重试。');
 for(const key of fields){if(route[key]===null||route[key]===undefined)delete state[key];else state[key]=route[key];}
 state.form=structuredClone(route.form);
 if(state.view==='form'&&state.form){
  for(const key of ['keyword','parent','product']){
   if(!state.form[key]?.id)continue;
   const current=(key==='product'?state.project?.products:state.project?.keywords)?.find(item=>item.id===state.form[key].id&&!item.merged_into);
   if(!current){state.view=state.project?'project':'projects';state.projectSection='keywords';state.form=null;break;}
   state.form[key]=current;
  }
 }
 state.queueSelection=null;
 if(state.view==='product'&&!state.project?.products?.some(p=>p.id===state.product&&!p.merged_into)){
  state.view='project';state.projectSection='leads';state.product=null;
 }
 state.renderedRoute=routeLocation(state);
}
