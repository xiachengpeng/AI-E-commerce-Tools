import {productThumbnail,icon} from '../components/presentation.mjs';
import {decisionSummary} from '../services/journey.mjs';
import { el,button,panel,notify,marketNames } from '../components/elements.mjs';
import { projectPath } from '../services/actions.mjs';
/** Manual summary sync uses the existing immutable server snapshots/checkpoints. */
export function renderSync(context){
 const {state,life,api}=context,id=state.project.id,base=projectPath(id)+'/sync';
 const valid=()=>life.active&&state.project?.id===id;
 const root=el(context,'section'),heading=el(context,'h1','','飞书摘要同步');heading.tabIndex=-1;root.append(heading,el(context,'p','rw-muted','仅同步你明确批准的原版本摘要；不会自动同步后续版本，也不替换写入检查点。'));
 const history=panel(context,'同步状态与历史'),previewHost=panel(context,'当前版本预览');root.append(button(context,'返回探索',()=>context.navigate('project')));
 state.syncUncertain||={};let preview=null,busy=false,approveButton=null,approvalAck=null,ackRow=null;
 const clearApproval=()=>{approveButton?.remove();ackRow?.remove();approveButton=null;approvalAck=null;ackRow=null;preview=null;};
 function summary(){
  const project=state.project,head=el(context,'div','rw-sync-summary-head');head.append(icon(context,'file-text'),el(context,'strong','',project.title),el(context,'span','rw-tag','项目版本 '+project.version));
  previewHost.append(head,el(context,'p','rw-muted','当前项目资料供核对；正式写入范围以服务端预览返回的摘要记录和目标表为准。'));
  const meta=el(context,'dl','rw-sync-summary-meta');for(const [label,value] of [['目标市场',marketNames[project.market]||project.market],['规则版本',project.rules_version??'未记录'],['商品档案',(project.products||[]).filter(p=>!p.merged_into).length+' 个'],['搜索词',(project.keywords||[]).length+' 个']])meta.append(el(context,'dt','',label),el(context,'dd','',value));previewHost.append(meta);
  const product=project.products?.find(p=>p.id===project.focus_product_id&&!p.merged_into)||project.products?.find(p=>!p.merged_into);if(product){const card=el(context,'section','rw-sync-product'),decision=decisionSummary(product),score=[...(product.scores||[])].reverse().find(s=>s.revision===product.revision);card.append(productThumbnail(context,product),el(context,'h3','',product.name),el(context,'span','rw-tag',decision.label),el(context,'p','rw-muted',decision.reason||decision.note),el(context,'p','rw-muted',score?.status==='complete'&&Number.isFinite(score.total)?'当前研究评分：'+score.total+' / 25':'当前暂无完整研究评分'));previewHost.append(card);const decisionCard=el(context,'section','rw-sync-decision');decisionCard.append(el(context,'h3','','人工决定与理由'));for(const [label,value] of [['当前结论',decision.label],['决定理由',decision.reason||'尚未保存人工决定与理由。']]){const row=el(context,'p');row.append(el(context,'span','rw-muted',label),el(context,'span','',value));decisionCard.append(row);}previewHost.append(decisionCard);const gaps=(product.requirement_statuses||[]).filter(r=>r.applies!==false&&!['pass','not_applicable'].includes(r.status));if(gaps.length){const missing=el(context,'section','rw-sync-missing');missing.append(el(context,'h3','','尚待核实的证据'));for(const gap of gaps.slice(0,4)){const row=el(context,'p');row.append(el(context,'strong','',gap.label||gap.key),el(context,'span','rw-tag','待核实'),el(context,'small','rw-muted',gap.status_reason||'需要补充来源后核对'));missing.append(row);}if(gaps.length>4)missing.append(el(context,'p','rw-muted','另有 '+(gaps.length-4)+' 项待核实，请返回原研究查看完整清单。'));previewHost.append(missing);}}
  previewHost.append(el(context,'p','rw-notice','本机研究资料保留。仅批准本次预览版本；后续修改不会自动同步。'));
 }

 const message=text=>{if(valid())notify(context,text);};
 async function mutate(key,path,body){
  if(busy||state.syncUncertain[id+':'+key])throw Error('上次提交结果待人工核对；请查看原同步记录，不要重复提交。');
  // Snapshot-owned intent must exist before transport: unmount snapshots before abort rejects.
  const identity=id+':'+key;state.syncUncertain[identity]=true;busy=true;
  try{const result=await api.request(path,{method:'POST',body,signal:life.signal});if(valid())delete state.syncUncertain[identity];return result;}
  catch(error){
   // Generic503 may follow an applied operation/timeout; retain its unknown intent.
   if(valid()&&[400,401,403,404,409,422,429].includes(error.status))delete state.syncUncertain[identity];
   throw error;
  }
  finally{busy=false;}
 }
 async function load(){
  try{const result=await api.request(base,{signal:life.signal});if(!valid())return;
   history.replaceChildren(el(context,'h2','','同步状态与历史'));
   if(!result.runs?.length)history.append(el(context,'p','','尚未同步。'));
   for(const run of result.runs||[]){const unknown=['unknown_write','manual_check','submission_uncertain'].includes(run.error_code),status=context.designDirectForms?(unknown?'写入结果待核对':({ready:'等待同步',running:'正在同步',complete:'已同步',retry_wait:'等待再次核对',blocked:'同步待处理'})[run.status]||'状态待核对'):run.status,row=panel(context,`版本 ${run.version} · ${status}`,run.message);row.append(el(context,'p','rw-muted',context.designDirectForms?`尝试 ${run.attempt_count||0} 次 · ${run.updated_at&&Number.isFinite(Date.parse(run.updated_at))?new Date(run.updated_at).toLocaleString('zh-CN'):'时间未记录'}`:`尝试 ${run.attempt_count||0} 次 · ${run.updated_at||'时间未记录'} · ${run.error_code||''}`));if(context.designDirectForms){const diagnostic=el(context,'details','rw-sync-run-diagnostic');diagnostic.append(el(context,'summary','','查看状态标识'),el(context,'p','rw-muted',run.status+' · '+(run.error_code||'无错误标识')));row.append(diagnostic);}
    if(run.next_attempt_at)row.append(el(context,'p','rw-muted','下次自动核对：'+run.next_attempt_at));
    if(run.status==='blocked'){
     const unknown=['unknown_write','manual_check','submission_uncertain'].includes(run.error_code);
     if(unknown||state.syncUncertain[id+':retry:'+run.id])row.append(el(context,'p','rw-notice','写入结果不确定，请人工核对原记录；不会盲目重复创建。'));
     else{if(run.error_code==='uncertain_create')row.append(el(context,'p','rw-notice','上次创建结果未确认；显式重试只恢复原版本，先核对远端检查点。'));
      row.append(button(context,'重新核对并重试',async()=>{await mutate('retry:'+run.id,base+'/'+encodeURIComponent(run.id)+'/retry',{});if(valid()){message('原版本已重新排队，将先核对远端检查点。');await load();}}));}
    }history.append(row);
   }
  }catch(error){if(valid())message(error.status===503?error.message+'。请到「设置 → 外部服务」核对飞书接口；本机研究可继续。':error.message+'。已显示历史保留。');}
 }
 const previewButton=button(context,'预览当前版本同步',async()=>{
  if(busy)return;const version=state.project.version;
  const result=await api.request(base+'/preview',{method:'POST',body:{version},signal:life.signal});
  if(!valid())return;if(state.project.version!==version||result.version!==version)throw Error('项目版本已改变，请重新预览。');
  clearApproval();preview={version:result.version,digest:result.digest};previewHost.replaceChildren(el(context,'h2','','当前版本预览'),el(context,'p','',`将新增或核对 ${result.records} 条版本 ${result.version} 的摘要记录。`));
  summary();for(const table of result.tables||[])previewHost.append(el(context,'p','',table.name+' · '+(table.exists?'使用专用表':'首次同步时创建')));
  approveButton=button(context,'确认同步此版本',async()=>{
   if(!preview)throw Error('请重新预览。');if(context.designDirectForms&&!approvalAck?.checked)throw Error('请先核对本次摘要与目标表。');const approved={...preview};if(state.project.version!==approved.version){clearApproval();previewHost.replaceChildren(el(context,'p','rw-notice','项目版本已改变，请重新预览。'));throw Error('项目版本已改变，请重新预览。');}
   try{await mutate('approve:'+approved.version+':'+approved.digest,base,approved);if(valid()){clearApproval();previewHost.replaceChildren(el(context,'p','','同步已排队；不会自动同步后续版本。'));await load();}}
   catch(error){if(valid()){clearApproval();previewHost.replaceChildren(el(context,'p','rw-notice',error.status===409?'预览已过期，请刷新项目后重新预览。':'提交结果待核对，请查看原同步记录。'));}throw error;}
  },'rw-primary');if(context.designDirectForms){ackRow=el(context,'label','rw-sync-ack');approvalAck=el(context,'input');approvalAck.type='checkbox';approvalAck.name='sync_preview_ack';approvalAck.checked=false;approvalAck.setAttribute('aria-label','我已核对本次摘要与目标表');ackRow.append(approvalAck,el(context,'span','','我已核对本次摘要与目标表'));approveButton.disabled=true;life.listen(approvalAck,'change',()=>{approveButton.disabled=!approvalAck.checked;});if(controls.insertBefore)controls.insertBefore(ackRow,history);else controls.append(ackRow);}if(controls.insertBefore)controls.insertBefore(approveButton,history);else controls.append(approveButton);
 });
 const layout=el(context,'div','rw-sync-workspace'),controls=panel(context,'同步到飞书','先预览，再确认批准的版本；配置在系统设置统一管理。');controls.classList.add('rw-sync-controls');const destination=el(context,'section','rw-sync-destination'),configStatus=el(context,'p','rw-muted','配置状态需到统一设置核对');const mark=el(context,'img','rw-service-mark');mark.src='/assets/research/feishu-reference-mark.png';mark.alt='';destination.append(mark,el(context,'strong','','飞书多维表格'),configStatus,el(context,'p','rw-muted','仅将你批准的摘要写入已配置的专用目标表。'));controls.append(destination);if(typeof api.integration==='function')void api.integration('feishu','research',{signal:life.signal}).then(config=>{if(valid())configStatus.textContent=config.configured?'凭据已保存（未测试连接）':'尚未配置，请先到统一设置保存凭据';}).catch(()=>{if(valid())configStatus.textContent='配置状态暂不可读，请到统一设置核对';});controls.append(previewButton,button(context,'刷新同步状态',load),button(context,'打开统一接口设置',()=>context.context?.openMainSettings?context.context.openMainSettings('integrations'):context.navigate('settings')),history);layout.append(previewHost,controls);root.append(layout);
 summary();previewHost.append(el(context,'p','rw-muted','尚未准备摘要。点击“预览当前版本同步”核对写入范围、版本和目标表；预览不会批准同步。'));
 if(Object.keys(state.syncUncertain).some(key=>key.startsWith(id+':')))root.append(el(context,'p','rw-notice','存在提交结果不确定的同步请求，请先人工核对原版本和远端记录。'));
 void load();return root;
}
