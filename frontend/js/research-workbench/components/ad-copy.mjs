import { el, button, link, panel } from './elements.mjs';
import { mediaPath, projectPath } from '../services/actions.mjs';
export const usableAdCopy=value=>typeof value==='string'&&!!value.trim()&&!/\{\{[^{}]*\}\}/.test(value);
export async function ownedMedia(context,path){
 const blob=await context.api.blob(path,{signal:context.life.signal});if(!context.life.active)return null;
 if(!/^(image|video)\//.test(blob.type))throw Error('来源未返回可用媒体');
 const owner=context.context?.objectURLs||globalThis.URL;const url=owner.createObjectURL(blob);context.life.track(()=>owner.revokeObjectURL(url));return {url,type:blob.type};
}
export function mediaControl(context,path,label='读取当前素材'){
 const host=el(context,'div'),feedback=el(context,'p','rw-muted'),preview=el(context,'div');let loaded=false;
 host.append(button(context,label,async()=>{if(loaded)return;feedback.textContent='正在通过项目授权读取素材…';
  try{const result=await ownedMedia(context,path);if(!result)return;
   const media=el(context,result.type.startsWith('video/')?'video':'img');media.src=result.url;if(media.tagName==='VIDEO')media.controls=true;else media.alt='已保存来源素材 · 仍需人工核验';
   const download=el(context,'a','','下载当前素材');download.href=result.url;download.download='research-media';preview.replaceChildren(media,download);loaded=true;feedback.textContent='已读取保存素材。';
  }catch(error){if(context.life.active)feedback.textContent=error.message+'；未确认取得素材。';}
 }),feedback,preview);return host;
}
export function adTextPanel(context,word,ad){
 const original=ad.primary_text||'',host=el(context,'div'),copy=el(context,'blockquote','',usableAdCopy(original)?original:original.trim()?'动态商品广告，未获取可用正文':'未获取可用广告正文');host.append(copy);
 if(!usableAdCopy(original)){host.append(el(context,'p','rw-muted','请打开原广告核对；此记录不用于翻译或提取下一层词。'));return host;}
 let translated='',chinese=false;const note=el(context,'p','rw-muted','引用始终使用保存原文。');
 const toggle=button(context,'切换为中文',async()=>{
  try{if(!chinese&&!translated){const data=await context.api.request(projectPath(context.state.project.id)+'/ads/translate',{method:'POST',body:{keyword_id:word.id,ad_id:ad.id,expected_text:original},signal:context.life.signal});if(!context.life.active)return;if(!usableAdCopy(data.translated))throw Error('未返回可用译文');translated=data.translated;}
   if(!context.life.active)return;chinese=!chinese;copy.textContent=chinese?translated:original;toggle.textContent=chinese?'查看原文':'切换为中文';note.textContent=chinese?'机器翻译仅供阅读；引用仍使用原文。':'原文 · 点击后翻译';
  }catch(error){if(context.life.active)note.textContent=error.message+'；原文已保留。';}
 });host.append(toggle,note,button(context,'复制原文',async()=>{await context.root.ownerDocument.defaultView.navigator.clipboard.writeText(original);}));return host;
}
export function renderAds(context){const host=panel(context,'已保存广告与媒体','采集事实不代表独立创意或具体商品已经确认。');
 for(const word of context.state.project.keywords||[])for(const ad of word.ads||[]){const card=panel(context,ad.advertiser||ad.id,`${word.text} · 开始 ${ad.start_date||'未知'} · ${ad.active===true?'当前活跃':'状态待核对'}`);
  card.append(adTextPanel(context,word,ad),link(context,'查看原广告','https://www.facebook.com/ads/library/?id='+encodeURIComponent(ad.id)));if(ad.landing_url)card.append(link(context,'查看商品入口',ad.landing_url));
  for(const [index] of (ad.media||[]).entries())card.append(mediaControl(context,mediaPath(context.state.project.id,{keyword_id:word.id,ad_id:ad.id,source:'ad',index}),'读取广告素材 '+(index+1)));
  host.append(card);
 }return host;
}
