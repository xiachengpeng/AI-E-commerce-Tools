function showAds(k){openForm('广告线索 · '+k.text,'此处展示采集事实。独立创意与具体商品仍需核验。',[],async()=>{});$('submit-form').classList.add('hidden');const root=$('form-fields');for(const a of k.ads){const n=box(a.advertiser||a.id);n.className='wide evidence';n.append(adTextPanel(k,a),el('p','muted',`广告 ${a.id} · ${a.active?'当前活跃':'状态待核对'} · 开始 ${a.start_date||'未知'}`),link('查看原广告 ↗','https://www.facebook.com/ads/library/?id='+encodeURIComponent(a.id)));if(a.landing_url)n.append(el('span','','　'),link('商品入口 ↗',a.landing_url));root.append(n);}}

const adTranslations=new Map();
function usableAdCopy(value){return typeof value==='string'&&!!value.trim()&&!/\{\{[^{}]*\}\}/.test(value);}
function adTextPanel(word,ad,tag='p',className=''){
 const original=ad.primary_text||'',projectId=S.project.id;
 const key=JSON.stringify([projectId,word.id,ad.id,original]);
 if(!adTranslations.has(key))adTranslations.set(key,{translated:'',chinese:false,loading:false,error:''});
 const state=adTranslations.get(key),panel=el('div','ad-translation');
 panel.dataset.translationKey=key;
 const available=usableAdCopy(original);
 const copy=el(tag,className,available?original:original.trim()?'动态商品广告，未获取可用正文':'未获取可用广告正文');
 panel.append(copy);
 if(!available){panel.append(el('p','muted','请打开原广告核对；这条记录不用于翻译或提取下一层词。'));return panel;}
 const controls=el('div','ad-translation-controls'),note=el('span','muted'),error=el('p','ad-translation-error');
 error.setAttribute('role','alert');
 const refresh=()=>{for(const node of document.querySelectorAll('.ad-translation'))if(node.dataset.translationKey===key)node.paintTranslation?.();};
 const toggle=button('切换为中文',async()=>{
  if(state.loading)return;
  if(state.chinese){state.chinese=false;refresh();return;}
  if(state.translated){state.chinese=true;refresh();return;}
  state.loading=true;state.error='';refresh();
  try{
   const result=await api('/projects/'+projectId+'/ads/translate',{method:'POST',body:JSON.stringify({keyword_id:word.id,ad_id:ad.id,expected_text:original})});
   if(typeof result.translated!=='string'||!result.translated.trim())throw Error('未返回可用译文，请重试');
   state.translated=result.translated;state.chinese=true;
  }catch(exc){state.error=exc.message||'翻译失败，请重试；原文已保留';}
  finally{state.loading=false;refresh();}
 },'ad-translation-toggle');
 panel.paintTranslation=()=>{
  copy.textContent=state.chinese?state.translated:original;
  panel.dataset.translationLanguage=state.chinese?'zh':'original';
  toggle.textContent=state.loading?'正在翻译…':state.chinese?'查看原文':state.error?'重试翻译':'切换为中文';
  toggle.disabled=state.loading;
  note.textContent=state.chinese?'阿里云机器翻译 · 仅供阅读，引用仍使用原文':state.loading?'正在调用阿里云机器翻译':'原文 · 点击后翻译';
  error.textContent=state.error;error.hidden=!state.error;
 };
 controls.append(toggle,note);panel.prepend(controls,error);panel.paintTranslation();return panel;
}
