import {el,button,panel} from './elements.mjs';
import {icon} from './presentation.mjs';

/** Named saved accounts; plaintext exists only in the currently revealed input. */
export function createIntegrationEditor(context, initial, options={}) {
 const provider=initial.provider;
 const card=panel(context,options.title||provider,initial.unavailable?'暂时无法读取，请重新读取接口配置。':initial.configured?'已保存凭据（未测试连接）':'未配置');card.dataset.integration=provider;card.classList.add('rw-account-editor');
 const note=card.querySelector('p'),status=el(context,'p','rw-account-feedback');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const heading=el(context,'header','rw-account-heading'),headingText=el(context,'div'),badge=el(context,'span','rw-account-badge');
 const title=card.querySelector('h2');title.remove();note.remove();headingText.append(title,note);heading.append(headingText,badge);card.append(heading);
 let current=initial,dirty=false,busy=false,epoch=0,isNew=false;
 const inputs={},secrets=new Map(),controls=[];
 const profileBox=el(context,'div','rw-profile-controls'),select=el(context,'select'),name=el(context,'input'),activeNote=el(context,'p','rw-muted rw-profile-active'),fields=el(context,'div','rw-account-fields');
 select.dataset.profileSelect='';select.setAttribute('aria-label','选择已保存配置');name.maxLength=60;name.setAttribute('aria-label','配置名称');name.placeholder='例如：主账户、备用账户';
 const accountLabel=el(context,'label','rw-account-selector','配置账号'),accountToolbar=el(context,'div','rw-profile-actions');accountLabel.append(select);profileBox.append(accountLabel,accountToolbar,activeNote);card.append(profileBox,fields);
 const nameLabel=el(context,'label','rw-field rw-account-name','账号名称');nameLabel.append(name);fields.append(nameLabel);
 function changed(){dirty=true;card.dataset.dirty='true';status.dataset.testState='';status.textContent='有未保存的更改';options.onChange?.();}
 function hideSecrets(){++epoch;for(const {input,toggle,mark,state} of secrets.values()){
  if(state.fetched!==null&&input.value===state.fetched)input.value='';state.fetched=null;input.type='password';mark.className='ph ph-eye-slash';toggle.setAttribute('aria-pressed','false');toggle.setAttribute('aria-label','显示完整'+(options.labels?.[input.name]||input.name));
 }}
 function refreshControls(){for(const control of controls)control.disabled=busy||!!current.unavailable;for(const input of Object.values(inputs))input.disabled=busy||!!current.unavailable;name.disabled=busy||!!current.unavailable;select.disabled=busy||dirty||isNew||!!current.unavailable;activate.disabled=busy||isNew||!!current.unavailable||(!dirty&&(current.profile_id||'default')===(current.active_profile_id||'default'));activate.hidden=isNew||(current.profile_id||'default')===(current.active_profile_id||'default');cancel.hidden=!dirty;card.dataset.dirty=String(dirty);badge.textContent=isNew?'新账号':(current.profile_id||'default')===(current.active_profile_id||'default')?'当前使用':'备用账号';badge.dataset.active=String(!isNew&&(current.profile_id||'default')===(current.active_profile_id||'default'));}
 async function perform(work){if(busy)return;busy=true;refreshControls();try{await work();}catch{if(context.life.active){if(!isNew)select.value=current.profile_id||'default';status.dataset.testState='error';status.textContent='操作未完成：请核对配置、名称及保存状态；如有其他窗口改动，请重新读取配置。已有密钥保留。';}}finally{busy=false;if(context.life.active)refreshControls();}}
 function paint(config){hideSecrets();current=config;isNew=false;dirty=false;
  select.replaceChildren();for(const p of config.profiles||[{id:'default',name:'原有配置'}]){const item=el(context,'option','',p.name+(p.id===(config.active_profile_id||'default')?' · 使用中':''));item.value=p.id;select.append(item);}select.value=config.profile_id||'default';name.value=config.name||'原有配置';
  for(const [key,input] of Object.entries(inputs)){const secret=secrets.has(key);input.value=secret?'':String(config.fields?.[key]??'');input.placeholder=secret?(config.secret_previews?.[key]||(config.fields?.[key]?'已保存，留空保留':'未配置')):'';}
  const active=(config.profiles||[]).find(p=>p.id===config.active_profile_id);activeNote.textContent='正在使用：'+(active?.name||'原有配置')+'。选择账号仅查看，启用后才用于后续任务。';note.textContent=config.unavailable?'暂时无法读取，请重新读取接口配置。':config.configured?'已保存凭据（未测试连接）':'请补齐凭据后保存';status.dataset.testState='';refreshControls();
 }
 for(const key of options.fields||[]){const label=el(context,'label','rw-field',options.labels?.[key]||key),input=el(context,'input');inputs[key]=input;input.name=key;input.autocomplete='off';input.maxLength=512;input.type=key==='daily_limit'?'number':key==='app_id'?'text':'password';
  if(key==='daily_limit'){input.min='1';input.max='1000000';}
  context.life.listen(input,'input',()=>{if(secrets.has(key))secrets.get(key).state.fetched=null;changed();refreshControls();});
  if(input.type==='password'){
   const wrap=el(context,'span','rw-secret-input'),state={fetched:null},mark=icon(context,'eye-slash');let toggle;
   toggle=button(context,'',async()=>{
    if(input.type==='text'){hideSecrets();return;}
    const id=++epoch;
    if(input.value){input.type='text';mark.className='ph ph-eye';toggle.setAttribute('aria-pressed','true');toggle.setAttribute('aria-label','隐藏完整'+(options.labels?.[key]||key));return;}
    if(isNew||!current.fields?.[key]){status.textContent='请先填写密钥。';return;}
    try{const result=await context.api.integrationProfile(provider,'reveal',{method:'POST',body:{profile_id:current.profile_id||'default',field:key,expected_version:current.profile_version??current.version},signal:context.life.signal});
     if(!context.life.active||id!==epoch)return;
     // A user edit while the read was pending always wins.
     if(input.value)return;
     if(typeof result.value!=='string')throw Error();
     state.fetched=result.value;input.value=result.value;input.type='text';mark.className='ph ph-eye';toggle.setAttribute('aria-pressed','true');toggle.setAttribute('aria-label','隐藏完整'+(options.labels?.[key]||key));
    }catch{if(context.life.active&&id===epoch)status.textContent='完整密钥暂不可读，请重新读取配置后重试。';}
   },'rw-secret-toggle');toggle.dataset.secretToggle=key;toggle.setAttribute('aria-pressed','false');toggle.setAttribute('aria-label','显示完整'+(options.labels?.[key]||key));toggle.append(mark);wrap.append(input,toggle);label.append(wrap);secrets.set(key,{input,toggle,mark,state});controls.push(toggle);
  }else label.append(input);fields.append(label);
 }
 context.life.listen(name,'input',()=>{changed();refreshControls();});
 const collect=()=>{const changes={};for(const [key,input] of Object.entries(inputs)){if(key==='daily_limit'){if(input.value.trim())changes[key]=Number(input.value);}else changes[key]=secrets.get(key)?.state.fetched===input.value?'':input.value.trim();}return changes;};
 const save=button(context,'保存配置',()=>perform(async()=>{
  if(!name.value.trim()){status.dataset.testState='error';status.textContent='请填写账号名称，方便区分多个账号。';name.focus();return;}
  status.textContent='正在保存配置…';let saved;
  if(isNew)saved=await context.api.integrationProfile(provider,'profiles',{method:'POST',body:{name:name.value.trim(),changes:collect()},signal:context.life.signal});
  else if(current.profiles)saved=await context.api.integrationProfile(provider,'profiles/'+current.profile_id,{method:'PATCH',body:{name:name.value.trim(),changes:collect(),expected_version:current.profile_version??current.version},signal:context.life.signal});
  else saved=await options.saveChanges(collect());
  if(!context.life.active)return;
  // Old API fixtures do not include profile metadata; do not retain submitted text.
  paint({...current,...saved});status.textContent='配置已保存；'+((saved.profile_id||'default')===(saved.active_profile_id||'default')?'后续操作读取新配置。':'尚未启用，点击“启用此账号”后生效。');options.onSaved?.(saved);
 }),'rw-primary');
 const probe=button(context,'测试连接',()=>perform(async()=>{
  if(dirty||isNew){status.textContent='请先保存当前更改，再测试连接；不会测试未保存的输入。';return;}
  status.textContent='正在测试已保存配置…';status.dataset.testState='pending';
  const result=await context.api.testIntegration(provider,'research',{signal:context.life.signal,...(current.profiles?{body:{profile_id:current.profile_id,expected_version:current.profile_version??current.version}}:{})});
  if(!context.life.active)return;note.textContent=result.success?'已保存凭据 · 本次连接测试通过':'已保存凭据 · 本次连接测试未通过';status.textContent=(result.success?'连接测试通过：':'连接测试未通过：')+(result.message||'请核对服务状态。');status.dataset.testState=result.success?'success':'error';options.onTest?.(result);
 }),'settings-button settings-button-secondary rw-service-test');
 const add=button(context,'新增账号',()=>{if(dirty){status.textContent='请先保存当前更改，再新增配置。';return;}hideSecrets();isNew=true;dirty=true;name.value='';const pending=el(context,'option','','新账号（未保存）');pending.value='';select.replaceChildren(pending);select.value='';note.textContent='填写新账号的连接信息';for(const input of Object.values(inputs)){input.value='';input.placeholder=input.name==='daily_limit'?'请设置上限':'请输入新配置的凭据';}activeNote.textContent='新配置不会继承其他账户的密钥，保存也不会自动启用。';status.textContent='填写名称与凭据后保存。';changed();status.textContent='填写名称与凭据后保存；新账号不会自动启用。';refreshControls();name.focus();});add.dataset.profileAdd='';
 const cancel=button(context,'放弃未保存更改',()=>{paint(current);status.textContent='未保存更改已放弃；已保存配置保持不变。';options.onReset?.();});cancel.dataset.profileCancel='';
 // Unlike the shared button helper, final enabled state belongs to this editor.
 function accountButton(label,callback){const node=el(context,'button','',label);node.type='button';context.life.listen(node,'click',async()=>{if(node.disabled||!context.life.active)return;try{await callback();}finally{if(context.life.active)refreshControls();}});return node;}
 const activate=accountButton('启用此账号',()=>perform(async()=>{
  if(dirty||isNew){status.textContent='请先保存当前更改，再切换使用配置。';return;}
  const saved=await context.api.integrationProfile(provider,'activate',{method:'POST',body:{profile_id:current.profile_id||'default',expected_version:current.active_version??current.version,profile_version:current.profile_version??current.version},signal:context.life.signal});
  if(!context.life.active)return;paint(saved);status.textContent='已切换使用配置，仅后续操作生效；不会自动启动任务或重试。';options.onSaved?.(saved);
 }));activate.dataset.profileActivate='';
 context.life.listen(select,'change',()=>{if(dirty||busy||isNew){select.value=current.profile_id||'default';return;}const id=select.value;hideSecrets();void perform(async()=>{const saved=await context.api.integrationProfile(provider,'profiles/'+id,{signal:context.life.signal,method:'GET'});if(!context.life.active)return;paint(saved);status.textContent='已读取所选配置，当前使用的账户未改变。';});});
 accountToolbar.append(activate,add);const footer=el(context,'footer','rw-account-footer'),actions=el(context,'div','rw-account-actions');actions.append(save,probe,cancel);
 footer.append(status,actions,el(context,'p','rw-muted rw-service-test-note','密钥留空保留原值。测试仅检查已保存账号的连接与读取权限，不执行采集、翻译或飞书写入。'));card.append(footer);
 controls.push(save,probe,add,activate,cancel);
 context.life.track(()=>{hideSecrets();for(const input of Object.values(inputs))if(secrets.has(input.name))input.value='';});
 const doc=context.root.ownerDocument;if(doc.addEventListener)context.life.listen(doc,'visibilitychange',()=>{if(doc.hidden)hideSecrets();});
 paint(initial);
 return {card,save,hideSecrets};
}
