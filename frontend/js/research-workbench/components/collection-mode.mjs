import {el,button} from './elements.mjs';
/** Reuse the versioned project setting; selecting a mode never enqueues a task. */
export function renderCollectionMode(context,word){
 const project=context.state.project,action=context.state.keywordActions?.[word.id],host=el(context,'label','rw-collection-mode','广告采集方式（本项目）'),select=el(context,'select'),hint=el(context,'small','rw-collection-mode-hint');
 select.setAttribute('aria-label','广告采集方式（本项目）');
 for(const [value,name] of [['ui','浏览器采集'],['api','API（Apify）']]){const option=el(context,'option','',name);option.value=value;select.append(option);}
 const selected=()=>context.state.project?.collection_modes?.meta||'ui',running=['ready','queued','running'].includes(action?.status)||['queued','running'].includes(word.status);
 select.value=selected();select.disabled=running;
 const describe=()=>{hint.textContent=running?'当前词正在采集，请完成或停止后再切换。':selected()==='api'?'API 可能收费；使用设置中的 Apify 配置。':'仅影响本项目的新搜索，不会自动重试。';};describe();
 let saving=false;
 context.life.listen(select,'change',async()=>{
  if(saving||running||context.state.writeBusy||!context.life.active){select.value=selected();return;}
  const mode=select.value;if(!['ui','api'].includes(mode)||mode===selected()){select.value=selected();return;}
  saving=true;select.disabled=true;hint.textContent='正在保存采集方式，请稍候…';
  try{await context.command('configure_collection',{meta:mode,trends:project.collection_modes?.trends||'ui'},{preservePosition:true,savedMessage:'采集方式已保存'});}
  finally{saving=false;if(context.life.active){select.value=selected();select.disabled=false;describe();if(selected()!==mode)hint.textContent='未确认保存成功，已恢复当前方式；请刷新核对后再试。';}}
 });host.append(select,hint);return host;
}

/** A shortcut to the same shared named accounts managed in Settings; never copies secrets. */
export function renderCollectionProfiles(context,word){
 const host=el(context,'section','rw-collection-profiles');host.hidden=(context.state.project.collection_modes?.meta||'ui')!=='api';if(host.hidden)return host;
 const label=el(context,'label','','Apify 共用 API 配置'),select=el(context,'select'),status=el(context,'p','rw-muted','正在读取已保存配置…'),current=el(context,'p','rw-api-profile-current'),notice=el(context,'p','rw-api-profile-warning','切换会影响所有项目后续 API 调用，包括未结束任务的查询。请先完成相关任务；不会自动搜索或重试。');
 select.setAttribute('aria-label','Apify 共用 API 配置');select.disabled=true;status.setAttribute('role','status');label.append(select);
 let config=null,busy=false,loaded=false;
 const taskBusy=()=>['queued','running'].includes(word.status)||Object.values(context.state.keywordActions||{}).some(a=>a.execution_mode==='api'&&(['ready','queued','running'].includes(a.status)||['manual','resume'].includes(a.recovery_action)));
 const apply=el(context,'div','rw-api-profile-confirm');apply.hidden=true;
 const confirm=button(context,'确认切换共用配置',async()=>{
  if(busy||!config||taskBusy()||context.state.writeBusy)return;
  const selected=select.value,option=config.profiles.find(p=>p.id===selected);if(!option?.configured||selected===config.active_profile_id)return;
  busy=true;context.state.writeBusy=true;select.disabled=true;cancel.disabled=true;refresh.disabled=true;status.textContent='正在切换共用配置…';
  try{
   const profile=await context.api.integrationProfile('apify','profiles/'+selected,{signal:context.life.signal});if(!context.life.active)return;
   const saved=await context.api.integrationProfile('apify','activate',{method:'POST',body:{profile_id:selected,expected_version:config.active_version??config.version,profile_version:profile.profile_version??profile.version},signal:context.life.signal});
   if(!context.life.active)return;paint(saved);status.textContent='共用配置已切换；不会自动开始采集。';
  }catch{if(context.life.active){select.value=config.active_profile_id;apply.hidden=true;status.textContent='未确认切换成功，请刷新配置核对；不会自动重试或开始采集。';}}
  finally{busy=false;context.state.writeBusy=false;if(context.life.active){select.disabled=!loaded||taskBusy();cancel.disabled=false;refresh.disabled=false;}}
 },'rw-primary'),cancel=button(context,'取消切换',()=>{if(!busy&&config){select.value=config.active_profile_id;apply.hidden=true;}}),refresh=button(context,'刷新配置',()=>load());
 apply.append(notice,confirm,cancel);context.life.listen(select,'change',()=>{if(!config||busy||taskBusy()){if(config)select.value=config.active_profile_id;return;}apply.hidden=select.value===config.active_profile_id;});
 function paint(data){
  if(!Array.isArray(data.profiles)||!data.profiles.some(p=>p.id===data.active_profile_id)||!Number.isInteger(data.active_version??data.version))throw Error('invalid account list');
  // Keep only identifiers/names and revisions. Masked credential DTOs are never retained.
  config={active_profile_id:data.active_profile_id,active_version:data.active_version??data.version,profiles:data.profiles.map(p=>({id:p.id,name:p.name,configured:p.configured===true}))};loaded=true;
  select.replaceChildren();for(const p of config.profiles){const item=el(context,'option','',p.name+(p.id===config.active_profile_id?' · 当前使用':'')+(p.configured?'':' · 未配置完整'));item.value=p.id;item.disabled=!p.configured;select.append(item);}select.value=config.active_profile_id;select.disabled=taskBusy();current.textContent='当前使用：'+config.profiles.find(p=>p.id===config.active_profile_id).name+'（所有项目共用）';apply.hidden=true;status.textContent=taskBusy()?'本项目仍有未结束的 API 任务，请先核对任务再切换账号。':'选择配置仅供准备，确认切换后才生效。';
 }
 async function load(){if(busy)return;busy=true;select.disabled=true;try{const data=await context.api.integration('apify','research',{signal:context.life.signal});if(context.life.active)paint(data);}catch{if(context.life.active){loaded=false;select.disabled=true;status.textContent='API 配置暂不可读，请刷新或到设置中核对。';}}finally{busy=false;}}
 const manage=button(context,'管理 API 配置',()=>context.context?.openMainSettings?context.context.openMainSettings('integrations'):context.navigate('settings'));
 host.append(label,current,status,apply,el(context,'div','rw-api-profile-tools'));host.children[host.children.length-1].append(refresh,manage);void load();return host;
}
