import { createApi } from './research-workbench/api.mjs';

const groups = [
 ['market','目标市场与费用（按你的实际业务填写）',{
  code:'目标市场',currency:'币种',min_aov:'预期最低客单价',max_aov:'预期最高客单价',
  payment_percent:'支付手续费（%）',payment_fixed:'每笔固定手续费',loss_reserve_percent:'损耗预留（%）'}],
 ['admission','每日研究上限与费用估算',{
  daily_candidates:'每日候选商品上限',daily_keywords:'每日关键词上限',daily_scans:'每日搜索上限',
  daily_ai_calls:'每日 AI 调用上限',daily_cost_usd:'每日估算预算（美元）',
  estimated_call_cost_usd:'每次 AI 估算费用（美元）',estimated_research_scan_cost_usd:'每次搜索估算费用（美元）'}],
 ['trend_thresholds','高级：趋势判断规则',{
  coverage:'数据覆盖比例',rising:'上涨变化阈值',declining:'下降变化阈值',stable_median_ratio:'稳定中位比例',
  peak_ratio:'峰值占比',seasonal_ratio:'季节性倍数',seasonal_years:'季节性年数',seasonal_tolerance_weeks:'季节性容差周数'}]
];

/** No network effects on render; every write is an explicit, single user action. */
export function renderCustomerSetup(context, initial) {
 const doc=context.root.ownerDocument;
 const node=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const host=node('section');host.className='customer-setup-content';
 const heading=node('h1','开始使用 AI 电商工具箱');
 heading.id='customerSetupTitle';host.append(heading,node('p','客户版 '+initial.version+' · 数据保存在本机，服务使用你自己的账户。'));
 host.append(node('p','① 配置 AI 与外部服务 → ② 确认研究规则 → ③ 按需开启后台。也可以先关闭此窗口浏览功能。'));
 const status=node('p');status.setAttribute('role','status');status.className='customer-setup-status';
 host.append(status);
 let data=initial,busy=false;
 const controls=[];
 function action(label,callback){const b=node('button',label);b.type='button';b.className='settings-button settings-button-secondary';
  b.addEventListener('click',async()=>{if(busy)return;busy=true;for(const c of controls)c.disabled=true;
   try{await callback();}catch{status.textContent='操作未完成。请核对填写内容和本机连接；已提交操作请先刷新查看，勿重复点击。';}
   finally{busy=false;for(const c of controls)c.disabled=false;}});controls.push(b);return b;}
 async function save(body){const result=await context.save(body);data={...data,...result};
  status.textContent=result.restart_required?'已保存。请从应用菜单正常退出，再重新打开后生效；当前后台状态请看“运行日志”。':'已保存。';return result;}
 const links=node('div');links.className='customer-setup-actions';
 links.append(action('配置 AI 模型',()=>context.navigate?.('ai')),action('配置外部服务与存储',()=>context.navigate?.('integrations')));
 host.append(links);
 const rules=node('details');rules.open=!initial.business;
 rules.append(node('summary','研究规则'+(initial.business?'（已保存，可修改）':'（待确认）')),
  node('p','以下初始值仅为示例。请确认市场、费用和预算符合实际；预算使用估算值，不代替服务商账单或保证不会超支。'));
 const fields=new Map(),source=initial.business||initial.template;
 for(const [group,title,labels] of groups){
  const section=node(group==='trend_thresholds'?'details':'fieldset');
  section.append(node(group==='trend_thresholds'?'summary':'legend',title));
  const grid=node('div');grid.className='customer-setup-grid';
  for(const [key,label] of Object.entries(labels)){
   const wrap=node('label',label);let input;
   if(key==='code'){
    input=node('select');for(const [value,name] of Object.entries({US:'美国',GB:'英国',CA:'加拿大',AU:'澳大利亚',DE:'德国',FR:'法国',JP:'日本'})){
     const option=node('option',name);option.value=value;input.append(option);}
   }else{input=node('input');input.type=key==='currency'?'text':'number';if(input.type==='number'){input.step='any';input.min='0';}}
   input.name=group+'.'+key;input.value=String(source[group][key]);wrap.append(input);grid.append(wrap);fields.set(input.name,input);
  }section.append(grid);rules.append(section);
 }
 const performance=node('fieldset');performance.append(node('legend','后台执行频率'));
 for(const [key,label] of [['browser_concurrency','同时打开的采集浏览器（1–2）'],['poll_seconds','轮询间隔（秒，至少 10）']]){
  const wrap=node('label',label),input=node('input');input.type='number';input.value=String(source[key]);input.step='1';input.min=key==='browser_concurrency'?'1':'10';input.name=key;wrap.append(input);performance.append(wrap);fields.set(key,input);
 }rules.append(performance);
 const check=(label,key)=>{const wrap=node('label'),input=node('input');input.type='checkbox';input.dataset[key]='';wrap.append(input,node('span',label));return {wrap,input};};
 const confirmed=check('我已核对上述规则和费用估算','customerRulesConfirmed');rules.append(confirmed.wrap);
 rules.append(action('保存研究规则',async()=>{
  if(!confirmed.input.checked){status.textContent='请先核对并勾选确认研究规则。';return;}
  const business=structuredClone(source);
  for(const [name,input] of fields){const [group,key]=name.split('.');
   const value=['currency','code'].includes(key)?input.value.trim():Number(input.value);
   if(input.value.trim()===''||typeof value==='number'&&!Number.isFinite(value)){status.textContent='请补全研究规则。';return;}
   if(key)business[group][key]=value;else business[group]=value;
  }
  await save({action:'rules',confirmed:true,business});
 }));host.append(rules);
 const background=node('fieldset');background.append(node('legend','后台任务'),
  node('p',initial.worker_enabled?'当前设置：下次启动运行后台。':'当前设置：后台暂停。'),
  node('p','开启后会按你提交的任务使用已配置服务，可能产生费用。密钥和模型请先在设置中保存并测试。更改开关后需正常退出并重新打开应用。'));
 const costs=check('我理解后台采集可能调用收费服务','customerCosts');
 const observe=check('同时观察飞书触发记录（只读取，不自动执行或写回）','customerObserve');observe.input.checked=!!initial.observe_feishu;
 background.append(costs.wrap,observe.wrap);
 const enable=action('下次启动时开启后台',async()=>{
  if(!data.business){status.textContent='请先保存研究规则。';return;}
  if(!costs.input.checked){status.textContent='请先确认后台服务费用。';return;}
  await save({action:'background',enabled:true,confirm_costs:true,observe_feishu:!!observe.input.checked});
 });enable.dataset.customerEnable='';
 background.append(enable,action('下次启动时暂停后台',()=>save({action:'background',enabled:false})));
 host.append(background);
 const footer=node('div');footer.className='customer-setup-actions';
 footer.append(action('完成引导',async()=>{await save({action:'complete'});context.close();}),action('稍后设置',()=>context.close()));host.append(footer);
 return host;
}

export async function mountCustomerSetup(doc=globalThis.document,api=createApi()) {
 let status;
 try{await api.session();status=await api.request('/customer-setup');}
 catch(error){if(error.status===404)return;return;}
 const parent=doc.getElementById('settingsPaneAi');if(!parent)return;
 const launch=doc.createElement('button');launch.type='button';launch.className='settings-button settings-button-secondary';launch.textContent='首次使用与后台设置 · v'+status.version;
 parent.prepend(launch);
 async function open(){
  if(doc.getElementById('customerSetupDialog'))return;
  try{status=await api.request('/customer-setup');}catch{return;}
  const dialog=doc.createElement('dialog');dialog.id='customerSetupDialog';dialog.className='customer-setup-dialog';dialog.setAttribute('aria-labelledby','customerSetupTitle');
  const close=()=>{dialog.close();dialog.remove();launch.focus();};
  dialog.addEventListener('close',()=>dialog.remove());
  const navigate=tab=>{close();globalThis.switchMainTab?.('settings');globalThis.switchSettingsTab?.(tab);};
  dialog.append(renderCustomerSetup({root:dialog,save:async body=>{status=await api.request('/customer-setup',{method:'POST',body});return status;},close,navigate},status));
  doc.body.append(dialog);dialog.showModal();
 }
 launch.addEventListener('click',()=>void open());
 if(!status.setup_complete)await open();
 return {open};
}
if(typeof document!=='undefined')void mountCustomerSetup();
