import {createLifecycle} from '../lifecycle.mjs';
import {renderProduct} from '../pages/product.mjs';
import {el,button} from './elements.mjs';
let sequence=0;

/** Reuse the original identity form and command contract without changing routes. */
export function createProductIdentityDialog(context,productId,{onCancel,onSaved}={}){
 const product=context.state.project?.products?.find(p=>p.id===productId&&!p.merged_into);if(!product)return null;
 const life=createLifecycle(),trigger=context.root.ownerDocument.activeElement,dialog=el(context,'dialog','rw-product-identity-dialog');dialog.dataset.productIdentityDialog='true';
 const localState={...context.state,view:'product',product:productId,step:'identification',productOverview:undefined};
 let closed=false,submitting=false,saved=false;
 const title=el(context,'h2','','核对商品与广告'),description=el(context,'p','rw-muted','对照商品页与广告，选择一致、不一致或暂时无法判断，并记录实际核对依据。保存后返回当前列表，只有确认一致才能继续核实。');
 title.id='rw-product-identity-'+(++sequence);title.tabIndex=-1;description.id=title.id+'-help';
 dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby',title.id);dialog.setAttribute('aria-describedby',description.id);dialog.setAttribute('aria-busy','false');
 const notice=el(context,'p','rw-product-dialog-notice');notice.setAttribute('role','alert');
 const requestClose=()=>{if(submitting){notice.textContent='正在保存，请等待结果后再关闭。';return;}onCancel?.();};
 const close=button({...context,life},'×',requestClose,'rw-product-dialog-close');close.setAttribute('aria-label','关闭商品核对');
 const header=el(context,'header','rw-product-dialog-header'),body=el(context,'div','rw-product-dialog-body');header.append(title,close,description,notice);dialog.append(header,body);
 const leave=fn=>{if(submitting){notice.textContent='正在保存，请等待结果后再进行其他操作。';return;}onCancel?.();fn?.();};
 const c={...context,root:dialog,life,state:localState,designDirectForms:true,productIdentityDialog:true,refreshProject:undefined,
  onFormSubmitting:value=>{submitting=value;close.disabled=value;dialog.setAttribute('aria-busy',String(value));if(value)notice.textContent='正在保存商品核对…';else notice.textContent='';},
  onFormSaved:()=>{saved=true;},
  navigate:view=>{if(saved)onSaved?.(localState.project,localState.product);else if(view==='product'||view==='project')onCancel?.();else leave(()=>context.navigate(view));},
  openForm:spec=>leave(()=>context.openForm(spec)),showQueue:selection=>leave(()=>context.showQueue(selection)),
  openProduct:(...args)=>leave(()=>context.openProduct?.(...args)),selectProduct:id=>leave(()=>context.selectProduct?.(id)),
 };
 body.append(renderProduct(c));
 const save=body.querySelector('button[type=submit]');if(save)save.textContent='保存核对结果';
 life.listen(dialog,'cancel',event=>{event.preventDefault();requestClose();});
 const controller={dialog,needsPaint:false,close({restoreFocus=true}={}){if(closed)return;closed=true;life.dispose();if(dialog.open&&dialog.close)dialog.close();dialog.remove();if(restoreFocus)queueMicrotask(()=>{const replacement=Array.from(context.root.querySelectorAll?.('[data-product-identity-trigger]')||[]).find(n=>n.dataset.productIdentityTrigger===productId);(replacement||trigger)?.focus?.({preventScroll:true});});}};
 const detach=context.life.track(()=>controller.close({restoreFocus:false}));life.track(detach);
 context.root.append(dialog);if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');title.focus({preventScroll:true});return controller;
}
