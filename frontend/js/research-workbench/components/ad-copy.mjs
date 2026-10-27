import { createMediaCache,sourceMediaKey } from '../services/media-cache.mjs';
export {createMediaCache} from '../services/media-cache.mjs';
import { el, button, link, panel } from './elements.mjs';
import { mediaPath, projectPath } from '../services/actions.mjs';
export const usableAdCopy=value=>typeof value==='string'&&!!value.trim()&&!/\{\{[^{}]*\}\}/.test(value);
export async function ownedMedia(context,path){
 const blob=await context.api.blob(path,{signal:context.life.signal});if(!context.life.active)return null;
 if(!/^(image|video)\//.test(blob.type))throw Error('来源未返回可用媒体');
 const owner=context.context?.objectURLs||globalThis.URL;const url=owner.createObjectURL(blob);context.life.track(()=>owner.revokeObjectURL(url));return {url,type:blob.type};
}
export function mediaControl(context,path,label='读取当前素材',{autoLoad=false}={}){
 const host=el(context,'div','rw-media-control'),feedback=el(context,'p','rw-muted'),preview=el(context,'div');let loaded=false,pending=false;
 feedback.setAttribute('role','status');
 const read=button(context,label,load);read.hidden=autoLoad;
 async function load(){
  if(pending||loaded||!context.life.active)return;pending=true;read.disabled=true;feedback.textContent='正在加载已保存素材…';
  try{const result=await ownedMedia(context,path);if(!result)return;
   const media=el(context,result.type.startsWith('video/')?'video':'img');
   const failed=()=>{if(!context.life.active)return;loaded=false;preview.replaceChildren();read.hidden=false;read.textContent='重试读取素材';feedback.textContent='素材未能显示，来源可能已失效或格式不可用，请重试或打开原来源核对。';};
   context.life.listen(media,'error',failed);
   context.life.listen(media,media.tagName==='VIDEO'?'loadedmetadata':'load',()=>{if(context.life.active)feedback.textContent='已显示保存素材。';});
   if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';media.playsInline=true;context.life.track(()=>{media.pause?.();media.removeAttribute?.('src');media.load?.();});}else media.alt='已保存来源素材 · 仍需人工核验';
   media.src=result.url;
   const download=el(context,'a','','下载当前素材');download.href=result.url;download.download='research-media';preview.replaceChildren(media,download);loaded=true;feedback.textContent='正在显示素材…';
  }catch(error){if(context.life.active){read.hidden=false;read.textContent='重试读取素材';feedback.textContent=error.message+' 可点击“重试读取素材”。';}}
  finally{pending=false;if(context.life.active)read.disabled=false;}
 }
 host.append(read,feedback,preview);
 if(autoLoad)queueMicrotask(()=>{if(context.life.active)void load();});
 return host;
}

export function adTextPanel(context,word,ad){
 const original=ad.primary_text||'',host=el(context,'div','rw-ad-text-card'),copy=el(context,'blockquote','',usableAdCopy(original)?original:original.trim()?'动态商品广告，未获取可用正文':'未获取可用广告正文');
 if(!usableAdCopy(original)){host.append(copy,el(context,'p','rw-muted','请打开原广告核对；此记录不用于翻译或提取下一层词。'));return host;}
 let translated='',requested='original',pending=false;const projectId=context.state.project.id,toolbar=el(context,'div','rw-ad-copy-toolbar'),note=el(context,'span','rw-ad-copy-note'),tools=el(context,'div','rw-ad-copy-tools');note.setAttribute('role','status');
 const originalButton=button(context,'原',()=>{requested='original';paint();},'rw-copy-language'),chineseButton=button(context,'中',async()=>{
  requested='chinese';if(pending){paint();return;}if(translated){paint();return;}pending=true;paint();
  try{const data=await context.api.request(projectPath(projectId)+'/ads/translate',{method:'POST',body:{keyword_id:word.id,ad_id:ad.id,expected_text:original},signal:context.life.signal});if(!context.life.active)return;if(!usableAdCopy(data.translated))throw Error('未返回可用译文');translated=data.translated;}
  catch(error){if(context.life.active){requested='original';paint();note.textContent='翻译未完成，原文已保留。'+error.message;return;}}
  finally{pending=false;if(context.life.active)chineseButton.setAttribute('aria-busy','false');}
  if(context.life.active)paint();
 },'rw-copy-language');
 originalButton.setAttribute('aria-label','查看原文');originalButton.title='显示保存的原文';chineseButton.setAttribute('aria-label','切换为中文');chineseButton.title='翻译为中文，仅供阅读';
 const copyButton=button(context,'',async()=>{try{await context.root.ownerDocument.defaultView.navigator.clipboard.writeText(original);if(context.life.active)note.textContent='已复制原文';}catch{if(context.life.active)note.textContent='复制失败，请手动选择原文复制。';}},'rw-copy-icon');copyButton.setAttribute('aria-label','复制原文');copyButton.title='复制保存的原文';const icon=el(context,'i','ph ph-copy');icon.setAttribute('aria-hidden','true');copyButton.append(icon);
 tools.setAttribute('aria-label','原文阅读工具');tools.append(chineseButton,el(context,'span','rw-copy-divider','｜'),originalButton,copyButton);toolbar.append(note,tools);host.append(toolbar,copy);
 function paint(){const chinese=requested==='chinese'&&!!translated;copy.textContent=chinese?translated:original;originalButton.setAttribute('aria-pressed',String(!chinese));chineseButton.setAttribute('aria-pressed',String(chinese));chineseButton.setAttribute('aria-busy',String(pending));note.textContent=pending?'正在翻译，引用仍用原文':chinese?'中文译文 · 引用仍用原文':'原文 · 引用保持原样';}
 paint();return host;
}
export function renderAds(context){const host=panel(context,'已保存广告与媒体','采集事实不代表独立创意或具体商品已经确认。');
 for(const word of context.state.project.keywords||[])for(const ad of word.ads||[]){const card=panel(context,ad.advertiser||ad.id,`${word.text} · 开始 ${ad.start_date||'未知'} · ${ad.active===true?'当前活跃':'状态待核对'}`);
  card.append(adTextPanel(context,word,ad),link(context,'查看原广告','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));if(ad.landing_url)card.append(link(context,'查看商品入口',ad.landing_url));
  for(const [index] of (ad.media||[]).entries())card.append(mediaControl(context,mediaPath(context.state.project.id,{keyword_id:word.id,ad_id:ad.id,source:'ad',index}),'读取广告素材 '+(index+1)));
  host.append(card);
 }return host;
}

/** Always-visible preview, scoped to the exact current product / keyword / ad. */
export function sourcePreview(context,word,product,ads=[],{fixedSource,onSelectionChange}={}) {
 const host=el(context,'section','rw-source-preview');host.dataset.sourcePreview='true';
 host.append(el(context,'h3','','广告素材与商品图'));
 const toolbar=el(context,'div','rw-media-toolbar'),stage=el(context,'div','rw-media-stage'),caption=el(context,'p','rw-muted');
 const key=context.state.project.id+':'+word.id+':'+(product?.id||ads[0]?.id||'entry')+(fixedSource?':'+fixedSource:'');
 context.state.focusMediaSelections||={};
 const saved=context.state.focusMediaSelections[key]||{};
 const selection={source:['product','ad'].includes(fixedSource)?fixedSource:saved.source==='product'?'product':saved.source==='ad'?'ad':ads.some(ad=>ad.media?.length)?'ad':'product',adId:ads.some(ad=>ad.id===saved.adId)?saved.adId:ads[0]?.id,index:Number.isInteger(saved.index)&&saved.index>=0?saved.index:0};
 context.state.focusMediaSelections[key]=selection;
 const cache=context.mediaCache||createMediaCache({life:context.life,api:context.api,owner:context.context?.objectURLs||globalThis.URL});
 const views=new Map(),prefetched=new Set(),thumbnails=new Map();let generation=0,current=null,pendingKey=null;
 const countLabel=el(context,'p','rw-muted'),feedback=el(context,'p','rw-muted'),preview=el(context,'div','rw-media-preview'),pagination=el(context,'div','rw-media-pagination');
 feedback.setAttribute('role','status');pagination.setAttribute('aria-label','素材列表');
 const retry=button(context,'重试读取素材',()=>{const item=selected();cache.invalidate(item.keyAt(item.index));return show();});retry.hidden=true;
 const navigation=el(context,'div','rw-gallery-navigation'),previous=el(context,'button','','上一张'),next=el(context,'button','','下一张');
 previous.type=next.type='button';navigation.append(previous,next);
 const move=delta=>{const item=selected(),index=item.index+delta;if(index>=0&&index<item.count){selection.index=index;paint();}};
 context.life.listen(previous,'click',()=>move(-1));context.life.listen(next,'click',()=>move(1));
 host.tabIndex=0;host.setAttribute('aria-label','来源素材预览，使用左右方向键切换');
 context.life.listen(host,'keydown',event=>{if(['INPUT','SELECT','TEXTAREA','VIDEO'].includes(event.target?.tagName))return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();move(event.key==='ArrowLeft'?-1:1);}});
 stage.append(countLabel,feedback,preview,retry,navigation,pagination);
 context.life.track(()=>{generation++;current?.lease.release();for(const thumb of thumbnails.values())thumb.lease?.release();for(const view of views.values())if(view.media.tagName==='VIDEO'){view.media.pause?.();view.media.removeAttribute?.('src');view.media.load?.();}});
 function selected(){
  const ad=ads.find(item=>item.id===selection.adId),isAd=selection.source==='ad',items=isAd?(ad?.media||[]):(product?.landing_snapshot?.images||[]),count=Math.min(items.length,12);
  selection.index=Math.min(selection.index,Math.max(0,count-1));
  const group=selection.source+':'+(isAd?ad?.id:product?.id);
  const pathAt=index=>mediaPath(context.state.project.id,{keyword_id:word.id,...(product?{product_id:product.id}:{}),...(isAd?{ad_id:ad.id}:{}),source:selection.source,index});
  const keyAt=index=>sourceMediaKey(context.state.project.id,word.id,selection.source,isAd?ad?.id:product?.id,product?.identity_revision,isAd?ad?.observed_at:product?.landing_snapshot?.observed_at,items,index);
  return {ad,isAd,items,count,group,pathAt,keyAt,index:selection.index};
 }
 async function show(){
  const item=selected(),id=++generation;retry.hidden=true;
  if(!item.count){pendingKey=null;current?.media.pause?.();current?.lease.release();current=null;preview.replaceChildren(el(context,'div','rw-media-empty',item.isAd?(item.ad?'这条广告尚未保存图片或视频，请打开原广告核对。':'这条线索未绑定具体广告，不能借用其他广告素材。'):'尚未保存商品图，请读取商品页或打开商品来源核对。'));countLabel.textContent='';feedback.textContent='';return;}
  const key=item.keyAt(item.index);
  countLabel.textContent='已保存 '+item.count+' 项 · 当前 '+(item.index+1)+' / '+item.count;
  if(current?.key===key){pendingKey=null;feedback.textContent='';return;}
  if(current&&current.group!==item.group){current.media.pause?.();current.lease.release();current=null;preview.replaceChildren();}
  feedback.textContent=current?'正在准备第 '+(item.index+1)+' 张；暂保留第 '+(current.index+1)+' 张预览。':'正在准备素材预览…';pendingKey=key;
  let lease;
  try{
   lease=await cache.acquire(key,item.pathAt(item.index));if(!lease)return;
   if(!context.life.active||id!==generation){lease.release();return;}
   let view=views.get(key);
   if(!view||view.url!==lease.url){
    const media=el(context,lease.type.startsWith('video/')?'video':'img');
    if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';media.playsInline=true;}else media.alt=(item.isAd?'广告素材':'商品图')+' '+(item.index+1)+' · 仍需人工核验';
    context.life.listen(media,'error',()=>{if(context.life.active&&current?.media===media){retry.hidden=false;feedback.textContent='当前素材无法显示，请重试或打开原来源核对。';}});
    media.src=lease.url;
    if(media.tagName==='IMG'&&media.decode)await media.decode();
    const download=el(context,'a','','下载当前素材');download.href=lease.url;download.download='research-media';view={media,download,url:lease.url};if(views.size>=16){const oldest=[...views.keys()].find(k=>k!==current?.key);if(oldest){views.get(oldest).media.pause?.();views.delete(oldest);}}views.set(key,view);
   }
   if(!context.life.active||id!==generation){lease.release();return;}
   current?.media.pause?.();current?.lease.release();current={...view,lease,key,group:item.group,index:item.index};preview.replaceChildren(view.media,view.download);feedback.textContent='';pendingKey=null;
   // Only nearby product pictures, never whole galleries or video collections.
   if(!item.isAd)for(const index of [item.index+1,item.index-1])if(index>=0&&index<item.count){const nextKey=item.keyAt(index);if(!prefetched.has(nextKey)){prefetched.add(nextKey);void cache.prefetch(nextKey,item.pathAt(index)).catch(()=>{});}}
  }catch(error){lease?.release();if(!context.life.active||id!==generation)return;if(lease)cache.invalidate(key);pendingKey=null;retry.hidden=false;feedback.textContent='第 '+(item.index+1)+' 项暂时无法显示；'+(current?'已保留上一张预览。':'')+error.message;}
 }

 const buttons=[];
 for(const [value,label] of [['product','商品图'],['ad','广告素材']]){
  const toggle=button(context,label,()=>{selection.source=value;selection.index=0;paint();});toggle.dataset.mediaSource=value;buttons.push(toggle);toolbar.append(toggle);
 }
 if(ads.length>1){const select=el(context,'select');select.setAttribute('aria-label','选择当前商品的来源广告');
  for(const ad of ads){const option=el(context,'option','',(ad.advertiser||'来源广告')+' · '+ad.id);option.value=ad.id;select.append(option);}select.value=selection.adId;
  context.life.listen(select,'change',()=>{selection.adId=select.value;selection.index=0;paint();});toolbar.append(select);
 }
 toolbar.hidden=!!fixedSource;host.append(toolbar,caption,stage);
 function paint(){
  host.dataset.activeMediaSource=selection.source;onSelectionChange?.({source:selection.source,adId:selection.adId});
  for(const toggle of buttons)toggle.setAttribute('aria-pressed',String(toggle.dataset.mediaSource===selection.source));
  const item=selected();caption.textContent=item.isAd?'广告素材 · 仅展示当前线索绑定的来源广告':'商品页图片 · 不代表广告素材';
  previous.disabled=!item.count||item.index===0;next.disabled=!item.count||item.index>=item.count-1;navigation.hidden=item.count<2;
  // Stable controls and preview nodes survive image switches.
  if(pagination.dataset.group!==item.group||pagination.children.length!==item.count){
   pagination.dataset.group=item.group;pagination.replaceChildren();for(const thumb of thumbnails.values())thumb.lease?.release();thumbnails.clear();
   if(item.count>1)for(let index=0;index<item.count;index++){const choose=button(context,String(index+1),()=>{selection.index=index;paint();});choose.setAttribute('aria-label','查看素材 '+(index+1));pagination.append(choose);}
  }
  const start=Math.max(0,Math.min(item.index-1,item.count-4));
  for(let index=0;index<pagination.children.length;index++){
   const choose=pagination.children[index];choose.setAttribute('aria-pressed',String(index===item.index));
   // Four visible thumbnails, with arrows retaining access to the whole gallery.
   // Video collections stay labelled rather than downloading videos as thumbnails.
   if(!item.isAd&&context.mediaCache){
    choose.className='rw-thumbnail-button';choose.hidden=index<start||index>=start+4;
    if(choose.hidden){const thumb=thumbnails.get(index);if(thumb){thumb.lease?.release();thumb.image?.remove();thumbnails.delete(index);}continue;}
    if(!thumbnails.has(index)){
     const thumb={};thumbnails.set(index,thumb);
     void cache.acquire(item.keyAt(index),item.pathAt(index)).then(lease=>{
      if(!lease)return;if(!context.life.active||thumbnails.get(index)!==thumb){lease.release();return;}
      if(!lease.type.startsWith('image/')){lease.release();return;}thumb.lease=lease;
      const image=el(context,'img');image.alt='商品图 '+(index+1);image.src=lease.url;thumb.image=image;choose.append(image);
      context.life.listen(image,'error',()=>{image.remove();thumb.lease?.release();thumb.lease=null;});
     }).catch(()=>{});
    }
   }
  }
  if(pendingKey!==item.keyAt(item.index))void show();
 }
 paint();return host;
}
