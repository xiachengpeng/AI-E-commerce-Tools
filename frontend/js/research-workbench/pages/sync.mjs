import { el,button,panel,notify } from '../components/elements.mjs';
import { projectPath } from '../services/actions.mjs';
/** Manual summary sync uses the existing immutable server snapshots/checkpoints. */
export function renderSync(context){
 const {state,life,api}=context,id=state.project.id,base=projectPath(id)+'/sync';
 const valid=()=>life.active&&state.project?.id===id;
 const root=el(context,'section'),heading=el(context,'h1','','飞书摘要同步');heading.tabIndex=-1;root.append(heading,el(context,'p','rw-muted','仅同步你明确批准的原版本摘要；不会自动同步后续版本，也不替换写入检查点。'));
 const history=panel(context,'同步状态与历史'),previewHost=panel(context,'当前版本预览');root.append(button(context,'返回探索',()=>context.navigate('project')),history,previewHost);
 state.syncUncertain||={};let preview=null,busy=false;
 const message=text=>{if(valid())notify(context,text);};
 async function mutate(key,path,body){
  if(busy||state.syncUncertain[id+':'+key])throw Error('上次提交结果待人工核对；请查看原同步记录，不要重复提交。');
  busy=true;
  try{return await api.request(path,{method:'POST',body,signal:life.signal});}
  catch(error){if(!error.status||error.status>=500&&error.status!==503)state.syncUncertain[id+':'+key]=true;throw error;}
  finally{busy=false;}
 }
 async function load(){
  try{const result=await api.request(base,{signal:life.signal});if(!valid())return;
   history.replaceChildren(el(context,'h2','','同步状态与历史'));
   if(!result.runs?.length)history.append(el(context,'p','','尚未同步。'));
   for(const run of result.runs||[]){const row=panel(context,`版本 ${run.version} · ${run.status}`,run.message);row.append(el(context,'p','rw-muted',`尝试 ${run.attempt_count||0} 次 · ${run.updated_at||'时间未记录'} · ${run.error_code||''}`));
    if(run.next_attempt_at)row.append(el(context,'p','rw-muted','下次自动核对：'+run.next_attempt_at));
    if(run.status==='blocked'){
     const unknown=['unknown_write','manual_check','submission_uncertain'].includes(run.error_code);
     if(unknown||state.syncUncertain[id+':retry:'+run.id])row.append(el(context,'p','rw-notice','写入结果不确定，请人工核对原记录；不会盲目重复创建。'));
     else{if(run.error_code==='uncertain_create')row.append(el(context,'p','rw-notice','上次创建结果未确认；显式重试只恢复原版本，先核对远端检查点。'));
      row.append(button(context,'重新核对并重试',async()=>{await mutate('retry:'+run.id,base+'/'+encodeURIComponent(run.id)+'/retry',{});if(valid()){message('原版本已重新排队，将先核对远端检查点。');await load();}}));}
    }history.append(row);
   }
  }catch(error){if(valid())message(error.status===503?error.message+'。请在「研究与集成」配置飞书凭据；本机研究可继续。':error.message+'。已显示历史保留。');}
 }
 const previewButton=button(context,'预览当前版本同步',async()=>{
  if(busy)return;const version=state.project.version;
  const result=await api.request(base+'/preview',{method:'POST',body:{version},signal:life.signal});
  if(!valid())return;if(state.project.version!==version||result.version!==version)throw Error('项目版本已改变，请重新预览。');
  preview={version:result.version,digest:result.digest};previewHost.replaceChildren(el(context,'h2','','当前版本预览'),el(context,'p','',`将新增或核对 ${result.records} 条版本 ${result.version} 的摘要记录。`));
  for(const table of result.tables||[])previewHost.append(el(context,'p','',table.name+' · '+(table.exists?'使用专用表':'首次同步时创建')));
  previewHost.append(button(context,'确认同步此版本',async()=>{
   if(!preview)throw Error('请重新预览。');const approved={...preview};if(state.project.version!==approved.version){preview=null;previewHost.replaceChildren(el(context,'p','rw-notice','项目版本已改变，请重新预览。'));throw Error('项目版本已改变，请重新预览。');}
   try{await mutate('approve:'+approved.version+':'+approved.digest,base,approved);if(valid()){preview=null;previewHost.replaceChildren(el(context,'p','','同步已排队；不会自动同步后续版本。'));await load();}}
   catch(error){if(valid()){preview=null;previewHost.replaceChildren(el(context,'p','rw-notice',error.status===409?'预览已过期，请刷新项目后重新预览。':'提交结果待核对，请查看原同步记录。'));}throw error;}
  },'rw-primary'));
 });root.append(previewButton,button(context,'刷新同步状态',load),button(context,'研究与集成设置',()=>context.navigate('settings')));
 if(Object.keys(state.syncUncertain).some(key=>key.startsWith(id+':')))root.append(el(context,'p','rw-notice','存在提交结果不确定的同步请求，请先人工核对原版本和远端记录。'));
 void load();return root;
}
