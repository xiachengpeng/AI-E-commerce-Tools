async function renderSources(root){
 root.append(el('p','','正在读取来源配置…'));
 try{
  const d=await api('/sources');if(S.view!=='sources')return;
  root.replaceChildren();
  root.append(await providerSettingsPanel());


  const grid=el('div','source-grid'),statusNames={healthy:'集成健康',degraded:'集成降级',unconfigured:'未配置',configured:'已配置，待核验'};
  for(const s of d.sources){
   const n=box(s.name,s.note),status=el('span','tag source-status '+(s.status||'manual'),statusNames[s.status]||'人工提交');
   n.append(status,el('span','tag',s.mode));
   if(s.integration_message)n.append(el('p','muted',s.integration_message));
   if(s.automation_state){
    n.append(el('p','notice',`自动接入：${s.automation_state==='connected'?'已连接':'尚未连接'}。 ${s.automation_reason||''}`));
    n.append(el('p','next-action',`现在可做：${s.next_step||'按当前商品阶段补齐证据。'}`));
    if(s.official_docs_url)n.append(link('查看官方接入说明 ↗',s.official_docs_url));
   }
   grid.append(n);
  }
  const others=el('details','source-capabilities');others.append(el('summary','','其他来源与人工验证方式'),el('p','muted',`可行性核验：${d.feasibility_checked_at||'待核验'}`),grid);root.append(others,el('p','connection-footnote','保存配置不会启动采集。Meta 与 Trends 的 API / UI 模式在项目设置中选择；其他来源可在商品档案中提交人工证据。'));
 }catch(e){warn(e.message);}
}

async function providerSettingsPanel(){
 const section=el('section','connection-settings');
 const ai=await api('/ai-settings'),panel=el('section','connection-card ai-connection');panel.dataset.aiSettings='true';
 const head=el('div','connection-card-head'),title=el('div');title.append(el('h3','','AI 中转站'),el('p','muted','用于初始关键词建议与沿商品原文扩词'));head.append(title,el('span','tag',ai.configured?'已配置 · 未验证连接':'待配置'));panel.append(head);
 const form=el('form','ai-settings-form');form.autocomplete='off';
 function field(labelText,name,value,type='text'){const label=el('label','connection-field',labelText),input=el('input');input.name=name;input.type=type;input.value=value;input.setAttribute('aria-label',labelText);input.autocomplete=type==='password'?'new-password':'off';label.append(input);return {label,input};}
 const address=field('接口地址（Base URL）','base_url',ai.base_url||''),model=field('模型名称','model',ai.model||''),key=field('AI API Key','api_key','','password');
 address.input.placeholder='https://你的中转站地址/v1';address.input.maxLength=2048;model.input.placeholder='填写中转站支持的模型名称';model.input.maxLength=200;key.input.maxLength=512;key.input.placeholder=ai.key_configured?'已保存密钥；留空保留，填入可替换':'输入中转站密钥';
 address.label.append(el('small','muted','使用 OpenAI 兼容地址，通常包含 /v1；留空使用官方默认地址。'));model.label.append(el('small','muted','按服务商提供的模型名填写。'));key.label.classList.add('connection-key');key.label.append(el('small','muted','密钥只保存在备用机后端，不回显，也不进入浏览器草稿。'));
 const feedback=el('p','connection-feedback muted',ai.source==='saved'?'使用页面保存的配置；尚未验证本次连接。':'当前沿用环境配置；可在这里修改。');feedback.dataset.aiFeedback='true';feedback.setAttribute('role','status');
 const actions=el('div','connection-actions'),save=el('button','primary','保存 AI 配置'),reset=button('恢复环境配置',async()=>{reset.disabled=true;save.disabled=true;try{const result=await api('/ai-settings',{method:'POST',body:JSON.stringify({reset:true})});address.input.value=result.base_url||'';model.input.value=result.model||'';key.input.value='';key.input.placeholder=result.key_configured?'已配置密钥；留空保留，填入可替换':'输入中转站密钥';head.querySelector('.tag').textContent=result.configured?'已配置 · 未验证连接':'待配置';feedback.textContent='已恢复环境配置。新的 AI 请求使用该配置。';}catch(e){feedback.textContent=e.message;}finally{reset.disabled=false;save.disabled=false;}});save.type='submit';
 actions.append(feedback,reset,save);form.append(address.label,model.label,key.label,actions);
 form.onsubmit=async event=>{event.preventDefault();save.disabled=true;reset.disabled=true;feedback.textContent='正在保存…';try{await api('/ai-settings',{method:'POST',body:JSON.stringify({base_url:address.input.value.trim(),model:model.input.value.trim(),api_key:key.input.value.trim()})});key.input.value='';key.input.placeholder='已保存密钥；留空保留，填入可替换';feedback.textContent='已保存，新 AI 请求使用此配置；尚未验证连接。';head.querySelector('.tag').textContent='已配置 · 未验证连接';}catch(e){key.input.value='';feedback.textContent=e.message;}finally{save.disabled=false;reset.disabled=false;}};
 panel.append(form);section.append(panel);
 const status=await api('/provider-settings'),grid=el('div','connection-provider-grid');
 for(const [provider,name,purpose] of [['apify','Apify','Meta 广告资料库采集'],['serpapi','SerpApi','Google Trends 趋势采集'],['firecrawl','Firecrawl','商品页读取 · 在读取按钮旁选择后调用']]){
  const card=el('section','connection-card'),heading=el('div','connection-card-head'),copy=el('div');copy.append(el('h3','',name),el('p','muted',purpose));heading.append(copy,el('span','tag',status.configured[provider]?'已配置':'待配置'));card.append(heading);
  const label=el('label','connection-field',name+' API Key'),input=el('input');input.type='password';input.autocomplete='new-password';input.maxLength=512;input.placeholder=status.configured[provider]?'填入新密钥以替换':'输入 API 密钥';input.setAttribute('aria-label',name+' API Key');label.append(input);card.append(label);
  const feedback=el('p','connection-feedback muted',status.configured[provider]?'已配置（未验证本次可用性）':'未配置');feedback.setAttribute('role','status');
  const buttons=el('div','connection-actions');const save=button('保存 '+name,async()=>{save.disabled=true;remove.disabled=true;feedback.textContent='正在保存…';try{await api('/provider-settings',{method:'POST',body:JSON.stringify({[provider]:input.value.trim()})});input.value='';feedback.textContent='已保存，新请求使用新密钥。';heading.querySelector('.tag').textContent='已配置';}catch(e){input.value='';feedback.textContent=e.message;}finally{save.disabled=false;remove.disabled=false;}},'primary');
  const remove=button('清除 '+name,async()=>{save.disabled=true;remove.disabled=true;try{await api('/provider-settings',{method:'POST',body:JSON.stringify({[provider]:null})});input.value='';feedback.textContent='已清除';heading.querySelector('.tag').textContent='待配置';}catch(e){feedback.textContent=e.message;}finally{save.disabled=false;remove.disabled=false;}},'ghost');buttons.append(feedback,remove,save);card.append(buttons);grid.append(card);
 }
 const collectorTitle=el('h3','connection-collect-heading','采集 API 密钥');section.append(collectorTitle,grid);return section;
}

function configureCollection(){
 const id=S.project.id,version=S.project.version;
 openForm('设置采集模式','各来源独立选择；失败不自动切换。已排队任务沿用原模式；修改模式后重新提交，会按当前模式创建新任务。',fields([['meta','Meta','select',true,{ui:'UI 自动化',api:'API（Apify）'}],['trends','Google Trends','select',true,{ui:'UI 自动化',api:'API（SerpApi）'}]]),async data=>{
  S.project=await api('/projects/'+id+'/commands',{method:'POST',body:JSON.stringify({version,command_id:newCommandId(),action:'configure_collection',payload:data})});
 },S.project.collection_modes||{meta:'ui',trends:'ui'});
}
